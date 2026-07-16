use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;
use uuid::Uuid;

use super::principal::McpPrincipal;
use super::types::{
    ControlAccess, ControlDecision, ControlGrant, ControlRequest, ControlTarget, PolicyAccess,
    TerminalCapability, TerminalMcpError, TerminalMcpPolicy,
};

const MAX_REASON_BYTES: usize = 512;
const MAX_RETAINED_REQUESTS: usize = 128;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ControlKey {
    user_id: String,
    caller_app_id: String,
    session_id: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RequestKey {
    control: ControlKey,
    capability: TerminalCapability,
}

struct RequestEntry {
    request: ControlRequest,
    decision_tx: watch::Sender<ControlDecision>,
}

#[derive(Default)]
struct ManagerState {
    grants: HashMap<ControlKey, ControlGrant>,
    requests: HashMap<String, RequestEntry>,
    requests_by_key: HashMap<RequestKey, String>,
    created_sessions: HashMap<String, (String, String)>,
}

#[derive(Default)]
pub struct TerminalMcpManager {
    state: Mutex<ManagerState>,
}

impl TerminalMcpManager {
    pub fn authorize(
        &self,
        policy: &TerminalMcpPolicy,
        principal: &McpPrincipal,
        target: ControlTarget,
        capability: TerminalCapability,
        reason: &str,
    ) -> Result<ControlAccess, TerminalMcpError> {
        let policy_access = policy.access_for(&principal.caller_app_id);
        if policy_access == PolicyAccess::Denied {
            return Err(TerminalMcpError::caller_not_authorized());
        }
        let key = control_key(principal, &target.session_id);
        let mut state = self
            .state
            .lock()
            .map_err(|_| TerminalMcpError::new("INTERNAL_ERROR", "Control state is unavailable"))?;
        if let Some(grant) = state.grants.get(&key)
            && grant.capabilities.contains(&capability)
        {
            return Ok(ControlAccess::Granted(grant.clone()));
        }
        if policy_access == PolicyAccess::Automatic {
            let grant = add_grant(&mut state, principal, target, capability);
            return Ok(ControlAccess::Granted(grant));
        }
        request_control_locked(&mut state, principal, target, capability, reason)
    }

    pub async fn wait_for_control(
        &self,
        principal: &McpPrincipal,
        request_id: &str,
        wait: Duration,
    ) -> Result<ControlDecision, TerminalMcpError> {
        let mut receiver = {
            let state = self.state.lock().map_err(|_| {
                TerminalMcpError::new("INTERNAL_ERROR", "Control state is unavailable")
            })?;
            let entry = state
                .requests
                .get(request_id)
                .ok_or_else(TerminalMcpError::control_revoked)?;
            if entry.request.user_id != principal.user_id
                || entry.request.caller_app_id != principal.caller_app_id
            {
                return Err(TerminalMcpError::caller_not_authorized());
            }
            entry.decision_tx.subscribe()
        };
        if *receiver.borrow() != ControlDecision::Pending {
            return Ok(*receiver.borrow());
        }
        let _ = tokio::time::timeout(wait, receiver.changed()).await;
        let decision = *receiver.borrow();
        Ok(decision)
    }

    pub fn decide(
        &self,
        request_id: &str,
        decision: ControlDecision,
    ) -> Result<ControlRequest, TerminalMcpError> {
        if !matches!(
            decision,
            ControlDecision::Approved | ControlDecision::Denied
        ) {
            return Err(TerminalMcpError::new(
                "INVALID_INPUT",
                "Invalid control decision",
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| TerminalMcpError::new("INTERNAL_ERROR", "Control state is unavailable"))?;
        let (request, decision_tx) = {
            let entry = state
                .requests
                .get_mut(request_id)
                .ok_or_else(TerminalMcpError::control_revoked)?;
            entry.request.decision = decision;
            (entry.request.clone(), entry.decision_tx.clone())
        };
        if decision == ControlDecision::Approved {
            let principal = McpPrincipal {
                user_id: request.user_id.clone(),
                caller_app_id: request.caller_app_id.clone(),
                caller_name: request.caller_name.clone(),
            };
            add_grant(
                &mut state,
                &principal,
                request.target.clone(),
                request.capability,
            );
            state.requests_by_key.remove(&RequestKey {
                control: control_key(&principal, &request.target.session_id),
                capability: request.capability,
            });
        }
        decision_tx.send_replace(decision);
        Ok(request)
    }

    pub fn record_created_session(&self, principal: &McpPrincipal, session_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.created_sessions.insert(
                session_id.to_owned(),
                (principal.user_id.clone(), principal.caller_app_id.clone()),
            );
        }
    }

    pub fn caller_created_session(&self, principal: &McpPrincipal, session_id: &str) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.created_sessions.get(session_id)
                == Some(&(principal.user_id.clone(), principal.caller_app_id.clone()))
        })
    }

    pub fn pending_requests(&self) -> Vec<ControlRequest> {
        self.state.lock().map_or_else(
            |_| Vec::new(),
            |state| {
                state
                    .requests
                    .values()
                    .filter(|entry| entry.request.decision == ControlDecision::Pending)
                    .map(|entry| entry.request.clone())
                    .collect()
            },
        )
    }

    pub fn active_grants(&self) -> Vec<ControlGrant> {
        self.state.lock().map_or_else(
            |_| Vec::new(),
            |state| state.grants.values().cloned().collect(),
        )
    }

    pub fn revoke_grant(&self, grant_id: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let before = state.grants.len();
        state.grants.retain(|_, grant| grant.id != grant_id);
        state.grants.len() != before
    }

    pub fn revoke_session(&self, session_id: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.grants.retain(|key, _| key.session_id != session_id);
        state.created_sessions.remove(session_id);
        revoke_requests(&mut state, |entry| {
            entry.request.target.session_id == session_id
        });
    }

    pub fn revoke_all(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.grants.clear();
        state.created_sessions.clear();
        revoke_requests(&mut state, |_| true);
    }
}

