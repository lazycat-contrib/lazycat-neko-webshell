use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use anyhow::{Context as _, anyhow};
use ngrok::prelude::*;
use tokio::runtime::Builder as RuntimeBuilder;
use url::Url;

use crate::plugins::tunnel::{StartTunnelRequest, TunnelSessionInfo, mark_status, now_ms};

pub fn spawn(
    request: StartTunnelRequest,
    stop_rx: tokio::sync::watch::Receiver<bool>,
    ready_tx: mpsc::Sender<Result<TunnelSessionInfo, String>>,
    status: Arc<Mutex<String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build ngrok tunnel runtime");
        let result = runtime.block_on(run(request, stop_rx, ready_tx, Arc::clone(&status)));
        if result.is_err() {
            mark_status(&status, "error");
        }
    })
}

async fn run(
    request: StartTunnelRequest,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
    ready_tx: mpsc::Sender<Result<TunnelSessionInfo, String>>,
    status: Arc<Mutex<String>>,
) -> anyhow::Result<()> {
    let authtoken = request
        .ngrok_authtoken
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("ngrok authtoken is required"))?;
    let upstream = Url::parse(&request.upstream_url).context("invalid ngrok upstream URL")?;
    let mut builder = ngrok::Session::builder();
    builder.authtoken(authtoken);
    let session = tokio::select! {
        _ = stop_rx.changed() => { mark_status(&status, "stopped"); return Ok(()); },
        session = builder.connect() => session?,
    };
    let endpoint = session.http_endpoint();
    let mut forwarder = tokio::select! {
        _ = stop_rx.changed() => { mark_status(&status, "stopped"); return Ok(()); },
        forwarder = endpoint.listen_and_forward(upstream) => forwarder?,
    };
    let info = TunnelSessionInfo {
        id: request.id,
        provider: "ngrok".to_owned(),
        public_url: forwarder.url().to_owned(),
        upstream_url: request.upstream_url,
        status: "running".to_owned(),
        created_at_ms: now_ms(),
    };
    ready_tx
        .send(Ok(info))
        .map_err(|_| anyhow!("tunnel manager dropped readiness receiver"))?;
    mark_status(&status, "running");

    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                mark_status(&status, "stopping");
                let _ = tokio::time::timeout(Duration::from_secs(3), forwarder.close()).await;
                mark_status(&status, "stopped");
                return Ok(());
            },
            _ = tokio::time::sleep(Duration::from_millis(250)) => {},
        }
        if forwarder.join().is_finished() {
            mark_status(&status, "stopped");
            let result = forwarder
                .join()
                .await
                .map_err(|err| anyhow!("ngrok forward task failed: {err}"))?;
            result.map_err(|err| anyhow!("ngrok forward task failed: {err}"))?;
            return Ok(());
        }
    }
}
