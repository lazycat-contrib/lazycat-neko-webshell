use std::collections::HashMap;

use anyhow::{anyhow, bail};
use buffa::MessageField;
use uuid::Uuid;

use crate::proto::lazycat::webshell::v1::{ControlLease, Session};
use crate::state::AppState;

const CONTROL_STATUS_ACTIVE: &str = "active";
const CONTROL_REASON_TAKEOVER: &str = "takeover";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlActor {
    pub actor_id: String,
    pub actor_kind: String,
}

impl ControlActor {
    pub fn new(actor_id: &str, actor_kind: &str) -> anyhow::Result<Self> {
        let actor_id = actor_id.trim();
        let actor_kind = actor_kind.trim();
        if actor_id.is_empty() || actor_kind.is_empty() {
            bail!("actor_id and actor_kind must not be empty");
        }
        Ok(Self {
            actor_id: actor_id.to_owned(),
            actor_kind: actor_kind.to_owned(),
        })
    }
}

pub fn request_session_control(
    state: &AppState,
    session_id: &str,
    actor: &ControlActor,
    reason: &str,
) -> anyhow::Result<ControlLease> {
    let session_id = normalize_session_id(session_id)?;
    let takeover = reason.trim().eq_ignore_ascii_case(CONTROL_REASON_TAKEOVER);
    let lease = {
        let mut leases = state
            .control_leases
            .write()
            .map_err(|_| anyhow!("control lease store lock poisoned"))?;
        if let Some(existing) = leases
            .get(session_id)
            .filter(|lease| lease_is_active(lease))
        {
            if !takeover || lease_actor_id(existing) == Some(actor.actor_id.as_str()) {
                return Ok(existing.clone());
            }
        }
        let lease = new_lease(actor);
        leases.insert(session_id.to_owned(), lease.clone());
        lease
    };
    mirror_session_control(state, session_id, Some(lease.clone()))?;
    Ok(lease)
}

pub fn release_session_control(
    state: &AppState,
    session_id: &str,
    lease_id: &str,
) -> anyhow::Result<()> {
    let session_id = normalize_session_id(session_id)?;
    let lease_id = lease_id.trim();
    if lease_id.is_empty() {
        bail!("lease_id must not be empty");
    }
    {
        let mut leases = state
            .control_leases
            .write()
            .map_err(|_| anyhow!("control lease store lock poisoned"))?;
        let current = leases
            .get(session_id)
            .and_then(|lease| lease.lease_id.as_deref());
        if current != Some(lease_id) {
            bail!("lease_id does not match active control lease");
        }
        leases.remove(session_id);
    }
    mirror_session_control(state, session_id, None)?;
    Ok(())
}

pub fn release_actor_session_control(
    state: &AppState,
    session_id: &str,
    actor_id: &str,
) -> anyhow::Result<bool> {
    let session_id = normalize_session_id(session_id)?;
    let actor_id = actor_id.trim();
    if actor_id.is_empty() {
        bail!("actor_id must not be empty");
    }
    let released = {
        let mut leases = state
            .control_leases
            .write()
            .map_err(|_| anyhow!("control lease store lock poisoned"))?;
        let actor_matches = leases
            .get(session_id)
            .filter(|lease| lease_is_active(lease))
            .and_then(lease_actor_id)
            == Some(actor_id);
        if actor_matches {
            leases.remove(session_id);
            true
        } else {
            false
        }
    };
    if released {
        mirror_session_control(state, session_id, None)?;
    }
    Ok(released)
}

pub fn current_session_control(state: &AppState, session_id: &str) -> Option<ControlLease> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return None;
    }
    if let Some(lease) = state
        .control_leases
        .read()
        .ok()
        .and_then(|leases| leases.get(session_id).cloned())
        .filter(lease_is_active)
    {
        return Some(lease);
    }
    state
        .sessions
        .read()
        .ok()
        .and_then(|sessions| {
            sessions
                .get(session_id)
                .and_then(|session| session.control.clone())
        })
        .filter(lease_is_active)
}

pub fn actor_controls_session(state: &AppState, session_id: &str, actor_id: &str) -> bool {
    let actor_id = actor_id.trim();
    if actor_id.is_empty() {
        return false;
    }
    current_session_control(state, session_id)
        .as_ref()
        .and_then(lease_actor_id)
        == Some(actor_id)
}

pub fn apply_runtime_control_to_session(
    mut session: Session,
    runtime_leases: &HashMap<String, ControlLease>,
) -> Session {
    if let Some(session_id) = session.id.as_deref() {
        if let Some(lease) = runtime_leases
            .get(session_id)
            .filter(|lease| lease_is_active(lease))
        {
            session.control = MessageField::some(lease.clone());
        }
    }
    session
}

