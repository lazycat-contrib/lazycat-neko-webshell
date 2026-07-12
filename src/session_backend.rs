use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::lightos;
use crate::lightos_admin;
use crate::ssh_backend;
use crate::state::AppState;
use crate::tty_init::lightos_features_enabled;
use crate::validation::validate_selector;

#[derive(Debug, Deserialize)]
pub struct SessionBackendsQuery {
    name: String,
}

#[derive(Debug, Serialize)]
pub struct SessionBackendsState {
    selector: String,
    backends: Vec<SessionBackendInfo>,
}

#[derive(Debug, Serialize)]
pub struct SessionBackendInfo {
    id: &'static str,
    label: &'static str,
    available: bool,
    supports_terminal_transfer: bool,
    lightos_only: bool,
}

pub async fn get_session_backends(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionBackendsQuery>,
) -> Result<Json<SessionBackendsState>, SessionBackendsError> {
    let selector = query.name.trim();
    if lightos_admin::is_client_selector(selector) {
        crate::client_terminal::authorize_client(&headers, selector)
            .await
            .map_err(|error| SessionBackendsError {
                status: error.status,
                message: error.to_string(),
            })?;
        return Ok(Json(SessionBackendsState {
            selector: selector.to_owned(),
            backends: vec![SessionBackendInfo {
                id: "webshell",
                label: "WebShell native",
                available: true,
                supports_terminal_transfer: false,
                lightos_only: false,
            }],
        }));
    }
    validate_selector(selector).map_err(|err| SessionBackendsError {
        status: StatusCode::BAD_REQUEST,
        message: err.message.unwrap_or_else(|| "invalid selector".to_owned()),
    })?;

    if ssh_backend::is_ssh_selector(selector) {
        ssh_backend::load_enabled_profile(&state.database(), selector).map_err(|err| {
            SessionBackendsError {
                status: StatusCode::FORBIDDEN,
                message: err
                    .message
                    .unwrap_or_else(|| "SSH profile is not available".to_owned()),
            }
        })?;
        return Ok(Json(SessionBackendsState {
            selector: selector.to_owned(),
            backends: vec![SessionBackendInfo {
                id: "ssh",
                label: "SSH",
                available: true,
                supports_terminal_transfer: true,
                lightos_only: false,
            }],
        }));
    }

    if !lightos_features_enabled() {
        return Err(SessionBackendsError {
            status: StatusCode::NOT_FOUND,
            message: "LightOS integration is disabled".to_owned(),
        });
    }

    lightos::authorize_selector(selector, true)
        .await
        .map_err(|err| SessionBackendsError {
            status: StatusCode::FORBIDDEN,
            message: err
                .message
                .unwrap_or_else(|| "selector is not authorized".to_owned()),
        })?;

    let herdr_installed = lightos::target_command_available(selector, "herdr")
        .await
        .unwrap_or(false);
    let zellij_available = lightos::target_command_available(selector, "zellij")
        .await
        .unwrap_or(false);

    let mut backends = vec![SessionBackendInfo {
        id: "webshell",
        label: "WebShell native",
        available: true,
        supports_terminal_transfer: true,
        lightos_only: true,
    }];
    if herdr_installed {
        backends.push(SessionBackendInfo {
            id: "herdr",
            label: "Herdr",
            available: true,
            supports_terminal_transfer: false,
            lightos_only: true,
        });
    }
    if zellij_available {
        backends.push(SessionBackendInfo {
            id: "zellij",
            label: "zellij",
            available: true,
            supports_terminal_transfer: false,
            lightos_only: true,
        });
    }

    Ok(Json(SessionBackendsState {
        selector: selector.to_owned(),
        backends,
    }))
}

#[derive(Debug)]
pub struct SessionBackendsError {
    status: StatusCode,
    message: String,
}

impl IntoResponse for SessionBackendsError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}