fn request_control_locked(
    state: &mut ManagerState,
    principal: &McpPrincipal,
    target: ControlTarget,
    capability: TerminalCapability,
    reason: &str,
) -> Result<ControlAccess, TerminalMcpError> {
    let request_key = RequestKey {
        control: control_key(principal, &target.session_id),
        capability,
    };
    if let Some(request_id) = state.requests_by_key.get(&request_key)
        && let Some(entry) = state.requests.get(request_id)
    {
        return match entry.request.decision {
            ControlDecision::Pending => Ok(ControlAccess::ApprovalRequired(entry.request.clone())),
            ControlDecision::Denied => Err(TerminalMcpError::control_denied()),
            ControlDecision::Approved => state
                .grants
                .get(&request_key.control)
                .cloned()
                .map(ControlAccess::Granted)
                .ok_or_else(TerminalMcpError::control_revoked),
            ControlDecision::Revoked => Err(TerminalMcpError::control_revoked()),
        };
    }
    let request = ControlRequest {
        id: Uuid::new_v4().to_string(),
        user_id: principal.user_id.clone(),
        caller_app_id: principal.caller_app_id.clone(),
        caller_name: principal.caller_name.clone(),
        target,
        capability,
        reason: truncate_utf8(reason.trim(), MAX_REASON_BYTES),
        decision: ControlDecision::Pending,
        created_at_ms: now_ms(),
    };
    let (decision_tx, _) = watch::channel(ControlDecision::Pending);
    state
        .requests_by_key
        .insert(request_key, request.id.clone());
    state.requests.insert(
        request.id.clone(),
        RequestEntry {
            request: request.clone(),
            decision_tx,
        },
    );
    prune_requests(state);
    Ok(ControlAccess::ApprovalRequired(request))
}

fn add_grant(
    state: &mut ManagerState,
    principal: &McpPrincipal,
    target: ControlTarget,
    capability: TerminalCapability,
) -> ControlGrant {
    let key = control_key(principal, &target.session_id);
    let grant = state.grants.entry(key).or_insert_with(|| ControlGrant {
        id: Uuid::new_v4().to_string(),
        user_id: principal.user_id.clone(),
        caller_app_id: principal.caller_app_id.clone(),
        caller_name: principal.caller_name.clone(),
        target,
        capabilities: BTreeSet::new(),
        created_at_ms: now_ms(),
    });
    grant.capabilities.insert(capability);
    grant.clone()
}

fn control_key(principal: &McpPrincipal, session_id: &str) -> ControlKey {
    ControlKey {
        user_id: principal.user_id.clone(),
        caller_app_id: principal.caller_app_id.clone(),
        session_id: session_id.to_owned(),
    }
}

fn revoke_requests(state: &mut ManagerState, mut predicate: impl FnMut(&RequestEntry) -> bool) {
    let request_ids = state
        .requests
        .iter()
        .filter(|(_, entry)| predicate(entry))
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for request_id in request_ids {
        if let Some(entry) = state.requests.get_mut(&request_id)
            && entry.request.decision == ControlDecision::Pending
        {
            entry.request.decision = ControlDecision::Revoked;
            entry.decision_tx.send_replace(ControlDecision::Revoked);
        }
    }
    state.requests_by_key.retain(|_, id| {
        state
            .requests
            .get(id)
            .is_some_and(|entry| entry.request.decision == ControlDecision::Pending)
    });
}

