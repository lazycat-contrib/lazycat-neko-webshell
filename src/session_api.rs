use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::lightos;
use crate::state::{AppState, SessionRecord};

#[derive(Debug, Deserialize)]
pub struct SessionPlacementRequest {
    tab_id: Option<String>,
    pane_id: Option<String>,
    tab_title: Option<String>,
    tab_custom_title: Option<String>,
    tab_order: Option<String>,
    pane_order: Option<String>,
}

pub async fn put_session_placement(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(request): Json<SessionPlacementRequest>,
) -> Response {
    let selector = match session_selector(&state, &session_id) {
        Ok(Some(selector)) => selector,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(message) => return (StatusCode::INTERNAL_SERVER_ERROR, message).into_response(),
    };
    if let Err(err) = lightos::authorize_selector(&selector, false).await {
        return (
            StatusCode::FORBIDDEN,
            err.message
                .unwrap_or_else(|| "session selector is not authorized".to_owned()),
        )
            .into_response();
    }

    let session = match update_session_placement(&state, &session_id, &request) {
        Ok(Some(session)) => session,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(message) => return (StatusCode::INTERNAL_SERVER_ERROR, message).into_response(),
    };
    Json(session.to_proto()).into_response()
}

fn session_selector(state: &AppState, session_id: &str) -> Result<Option<String>, String> {
    let sessions = state
        .sessions
        .read()
        .map_err(|_| "session store lock poisoned".to_owned())?;
    Ok(sessions
        .get(session_id)
        .map(|session| session.selector.clone()))
}

fn update_session_placement(
    state: &AppState,
    session_id: &str,
    request: &SessionPlacementRequest,
) -> Result<Option<SessionRecord>, String> {
    let mut snapshot = None;
    let session = {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| "session store lock poisoned".to_owned())?;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(None);
        };
        let changed = apply_session_placement(&mut session.metadata, request);
        let session = session.clone();
        if changed {
            snapshot = Some(sessions.clone());
        }
        session
    };
    if let Some(snapshot) = snapshot {
        state
            .persist_sessions_snapshot(&snapshot)
            .map_err(|err| format!("failed to persist session placement: {err}"))?;
    }
    Ok(Some(session))
}

fn apply_session_placement(
    metadata: &mut HashMap<String, String>,
    request: &SessionPlacementRequest,
) -> bool {
    let mut changed = false;
    changed |= set_metadata_value(metadata, "tabId", request.tab_id.as_deref());
    changed |= set_metadata_value(metadata, "paneId", request.pane_id.as_deref());
    changed |= set_clearable_metadata_value(metadata, "tabTitle", request.tab_title.as_deref());
    changed |= set_metadata_value(
        metadata,
        "tabCustomTitle",
        request.tab_custom_title.as_deref(),
    );
    changed |= set_metadata_value(metadata, "tabOrder", request.tab_order.as_deref());
    changed |= set_metadata_value(metadata, "paneOrder", request.pane_order.as_deref());
    changed
}

fn set_metadata_value(
    metadata: &mut HashMap<String, String>,
    key: &str,
    value: Option<&str>,
) -> bool {
    let Some(value) = metadata_value(value) else {
        return false;
    };
    if metadata.get(key).is_some_and(|existing| existing == &value) {
        return false;
    }
    metadata.insert(key.to_owned(), value);
    true
}

fn set_clearable_metadata_value(
    metadata: &mut HashMap<String, String>,
    key: &str,
    value: Option<&str>,
) -> bool {
    let trimmed = value.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        return metadata.remove(key).is_some();
    }
    let Some(value) = metadata_value(Some(trimmed)) else {
        return false;
    };
    if metadata.get(key).is_some_and(|existing| existing == &value) {
        return false;
    }
    metadata.insert(key.to_owned(), value);
    true
}

fn metadata_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(128).collect())
}
