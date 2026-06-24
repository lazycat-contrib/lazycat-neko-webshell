use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, mpsc};

use anyhow::anyhow;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as STANDARD_BASE64;
use capnp::message::{ReaderOptions, TypedBuilder};
use capnp_futures::serialize::{read_message, write_message};
use capnp_rpc::{RpcSystem, rpc_twoparty_capnp::Side, twoparty::VatNetwork};
use futures::AsyncReadExt as _;
use quinn::{
    ClientConfig as QuinnClientConfig, Connection as QuinnConnection, Endpoint as QuinnEndpoint,
    RecvStream as QuinnRecvStream, SendStream as QuinnSendStream,
};
use reqwest::Method;
use rustls::{ClientConfig as RustlsClientConfig, RootCertStore};
use serde::Deserialize;
use tokio::net::{ToSocketAddrs, lookup_host};
use tokio::runtime::Builder as RuntimeBuilder;
use tokio::task::{LocalSet, spawn_local};
use uuid::Uuid;

use crate::plugins::tunnel::{StartTunnelRequest, TunnelSessionInfo, mark_status, now_ms};

pub mod generated;

const SIGNATURE: [u8; 8] = [0x0A, 0x36, 0xCD, 0x12, 0xA1, 0x3E, b'0', b'1'];
const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;

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
            .expect("failed to build Cloudflare tunnel runtime");
        runtime.block_on(LocalSet::new().run_until(async move {
            let result = run(request, stop_rx, ready_tx, Arc::clone(&status)).await;
            if let Err(error) = result {
                mark_status(&status, "error");
                let _ = error;
            }
        }));
    });
}

async fn run(
    request: StartTunnelRequest,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::Sender<Result<TunnelSessionInfo, String>>,
    status: Arc<Mutex<String>>,
) -> anyhow::Result<()> {
    let config = TunnelConfig::try_cloudflare().await?;
    let public_url = format!("https://{}", config.hostname);
    let connection = Connection::new(config, 0).await?;
    let info = TunnelSessionInfo {
        id: request.id,
        provider: "cloudflare-quick".to_owned(),
        public_url,
        upstream_url: request.upstream_url,
        status: "running".to_owned(),
        created_at_ms: now_ms(),
    };
    ready_tx
        .send(Ok(info.clone()))
        .map_err(|_| anyhow!("tunnel manager dropped readiness receiver"))?;
    mark_status(&status, "running");

    loop {
        if stop_rx.try_recv().is_ok() {
            mark_status(&status, "stopped");
            return Ok(());
        }
        let accept =
            tokio::time::timeout(std::time::Duration::from_millis(250), connection.accept()).await;
        let connect_request = match accept {
            Ok(Ok(connect_request)) => connect_request,
            Ok(Err(error)) => {
                mark_status(&status, "error");
                return Err(error);
            }
            Err(_) => continue,
        };
        let upstream_url = info.upstream_url.clone();
        spawn_local(async move {
            let _ = handle_connect_request(connect_request, upstream_url).await;
        });
    }
}

async fn handle_connect_request(
    mut connect_request: ConnectRequest,
    upstream_base: String,
) -> anyhow::Result<()> {
    let method = connect_request
        .metadata
        .get("HttpMethod")
        .map(String::as_str)
        .unwrap_or("GET")
        .parse::<Method>()
        .unwrap_or(Method::GET);
    let upstream_url = build_upstream_url(&upstream_base, &connect_request.request_dest)?;
    let request_body =
        read_request_body(&mut connect_request.recv_stream, &connect_request.metadata).await?;
    let client = reqwest::Client::new();
    let mut builder = client.request(method, upstream_url).body(request_body);
    for (key, value) in forwarded_request_headers(&connect_request.metadata) {
        builder = builder.header(key, value);
    }
    let response = builder.send().await?;
    let status = response.status().as_u16().to_string();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (format!("HttpHeader:{key}"), value.to_owned()))
        })
        .collect::<Vec<_>>();
    let body = response.bytes().await?;

    let mut metadata = HashMap::new();
    metadata.insert("HttpStatus".to_owned(), status);
    for (key, value) in headers {
        metadata.insert(key, value);
    }
    let (mut send_stream, _) = connect_request
        .respond_with(ConnectResponse::Metadata(metadata))
        .await?;
    send_stream.write_all(&body).await?;
    Ok(())
}

