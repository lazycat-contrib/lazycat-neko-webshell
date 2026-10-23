use crate::plugins::pomodoro::engine::{NOTIFICATION_SOURCE_KIND, StartPomodoroRequest};
use crate::state::AppState;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use std::sync::Arc;

pub async fn get_pomodoro_state(State(state): State<Arc<AppState>>) -> Response {
    match state.plugin.pomodoro.state() {
        Ok(pomodoro) => Json(pomodoro).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read pomodoro state: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_pomodoro_start(
    State(state): State<Arc<AppState>>,
    Json(request): Json<StartPomodoroRequest>,
) -> Response {
    match state.plugin.pomodoro.start_round(
        request.minutes,
        request.rounds.unwrap_or(4),
        request.current_round.unwrap_or(1),
    ) {
        Ok(pomodoro) => Json(pomodoro).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to start pomodoro: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_pomodoro_stop(State(state): State<Arc<AppState>>) -> Response {
    match state.plugin.pomodoro.stop() {
        Ok(pomodoro) => Json(pomodoro).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to stop pomodoro: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_pomodoro_dismiss(State(state): State<Arc<AppState>>) -> Response {
    match state.plugin.pomodoro.dismiss_completed() {
        Ok(pomodoro) => Json(pomodoro).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to dismiss pomodoro: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_notification_action(
    State(state): State<Arc<AppState>>,
    Path((id, action_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let notification = match state.notifications.notification(&id) {
        Ok(Some(notification)) => notification,
        Ok(None) => return (StatusCode::NOT_FOUND, "notification not found").into_response(),
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read notification: {err}"),
            )
                .into_response();
        }
    };
    if !notification
        .actions
        .iter()
        .any(|action| action.id == action_id)
    {
        return (StatusCode::NOT_FOUND, "notification action not found").into_response();
    }
    if notification.source_kind == NOTIFICATION_SOURCE_KIND {
        return match state
            .plugin
            .pomodoro
            .handle_notification_action(&id, &action_id)
        {
            Ok(Some(pomodoro)) => Json(pomodoro).into_response(),
            Ok(None) => (StatusCode::NOT_FOUND, "notification action not found").into_response(),
            Err(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to run notification action: {err}"),
            )
                .into_response(),
        };
    }
    if notification.source_kind == crate::plugins::terminal_mcp::PLUGIN_ID {
        if !crate::plugin::http::terminal_mcp_http::is_terminal_ui_request(&headers) {
            return (StatusCode::FORBIDDEN, "terminal-side approval is required").into_response();
        }
        return match crate::plugin::http::terminal_mcp_http::handle_notification_action(
            &state,
            &notification,
            &action_id,
        ) {
            Ok(Some(request)) => Json(request).into_response(),
            Ok(None) => (StatusCode::NOT_FOUND, "notification action not found").into_response(),
            Err(error) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": {
                        "code": error.code,
                        "message": error.message,
                    }
                })),
            )
                .into_response(),
        };
    }
    match state.notifications.mark_actioned(&id) {
        Ok(Some(notification)) => Json(notification).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "notification not found").into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to update notification: {err}"),
        )
            .into_response(),
    }
}
