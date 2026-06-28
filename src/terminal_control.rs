use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use anyhow::{anyhow, bail};
use tokio::sync::broadcast;
use uuid::Uuid;

const CONTROL_EVENT_BUFFER: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalControlSnapshot {
    pub session_id: String,
    pub connection_id: String,
    pub controller_id: Option<String>,
    pub is_controller: bool,
    pub connection_count: usize,
}

#[derive(Debug)]
struct SessionControlState {
    connections: HashSet<String>,
    controller: Option<String>,
    events: broadcast::Sender<()>,
}

impl SessionControlState {
    fn new() -> Self {
        let (events, _) = broadcast::channel(CONTROL_EVENT_BUFFER);
        Self {
            connections: HashSet::new(),
            controller: None,
            events,
        }
    }

    fn snapshot(&self, session_id: &str, connection_id: &str) -> TerminalControlSnapshot {
        TerminalControlSnapshot {
            session_id: session_id.to_owned(),
            connection_id: connection_id.to_owned(),
            controller_id: self.controller.clone(),
            is_controller: self.controller.as_deref() == Some(connection_id),
            connection_count: self.connections.len(),
        }
    }
}

#[derive(Debug, Default)]
pub struct TerminalControlHub {
    sessions: RwLock<HashMap<String, SessionControlState>>,
}

impl TerminalControlHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn connect(&self, session_id: &str) -> anyhow::Result<TerminalControlSnapshot> {
        let session_id = normalize_session_id(session_id)?;
        let connection_id = Uuid::new_v4().to_string();
        let (snapshot, events) = {
            let mut sessions = self
                .sessions
                .write()
                .map_err(|_| anyhow!("terminal control store lock poisoned"))?;
            let session = sessions
                .entry(session_id.to_owned())
                .or_insert_with(SessionControlState::new);
            session.connections.insert(connection_id.clone());
            if session.controller.is_none() && session.connections.len() == 1 {
                session.controller = Some(connection_id.clone());
            }
            (
                session.snapshot(session_id, &connection_id),
                session.events.clone(),
            )
        };
        let _ = events.send(());
        Ok(snapshot)
    }

    pub fn disconnect(&self, session_id: &str, connection_id: &str) -> anyhow::Result<()> {
        let session_id = normalize_session_id(session_id)?;
        let connection_id = normalize_connection_id(connection_id)?;
        let notify = {
            let mut sessions = self
                .sessions
                .write()
                .map_err(|_| anyhow!("terminal control store lock poisoned"))?;
            let Some(session) = sessions.get_mut(session_id) else {
                return Ok(());
            };
            if !session.connections.remove(connection_id) {
                return Ok(());
            }
            if session.controller.as_deref() == Some(connection_id) {
                session.controller = auto_controller(&session.connections);
            }
            if session.connections.is_empty() {
                sessions.remove(session_id);
                None
            } else {
                Some(session.events.clone())
            }
        };
        if let Some(events) = notify {
            let _ = events.send(());
        }
        Ok(())
    }

    pub fn take_control(
        &self,
        session_id: &str,
        connection_id: &str,
    ) -> anyhow::Result<TerminalControlSnapshot> {
        self.update_connection(session_id, connection_id, |session, connection_id| {
            session.controller = Some(connection_id.to_owned());
        })
    }

    pub fn release_control(
        &self,
        session_id: &str,
        connection_id: &str,
    ) -> anyhow::Result<TerminalControlSnapshot> {
        self.update_connection(session_id, connection_id, |session, connection_id| {
            if session.controller.as_deref() == Some(connection_id) {
                session.controller = release_controller(&session.connections, connection_id);
            }
        })
    }

    pub fn snapshot(
        &self,
        session_id: &str,
        connection_id: &str,
    ) -> anyhow::Result<Option<TerminalControlSnapshot>> {
        let session_id = normalize_session_id(session_id)?;
        let connection_id = normalize_connection_id(connection_id)?;
        let sessions = self
            .sessions
            .read()
            .map_err(|_| anyhow!("terminal control store lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(None);
        };
        if !session.connections.contains(connection_id) {
            return Ok(None);
        }
        Ok(Some(session.snapshot(session_id, connection_id)))
    }

    pub fn is_controller(&self, session_id: &str, connection_id: &str) -> bool {
        let Ok(session_id) = normalize_session_id(session_id) else {
            return false;
        };
        let Ok(connection_id) = normalize_connection_id(connection_id) else {
            return false;
        };
        self.sessions
            .read()
            .ok()
            .and_then(|sessions| {
                sessions
                    .get(session_id)
                    .and_then(|session| session.controller.as_deref().map(str::to_owned))
            })
            .as_deref()
            == Some(connection_id)
    }

    pub fn subscribe(&self, session_id: &str) -> Option<broadcast::Receiver<()>> {
        let session_id = normalize_session_id(session_id).ok()?;
        self.sessions.read().ok().and_then(|sessions| {
            sessions
                .get(session_id)
                .map(|session| session.events.subscribe())
        })
    }

    fn update_connection(
        &self,
        session_id: &str,
        connection_id: &str,
        update: impl FnOnce(&mut SessionControlState, &str),
    ) -> anyhow::Result<TerminalControlSnapshot> {
        let session_id = normalize_session_id(session_id)?;
        let connection_id = normalize_connection_id(connection_id)?;
        let (snapshot, events) = {
            let mut sessions = self
                .sessions
                .write()
                .map_err(|_| anyhow!("terminal control store lock poisoned"))?;
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("terminal control session is not connected"))?;
            if !session.connections.contains(connection_id) {
                bail!("terminal control connection is not connected");
            }
            update(session, connection_id);
            (
                session.snapshot(session_id, connection_id),
                session.events.clone(),
            )
        };
        let _ = events.send(());
        Ok(snapshot)
    }
}

