use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, anyhow, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod cloudflare_quick;
pub mod ngrok_provider;

pub const PLUGIN_ID: &str = "public-tunnel";

const DEFAULT_PROVIDER: &str = "cloudflare-quick";
const START_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Default)]
pub struct TunnelManager {
    sessions: Mutex<HashMap<String, TunnelHandle>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSessionInfo {
    pub id: String,
    pub provider: String,
    pub public_url: String,
    pub upstream_url: String,
    pub status: String,
    pub created_at_ms: u64,
}

#[derive(Debug)]
pub struct StartTunnelRequest {
    pub id: String,
    pub provider: String,
    pub upstream_url: String,
    pub ngrok_authtoken: Option<String>,
}

pub struct TunnelPluginResponse {
    pub status: String,
    pub content_type: String,
    pub payload: Vec<u8>,
    pub metadata: HashMap<String, String>,
}

struct TunnelHandle {
    info: TunnelSessionInfo,
    status: Arc<Mutex<String>>,
    stop_tx: mpsc::Sender<()>,
}

impl TunnelManager {
    pub fn invoke_metadata(
        &self,
        operation: &str,
        metadata: &HashMap<String, String>,
    ) -> anyhow::Result<TunnelPluginResponse> {
        match operation.trim() {
            "" | "list" | "status" | "default" => self.list(),
            "start" => self.start(metadata),
            "stop" => self.stop(metadata),
            operation => bail!("unsupported public tunnel operation: {operation}"),
        }
    }

    fn start(&self, metadata: &HashMap<String, String>) -> anyhow::Result<TunnelPluginResponse> {
        let start = parse_start_request(metadata)?;
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let status = Arc::new(Mutex::new("starting".to_owned()));

        match start.provider.as_str() {
            "cloudflare-quick" => {
                cloudflare_quick::spawn(start, stop_rx, ready_tx, Arc::clone(&status));
            }
            "ngrok" => ngrok_provider::spawn(start, stop_rx, ready_tx, Arc::clone(&status)),
            provider => bail!("unsupported tunnel provider: {provider}"),
        }

        let info = ready_rx
            .recv_timeout(START_TIMEOUT)
            .map_err(|_| anyhow!("tunnel provider did not become ready"))?
            .map_err(anyhow::Error::msg)?;
        let handle = TunnelHandle {
            info: info.clone(),
            status,
            stop_tx,
        };
        self.sessions
            .lock()
            .map_err(|_| anyhow!("tunnel session store lock poisoned"))?
            .insert(info.id.clone(), handle);
        json_response(
            "complete",
            &serde_json::json!({
                "session": info,
                "providers": provider_descriptors(),
            }),
        )
    }

    fn list(&self) -> anyhow::Result<TunnelPluginResponse> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("tunnel session store lock poisoned"))?
            .values()
            .map(TunnelHandle::snapshot)
            .collect::<Vec<_>>();
        json_response(
            "complete",
            &serde_json::json!({
                "sessions": sessions,
                "providers": provider_descriptors(),
            }),
        )
    }

    fn stop(&self, metadata: &HashMap<String, String>) -> anyhow::Result<TunnelPluginResponse> {
        let tunnel_id = required_metadata(metadata, "tunnelId")?;
        let handle = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("tunnel session store lock poisoned"))?
            .remove(tunnel_id)
            .ok_or_else(|| anyhow!("tunnel session not found: {tunnel_id}"))?;
        let mut info = handle.snapshot();
        let _ = handle.stop_tx.send(());
        "stopping".clone_into(&mut info.status);
        json_response(
            "complete",
            &serde_json::json!({
                "session": info,
                "providers": provider_descriptors(),
            }),
        )
    }
}

impl TunnelHandle {
    fn snapshot(&self) -> TunnelSessionInfo {
        let mut info = self.info.clone();
        info.status = self
            .status
            .lock()
            .map_or_else(|_| "unknown".to_owned(), |status| status.clone());
        info
    }
}

pub(crate) fn mark_status(status: &Arc<Mutex<String>>, value: &str) {
    if let Ok(mut status) = status.lock() {
        value.clone_into(&mut status);
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().try_into().unwrap_or(u64::MAX)
        })
}

fn parse_start_request(metadata: &HashMap<String, String>) -> anyhow::Result<StartTunnelRequest> {
    let provider = metadata
        .get("provider")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_PROVIDER)
        .to_owned();
    let upstream_url = if let Some(upstream_url) = metadata
        .get("upstreamUrl")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_upstream_url(upstream_url)?;
        upstream_url.to_owned()
    } else {
        let host = metadata
            .get("host")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("127.0.0.1");
        validate_host(host)?;
        let port = metadata
            .get("port")
            .map(String::as_str)
            .map(str::trim)
            .ok_or_else(|| anyhow!("metadata.port is required"))?
            .parse::<u16>()
            .context("metadata.port must be a number from 1 to 65535")?;
        if port == 0 {
            bail!("metadata.port must be a number from 1 to 65535");
        }
        let path = metadata
            .get("path")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("/");
        build_http_url(host, port, path)?
    };
    let ngrok_authtoken = metadata
        .get("ngrokAuthtoken")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Ok(StartTunnelRequest {
        id: Uuid::new_v4().to_string(),
        provider,
        upstream_url,
        ngrok_authtoken,
    })
}

fn validate_host(host: &str) -> anyhow::Result<()> {
    if host.contains('/') || host.contains('\\') || host.contains('@') {
        bail!("metadata.host must be an IP address or hostname without a scheme");
    }
    if !is_local_host(host) {
        bail!("metadata.host must be localhost or 127.0.0.1 by default");
    }
    Ok(())
}

fn validate_upstream_url(value: &str) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(value).map_err(|err| anyhow!("invalid upstream URL: {err}"))?;
    if url.scheme() != "http" {
        bail!("metadata.upstreamUrl must use http");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("metadata.upstreamUrl must include a host"))?;
    if !is_local_host(host) {
        bail!("metadata.upstreamUrl must point to localhost or 127.0.0.1");
    }
    if url.port_or_known_default().is_none() {
        bail!("metadata.upstreamUrl must include a port");
    }
    Ok(())
}

fn is_local_host(host: &str) -> bool {
    matches!(
        host.trim_matches(['[', ']']),
        "127.0.0.1" | "localhost" | "::1"
    )
}

fn build_http_url(host: &str, port: u16, path: &str) -> anyhow::Result<String> {
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let path = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    };
    let value = format!("http://{host}:{port}{path}");
    reqwest::Url::parse(&value).map_err(|err| anyhow!("invalid upstream URL: {err}"))?;
    Ok(value)
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

fn json_response(
    status: &str,
    payload: &serde_json::Value,
) -> anyhow::Result<TunnelPluginResponse> {
    Ok(TunnelPluginResponse {
        status: status.to_owned(),
        content_type: "application/json".to_owned(),
        payload: serde_json::to_vec(payload)?,
        metadata: HashMap::new(),
    })
}

fn provider_descriptors() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "id": "cloudflare-quick",
            "label": "Cloudflare Quick Tunnel",
            "requiresToken": false,
            "experimental": true,
        }),
        serde_json::json!({
            "id": "ngrok",
            "label": "ngrok",
            "requiresToken": true,
            "experimental": false,
        }),
    ]
}
