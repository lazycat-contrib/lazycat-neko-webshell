use std::convert::Infallible;
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::io::ReaderStream;
use url::Url;
use uuid::Uuid;
use zip::ZipArchive;

use crate::config::{DEFAULT_SOUNDS_DIR, ENV_SOUNDS_DIR};

const SUPPORTED_AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "ogg", "flac", "m4a", "webm"];
const MAX_SOUND_PACKAGE_BYTES: u64 = 500 * 1_024 * 1_024;
const MAX_SOUND_PACKAGE_EXTRACTED_BYTES: u64 = 2_048 * 1_024 * 1_024;
const MAX_SOUND_PACKAGE_FILES: usize = 5_000;
const SOUND_PACKAGE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(240);
const SOUND_PACKAGE_PROGRESS_CHUNK_BYTES: u64 = 1_024 * 1_024;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSoundPackageRequest {
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSoundPackageResponse {
    downloaded_bytes: u64,
    extracted_bytes: u64,
    extracted_files: usize,
    skipped_files: usize,
    catalog: SoundCatalog,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SoundPackageInstallEvent {
    status: &'static str,
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    extracted_bytes: u64,
    extracted_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_files: Option<usize>,
    skipped_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog: Option<SoundCatalog>,
}

pub async fn list_sounds() -> Json<SoundCatalog> {
    Json(sound_catalog().await)
}

pub async fn install_sound_package(Json(payload): Json<InstallSoundPackageRequest>) -> Response {
    let url = match validate_sound_package_url(&payload.url) {
        Ok(url) => url,
        Err(error) => return sound_package_error_response(error),
    };
    let (sender, receiver) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let result = install_sound_package_from_url(url, sender.clone()).await;
        let event = match result {
            Ok(response) => SoundPackageInstallEvent::done(response),
            Err(error) => SoundPackageInstallEvent::error(error.to_string()),
        };
        let _ = sender.send(event);
    });
    sound_package_stream_response(receiver)
}

async fn sound_catalog() -> SoundCatalog {
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
    SoundCatalog {
        root_path: root.to_string_lossy().to_string(),
        exists,
        files,
    }
}

async fn install_sound_package_from_url(
    url: Url,
    progress: mpsc::UnboundedSender<SoundPackageInstallEvent>,
) -> Result<InstallSoundPackageResponse, SoundPackageError> {
    let (package_path, downloaded_bytes, total_bytes) =
        download_sound_package(&url, &progress).await?;
    let root = sounds_dir();
    let extraction_result = tokio::task::spawn_blocking({
        let package_path = package_path.clone();
        let progress = progress.clone();
        move || extract_sound_package(&package_path, &root, &progress)
    })
    .await
    .map_err(|err| SoundPackageError::Io(std::io::Error::other(err)))?;
    let _ = tokio::fs::remove_file(&package_path).await;
    let extraction = extraction_result?;
    let catalog = sound_catalog().await;
    let _ = progress.send(SoundPackageInstallEvent::progress(
        "complete",
        downloaded_bytes,
        total_bytes,
        extraction.extracted_bytes,
        extraction.extracted_files,
        Some(extraction.extracted_files),
        extraction.skipped_files,
    ));
    Ok(InstallSoundPackageResponse {
        downloaded_bytes,
        extracted_bytes: extraction.extracted_bytes,
        extracted_files: extraction.extracted_files,
        skipped_files: extraction.skipped_files,
        catalog,
    })
}

fn sound_package_stream_response(
    receiver: mpsc::UnboundedReceiver<SoundPackageInstallEvent>,
) -> Response {
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|event| {
            let bytes = sound_package_event_line(&event);
            (Ok::<Bytes, Infallible>(bytes), receiver)
        })
    });
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn sound_package_error_response(error: SoundPackageError) -> Response {
    let status = match error {
        SoundPackageError::BadRequest(_) | SoundPackageError::Zip(_) => StatusCode::BAD_REQUEST,
        SoundPackageError::Download(_) => StatusCode::BAD_GATEWAY,
        SoundPackageError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string()).into_response()
}

fn sound_package_event_line(event: &SoundPackageInstallEvent) -> Bytes {
    let mut line = serde_json::to_vec(event).unwrap_or_else(|_| {
        br#"{"status":"error","phase":"complete","message":"failed to encode sound package progress","downloadedBytes":0,"extractedBytes":0,"extractedFiles":0,"skippedFiles":0}"#.to_vec()
    });
    line.push(b'\n');
    Bytes::from(line)
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

async fn download_sound_package(
    url: &Url,
    progress: &mpsc::UnboundedSender<SoundPackageInstallEvent>,
) -> Result<(PathBuf, u64, Option<u64>), SoundPackageError> {
    let package_path =
        std::env::temp_dir().join(format!("lazycat-webshell-sounds-{}.zip", Uuid::new_v4()));
    let result = download_sound_package_to_path(url, &package_path, progress).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&package_path).await;
    }
    result.map(|(downloaded_bytes, total_bytes)| (package_path, downloaded_bytes, total_bytes))
}

