use std::path::{Component, Path, PathBuf};

use axum::Json;
use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use tokio_util::io::ReaderStream;

use crate::config::{DEFAULT_SOUNDS_DIR, ENV_SOUNDS_DIR};

const SUPPORTED_AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "ogg", "flac", "m4a", "webm"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundCatalog {
    root_path: String,
    exists: bool,
    files: Vec<SoundFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFile {
    id: String,
    name: String,
    category: String,
    path: String,
    url: String,
    extension: String,
    size_bytes: u64,
}

pub async fn list_sounds() -> Json<SoundCatalog> {
    let root = sounds_dir();
    let exists = root.is_dir();
    let files = if exists {
        match tokio::task::spawn_blocking({
            let root = root.clone();
            move || collect_sound_files(&root)
        })
        .await
        {
            Ok(Ok(files)) => files,
            Ok(Err(_)) | Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };
    Json(SoundCatalog {
        root_path: root.to_string_lossy().to_string(),
        exists,
        files,
    })
}

pub async fn sound_file(AxumPath(path): AxumPath<String>) -> Response {
    match open_sound_file(&path).await {
        Ok((path, file)) => sound_response(&path, file),
        Err(SoundError::BadRequest(message)) => (StatusCode::BAD_REQUEST, message).into_response(),
        Err(SoundError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(SoundError::Io(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read sound file: {err}"),
        )
            .into_response(),
    }
}

pub fn sounds_dir() -> PathBuf {
    std::env::var_os(ENV_SOUNDS_DIR)
        .map_or_else(|| PathBuf::from(DEFAULT_SOUNDS_DIR), PathBuf::from)
}

async fn open_sound_file(path: &str) -> Result<(PathBuf, tokio::fs::File), SoundError> {
    let relative = validate_request_path(path)?;
    let root = sounds_dir();
    let full_path = root.join(&relative);
    let canonical_root = tokio::fs::canonicalize(&root).await?;
    let canonical_path = tokio::fs::canonicalize(&full_path).await?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(SoundError::BadRequest("invalid sound file path".to_owned()));
    }
    let metadata = tokio::fs::metadata(&canonical_path).await?;
    if !metadata.file_type().is_file() || !supported_audio_file(&canonical_path) {
        return Err(SoundError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "sound file not found",
        )));
    }
    let file = tokio::fs::File::open(&canonical_path).await?;
    Ok((canonical_path, file))
}

fn sound_response(path: &Path, file: tokio::fs::File) -> Response {
    let stream = ReaderStream::new(file);
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    if let Ok(value) = HeaderValue::from_str(content_type.essence_str()) {
        headers.insert(CONTENT_TYPE, value);
    }
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response
}

fn collect_sound_files(root: &Path) -> std::io::Result<Vec<SoundFile>> {
    let mut files = Vec::new();
    visit_sounds_dir(root, root, &mut files)?;
    files.sort_by(|left, right| {
        left.category
            .cmp(&right.category)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(files)
}

fn visit_sounds_dir(root: &Path, dir: &Path, files: &mut Vec<SoundFile>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            visit_sounds_dir(root, &path, files)?;
            continue;
        }
        if !file_type.is_file() || !supported_audio_file(&path) {
            continue;
        }
        let metadata = entry.metadata()?;
        if let Some(file) = sound_file_from_path(root, &path, metadata.len()) {
            files.push(file);
        }
    }
    Ok(())
}

fn sound_file_from_path(root: &Path, path: &Path, size_bytes: u64) -> Option<SoundFile> {
    let relative = path.strip_prefix(root).ok()?;
    let normalized = normalize_relative_path(relative)?;
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sound_label)
        .filter(|value| !value.is_empty())?;
    let category = relative
        .components()
        .next()
        .and_then(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .filter(|_| relative.components().count() > 1)
        .map(sound_label)
        .unwrap_or_else(|| "Root".to_owned());
    Some(SoundFile {
        id: normalized.clone(),
        name,
        category,
        url: format!("/sounds/{}", encode_sound_url_path(&normalized)),
        path: normalized,
        extension,
        size_bytes,
    })
}

fn validate_request_path(path: &str) -> Result<PathBuf, SoundError> {
    let relative = Path::new(path);
    let Some(normalized) = normalize_relative_path(relative) else {
        return Err(SoundError::BadRequest("invalid sound file path".to_owned()));
    };
    if !supported_audio_file(Path::new(&normalized)) {
        return Err(SoundError::BadRequest(
            "unsupported sound file type".to_owned(),
        ));
    }
    Ok(PathBuf::from(normalized))
}

fn normalize_relative_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let part = value.to_str()?;
                if part.is_empty()
                    || part.starts_with('.')
                    || part.starts_with('-')
                    || part.chars().any(char::is_control)
                {
                    return None;
                }
                parts.push(part.to_owned());
            }
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn supported_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            SUPPORTED_AUDIO_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

fn encode_sound_url_path(path: &str) -> String {
    path.split('/')
        .map(encode_url_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_url_path_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(hex_digit(byte >> 4));
            encoded.push(hex_digit(byte & 0x0f));
        }
    }
    encoded
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => char::from(b'0' + value),
        10..=15 => char::from(b'A' + value - 10),
        _ => '0',
    }
}

fn sound_label(value: &str) -> String {
    value
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug)]
enum SoundError {
    BadRequest(String),
    Io(std::io::Error),
}

impl From<std::io::Error> for SoundError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        encode_sound_url_path, normalize_relative_path, sound_label, supported_audio_file,
        validate_request_path,
    };

    #[test]
    fn supports_common_audio_extensions() {
        assert!(supported_audio_file(Path::new("rain/light-rain.mp3")));
        assert!(supported_audio_file(Path::new("noise/white-noise.wav")));
        assert!(supported_audio_file(Path::new("ambient/custom.ogg")));
        assert!(!supported_audio_file(Path::new("README.md")));
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert_eq!(
            normalize_relative_path(Path::new("rain/light-rain.mp3")).as_deref(),
            Some("rain/light-rain.mp3")
        );
        assert!(normalize_relative_path(Path::new("../secret.mp3")).is_none());
        assert!(normalize_relative_path(Path::new(".hidden/sound.mp3")).is_none());
    }

    #[test]
    fn validates_requested_sound_paths() {
        assert_eq!(
            validate_request_path("rain/light-rain.mp3")
                .unwrap()
                .to_string_lossy(),
            "rain/light-rain.mp3"
        );
        assert!(validate_request_path("../secret.mp3").is_err());
        assert!(validate_request_path("rain/readme.md").is_err());
    }

    #[test]
    fn encodes_sound_urls_per_path_segment() {
        assert_eq!(
            encode_sound_url_path("rain/light rain#.mp3"),
            "rain/light%20rain%23.mp3"
        );
        assert_eq!(
            encode_sound_url_path("ambient/雨声.ogg"),
            "ambient/%E9%9B%A8%E5%A3%B0.ogg"
        );
    }

    #[test]
    fn formats_labels_from_file_names() {
        assert_eq!(sound_label("white-noise"), "White Noise");
        assert_eq!(sound_label("rain_on_window"), "Rain On Window");
    }
}
