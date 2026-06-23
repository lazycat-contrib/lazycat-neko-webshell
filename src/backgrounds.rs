use std::path::{Path as FsPath, PathBuf};

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tracing::warn;
use uuid::Uuid;

use crate::config::{DEFAULT_BACKGROUND_DIR, ENV_BACKGROUND_DIR, MAX_TERMINAL_BACKGROUND_BYTES};

#[derive(Debug, Deserialize)]
pub struct BackgroundUploadQuery {
    filename: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundDescriptor {
    id: String,
    mime_type: String,
    size: u64,
    url: String,
}

#[derive(Debug, Clone, Copy)]
struct BackgroundFormat {
    extension: &'static str,
    mime_type: &'static str,
}

#[derive(Debug)]
enum BackgroundError {
    BadRequest(String),
    Io(std::io::Error),
}

impl From<std::io::Error> for BackgroundError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

pub async fn upload_background(
    headers: HeaderMap,
    Query(query): Query<BackgroundUploadQuery>,
    body: Bytes,
) -> Response {
    match store_background(&headers, &query.filename, body).await {
        Ok(background) => (StatusCode::CREATED, Json(background)).into_response(),
        Err(BackgroundError::BadRequest(message)) => {
            (StatusCode::BAD_REQUEST, message).into_response()
        }
        Err(BackgroundError::Io(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to store terminal background: {err}"),
        )
            .into_response(),
    }
}

pub async fn delete_background(Path(id): Path<String>) -> Response {
    match remove_background(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(BackgroundError::BadRequest(message)) => {
            (StatusCode::BAD_REQUEST, message).into_response()
        }
        Err(BackgroundError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(BackgroundError::Io(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to delete terminal background: {err}"),
        )
            .into_response(),
    }
}

pub async fn background_file(Path(id): Path<String>) -> Response {
    match read_background_file(&id).await {
        Ok((format, bytes)) => background_response(format, bytes),
        Err(BackgroundError::BadRequest(message)) => {
            (StatusCode::BAD_REQUEST, message).into_response()
        }
        Err(BackgroundError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(BackgroundError::Io(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read terminal background: {err}"),
        )
            .into_response(),
    }
}

fn background_response(format: BackgroundFormat, bytes: Bytes) -> Response {
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(format.mime_type));
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response
}

async fn store_background(
    headers: &HeaderMap,
    filename: &str,
    body: Bytes,
) -> Result<BackgroundDescriptor, BackgroundError> {
    validate_background_filename(filename)?;
    if body.is_empty() || body.len() > MAX_TERMINAL_BACKGROUND_BYTES {
        return Err(BackgroundError::BadRequest(
            "background image must be between 1 byte and 10 MB".to_owned(),
        ));
    }
    validate_declared_mime(headers)?;
    let format = sniff_background_format(&body).ok_or_else(|| {
        BackgroundError::BadRequest("only PNG, JPEG, and WebP images are allowed".to_owned())
    })?;

    let id = Uuid::new_v4().to_string();
    let dir = ensure_background_dir().await?;
    remove_all_backgrounds(&dir).await?;
    let path = background_data_path(&dir, &id, format.extension);
    tokio::fs::write(path, &body).await?;

    Ok(BackgroundDescriptor {
        id: id.clone(),
        mime_type: format.mime_type.to_owned(),
        size: u64::try_from(body.len()).unwrap_or(u64::MAX),
        url: format!("/api/terminal-backgrounds/{id}/file"),
    })
}

async fn remove_background(id: &str) -> Result<(), BackgroundError> {
    validate_background_id(id)?;
    let dir = ensure_background_dir().await?;
    let mut removed = false;
    for format in BACKGROUND_FORMATS {
        match tokio::fs::remove_file(background_data_path(&dir, id, format.extension)).await {
            Ok(()) => removed = true,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(BackgroundError::Io(err)),
        }
    }
    if removed {
        Ok(())
    } else {
        Err(BackgroundError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "background not found",
        )))
    }
}

async fn read_background_file(id: &str) -> Result<(BackgroundFormat, Bytes), BackgroundError> {
    validate_background_id(id)?;
    let dir = ensure_background_dir().await?;
    for format in BACKGROUND_FORMATS {
        let path = background_data_path(&dir, id, format.extension);
        match tokio::fs::read(path).await {
            Ok(bytes) => return Ok((*format, Bytes::from(bytes))),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(BackgroundError::Io(err)),
        }
    }
    Err(BackgroundError::Io(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "background not found",
    )))
}

async fn remove_all_backgrounds(dir: &FsPath) -> std::io::Result<()> {
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if BACKGROUND_FORMATS
            .iter()
            .any(|format| format.extension == extension)
            && let Err(err) = tokio::fs::remove_file(&path).await
        {
            warn!(path = %path.display(), error = %err, "failed to remove stale terminal background");
        }
    }
    Ok(())
}

async fn ensure_background_dir() -> std::io::Result<PathBuf> {
    let dir = background_dir();
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

fn background_dir() -> PathBuf {
    std::env::var_os(ENV_BACKGROUND_DIR)
        .map_or_else(|| PathBuf::from(DEFAULT_BACKGROUND_DIR), PathBuf::from)
}

fn background_data_path(dir: &FsPath, id: &str, extension: &str) -> PathBuf {
    dir.join(format!("{id}.{extension}"))
}

fn validate_background_filename(filename: &str) -> Result<(), BackgroundError> {
    let filename = filename.trim();
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err(BackgroundError::BadRequest(
            "invalid background filename".to_owned(),
        ));
    }
    let extension = filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .ok_or_else(|| {
            BackgroundError::BadRequest("background filename must have an extension".to_owned())
        })?;
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err(BackgroundError::BadRequest(
            "only .png, .jpg, .jpeg, and .webp are allowed".to_owned(),
        ));
    }
    Ok(())
}

