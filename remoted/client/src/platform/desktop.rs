//! Desktop credentials and a UI-thread bridge to NSH native dialogs.
mod credentials;
mod files;

use super::*;
use std::{
    fs::{self, File, OpenOptions},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

const SERVICE: &str = "community.lazycat.neko.remoted";
type DialogReply = oneshot::Sender<Result<Option<PathBuf>>>;
struct DialogRequest {
    name: Option<String>,
    reply: DialogReply,
}
static DIALOGS: OnceLock<mpsc::Sender<DialogRequest>> = OnceLock::new();
static CREDENTIALS: Mutex<()> = Mutex::new(());

pub fn data_dir() -> Result<PathBuf> {
    Ok(
        directories::ProjectDirs::from("community", "lazycat", "neko-remoted")
            .context("Cannot locate this user's application data directory")?
            .data_local_dir()
            .to_owned(),
    )
}

/// Holds a per-user process lock for the lifetime of the desktop application.
///
/// # Errors
/// Returns an error when the directory is inaccessible or another instance runs.
pub fn initialize() -> Result<File> {
    use fs2::FileExt;
    let directory = data_dir()?;
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("instance.lock"))?;
    lock.try_lock_exclusive()
        .context("Remoted is already running for this user")?;
    Ok(lock)
}

/// Starts NSH dialog handling in the root UI owner; workers never call UI APIs.
pub fn start_services() {
    use nsh_core::{
        element::{pick_paths, pick_save_path, spawn},
        file_dialog::{OpenDialog, SaveDialog},
    };
    let (sender, mut receiver) = mpsc::channel::<DialogRequest>(8);
    // A single desktop window owns the services for this process.
    if DIALOGS.set(sender).is_err() {
        return;
    }
    spawn(async move {
        while let Some(request) = receiver.recv().await {
            if request.reply.is_closed() {
                continue;
            }
            let result = match request.name {
                Some(name) => pick_save_path(SaveDialog::new().file_name(name)).await,
                None => pick_paths(OpenDialog::files())
                    .await
                    .map(|paths| paths.and_then(|p| p.into_iter().next())),
            }
            .map_err(anyhow::Error::msg);
            let _ = request.reply.send(result);
        }
    });
}

pub fn drain_events() -> Vec<Value> {
    Vec::new()
}

async fn dialog(name: Option<String>) -> Result<Option<PathBuf>> {
    let (reply, receiver) = oneshot::channel();
    DIALOGS
        .get()
        .context("Desktop UI is not ready")?
        .try_send(DialogRequest { name, reply })
        .map_err(|_| anyhow::anyhow!("Desktop dialog queue is unavailable"))?;
    tokio::time::timeout(Duration::from_secs(300), receiver)
        .await
        .context("File dialog timed out")?
        .context("Desktop window closed")?
}

pub async fn request(value: Value) -> Result<Value> {
    match value["op"].as_str().context("Missing platform operation")? {
        "scan" => bail!("此桌面客户端不使用摄像头，请粘贴或手动输入设备码"),
        "secureGet" | "secureSet" => {
            tokio::task::spawn_blocking(move || credentials::request(&value)).await?
        }
        "pickUpload" => {
            let Some(path) = dialog(None).await? else {
                return Ok(Value::Null);
            };
            tokio::task::spawn_blocking(move || files::open_upload(&path)).await?
        }
        "pickDownload" => {
            let name = value["name"].as_str().context("Missing download name")?;
            let safe_name = name
                .rsplit(['/', '\\'])
                .next()
                .filter(|s| !s.is_empty() && *s != "." && *s != "..")
                .unwrap_or("download")
                .to_owned();
            let Some(path) = dialog(Some(safe_name)).await? else {
                return Ok(Value::Null);
            };
            tokio::task::spawn_blocking(move || files::open_download(&path)).await?
        }
        _ => tokio::task::spawn_blocking(move || files::request(&value)).await?,
    }
}