fn prune_requests(state: &mut ManagerState) {
    if state.requests.len() <= MAX_RETAINED_REQUESTS {
        return;
    }
    let mut completed = state
        .requests
        .values()
        .filter(|entry| entry.request.decision != ControlDecision::Pending)
        .map(|entry| (entry.request.created_at_ms, entry.request.id.clone()))
        .collect::<Vec<_>>();
    completed.sort();
    for (_, id) in completed
        .into_iter()
        .take(state.requests.len() - MAX_RETAINED_REQUESTS)
    {
        state.requests.remove(&id);
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn now_ms() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::terminal_mcp::types::TerminalMcpPolicyMode;

    fn principal() -> McpPrincipal {
        McpPrincipal {
            user_id: "lazycat".to_owned(),
            caller_app_id: "cloud.lazycat.app.agent".to_owned(),
            caller_name: "Agent".to_owned(),
        }
    }

    fn target() -> ControlTarget {
        ControlTarget {
            session_id: "session-one".to_owned(),
            backend: "webshell".to_owned(),
            label: "Shell".to_owned(),
        }
    }

    #[tokio::test]
    async fn confirms_grants_waits_and_revokes_control() {
        let manager = TerminalMcpManager::default();
        let principal = principal();
        let policy = TerminalMcpPolicy::default();

        let ControlAccess::ApprovalRequired(request) = manager
            .authorize(
                &policy,
                &principal,
                target(),
                TerminalCapability::Interact,
                "Open Codex",
            )
            .unwrap()
        else {
            panic!("confirmation policy should create a request");
        };
        manager
            .decide(&request.id, ControlDecision::Approved)
            .unwrap();
        assert_eq!(
            manager
                .wait_for_control(&principal, &request.id, Duration::from_millis(10))
                .await
                .unwrap(),
            ControlDecision::Approved
        );
        assert!(matches!(
            manager
                .authorize(
                    &policy,
                    &principal,
                    target(),
                    TerminalCapability::Interact,
                    "Open Codex"
                )
                .unwrap(),
            ControlAccess::Granted(_)
        ));

        manager.revoke_session("session-one");
        assert!(manager.active_grants().is_empty());
    }

    #[test]
    fn automatic_mode_grants_without_pending_request() {
        let manager = TerminalMcpManager::default();
        let policy = TerminalMcpPolicy {
            mode: TerminalMcpPolicyMode::SameUserAutomatic,
            ..Default::default()
        };

        assert!(matches!(
            manager
                .authorize(
                    &policy,
                    &principal(),
                    target(),
                    TerminalCapability::Create,
                    "Create SSH session"
                )
                .unwrap(),
            ControlAccess::Granted(_)
        ));
        assert!(manager.pending_requests().is_empty());
    }

    #[test]
    fn read_only_and_denied_callers_cannot_control_sessions() {
        let manager = TerminalMcpManager::default();
        let policy = TerminalMcpPolicy {
            mode: TerminalMcpPolicyMode::ReadOnly,
            ..Default::default()
        };

        assert_eq!(
            manager
                .authorize(
                    &policy,
                    &principal(),
                    target(),
                    TerminalCapability::Interact,
                    "write"
                )
                .unwrap_err()
                .code,
            "CALLER_NOT_AUTHORIZED"
        );
    }

    #[tokio::test]
    async fn duplicate_pending_request_is_reused_and_disable_wakes_waiters() {
        let manager = TerminalMcpManager::default();
        let principal = principal();
        let policy = TerminalMcpPolicy::default();
        let first = manager
            .authorize(
                &policy,
                &principal,
                target(),
                TerminalCapability::Interact,
                "first",
            )
            .unwrap();
        let second = manager
            .authorize(
                &policy,
                &principal,
                target(),
                TerminalCapability::Interact,
                "second",
            )
            .unwrap();
        let (ControlAccess::ApprovalRequired(first), ControlAccess::ApprovalRequired(second)) =
            (first, second)
        else {
            panic!("both calls should require approval");
        };
        assert_eq!(first.id, second.id);

        manager.revoke_all();
        assert_eq!(
            manager
                .wait_for_control(&principal, &first.id, Duration::from_millis(10))
                .await
                .unwrap(),
            ControlDecision::Revoked
        );
    }

    #[test]
    fn tracks_sessions_created_by_the_caller() {
        let manager = TerminalMcpManager::default();
        let principal = principal();

        manager.record_created_session(&principal, "session-one");

        assert!(manager.caller_created_session(&principal, "session-one"));
        assert!(!manager.caller_created_session(&principal, "session-two"));
    }
}
