use std::io;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::config::MAX_USER_SETTINGS_BYTES;
use crate::database::{KV_KEY_SETTINGS, KV_NAMESPACE_PREFERENCES};
use crate::state::AppState;

pub async fn get_settings(State(state): State<Arc<AppState>>) -> Response {
    match state
        .database()
        .load_kv(KV_NAMESPACE_PREFERENCES, KV_KEY_SETTINGS)
    {
        Ok(Some(bytes)) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) if value.is_object() => Json(value).into_response(),
            Ok(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "settings record must be a JSON object",
            )
                .into_response(),
            Err(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to parse settings: {err}"),
            )
                .into_response(),
        },
        Ok(None) => Json(json!({})).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read settings: {err}"),
        )
            .into_response(),
    }
}

pub async fn put_settings(State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    if body.is_empty() || body.len() > MAX_USER_SETTINGS_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            format!("settings must be between 1 byte and {MAX_USER_SETTINGS_BYTES} bytes"),
        )
            .into_response();
    }

    let value = match serde_json::from_slice::<Value>(&body) {
        Ok(value) if value.is_object() => value,
        Ok(_) => {
            return (StatusCode::BAD_REQUEST, "settings must be a JSON object").into_response();
        }
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid settings JSON: {err}"),
            )
                .into_response();
        }
    };

    match write_settings(&state, &value) {
        Ok(()) => Json(value).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to store settings: {err}"),
        )
            .into_response(),
    }
}

fn write_settings(state: &AppState, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|err| io::Error::other(err.to_string()))?;
    state
        .database()
        .store_kv(KV_NAMESPACE_PREFERENCES, KV_KEY_SETTINGS, &bytes)
}