fn auto_controller(connections: &HashSet<String>) -> Option<String> {
    if connections.len() == 1 {
        connections.iter().next().cloned()
    } else {
        None
    }
}

fn release_controller(connections: &HashSet<String>, released: &str) -> Option<String> {
    if connections.len() == 1 && connections.contains(released) {
        return Some(released.to_owned());
    }
    let mut others = connections
        .iter()
        .filter(|connection| connection.as_str() != released);
    let next = others.next().cloned();
    if next.is_some() && others.next().is_none() {
        next
    } else {
        None
    }
}

fn normalize_session_id(session_id: &str) -> anyhow::Result<&str> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        bail!("session_id must not be empty");
    }
    Ok(session_id)
}

fn normalize_connection_id(connection_id: &str) -> anyhow::Result<&str> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        bail!("connection_id must not be empty");
    }
    Ok(connection_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_connection_becomes_controller() {
        let hub = TerminalControlHub::new();

        let first = hub.connect("session-one").unwrap();

        assert!(first.is_controller);
        assert_eq!(
            first.controller_id.as_deref(),
            Some(first.connection_id.as_str())
        );
        assert_eq!(first.connection_count, 1);
    }

    #[test]
    fn second_connection_observes_existing_controller() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();

        let second = hub.connect("session-one").unwrap();

        assert!(!second.is_controller);
        assert_eq!(second.controller_id, Some(first.connection_id));
        assert_eq!(second.connection_count, 2);
    }

    #[test]
    fn take_control_switches_controller() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();
        let second = hub.connect("session-one").unwrap();

        let takeover = hub
            .take_control("session-one", &second.connection_id)
            .unwrap();

        assert!(takeover.is_controller);
        assert_eq!(takeover.controller_id, Some(second.connection_id.clone()));
        assert!(!hub.is_controller("session-one", &first.connection_id));
        assert!(hub.is_controller("session-one", &second.connection_id));
    }

    #[test]
    fn take_control_can_switch_back_to_previous_observer() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();
        let second = hub.connect("session-one").unwrap();

        hub.take_control("session-one", &second.connection_id)
            .unwrap();
        let takeover = hub
            .take_control("session-one", &first.connection_id)
            .unwrap();

        assert!(takeover.is_controller);
        assert_eq!(takeover.controller_id, Some(first.connection_id.clone()));
        assert!(hub.is_controller("session-one", &first.connection_id));
        assert!(!hub.is_controller("session-one", &second.connection_id));
    }

    #[test]
    fn disconnecting_takeover_controller_promotes_only_remaining_connection() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();
        let second = hub.connect("session-one").unwrap();

        hub.take_control("session-one", &second.connection_id)
            .unwrap();
        hub.disconnect("session-one", &second.connection_id)
            .unwrap();
        let first_snapshot = hub
            .snapshot("session-one", &first.connection_id)
            .unwrap()
            .unwrap();

        assert!(first_snapshot.is_controller);
        assert_eq!(first_snapshot.controller_id, Some(first.connection_id));
        assert_eq!(first_snapshot.connection_count, 1);
    }

    #[test]
    fn disconnecting_controller_promotes_only_remaining_connection() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();
        let second = hub.connect("session-one").unwrap();

        hub.disconnect("session-one", &first.connection_id).unwrap();
        let second_snapshot = hub
            .snapshot("session-one", &second.connection_id)
            .unwrap()
            .unwrap();

        assert!(second_snapshot.is_controller);
        assert_eq!(second_snapshot.controller_id, Some(second.connection_id));
        assert_eq!(second_snapshot.connection_count, 1);
    }

    #[test]
    fn disconnecting_controller_with_multiple_observers_leaves_no_controller() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();
        let second = hub.connect("session-one").unwrap();
        let third = hub.connect("session-one").unwrap();

        hub.disconnect("session-one", &first.connection_id).unwrap();

        assert_eq!(
            hub.snapshot("session-one", &second.connection_id)
                .unwrap()
                .unwrap()
                .controller_id,
            None
        );
        assert!(!hub.is_controller("session-one", &third.connection_id));
    }

    #[test]
    fn releasing_controller_promotes_single_observer() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();
        let second = hub.connect("session-one").unwrap();

        hub.release_control("session-one", &first.connection_id)
            .unwrap();
        let second_snapshot = hub
            .snapshot("session-one", &second.connection_id)
            .unwrap()
            .unwrap();

        assert!(second_snapshot.is_controller);
        assert_eq!(second_snapshot.controller_id, Some(second.connection_id));
    }

    #[test]
    fn releasing_controller_with_multiple_observers_leaves_no_controller() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();
        let second = hub.connect("session-one").unwrap();
        let third = hub.connect("session-one").unwrap();

        hub.release_control("session-one", &first.connection_id)
            .unwrap();

        assert_eq!(
            hub.snapshot("session-one", &second.connection_id)
                .unwrap()
                .unwrap()
                .controller_id,
            None
        );
        assert!(!hub.is_controller("session-one", &third.connection_id));
    }

    #[test]
    fn disconnecting_observer_keeps_controller() {
        let hub = TerminalControlHub::new();
        let first = hub.connect("session-one").unwrap();
        let second = hub.connect("session-one").unwrap();

        hub.disconnect("session-one", &second.connection_id)
            .unwrap();
        let first_snapshot = hub
            .snapshot("session-one", &first.connection_id)
            .unwrap()
            .unwrap();

        assert!(first_snapshot.is_controller);
        assert_eq!(first_snapshot.connection_count, 1);
    }
}