async fn read_request_body(
    recv_stream: &mut QuinnRecvStream,
    metadata: &HashMap<String, String>,
) -> anyhow::Result<Vec<u8>> {
    let content_length = metadata
        .get("HttpHeader:Content-Length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length == 0 {
        return Ok(Vec::new());
    }
    if content_length > MAX_REQUEST_BODY_BYTES {
        return Err(anyhow!("request body too large for quick tunnel proxy"));
    }
    let mut body = Vec::with_capacity(content_length);
    recv_stream
        .take(content_length as u64)
        .read_to_end(&mut body)
        .await?;
    Ok(body)
}

fn build_upstream_url(base: &str, request_dest: &str) -> anyhow::Result<String> {
    let base = reqwest::Url::parse(base)?;
    let dest = reqwest::Url::parse(request_dest)
        .or_else(|_| base.join(request_dest.trim_start_matches('/')))?;
    let mut upstream = base;
    upstream.set_path(dest.path());
    upstream.set_query(dest.query());
    Ok(upstream.to_string())
}

fn forwarded_request_headers(metadata: &HashMap<String, String>) -> Vec<(String, String)> {
    const SKIP: &[&str] = &[
        "host",
        "content-length",
        "connection",
        "cf-ray",
        "cf-visitor",
        "cf-connecting-ip",
        "cf-ew-via",
        "cf-worker",
        "cdn-loop",
    ];
    metadata
        .iter()
        .filter_map(|(key, value)| {
            let name = key.strip_prefix("HttpHeader:")?;
            if SKIP.iter().any(|skip| name.eq_ignore_ascii_case(skip)) {
                return None;
            }
            Some((name.to_owned(), value.clone()))
        })
        .collect()
}

#[derive(Clone)]
struct TunnelConfig {
    account_tag: String,
    tunnel_secret: Vec<u8>,
    tunnel_id: Vec<u8>,
    hostname: String,
}

impl TunnelConfig {
    async fn try_cloudflare() -> anyhow::Result<Self> {
        let create_tunnel_response = reqwest::Client::new()
            .post("https://api.trycloudflare.com/tunnel")
            .send()
            .await?
            .json::<CreateTunnelResponse>()
            .await?;
        Ok(Self {
            account_tag: create_tunnel_response.result.account_tag,
            tunnel_secret: STANDARD_BASE64.decode(&create_tunnel_response.result.secret)?,
            tunnel_id: Uuid::parse_str(&create_tunnel_response.result.id)?
                .as_bytes()
                .to_vec(),
            hostname: create_tunnel_response.result.hostname,
        })
    }
}

#[derive(Deserialize)]
struct CreateTunnelResponse {
    result: CreateTunnelResult,
}

#[derive(Deserialize)]
struct CreateTunnelResult {
    account_tag: String,
    secret: String,
    id: String,
    hostname: String,
}

struct Connection {
    connection: QuinnConnection,
}

impl Connection {
    async fn new(tunnel_config: TunnelConfig, conn_idx: u8) -> anyhow::Result<Self> {
        let endpoint = Self::create_client_endpoint((Ipv4Addr::UNSPECIFIED, 0)).await?;
        let connection =
            Self::initiate_connection(&endpoint, "region2.argotunnel.com:7844").await?;
        Self::register_connection(&connection, tunnel_config, conn_idx).await?;
        Ok(Self { connection })
    }

    async fn create_client_endpoint(src_addr: impl ToSocketAddrs) -> anyhow::Result<QuinnEndpoint> {
        let mut last_error = None;
        for src_addr in lookup_host(src_addr).await? {
            match QuinnEndpoint::client(src_addr) {
                Ok(result) => return Ok(result),
                Err(error) => last_error = Some(anyhow!(error)),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("could not resolve source address")))
    }

    async fn initiate_connection(
        endpoint: &QuinnEndpoint,
        dst_addr: impl ToSocketAddrs,
    ) -> anyhow::Result<QuinnConnection> {
        let mut last_error = None;
        for dst_addr in lookup_host(dst_addr).await? {
            let mut root_cert_store = RootCertStore::empty();
            root_cert_store.add(&generated::cloudflare_ca())?;
            let mut tls_config = RustlsClientConfig::builder()
                .with_safe_default_cipher_suites()
                .with_safe_default_kx_groups()
                .with_protocol_versions(&[&rustls::version::TLS13])
                .expect("TLS 1.3 must be supported")
                .with_root_certificates(root_cert_store)
                .with_no_client_auth();
            tls_config.enable_early_data = true;
            tls_config.alpn_protocols = vec![b"argotunnel".to_vec()];
            match endpoint.connect_with(
                QuinnClientConfig::new(Arc::new(tls_config)),
                dst_addr,
                "quic.cftunnel.com",
            ) {
                Ok(connecting) => match connecting.await {
                    Ok(connection) => return Ok(connection),
                    Err(error) => last_error = Some(anyhow!(error)),
                },
                Err(error) => last_error = Some(anyhow!(error)),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("could not resolve Cloudflare tunnel region")))
    }

