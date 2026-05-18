use std::io;
use std::path::{Path, PathBuf};

use axum::Json;
use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::config::{DEFAULT_USER_SETTINGS_FILE, MAX_USER_SETTINGS_BYTES};

pub async fn get_settings() -> Response {
    match tokio::fs::read(settings_path()).await {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) if value.is_object() => Json(value).into_response(),
            Ok(_) => (
                StatusCode::BAD_REQUEST,
                "settings file must be a JSON object",
            )
                .into_response(),
            Err(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to parse settings: {err}"),
            )
                .into_response(),
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => Json(json!({})).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read settings: {err}"),
        )
            .into_response(),
    }
}

pub async fn put_settings(body: Bytes) -> Response {
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

    match write_settings(&value).await {
        Ok(()) => Json(value).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to store settings: {err}"),
        )
            .into_response(),
    }
}

async fn write_settings(value: &Value) -> io::Result<()> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|err| io::Error::other(err.to_string()))?;
    let temp = temp_path_for(&path);
    tokio::fs::write(&temp, bytes).await?;
    tokio::fs::rename(temp, path).await?;
    Ok(())
}

fn settings_path() -> PathBuf {
    std::env::var_os("PURE_TERMINAL_SETTINGS_FILE")
        .map_or_else(|| PathBuf::from(DEFAULT_USER_SETTINGS_FILE), PathBuf::from)
}

fn temp_path_for(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("json")
    ))
}