fn mirror_session_control(
    state: &AppState,
    session_id: &str,
    lease: Option<ControlLease>,
) -> anyhow::Result<()> {
    let snapshot = {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(());
        };
        session.control = lease;
        sessions.clone()
    };
    state.persist_sessions_snapshot(&snapshot)?;
    Ok(())
}

fn normalize_session_id(session_id: &str) -> anyhow::Result<&str> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        bail!("session_id must not be empty");
    }
    Ok(session_id)
}

fn new_lease(actor: &ControlActor) -> ControlLease {
    ControlLease {
        lease_id: Some(Uuid::new_v4().to_string()),
        actor_id: Some(actor.actor_id.clone()),
        actor_kind: Some(actor.actor_kind.clone()),
        status: Some(CONTROL_STATUS_ACTIVE.to_owned()),
        ..Default::default()
    }
}

fn lease_actor_id(lease: &ControlLease) -> Option<&str> {
    lease
        .actor_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn lease_is_active(lease: &ControlLease) -> bool {
    lease
        .status
        .as_deref()
        .map(str::trim)
        .map(|status| status.is_empty() || status.eq_ignore_ascii_case(CONTROL_STATUS_ACTIVE))
        .unwrap_or(true)
        && lease_actor_id(lease).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DEFAULT_COLS, DEFAULT_ROWS};
    use crate::state::SessionRecord;

    #[test]
    fn attach_returns_existing_lease_without_overwriting() {
        let state = test_state();
        insert_session(&state, "session-one");
        let first = ControlActor::new("desktop", "desktop").unwrap();
        let second = ControlActor::new("phone", "mobile").unwrap();

        let first_lease = request_session_control(&state, "session-one", &first, "attach").unwrap();
        let second_lease =
            request_session_control(&state, "session-one", &second, "attach").unwrap();

        assert_eq!(second_lease.lease_id, first_lease.lease_id);
        assert_eq!(second_lease.actor_id.as_deref(), Some("desktop"));
    }

    #[test]
    fn takeover_replaces_existing_lease() {
        let state = test_state();
        insert_session(&state, "session-one");
        let first = ControlActor::new("desktop", "desktop").unwrap();
        let second = ControlActor::new("phone", "mobile").unwrap();

        let first_lease = request_session_control(&state, "session-one", &first, "attach").unwrap();
        let second_lease =
            request_session_control(&state, "session-one", &second, "takeover").unwrap();

        assert_ne!(second_lease.lease_id, first_lease.lease_id);
        assert_eq!(second_lease.actor_id.as_deref(), Some("phone"));
        assert!(actor_controls_session(&state, "session-one", "phone"));
        assert!(!actor_controls_session(&state, "session-one", "desktop"));
    }

    #[test]
    fn release_requires_matching_lease() {
        let state = test_state();
        insert_session(&state, "session-one");
        let actor = ControlActor::new("desktop", "desktop").unwrap();
        let lease = request_session_control(&state, "session-one", &actor, "attach").unwrap();

        let mismatch = release_session_control(&state, "session-one", "wrong-lease");
        assert!(mismatch.is_err());
        release_session_control(&state, "session-one", lease.lease_id.as_deref().unwrap()).unwrap();
        assert!(current_session_control(&state, "session-one").is_none());
    }

    #[test]
    fn release_by_actor_only_releases_matching_controller() {
        let state = test_state();
        insert_session(&state, "session-one");
        let first = ControlActor::new("desktop", "desktop").unwrap();
        let second = ControlActor::new("phone", "mobile").unwrap();
        request_session_control(&state, "session-one", &first, "attach").unwrap();

        assert!(!release_actor_session_control(&state, "session-one", &second.actor_id).unwrap());
        assert!(actor_controls_session(
            &state,
            "session-one",
            &first.actor_id
        ));

        assert!(release_actor_session_control(&state, "session-one", &first.actor_id).unwrap());
        assert!(current_session_control(&state, "session-one").is_none());
    }

    fn test_state() -> AppState {
        AppState::new_for_test(std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-control-{}.db",
            Uuid::new_v4()
        )))
    }

    fn insert_session(state: &AppState, session_id: &str) {
        let session = SessionRecord {
            id: session_id.to_owned(),
            host: "demo".to_owned(),
            selector: "demo@owner".to_owned(),
            status: "running".to_owned(),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            command: "/bin/sh".to_owned(),
            args: Vec::new(),
            control: None,
            metadata: HashMap::new(),
        };
        state
            .sessions
            .write()
            .unwrap()
            .insert(session_id.to_owned(), session);
    }
}