fn validate_declared_mime(headers: &HeaderMap) -> Result<(), BackgroundError> {
    let Some(mime_type) = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/webp" | "application/octet-stream"
    ) {
        Ok(())
    } else {
        Err(BackgroundError::BadRequest(format!(
            "unsupported background image MIME type: {mime_type}"
        )))
    }
}

fn validate_background_id(id: &str) -> Result<(), BackgroundError> {
    if valid_background_id(id) {
        Ok(())
    } else {
        Err(BackgroundError::BadRequest(
            "invalid background id".to_owned(),
        ))
    }
}

fn valid_background_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-')
}

const BACKGROUND_FORMATS: &[BackgroundFormat] = &[
    BackgroundFormat {
        extension: "png",
        mime_type: "image/png",
    },
    BackgroundFormat {
        extension: "jpg",
        mime_type: "image/jpeg",
    },
    BackgroundFormat {
        extension: "webp",
        mime_type: "image/webp",
    },
];

fn sniff_background_format(bytes: &[u8]) -> Option<BackgroundFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(BACKGROUND_FORMATS[0]);
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some(BACKGROUND_FORMATS[1]);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some(BACKGROUND_FORMATS[2]);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{sniff_background_format, validate_background_filename, validate_background_id};

    #[test]
    fn validates_background_upload_boundaries() {
        assert!(validate_background_filename("wallpaper.png").is_ok());
        assert!(validate_background_filename("wallpaper.webp").is_ok());
        assert!(validate_background_filename("../wallpaper.png").is_err());
        assert!(validate_background_filename("wallpaper.svg").is_err());
        assert!(validate_background_id("1d76747b-88ff-449f-9e19-cc89fb1a7a67").is_ok());
        assert!(validate_background_id("../escape").is_err());
    }

    #[test]
    fn sniffs_only_safe_bitmap_formats() {
        assert_eq!(
            sniff_background_format(b"\x89PNG\r\n\x1a\nrest")
                .unwrap()
                .mime_type,
            "image/png"
        );
        assert_eq!(
            sniff_background_format(b"\xff\xd8\xffrest")
                .unwrap()
                .mime_type,
            "image/jpeg"
        );
        assert_eq!(
            sniff_background_format(b"RIFFxxxxWEBPrest")
                .unwrap()
                .mime_type,
            "image/webp"
        );
        assert!(sniff_background_format(b"<svg></svg>").is_none());
    }
}
