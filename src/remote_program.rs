use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::database::{AppDatabase, KV_NAMESPACE_STATE};

const REMOTE_PROGRAMS_KEY: &str = "remote_programs";
const MAX_REMOTE_PROGRAM_ENTRIES: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteProgramKind {
    Herdr,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteBootstrapState {
    Pending,
    Sent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RemoteProgramEntry {
    selector: String,
    pane_id: String,
    program_kind: RemoteProgramKind,
    bootstrap: RemoteBootstrapState,
    updated_at_ms: u64,
}

pub struct RemoteProgramStore {
    database: Arc<AppDatabase>,
    entries: RwLock<HashMap<String, RemoteProgramEntry>>,
}

impl RemoteProgramStore {
    pub fn load(database: Arc<AppDatabase>) -> io::Result<Self> {
        let stored = database
            .load_kv(KV_NAMESPACE_STATE, REMOTE_PROGRAMS_KEY)?
            .map(|bytes| {
                serde_json::from_slice::<HashMap<String, RemoteProgramEntry>>(&bytes)
                    .map_err(|error| io::Error::other(error.to_string()))
            })
            .transpose()?
            .unwrap_or_default();
        let mut entries = stored
            .into_values()
            .filter(|entry| !entry.selector.trim().is_empty() && !entry.pane_id.trim().is_empty())
            .map(|entry| (entry_key(&entry.selector, &entry.pane_id), entry))
            .collect::<HashMap<_, _>>();
        prune_oldest_entries(&mut entries);
        Ok(Self {
            database,
            entries: RwLock::new(entries),
        })
    }

    pub fn mark_pending(
        &self,
        selector: &str,
        pane_id: &str,
        program_kind: RemoteProgramKind,
    ) -> io::Result<()> {
        let selector = normalized_identity(selector, "selector")?;
        let pane_id = normalized_identity(pane_id, "pane id")?;
        self.mutate(|entries| {
            entries.insert(
                entry_key(selector, pane_id),
                RemoteProgramEntry {
                    selector: selector.to_owned(),
                    pane_id: pane_id.to_owned(),
                    program_kind,
                    bootstrap: RemoteBootstrapState::Pending,
                    updated_at_ms: now_ms(),
                },
            );
            true
        })
    }

    pub fn mark_sent(&self, selector: &str, pane_id: &str) -> io::Result<()> {
        self.update_bootstrap(selector, pane_id, RemoteBootstrapState::Sent)
    }

    pub fn mark_pending_after_rejection(&self, selector: &str, pane_id: &str) -> io::Result<()> {
        self.update_bootstrap(selector, pane_id, RemoteBootstrapState::Pending)
    }

    pub fn program_kind(&self, selector: &str, pane_id: &str) -> Option<RemoteProgramKind> {
        self.entries
            .read()
            .ok()?
            .get(&entry_key(selector.trim(), pane_id.trim()))
            .map(|entry| entry.program_kind)
    }

    pub fn bootstrap_state(&self, selector: &str, pane_id: &str) -> Option<RemoteBootstrapState> {
        self.entries
            .read()
            .ok()?
            .get(&entry_key(selector.trim(), pane_id.trim()))
            .map(|entry| entry.bootstrap)
    }

    pub fn reconcile_selector<I, S>(&self, selector: &str, pane_ids: I) -> io::Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let selector = normalized_identity(selector, "selector")?;
        let retained = pane_ids
            .into_iter()
            .map(|pane_id| pane_id.as_ref().trim().to_owned())
            .filter(|pane_id| !pane_id.is_empty())
            .collect::<HashSet<_>>();
        self.mutate(|entries| {
            let previous_len = entries.len();
            entries
                .retain(|_, entry| entry.selector != selector || retained.contains(&entry.pane_id));
            entries.len() != previous_len
        })
    }

    fn update_bootstrap(
        &self,
        selector: &str,
        pane_id: &str,
        bootstrap: RemoteBootstrapState,
    ) -> io::Result<()> {
        let selector = normalized_identity(selector, "selector")?;
        let pane_id = normalized_identity(pane_id, "pane id")?;
        self.mutate(|entries| {
            let Some(entry) = entries.get_mut(&entry_key(selector, pane_id)) else {
                return false;
            };
            if entry.bootstrap == bootstrap {
                return false;
            }
            entry.bootstrap = bootstrap;
            entry.updated_at_ms = now_ms();
            true
        })
    }

    fn mutate(
        &self,
        change: impl FnOnce(&mut HashMap<String, RemoteProgramEntry>) -> bool,
    ) -> io::Result<()> {
        let mut entries = self
            .entries
            .write()
            .map_err(|_| io::Error::other("remote program store lock poisoned"))?;
        let previous = entries.clone();
        if !change(&mut entries) {
            return Ok(());
        }
        prune_oldest_entries(&mut entries);
        if let Err(error) = persist_entries(&self.database, &entries) {
            *entries = previous;
            return Err(error);
        }
        Ok(())
    }
}

fn persist_entries(
    database: &AppDatabase,
    entries: &HashMap<String, RemoteProgramEntry>,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(entries).map_err(|error| io::Error::other(error.to_string()))?;
    database.store_kv(KV_NAMESPACE_STATE, REMOTE_PROGRAMS_KEY, &bytes)
}

fn prune_oldest_entries(entries: &mut HashMap<String, RemoteProgramEntry>) {
    if entries.len() <= MAX_REMOTE_PROGRAM_ENTRIES {
        return;
    }
    let mut oldest = entries
        .iter()
        .map(|(key, entry)| (key.clone(), entry.updated_at_ms))
        .collect::<Vec<_>>();
    oldest.sort_unstable_by_key(|(_, updated_at_ms)| *updated_at_ms);
    let remove_count = entries.len() - MAX_REMOTE_PROGRAM_ENTRIES;
    for (key, _) in oldest.into_iter().take(remove_count) {
        entries.remove(&key);
    }
}

fn normalized_identity<'a>(value: &'a str, label: &str) -> io::Result<&'a str> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("remote program {label} is required"),
        ));
    }
    Ok(normalized)
}

fn entry_key(selector: &str, pane_id: &str) -> String {
    format!("{}:{selector}{pane_id}", selector.len())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{RemoteProgramKind, RemoteProgramStore};
    use crate::database::AppDatabase;

    fn test_database() -> Arc<AppDatabase> {
        let suffix = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        Arc::new(
            AppDatabase::open(
                std::env::temp_dir().join(format!("neko-remote-program-{suffix}.db")),
            )
            .unwrap(),
        )
    }

    #[test]
    fn persists_program_state_and_reconciles_only_one_selector() {
        let database = test_database();
        let store = RemoteProgramStore::load(Arc::clone(&database)).unwrap();
        store
            .mark_pending("client:first", "pane-1", RemoteProgramKind::Herdr)
            .unwrap();
        store
            .mark_pending("client:second", "pane-1", RemoteProgramKind::Herdr)
            .unwrap();
        store
            .reconcile_selector("client:first", ["pane-2"])
            .unwrap();
        assert_eq!(store.program_kind("client:first", "pane-1"), None);
        assert_eq!(
            store.program_kind("client:second", "pane-1"),
            Some(RemoteProgramKind::Herdr)
        );
        let reloaded = RemoteProgramStore::load(database).unwrap();
        assert_eq!(
            reloaded.program_kind("client:second", "pane-1"),
            Some(RemoteProgramKind::Herdr)
        );
    }
}
