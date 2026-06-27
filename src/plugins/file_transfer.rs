use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use connectrpc::ConnectError;
use serde_json::{Value, json};
use uuid::Uuid;

pub const MAX_FILE_TRANSFER_BYTES: usize = 64 * 1024 * 1024;

const UPLOAD_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub struct FileTransferUploadManager {
    uploads: Mutex<HashMap<String, UploadState>>,
}

pub struct FinishedUpload {
    pub path: String,
    pub data: Vec<u8>,
}

struct UploadState {
    session_id: String,
    path: String,
    name: String,
    size: usize,
    received: usize,
    data: Vec<u8>,
    created_at: Instant,
}

impl FileTransferUploadManager {
    pub fn begin(
        &self,
        session_id: &str,
        path: &str,
        name: &str,
        size: usize,
    ) -> Result<Value, ConnectError> {
        if size > MAX_FILE_TRANSFER_BYTES {
            return Err(ConnectError::invalid_argument(
                "file size is outside the supported transfer limit",
            ));
        }
        let mut uploads = self.lock_uploads()?;
        prune_stale_uploads(&mut uploads);
        let upload_id = Uuid::new_v4().to_string();
        let upload = UploadState {
            session_id: session_id.to_owned(),
            path: path.to_owned(),
            name: if name.trim().is_empty() {
                "upload".to_owned()
            } else {
                name.to_owned()
            },
            size,
            received: 0,
            data: Vec::with_capacity(size),
            created_at: Instant::now(),
        };
        let progress = upload_progress(&upload_id, &upload, false);
        uploads.insert(upload_id, upload);
        Ok(progress)
    }

    pub fn append(
        &self,
        session_id: &str,
        upload_id: &str,
        offset: usize,
        chunk: &[u8],
    ) -> Result<Value, ConnectError> {
        let mut uploads = self.lock_uploads()?;
        prune_stale_uploads(&mut uploads);
        let upload = upload_for_session(uploads.get_mut(upload_id), session_id)?;
        if offset != upload.received {
            return Err(ConnectError::invalid_argument(
                "upload chunk offset mismatch",
            ));
        }
        if upload.received + chunk.len() > upload.size
            || upload.received + chunk.len() > MAX_FILE_TRANSFER_BYTES
        {
            uploads.remove(upload_id);
            return Err(ConnectError::invalid_argument(
                "upload exceeds declared file size",
            ));
        }
        upload.data.extend_from_slice(chunk);
        upload.received += chunk.len();
        Ok(upload_progress(upload_id, upload, false))
    }

    pub fn finish(
        &self,
        session_id: &str,
        upload_id: &str,
    ) -> Result<FinishedUpload, ConnectError> {
        let mut uploads = self.lock_uploads()?;
        prune_stale_uploads(&mut uploads);
        let Some(upload) = uploads.remove(upload_id) else {
            return Err(ConnectError::not_found("upload is not initialized"));
        };
        if upload.session_id != session_id {
            return Err(ConnectError::permission_denied(
                "upload does not belong to this session",
            ));
        }
        if upload.received != upload.size {
            return Err(ConnectError::invalid_argument(
                "upload ended before declared size",
            ));
        }
        Ok(FinishedUpload {
            path: upload.path,
            data: upload.data,
        })
    }

    pub fn cancel(&self, session_id: &str, upload_id: &str) -> Result<Value, ConnectError> {
        let mut uploads = self.lock_uploads()?;
        prune_stale_uploads(&mut uploads);
        if let Some(upload) = uploads.get(upload_id) {
            if upload.session_id != session_id {
                return Err(ConnectError::permission_denied(
                    "upload does not belong to this session",
                ));
            }
        }
        uploads.remove(upload_id);
        Ok(json!({ "uploadId": upload_id, "cancelled": true }))
    }

    fn lock_uploads(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, UploadState>>, ConnectError> {
        self.uploads
            .lock()
            .map_err(|_| ConnectError::internal("file upload store lock poisoned"))
    }
}

fn upload_for_session<'a>(
    upload: Option<&'a mut UploadState>,
    session_id: &str,
) -> Result<&'a mut UploadState, ConnectError> {
    let upload = upload.ok_or_else(|| ConnectError::not_found("upload is not initialized"))?;
    if upload.session_id != session_id {
        return Err(ConnectError::permission_denied(
            "upload does not belong to this session",
        ));
    }
    Ok(upload)
}

fn prune_stale_uploads(uploads: &mut HashMap<String, UploadState>) {
    uploads.retain(|_, upload| upload.created_at.elapsed() <= UPLOAD_TTL);
}

fn upload_progress(upload_id: &str, upload: &UploadState, done: bool) -> Value {
    json!({
        "uploadId": upload_id,
        "name": upload.name,
        "path": upload.path,
        "received": upload.received,
        "size": upload.size,
        "percent": transfer_percent(upload.received, upload.size),
        "done": done,
    })
}

fn transfer_percent(received: usize, total: usize) -> u8 {
    if total == 0 {
        return 100;
    }
    u8::try_from(((received.saturating_mul(100)) / total).min(100)).unwrap_or(100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_upload_chunks_in_order() {
        let uploads = FileTransferUploadManager::default();
        let begin = uploads
            .begin("session-1", "/tmp/demo.txt", "demo.txt", 5)
            .unwrap();
        let upload_id = begin["uploadId"].as_str().expect("upload id");

        let progress = uploads
            .append("session-1", upload_id, 0, b"he")
            .expect("first chunk");
        assert_eq!(progress["percent"], 40);
        let progress = uploads
            .append("session-1", upload_id, 2, b"llo")
            .expect("second chunk");
        assert_eq!(progress["percent"], 100);

        let finished = uploads
            .finish("session-1", upload_id)
            .expect("finished upload");
        assert_eq!(finished.path, "/tmp/demo.txt");
        assert_eq!(finished.data, b"hello");
    }

    #[test]
    fn rejects_out_of_order_chunks() {
        let uploads = FileTransferUploadManager::default();
        let begin = uploads
            .begin("session-1", "/tmp/demo.txt", "demo.txt", 5)
            .unwrap();
        let upload_id = begin["uploadId"].as_str().expect("upload id");

        let error = uploads
            .append("session-1", upload_id, 1, b"x")
            .expect_err("offset mismatch");
        assert!(error.to_string().contains("upload chunk offset mismatch"));
    }
}