async fn download_sound_package_to_path(
    url: &Url,
    package_path: &Path,
    progress: &mpsc::UnboundedSender<SoundPackageInstallEvent>,
) -> Result<(u64, Option<u64>), SoundPackageError> {
    let client = reqwest::Client::builder()
        .timeout(SOUND_PACKAGE_DOWNLOAD_TIMEOUT)
        .user_agent("lazycat-neko-webshell/sounds")
        .build()?;
    let response = client.get(url.clone()).send().await?.error_for_status()?;
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > MAX_SOUND_PACKAGE_BYTES) {
        return Err(SoundPackageError::BadRequest(
            "sound package is too large".to_owned(),
        ));
    }

    let _ = progress.send(SoundPackageInstallEvent::progress(
        "download",
        0,
        total_bytes,
        0,
        0,
        None,
        0,
    ));
    let mut file = tokio::fs::File::create(package_path).await?;
    let mut downloaded_bytes = 0_u64;
    let mut reported_bytes = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        downloaded_bytes = downloaded_bytes
            .checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
            .ok_or_else(|| {
                SoundPackageError::BadRequest("sound package is too large".to_owned())
            })?;
        if downloaded_bytes > MAX_SOUND_PACKAGE_BYTES {
            return Err(SoundPackageError::BadRequest(
                "sound package is too large".to_owned(),
            ));
        }
        file.write_all(&chunk).await?;
        if downloaded_bytes.saturating_sub(reported_bytes) >= SOUND_PACKAGE_PROGRESS_CHUNK_BYTES {
            reported_bytes = downloaded_bytes;
            let _ = progress.send(SoundPackageInstallEvent::progress(
                "download",
                downloaded_bytes,
                total_bytes,
                0,
                0,
                None,
                0,
            ));
        }
    }
    file.flush().await?;
    let _ = progress.send(SoundPackageInstallEvent::progress(
        "download",
        downloaded_bytes,
        total_bytes,
        0,
        0,
        None,
        0,
    ));
    Ok((downloaded_bytes, total_bytes))
}

fn extract_sound_package(
    package_path: &Path,
    root: &Path,
    progress: &mpsc::UnboundedSender<SoundPackageInstallEvent>,
) -> Result<SoundPackageExtraction, SoundPackageError> {
    std::fs::create_dir_all(root)?;
    let canonical_root = std::fs::canonicalize(root)?;
    let file = File::open(package_path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut entries = Vec::new();
    let mut extracted_bytes = 0_u64;
    let mut skipped_files = 0_usize;

    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        if file.is_dir() {
            continue;
        }
        let Some(relative_path) = sound_package_entry_path(file.name()) else {
            skipped_files += 1;
            continue;
        };
        if entries.len() >= MAX_SOUND_PACKAGE_FILES {
            return Err(SoundPackageError::BadRequest(
                "sound package contains too many audio files".to_owned(),
            ));
        }
        extracted_bytes = extracted_bytes.checked_add(file.size()).ok_or_else(|| {
            SoundPackageError::BadRequest("sound package expands too large".to_owned())
        })?;
        if extracted_bytes > MAX_SOUND_PACKAGE_EXTRACTED_BYTES {
            return Err(SoundPackageError::BadRequest(
                "sound package expands too large".to_owned(),
            ));
        }
        entries.push(SoundPackageEntry {
            index,
            relative_path,
            size_bytes: file.size(),
        });
    }

    if entries.is_empty() {
        return Err(SoundPackageError::BadRequest(
            "sound package contains no supported audio files".to_owned(),
        ));
    }

    let total_files = entries.len();
    let total_extracted_bytes = extracted_bytes;
    let mut written_bytes = 0_u64;
    let mut written_files = 0_usize;
    let _ = progress.send(SoundPackageInstallEvent::progress(
        "extract",
        0,
        None,
        0,
        0,
        Some(total_files),
        skipped_files,
    ));
    for entry in &entries {
        let mut file = archive.by_index(entry.index)?;
        let output_path = root.join(&entry.relative_path);
        let Some(parent) = output_path.parent() else {
            return Err(SoundPackageError::BadRequest(
                "invalid sound package path".to_owned(),
            ));
        };
        std::fs::create_dir_all(parent)?;
        let canonical_parent = std::fs::canonicalize(parent)?;
        if !canonical_parent.starts_with(&canonical_root) {
            return Err(SoundPackageError::BadRequest(
                "invalid sound package path".to_owned(),
            ));
        }
        let mut output = File::create(output_path)?;
        let copied = std::io::copy(&mut file, &mut output)?;
        written_bytes = written_bytes.saturating_add(copied.min(entry.size_bytes));
        written_files += 1;
        let _ = progress.send(SoundPackageInstallEvent::progress(
            "extract",
            0,
            None,
            written_bytes,
            written_files,
            Some(total_files),
            skipped_files,
        ));
    }

    Ok(SoundPackageExtraction {
        extracted_bytes: total_extracted_bytes,
        extracted_files: entries.len(),
        skipped_files,
    })
}

