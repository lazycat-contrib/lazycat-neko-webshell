use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::notifications::WebshellNotification;
use crate::state::AppState;

use super::types::{ControlDecision, ControlGrant, ControlRequest, TerminalMcpError};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlStateResponse {
    pending_requests: Vec<ControlRequest>,
    active_grants: Vec<ControlGrant>,
}

pub async fn get_control_state(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !is_terminal_ui_request(&headers) {
        return delegated_caller_response();
    }
    let mut pending_requests = state.terminal_mcp.pending_requests();
    let mut active_grants = state.terminal_mcp.active_grants();
    pending_requests.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    active_grants.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    Json(ControlStateResponse {
        pending_requests,
        active_grants,
    })
    .into_response()
}

pub async fn post_approve_request(
    State(state): State<Arc<AppState>>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_terminal_ui_request(&headers) {
        return delegated_caller_response();
    }
    decide_request(&state, &request_id, ControlDecision::Approved)
}

pub async fn post_deny_request(
    State(state): State<Arc<AppState>>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_terminal_ui_request(&headers) {
        return delegated_caller_response();
    }
    decide_request(&state, &request_id, ControlDecision::Denied)
}

pub async fn post_revoke_grant(
    State(state): State<Arc<AppState>>,
    Path(grant_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_terminal_ui_request(&headers) {
        return delegated_caller_response();
    }
    if state.terminal_mcp.revoke_grant(grant_id.trim()) {
        Json(serde_json::json!({ "revoked": true })).into_response()
    } else {
        (StatusCode::NOT_FOUND, "control grant not found").into_response()
    }
}

pub(crate) fn is_terminal_ui_request(headers: &HeaderMap) -> bool {
    // LazyCat delegated calls carry an internal user ticket and projected source identity.
    // Direct browser UI calls carry neither marker.
    !headers.contains_key("x-hc-user-ticket") && !headers.contains_key("x-hc-source")
}

pub(crate) fn handle_notification_action(
    state: &AppState,
    notification: &WebshellNotification,
    action_id: &str,
) -> Result<Option<ControlRequest>, TerminalMcpError> {
    if notification.source_kind != super::PLUGIN_ID {
        return Ok(None);
    }
    let decision = match action_id {
        "terminal-mcp.approve" => ControlDecision::Approved,
        "terminal-mcp.deny" => ControlDecision::Denied,
        _ => return Ok(None),
    };
    let action = notification
        .actions
        .iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| TerminalMcpError::invalid_input("notification action not found"))?;
    let request_id = action
        .payload
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|request_id| !request_id.is_empty())
        .ok_or_else(|| TerminalMcpError::invalid_input("notification request id is missing"))?;
    if notification.source_id.as_deref() != Some(request_id) {
        return Err(TerminalMcpError::caller_not_authorized());
    }
    let request = state.terminal_mcp.decide(request_id, decision)?;
    state
        .notifications
        .mark_actioned(&notification.id)
        .map_err(|_| {
            TerminalMcpError::new("INTERNAL_ERROR", "Failed to update approval notification")
        })?;
    Ok(Some(request))
}

fn decide_request(state: &AppState, request_id: &str, decision: ControlDecision) -> Response {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "request id is required").into_response();
    }
    match state.terminal_mcp.decide(request_id, decision) {
        Ok(request) => {
            let _ = state
                .notifications
                .mark_source_actioned(super::PLUGIN_ID, request_id);
            Json(request).into_response()
        }
        Err(error) => terminal_error_response(error),
    }
}

fn terminal_error_response(error: TerminalMcpError) -> Response {
    let status = match error.code {
        "CONTROL_REVOKED" => StatusCode::NOT_FOUND,
        "INVALID_INPUT" => StatusCode::BAD_REQUEST,
        "CALLER_NOT_AUTHORIZED" => StatusCode::FORBIDDEN,
        _ => StatusCode::CONFLICT,
    };
    (
        status,
        Json(serde_json::json!({
            "error": {
                "code": error.code,
                "message": error.message,
            }
        })),
    )
        .into_response()
}

