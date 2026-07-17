use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::LIGHTOSCTL;
use crate::state::SessionRecord;

pub const PLUGIN_ID: &str = "lightos-port-forward";

const FORWARD_READY_TIMEOUT: Duration = Duration::from_secs(5);
const FORWARD_READY_POLL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct LightOsPortForwardManager {
    forwards: Mutex<HashMap<String, ForwardHandle>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: String,
    pub selector: String,
    pub local_host: String,
    pub local_port: u16,
    pub local_url: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub status: String,
    pub created_at_ms: u64,
}

struct ForwardHandle {
    info: ForwardInfo,
    child: Child,
}

impl LightOsPortForwardManager {
    pub fn invoke(
        &self,
        session: &SessionRecord,
        operation: &str,
        metadata: &HashMap<String, String>,
    ) -> anyhow::Result<serde_json::Value> {
        match operation.trim() {
            "" | "default" | "status" | "list" => self.list(),
            "acquire" | "start" => self.acquire(session, metadata),
            "release" | "stop" => self.release(metadata),
            operation => bail!("unsupported LightOS port forward operation: {operation}"),
        }
    }

    fn acquire(
        &self,
        session: &SessionRecord,
        metadata: &HashMap<String, String>,
    ) -> anyhow::Result<serde_json::Value> {
        let remote_host = metadata
            .get("remoteHost")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("127.0.0.1");
        validate_host(remote_host, "remoteHost")?;
        let remote_port = required_port(metadata, "remotePort")?;
        let local_port = reserve_local_port()?;
        let local_host = "127.0.0.1";
        let spec = format!("{local_host}:{local_port}:{remote_host}:{remote_port}");
        let mut child = Command::new(LIGHTOSCTL)
            .args(["forward", "-L", spec.as_str(), session.selector.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("failed to start {LIGHTOSCTL} forward"))?;

        if let Err(error) = wait_forward_ready(&mut child, local_port) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        let info = ForwardInfo {
            id: Uuid::new_v4().to_string(),
            selector: session.selector.clone(),
            local_host: local_host.to_owned(),
            local_port,
            local_url: format!("http://{local_host}:{local_port}/"),
            remote_host: remote_host.to_owned(),
            remote_port,
            status: "running".to_owned(),
            created_at_ms: crate::plugins::tunnel::now_ms(),
        };
        self.forwards
            .lock()
            .map_err(|_| anyhow!("LightOS forward store lock poisoned"))?
            .insert(
                info.id.clone(),
                ForwardHandle {
                    info: info.clone(),
                    child,
                },
            );
        Ok(serde_json::json!({
            "forward": info,
            "forwards": self.forward_snapshots()?,
        }))
    }

    fn list(&self) -> anyhow::Result<serde_json::Value> {
        Ok(serde_json::json!({
            "forwards": self.forward_snapshots()?,
        }))
    }

    fn release(&self, metadata: &HashMap<String, String>) -> anyhow::Result<serde_json::Value> {
        let forward_id = required_metadata(metadata, "forwardId")?;
        let mut handle = self
            .forwards
            .lock()
            .map_err(|_| anyhow!("LightOS forward store lock poisoned"))?
            .remove(forward_id)
            .ok_or_else(|| anyhow!("LightOS forward not found: {forward_id}"))?;
        let _ = handle.child.kill();
        let _ = handle.child.wait();
        "stopped".clone_into(&mut handle.info.status);
        Ok(serde_json::json!({
            "forward": handle.info,
            "forwards": self.forward_snapshots()?,
        }))
    }

    fn forward_snapshots(&self) -> anyhow::Result<Vec<ForwardInfo>> {
        let mut forwards = self
            .forwards
            .lock()
            .map_err(|_| anyhow!("LightOS forward store lock poisoned"))?;
        let mut snapshots = Vec::with_capacity(forwards.len());
        let mut exited = Vec::new();
        for (id, handle) in forwards.iter_mut() {
            let mut info = handle.info.clone();
            if let Ok(Some(status)) = handle.child.try_wait() {
                info.status = format!("exited:{status}");
                exited.push(id.clone());
            } else if !local_port_listening(handle.info.local_port) {
                "unreachable".clone_into(&mut info.status);
            }
            snapshots.push(info);
        }
        for id in exited {
            forwards.remove(&id);
        }
        snapshots.sort_by_key(|item| item.created_at_ms);
        Ok(snapshots)
    }
}

fn reserve_local_port() -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").context("failed to reserve local TCP port")?;
    let port = listener
        .local_addr()
        .context("failed to inspect reserved local TCP port")?
        .port();
    drop(listener);
    Ok(port)
}

fn wait_forward_ready(child: &mut Child, port: u16) -> anyhow::Result<()> {
    let deadline = Instant::now() + FORWARD_READY_TIMEOUT;
    loop {
        if local_port_listening(port) {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .context("failed to poll lightosctl forward")?
        {
            bail!("lightosctl forward exited before listening on 127.0.0.1:{port}: {status}");
        }
        if Instant::now() >= deadline {
            bail!("lightosctl forward did not listen on 127.0.0.1:{port}");
        }
        std::thread::sleep(FORWARD_READY_POLL);
    }
}

fn local_port_listening(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(80)).is_ok()
}

fn required_metadata<'a>(
    metadata: &'a HashMap<String, String>,
    key: &str,
) -> anyhow::Result<&'a str> {
    metadata
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("metadata.{key} is required"))
}

fn required_port(metadata: &HashMap<String, String>, key: &str) -> anyhow::Result<u16> {
    let port = required_metadata(metadata, key)?
        .parse::<u16>()
        .with_context(|| format!("metadata.{key} must be a number from 1 to 65535"))?;
    if port == 0 {
        bail!("metadata.{key} must be a number from 1 to 65535");
    }
    Ok(port)
}

fn validate_host(host: &str, field: &str) -> anyhow::Result<()> {
    if host.contains('/') || host.contains('\\') || host.contains('@') || host.contains(':') {
        bail!("metadata.{field} must be a hostname or IP address without a scheme or port");
    }
    Ok(())
}
