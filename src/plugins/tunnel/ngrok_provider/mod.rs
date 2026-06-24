use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use anyhow::{Context as _, anyhow};
use ngrok::prelude::*;
use tokio::runtime::Builder as RuntimeBuilder;
use url::Url;

use crate::plugins::tunnel::{StartTunnelRequest, TunnelSessionInfo, mark_status, now_ms};

pub fn spawn(
    request: StartTunnelRequest,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::Sender<Result<TunnelSessionInfo, String>>,
    status: Arc<Mutex<String>>,
) {
    std::thread::spawn(move || {
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build ngrok tunnel runtime");
        let result = runtime.block_on(run(request, stop_rx, ready_tx, Arc::clone(&status)));
        if result.is_err() {
            mark_status(&status, "error");
        }
    });
}

async fn run(
    request: StartTunnelRequest,
    stop_rx: mpsc::Receiver<()>,
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
    let session = builder.connect().await?;
    let mut forwarder = session.http_endpoint().listen_and_forward(upstream).await?;
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
        if stop_rx.try_recv().is_ok() {
            mark_status(&status, "stopping");
            let _ = forwarder.close().await;
            mark_status(&status, "stopped");
            return Ok(());
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
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