    async fn register_connection(
        connection: &QuinnConnection,
        tunnel_config: TunnelConfig,
        conn_idx: u8,
    ) -> anyhow::Result<()> {
        let (send_stream, recv_stream) = connection.open_bi().await?;
        let mut rpc_system = RpcSystem::new(
            Box::new(VatNetwork::new(
                recv_stream,
                send_stream,
                Side::Client,
                ReaderOptions::new(),
            )),
            None,
        );
        let registration_client =
            rpc_system.bootstrap::<generated::registration_server::Client>(Side::Server);
        let disconnector = rpc_system.get_disconnector();
        let local_driver = spawn_local(rpc_system);
        let mut request = registration_client.register_connection_request();
        let mut auth = request.get().init_auth();
        auth.set_account_tag(&tunnel_config.account_tag);
        auth.set_tunnel_secret(&tunnel_config.tunnel_secret);
        request.get().set_tunnel_id(&tunnel_config.tunnel_id);
        request.get().set_conn_index(conn_idx);
        request
            .get()
            .init_options()
            .init_client()
            .set_client_id(&[0; 16]);
        let response = request.send().promise.await?;
        match response.get()?.get_result()?.get_result().which()? {
            generated::connection_response::result::Which::ConnectionDetails(_) => {}
            generated::connection_response::result::Which::Error(error) => {
                let error = error?;
                return Err(anyhow!(
                    "{} (should_retry = {}, retry_after = {})",
                    error.get_cause()?.to_string()?,
                    error.get_should_retry(),
                    error.get_retry_after()
                ));
            }
        }
        disconnector.await?;
        local_driver.await??;
        Ok(())
    }

    async fn accept(&self) -> anyhow::Result<ConnectRequest> {
        let (send_stream, mut recv_stream) = self.connection.accept_bi().await?;
        let mut signature = [0; 8];
        recv_stream.read_exact(&mut signature).await?;
        if signature != SIGNATURE {
            return Err(anyhow!(
                "unknown Cloudflare tunnel signature: {signature:02X?}"
            ));
        }
        let connect_request_reader = read_message(&mut recv_stream, ReaderOptions::new()).await?;
        let root_reader =
            connect_request_reader.get_root::<generated::connect_request::Reader>()?;
        let metadata_reader = root_reader.get_metadata()?;
        let mut metadata = HashMap::with_capacity(metadata_reader.len() as usize);
        for item in metadata_reader {
            metadata.insert(item.get_key()?.to_string()?, item.get_val()?.to_string()?);
        }
        Ok(ConnectRequest {
            request_dest: root_reader.get_dest()?.to_string()?,
            metadata,
            send_stream,
            recv_stream,
        })
    }
}

struct ConnectRequest {
    request_dest: String,
    metadata: HashMap<String, String>,
    send_stream: QuinnSendStream,
    recv_stream: QuinnRecvStream,
}

impl ConnectRequest {
    async fn respond_with(
        mut self,
        response: ConnectResponse,
    ) -> anyhow::Result<(QuinnSendStream, QuinnRecvStream)> {
        let mut builder = TypedBuilder::<generated::connect_response::Owned>::new_default();
        let root = builder.init_root();
        match response {
            ConnectResponse::Metadata(metadata) => {
                let mut items = root.init_metadata(metadata.len() as u32);
                for (index, (key, value)) in metadata.into_iter().enumerate() {
                    let mut item = items.reborrow().get(index as u32);
                    item.set_key(key);
                    item.set_val(value);
                }
            }
        }
        self.send_stream.write_all(&SIGNATURE).await?;
        write_message(&mut self.send_stream, &builder.into_inner()).await?;
        Ok((self.send_stream, self.recv_stream))
    }
}

enum ConnectResponse {
    Metadata(HashMap<String, String>),
}