fn delegated_caller_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "error": {
                "code": "CALLER_NOT_AUTHORIZED",
                "message": "Terminal-side approval must be performed from the Terminal UI",
            }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::plugins::terminal_mcp::principal::McpPrincipal;
    use crate::plugins::terminal_mcp::types::{
        ControlAccess, ControlTarget, TerminalCapability, TerminalMcpPolicy,
    };

    fn state() -> AppState {
        AppState::new_for_test(
            std::env::temp_dir().join(format!("terminal-mcp-http-{}.db", Uuid::new_v4())),
        )
    }

    fn principal() -> McpPrincipal {
        McpPrincipal {
            user_id: "lazycat".to_owned(),
            caller_app_id: "cloud.lazycat.app.agent".to_owned(),
            caller_name: "Agent".to_owned(),
        }
    }

    fn pending_request(state: &AppState) -> ControlRequest {
        let ControlAccess::ApprovalRequired(request) = state
            .terminal_mcp
            .authorize(
                &TerminalMcpPolicy::default(),
                &principal(),
                ControlTarget {
                    session_id: "session-one".to_owned(),
                    backend: "webshell".to_owned(),
                    label: "Shell".to_owned(),
                },
                TerminalCapability::Interact,
                "confirm command",
            )
            .unwrap()
        else {
            panic!("request should require approval");
        };
        request
    }

    #[test]
    fn notification_action_applies_decision_before_marking_actioned() {
        let state = state();
        let request = pending_request(&state);
        let notification = state
            .notifications
            .add(crate::notifications::NewNotification {
                source_kind: super::super::PLUGIN_ID.to_owned(),
                source_id: Some(request.id.clone()),
                kind: "interactive".to_owned(),
                severity: "warning".to_owned(),
                presentation_hint: "modal".to_owned(),
                title: "Approve".to_owned(),
                body: "Confirm".to_owned(),
                url: None,
                actions: vec![crate::notifications::NotificationAction {
                    id: "terminal-mcp.approve".to_owned(),
                    label: "Approve".to_owned(),
                    style: Some("primary".to_owned()),
                    payload: serde_json::json!({ "requestId": request.id }),
                }],
            })
            .unwrap();

        let decided = handle_notification_action(&state, &notification, "terminal-mcp.approve")
            .unwrap()
            .unwrap();

        assert_eq!(decided.decision, ControlDecision::Approved);
        assert_eq!(state.terminal_mcp.active_grants().len(), 1);
        assert_eq!(
            state
                .notifications
                .notification(&notification.id)
                .unwrap()
                .unwrap()
                .state,
            "actioned"
        );
    }

    #[test]
    fn notification_action_rejects_mismatched_request_ids() {
        let state = state();
        let request = pending_request(&state);
        let notification = WebshellNotification {
            id: "notification-one".to_owned(),
            source_kind: super::super::PLUGIN_ID.to_owned(),
            source_id: Some(request.id),
            kind: "interactive".to_owned(),
            severity: "warning".to_owned(),
            presentation_hint: "modal".to_owned(),
            title: String::new(),
            body: String::new(),
            url: None,
            actions: vec![crate::notifications::NotificationAction {
                id: "terminal-mcp.approve".to_owned(),
                label: "Approve".to_owned(),
                style: None,
                payload: serde_json::json!({ "requestId": "other-request" }),
            }],
            state: "unread".to_owned(),
            created_at_ms: 0,
            updated_at_ms: 0,
        };

        assert_eq!(
            handle_notification_action(&state, &notification, "terminal-mcp.approve")
                .unwrap_err()
                .code,
            "CALLER_NOT_AUTHORIZED"
        );
    }

    #[test]
    fn delegated_callers_cannot_use_terminal_side_approval_routes() {
        let mut headers = HeaderMap::new();
        headers.insert("x-hc-source", "cloud.lazycat.app.agent".parse().unwrap());

        assert!(!is_terminal_ui_request(&headers));

        let mut ticket_headers = HeaderMap::new();
        ticket_headers.insert("x-hc-user-ticket", "lazycat-ticket".parse().unwrap());
        assert!(!is_terminal_ui_request(&ticket_headers));

        assert!(is_terminal_ui_request(&HeaderMap::new()));
    }

    #[tokio::test]
    async fn delegated_caller_cannot_approve_a_pending_request() {
        let state = Arc::new(state());
        let request = pending_request(&state);
        let mut headers = HeaderMap::new();
        headers.insert("x-hc-source", "cloud.lazycat.app.agent".parse().unwrap());

        let response =
            post_approve_request(State(Arc::clone(&state)), Path(request.id), headers).await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(state.terminal_mcp.active_grants().is_empty());
        assert_eq!(state.terminal_mcp.pending_requests().len(), 1);
    }
}
