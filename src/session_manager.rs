use std::collections::HashMap;
use std::io;
use std::sync::{Arc, LockResult, RwLock, RwLockReadGuard, RwLockWriteGuard};

use anyhow::anyhow;
use tracing::warn;

use crate::database::AppDatabase;
use crate::state::{SessionRecord, SessionStore};
use crate::terminal_manager::{ManagedTerminal, OutputBuffer, TerminalRegistry, TerminalSpec};
use crate::validation::normalize_output_frame_limit;

const METADATA_OUTPUT_BUFFER_LIMIT: &str = "outputBufferLimit";

pub struct SessionManager {
    records: Arc<RwLock<HashMap<String, SessionRecord>>>,
    terminals: Arc<TerminalRegistry>,
    output_buffers: Arc<RwLock<HashMap<String, Arc<OutputBuffer>>>>,
    database: Arc<AppDatabase>,
    store: Arc<SessionStore>,
}

impl SessionManager {
    pub fn new(
        records: HashMap<String, SessionRecord>,
        store: Arc<SessionStore>,
        database: Arc<AppDatabase>,
    ) -> Self {
        Self {
            records: Arc::new(RwLock::new(records)),
            terminals: Arc::new(TerminalRegistry::new()),
            output_buffers: Arc::new(RwLock::new(HashMap::new())),
            database,
            store,
        }
    }

