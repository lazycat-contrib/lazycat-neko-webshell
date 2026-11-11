//! Local streaming handles. Downloads replace the selected destination only at commit.
use super::*;
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
use tempfile::NamedTempFile;

const CHUNK: usize = 65536;
const MAX_SIZE: u64 = 4 * 1024 * 1024 * 1024;
const MAX_HANDLES: usize = 32;
enum Handle {
    Upload(File),
    Download {
        temporary: NamedTempFile,
        destination: PathBuf,
        written: u64,
    },
}
static FILES: OnceLock<Mutex<HashMap<String, Handle>>> = OnceLock::new();
fn handles() -> Result<std::sync::MutexGuard<'static, HashMap<String, Handle>>> {
    FILES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| anyhow::anyhow!("File handle lock poisoned"))
}
fn insert(handle: Handle, name: &str, size: u64) -> Result<Value> {
    let mut files = handles()?;
    ensure!(files.len() < MAX_HANDLES, "Too many open local files");
    let id = uuid::Uuid::new_v4().to_string();
    files.insert(id.clone(), handle);
    Ok(json!({"handle":id, "name":name, "size":size}))
}
pub(super) fn open_upload(path: &Path) -> Result<Value> {
    let file = File::open(path).context("Cannot open selected upload")?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "Selected upload is not a regular file");
    ensure!(metadata.len() <= MAX_SIZE, "Selected upload exceeds 4 GiB");
    insert(
        Handle::Upload(file),
        path.file_name()
            .and_then(|n| n.to_str())
            .context("Upload filename is not UTF-8")?,
        metadata.len(),
    )
}
pub(super) fn open_download(path: &Path) -> Result<Value> {
    ensure!(!path.is_dir(), "Download destination is a directory");
    let temporary = NamedTempFile::new_in(path.parent().context("Missing destination directory")?)?;
    insert(
        Handle::Download {
            temporary,
            destination: path.to_owned(),
            written: 0,
        },
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download"),
        0,
    )
}
pub(super) fn request(value: &Value) -> Result<Value> {
    let op = value["op"].as_str().context("Missing file operation")?;
    ensure!(
        ["read", "seek", "write", "close", "cancel", "commit"].contains(&op),
        "Unsupported desktop platform operation"
    );
    let id = value["handle"].as_str().context("Missing local handle")?;
    let mut files = handles()?;
    let handle = files
        .get_mut(id)
        .context("Local handle is closed or invalid")?;
    match (op, handle) {
        ("read", Handle::Upload(file)) => {
            let size = value["size"].as_u64().unwrap_or(CHUNK as u64);
            ensure!(size > 0 && size <= CHUNK as u64, "Invalid chunk size");
            let mut bytes = vec![0; size as usize];
            let count = file.read(&mut bytes)?;
            bytes.truncate(count);
            Ok(json!({"data":neko_remoted_protocol::encode(&bytes), "eof":count == 0}))
        }
        ("seek", Handle::Upload(file)) => {
            let offset = value["offset"].as_u64().context("Missing seek offset")?;
            ensure!(offset <= file.metadata()?.len(), "Seek outside upload");
            file.seek(SeekFrom::Start(offset))?;
            Ok(Value::Null)
        }
        (
            "write",
            Handle::Download {
                temporary, written, ..
            },
        ) => {
            let bytes = neko_remoted_protocol::decode(
                value["data"].as_str().context("Missing chunk")?,
                CHUNK,
            )?;
            ensure!(
                *written + bytes.len() as u64 <= MAX_SIZE,
                "Download exceeds 4 GiB"
            );
            temporary.write_all(&bytes)?;
            *written += bytes.len() as u64;
            Ok(json!(bytes.len()))
        }
        ("close", Handle::Upload(_)) | ("cancel", Handle::Download { .. }) => {
            let removed = files.remove(id).context("Local handle disappeared")?;
            if let Handle::Download { temporary, .. } = removed {
                temporary
                    .close()
                    .context("Cannot remove cancelled download")?;
            }
            Ok(Value::Null)
        }
        ("commit", Handle::Download { temporary, .. }) => {
            temporary.as_file_mut().sync_all()?;
            let Some(Handle::Download {
                temporary,
                destination,
                ..
            }) = files.remove(id)
            else {
                unreachable!("download handle checked under lock")
            };
            temporary
                .persist(destination)
                .map_err(|error| anyhow::anyhow!("Cannot commit download: {}", error.error))?;
            Ok(Value::Null)
        }
        _ => bail!("Operation does not match the local file handle"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_cancel_preserves_destination_and_commit_replaces_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("target.bin");
        fs::write(&path, b"old").unwrap();
        for commit in [false, true] {
            let handle = open_download(&path).unwrap()["handle"]
                .as_str()
                .unwrap()
                .to_owned();
            request(&json!({"op":"write", "handle":handle, "data":neko_remoted_protocol::encode(b"new")})).unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"old");
            request(&json!({"op":if commit {"commit"} else {"cancel"}, "handle":handle})).unwrap();
            assert!(request(&json!({"op":"read", "handle":handle})).is_err());
        }
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[test]
    fn upload_streams_seeks_and_rejects_wrong_direction_or_oversized_chunks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("upload.bin");
        fs::write(&path, vec![42; CHUNK + 3]).unwrap();
        let handle = open_upload(&path).unwrap()["handle"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(request(&json!({"op":"read", "handle":handle, "size":CHUNK+1})).is_err());
        assert!(request(&json!({"op":"write", "handle":handle, "data":""})).is_err());
        let read = || request(&json!({"op":"read", "handle":handle})).unwrap();
        assert_eq!(
            neko_remoted_protocol::decode(read()["data"].as_str().unwrap(), CHUNK)
                .unwrap()
                .len(),
            CHUNK
        );
        assert_eq!(
            neko_remoted_protocol::decode(read()["data"].as_str().unwrap(), CHUNK)
                .unwrap()
                .len(),
            3
        );
        assert_eq!(read()["eof"], true);
        request(&json!({"op":"seek", "handle":handle, "offset":0})).unwrap();
        assert_eq!(read()["eof"], false);
        request(&json!({"op":"close", "handle":handle})).unwrap();
        assert!(request(&json!({"op":"read", "handle":handle})).is_err());
        assert!(open_upload(directory.path()).is_err());
    }
}