fn validate_sound_package_url(value: &str) -> Result<Url, SoundPackageError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 2_048 {
        return Err(SoundPackageError::BadRequest(
            "invalid sound package url".to_owned(),
        ));
    }
    let url = Url::parse(trimmed)
        .map_err(|_| SoundPackageError::BadRequest("invalid sound package url".to_owned()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(SoundPackageError::BadRequest(
            "sound package url must be an http or https url without credentials".to_owned(),
        ));
    }
    Ok(url)
}

fn sound_package_entry_path(entry_name: &str) -> Option<String> {
    let normalized_name = entry_name.replace('\\', "/");
    let normalized = normalize_relative_path(Path::new(&normalized_name))?;
    let mut parts = normalized.split('/').collect::<Vec<_>>();
    if parts.first().is_some_and(|part| *part == "sounds") {
        parts.remove(0);
    }
    if parts.is_empty() {
        return None;
    }
    let relative_path = parts.join("/");
    supported_audio_file(Path::new(&relative_path)).then_some(relative_path)
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

#[derive(Debug, thiserror::Error)]
enum SoundPackageError {
    #[error("{0}")]
    BadRequest(String),
    #[error("failed to download sound package: {0}")]
    Download(#[from] reqwest::Error),
    #[error("failed to extract sound package: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid sound package zip: {0}")]
    Zip(#[from] zip::result::ZipError),
}

#[derive(Debug)]
struct SoundPackageEntry {
    index: usize,
    relative_path: String,
    size_bytes: u64,
}

#[derive(Debug)]
struct SoundPackageExtraction {
    extracted_bytes: u64,
    extracted_files: usize,
    skipped_files: usize,
}

impl SoundPackageInstallEvent {
    fn progress(
        phase: &'static str,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        extracted_bytes: u64,
        extracted_files: usize,
        total_files: Option<usize>,
        skipped_files: usize,
    ) -> Self {
        Self {
            status: "progress",
            phase,
            message: None,
            downloaded_bytes,
            total_bytes,
            extracted_bytes,
            extracted_files,
            total_files,
            skipped_files,
            catalog: None,
        }
    }

    fn done(response: InstallSoundPackageResponse) -> Self {
        Self {
            status: "done",
            phase: "complete",
            message: None,
            downloaded_bytes: response.downloaded_bytes,
            total_bytes: Some(response.downloaded_bytes),
            extracted_bytes: response.extracted_bytes,
            extracted_files: response.extracted_files,
            total_files: Some(response.extracted_files),
            skipped_files: response.skipped_files,
            catalog: Some(response.catalog),
        }
    }

    fn error(message: String) -> Self {
        Self {
            status: "error",
            phase: "complete",
            message: Some(message),
            downloaded_bytes: 0,
            total_bytes: None,
            extracted_bytes: 0,
            extracted_files: 0,
            total_files: None,
            skipped_files: 0,
            catalog: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        encode_sound_url_path, normalize_relative_path, sound_label, sound_package_entry_path,
        supported_audio_file, validate_request_path, validate_sound_package_url,
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

    #[test]
    fn normalizes_sound_package_entries() {
        assert_eq!(
            sound_package_entry_path("sounds/rain/light-rain.mp3").as_deref(),
            Some("rain/light-rain.mp3")
        );
        assert_eq!(
            sound_package_entry_path("noise/white-noise.wav").as_deref(),
            Some("noise/white-noise.wav")
        );
        assert_eq!(
            sound_package_entry_path("sounds\\custom\\focus.ogg").as_deref(),
            Some("custom/focus.ogg")
        );
        assert!(sound_package_entry_path("sounds/../secret.mp3").is_none());
        assert!(sound_package_entry_path("sounds/.hidden/focus.mp3").is_none());
        assert!(sound_package_entry_path("sounds/readme.md").is_none());
    }

    #[test]
    fn validates_sound_package_urls() {
        assert!(validate_sound_package_url("https://example.com/sounds.zip").is_ok());
        assert!(validate_sound_package_url("http://example.com/sounds.zip").is_ok());
        assert!(validate_sound_package_url("file:///tmp/sounds.zip").is_err());
        assert!(validate_sound_package_url("https://user@example.com/sounds.zip").is_err());
        assert!(validate_sound_package_url("").is_err());
    }
}
