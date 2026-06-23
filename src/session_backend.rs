use axum::Json;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::lightos;
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
}

pub async fn get_session_backends(
    Query(query): Query<SessionBackendsQuery>,
) -> Result<Json<SessionBackendsState>, SessionBackendsError> {
    let selector = query.name.trim();
    validate_selector(selector).map_err(|err| SessionBackendsError {
        status: StatusCode::BAD_REQUEST,
        message: err.message.unwrap_or_else(|| "invalid selector".to_owned()),
    })?;
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
    }];
    if herdr_installed {
        backends.push(SessionBackendInfo {
            id: "herdr",
            label: "Herdr",
            available: true,
        });
    }
    if zellij_available {
        backends.push(SessionBackendInfo {
            id: "zellij",
            label: "zellij",
            available: true,
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