    pub fn read(&self) -> LockResult<RwLockReadGuard<'_, HashMap<String, SessionRecord>>> {
        self.records.read()
    }

    pub fn write(&self) -> LockResult<RwLockWriteGuard<'_, HashMap<String, SessionRecord>>> {
        self.records.write()
    }

    pub fn persist_snapshot(&self, records: &HashMap<String, SessionRecord>) -> io::Result<()> {
        self.store.save(records)
    }

    pub fn output_buffer(&self, session_id: &str, limit: usize) -> Arc<OutputBuffer> {
        let normalized_limit = normalize_output_frame_limit(Some(limit));
        let buffer = self
            .output_buffers
            .write()
            .expect("terminal output buffer registry poisoned")
            .entry(session_id.to_owned())
            .or_insert_with(|| {
                Arc::new(OutputBuffer::persistent(
                    normalized_limit,
                    session_id.to_owned(),
                    Arc::clone(&self.database),
                ))
            })
            .clone();
        buffer.set_limit(normalized_limit);
        buffer
    }

    pub fn open_terminal(
        &self,
        spec: TerminalSpec,
        allow_spawn: bool,
    ) -> anyhow::Result<Arc<ManagedTerminal>> {
        let output = self.output_buffer(&spec.session_id, spec.output_frame_limit);
        self.terminals.open(spec, allow_spawn, output)
    }

    pub fn close_sessions<'a>(&self, session_ids: impl IntoIterator<Item = &'a str>) {
        for session_id in session_ids {
            self.close_terminal_and_output(session_id);
        }
    }

    pub fn close_terminal_and_output(&self, session_id: &str) {
        self.terminals.close(session_id);
        self.remove_output_buffer(session_id);
    }

    pub fn forget_terminal(&self, session_id: &str) {
        self.terminals.forget(session_id);
    }

    pub fn remove_output_buffer(&self, session_id: &str) {
        let buffer = self
            .output_buffers
            .write()
            .ok()
            .and_then(|mut buffers| buffers.remove(session_id));
        if let Some(buffer) = buffer {
            buffer.close_history();
        } else if let Err(err) = self.database.delete_output_history(session_id) {
            warn!(error = %err, session_id = %session_id, "failed to remove terminal output history");
        }
    }

    pub fn mark_status(&self, session_id: &str, status: &str) {
        let snapshot = {
            let Ok(mut records) = self.records.write() else {
                return;
            };
            let Some(session) = records.get_mut(session_id) else {
                return;
            };
            status.clone_into(&mut session.status);
            records.clone()
        };
        if let Err(err) = self.persist_snapshot(&snapshot) {
            warn!(error = %err, "failed to persist terminal session status");
        }
    }

    pub fn set_restartable(&self, session_id: &str, restartable: bool) -> anyhow::Result<()> {
        let snapshot = {
            let mut records = self
                .records
                .write()
                .map_err(|_| anyhow!("session store lock poisoned"))?;
            let session = records
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("unknown session id"))?;
            session.set_restartable(restartable);
            records.clone()
        };
        self.persist_snapshot(&snapshot)?;
        Ok(())
    }

    pub fn set_output_frame_limit(&self, session_id: &str, limit: usize) -> anyhow::Result<usize> {
        let limit = normalize_output_frame_limit(Some(limit));
        let snapshot = {
            let mut records = self
                .records
                .write()
                .map_err(|_| anyhow!("session store lock poisoned"))?;
            let session = records
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("unknown session id"))?;
            session
                .metadata
                .insert(METADATA_OUTPUT_BUFFER_LIMIT.to_owned(), limit.to_string());
            records.clone()
        };
        self.persist_snapshot(&snapshot)?;
        Ok(limit)
    }

    pub fn persist_resize(&self, session_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let mut changed = false;
        let snapshot = {
            let mut records = self
                .records
                .write()
                .map_err(|_| anyhow!("session store lock poisoned"))?;
            let session = records
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("unknown session id"))?;
            if session.cols != cols || session.rows != rows {
                session.cols = cols;
                session.rows = rows;
                changed = true;
            }
            changed.then(|| records.clone())
        };
        if let Some(snapshot) = snapshot {
            self.persist_snapshot(&snapshot)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DEFAULT_COLS, DEFAULT_ROWS};
    use crate::database::AppDatabase;
    use crate::state::default_session_command;
    use uuid::Uuid;

    #[test]
    fn persists_status_resize_restart_policy_and_output_limit() {
        let (manager, database) = test_manager(HashMap::from([(
            "session-one".to_owned(),
            test_session("session-one", "starting"),
        )]));

        manager.mark_status("session-one", "running");
        manager.persist_resize("session-one", 100, 40).unwrap();
        manager.set_restartable("session-one", true).unwrap();
        let limit = manager.set_output_frame_limit("session-one", 64).unwrap();

        assert_eq!(limit, 128);
        let records = manager.read().unwrap();
        let record = records.get("session-one").unwrap();
        assert_eq!(record.status, "running");
        assert_eq!(record.cols, 100);
        assert_eq!(record.rows, 40);
        assert_eq!(
            record.metadata.get("restartable").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            record.metadata.get("outputBufferLimit").map(String::as_str),
            Some("128")
        );
        drop(records);

        let persisted = database
            .load_kv(
                crate::database::KV_NAMESPACE_STATE,
                crate::database::KV_KEY_SESSIONS,
            )
            .unwrap()
            .expect("persisted sessions");
        let persisted: serde_json::Value = serde_json::from_slice(&persisted).unwrap();
        let session = &persisted["sessions"][0];
        assert_eq!(session["status"], "running");
        assert_eq!(session["cols"], 100);
        assert_eq!(session["rows"], 40);
        assert_eq!(session["metadata"]["restartable"], "true");
        assert_eq!(session["metadata"]["outputBufferLimit"], "128");
    }

    #[test]
    fn close_sessions_removes_output_buffer_and_history_rows() {
        let (manager, database) = test_manager(HashMap::new());
        let first = manager.output_buffer("session-one", 128);
        database
            .append_output_frame(
                "session-one",
                &crate::terminal_manager::OutputFrame {
                    sequence: 1,
                    data: b"stale history".to_vec(),
                },
                1,
            )
            .unwrap();

        manager.close_sessions(["session-one"]);

        assert!(
            database
                .load_output_history("session-one")
                .unwrap()
                .is_empty()
        );
        let recreated = manager.output_buffer("session-one", 128);
        assert!(!Arc::ptr_eq(&first, &recreated));
    }

    fn test_manager(records: HashMap<String, SessionRecord>) -> (SessionManager, Arc<AppDatabase>) {
        let suffix = Uuid::new_v4();
        let database = Arc::new(
            AppDatabase::open(
                std::env::temp_dir().join(format!("lazycat-neko-webshell-manager-{suffix}.db")),
            )
            .unwrap(),
        );
        let manager = SessionManager::new(
            records,
            Arc::new(SessionStore::new(Arc::clone(&database))),
            Arc::clone(&database),
        );
        (manager, database)
    }

    fn test_session(id: &str, status: &str) -> SessionRecord {
        let selector = format!("{id}@owner");
        let (command, args) = default_session_command(&selector);
        SessionRecord {
            id: id.to_owned(),
            host: id.to_owned(),
            selector,
            status: status.to_owned(),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            command,
            args,
            control: None,
            metadata: HashMap::from([
                ("host".to_owned(), id.to_owned()),
                ("restartable".to_owned(), "false".to_owned()),
            ]),
        }
    }
}
