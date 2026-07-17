use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message as BrowserMessage, WebSocket};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use lzc_sdk::{ClientCredentials, CredentialPaths, TokenProvider};
use reqwest::{Method, Url};
use rustls23::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls23::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls23::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls23::{DigitallySignedStruct, SignatureScheme};
use secrecy::ExposeSecret as _;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::time::timeout;
use tokio_tungstenite::Connector;
use tokio_tungstenite::tungstenite::Message as RemoteMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tracing::{info, warn};

use crate::http_body::read_limited_body;
use crate::lightos;
use crate::lightos_admin::{
    self, build_admin_url, build_upstream_headers, current_request_account_id,
    list_visible_client_instances, parse_client_selector, resolve_admin_base_url,
};
use crate::proto::lazycat::webshell::v1::Session;
use crate::remote_program::{RemoteBootstrapState, RemoteProgramKind, RemoteProgramStore};
use crate::workspace::{
    SessionBackend, SplitAxis, SplitDirection, WorkspaceAction, WorkspaceActionRequest,
    WorkspaceLayoutNode, WorkspacePaneState, WorkspaceState, WorkspaceTabState,
};

const CLIENT_TERMINAL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TICKET_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_WORKSPACE_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const REMOTE_HERDR_LAUNCH: &str = "if command -v herdr >/dev/null 2>&1; then exec herdr; elif [ -x \"$HOME/.local/bin/herdr\" ]; then exec \"$HOME/.local/bin/herdr\"; else printf '%s\\n' 'Herdr is not installed on this remote device.'; exit 127; fi\r";

type RemoteWebSocketRequest = tokio_tungstenite::tungstenite::http::Request<()>;

async fn await_client_terminal_boundary<T, F>(
    duration: Duration,
    future: F,
    timeout_message: &'static str,
) -> Result<T, ClientTerminalError>
where
    F: Future<Output = T>,
{
    timeout(duration, future)
        .await
        .map_err(|_| ClientTerminalError::new(StatusCode::GATEWAY_TIMEOUT, timeout_message))
}

#[derive(Debug, Error)]
#[error("{message}")]
pub(crate) struct ClientTerminalError {
    pub status: StatusCode,
    pub(crate) message: String,
}

impl ClientTerminalError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, message)
    }
}

impl IntoResponse for ClientTerminalError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

impl From<lightos_admin::LightOsAdminError> for ClientTerminalError {
    fn from(error: lightos_admin::LightOsAdminError) -> Self {
        Self::new(error.status, error.message)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ClientTerminalTicket {
    #[serde(default)]
    client_instance_id: String,
    #[serde(default)]
    device_api_url: String,
    #[serde(default)]
    terminal_service_name: String,
    #[serde(default)]
    ticket: String,
}

#[derive(Serialize)]
struct ClientTerminalTicketRequest<'a> {
    id: &'a str,
}

struct ClientTerminalDialInfo {
    ticket: ClientTerminalTicket,
    device_api_url: Url,
    auth_token: secrecy::SecretString,
}

pub(crate) struct RemoteTerminalConnection {
    request: RemoteWebSocketRequest,
    connector: Connector,
    selector: String,
    pane_id: String,
    replay_after: u64,
    safe_url: String,
    ticket: secrecy::SecretString,
    auth_token: secrecy::SecretString,
    program_state: Option<(RemoteProgramKind, RemoteBootstrapState)>,
    remote_programs: Arc<RemoteProgramStore>,
}

pub(crate) struct RemoteTerminalConnectOptions<'a> {
    pub cols: u16,
    pub rows: u16,
    pub replay_after: u64,
    pub foreground: Option<&'a str>,
    pub background: Option<&'a str>,
    pub cursor: Option<&'a str>,
}

struct RemoteWebSocketFailure {
    user_message: String,
    technical_message: String,
    error_code: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteBootstrapEvent {
    ReplayStart,
    ReplayComplete,
    TerminalOutput,
    ControlRejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteBootstrapAction {
    None,
    SendHerdr,
    RevertPending,
}

struct RemoteHerdrBootstrap {
    pending: bool,
    attempted: bool,
    output_seen: bool,
}

impl RemoteHerdrBootstrap {
    const fn pending() -> Self {
        Self {
            pending: true,
            attempted: false,
            output_seen: false,
        }
    }

    fn observe(&mut self, event: RemoteBootstrapEvent) -> RemoteBootstrapAction {
        match event {
            RemoteBootstrapEvent::ReplayComplete if self.pending && !self.attempted => {
                self.attempted = true;
                RemoteBootstrapAction::SendHerdr
            }
            RemoteBootstrapEvent::TerminalOutput if self.attempted => {
                self.output_seen = true;
                RemoteBootstrapAction::None
            }
            RemoteBootstrapEvent::ControlRejected if self.attempted && !self.output_seen => {
                self.pending = true;
                RemoteBootstrapAction::RevertPending
            }
            RemoteBootstrapEvent::ReplayStart
            | RemoteBootstrapEvent::ReplayComplete
            | RemoteBootstrapEvent::TerminalOutput
            | RemoteBootstrapEvent::ControlRejected => RemoteBootstrapAction::None,
        }
    }

    fn mark_sent(&mut self) {
        self.pending = false;
    }
}

struct SkipServerCertificateVerification(CryptoProvider);

impl fmt::Debug for SkipServerCertificateVerification {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SkipServerCertificateVerification")
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for SkipServerCertificateVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls23::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls23::Error> {
        verify_tls12_signature(
            message,
            certificate,
            signed,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls23::Error> {
        verify_tls13_signature(
            message,
            certificate,
            signed,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct RemoteWorkspaceState {
    #[serde(default)]
    active_tab_id: String,
    #[serde(default)]
    tabs: Vec<RemoteWorkspaceTab>,
}

#[derive(Debug, Deserialize)]
struct RemoteWorkspaceTab {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    custom_label: bool,
    #[serde(default)]
    active_pane_id: String,
    layout: Option<RemoteWorkspaceLayoutNode>,
    #[serde(default)]
    panes: Vec<RemoteWorkspacePane>,
}

// The Go client-terminal wire schema uses leaf/direction/size, while the local
// workspace model uses pane/axis. Keep the translation at this boundary.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum RemoteWorkspaceLayoutNode {
    Leaf {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<f64>,
    },
    Split {
        direction: RemoteSplitDirection,
        children: Vec<RemoteWorkspaceLayoutNode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<f64>,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RemoteSplitDirection {
    Vertical,
    Horizontal,
}

#[derive(Debug, Deserialize)]
struct RemoteWorkspacePane {
    #[serde(default)]
    id: String,
    #[serde(default)]
    cols: u16,
    #[serde(default)]
    rows: u16,
    #[serde(default)]
    exited: bool,
}

#[derive(Debug, Serialize)]
struct RemoteWorkspaceActionRequest {
    action: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    tab_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pane_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    direction: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    layout: Option<RemoteWorkspaceLayoutNode>,
    #[serde(skip_serializing_if = "String::is_empty")]
    active_pane_id: String,
    cols: u16,
    rows: u16,
}

pub(crate) async fn authorize_client(
    headers: &HeaderMap,
    selector: &str,
) -> Result<String, ClientTerminalError> {
    if parse_client_selector(selector).is_none() {
        return Err(ClientTerminalError::bad_request("invalid client target"));
    }
    if current_request_account_id(headers).is_none() {
        return Err(ClientTerminalError::unauthorized("account id is required"));
    }
    let visible = list_visible_client_instances(headers).await?;
    authorize_client_id(selector, &visible)
}

fn authorize_client_id(
    selector: &str,
    visible: &[lightos_admin::ClientInstanceSummary],
) -> Result<String, ClientTerminalError> {
    let client_id = parse_client_selector(selector)
        .ok_or_else(|| ClientTerminalError::bad_request("invalid client target"))?;
    visible
        .iter()
        .any(|item| item.id.trim() == client_id)
        .then(|| client_id.to_owned())
        .ok_or_else(|| {
            ClientTerminalError::forbidden("instance is not accessible by current account")
        })
}

pub(crate) async fn get_workspace(
    headers: &HeaderMap,
    selector: &str,
    cols: u16,
    rows: u16,
    remote_programs: &RemoteProgramStore,
) -> Result<WorkspaceState, ClientTerminalError> {
    let query = [("cols", cols.to_string()), ("rows", rows.to_string())];
    let body =
        client_terminal_json(headers, selector, Method::GET, "/workspace", &query, None).await?;
    let remote = serde_json::from_slice::<RemoteWorkspaceState>(&body).map_err(|error| {
        ClientTerminalError::bad_gateway(format!("invalid remote workspace response: {error}"))
    })?;
    let workspace = convert_remote_workspace(selector, remote, remote_programs)?;
    info!(
        selector,
        tabs = workspace.tabs.len(),
        active_tab = workspace.active_tab_id.as_deref().unwrap_or_default(),
        "remote client workspace decoded"
    );
    Ok(workspace)
}

pub(crate) async fn apply_workspace_action(
    headers: &HeaderMap,
    selector: &str,
    cols: u16,
    rows: u16,
    request: &WorkspaceActionRequest,
    remote_programs: &RemoteProgramStore,
) -> Result<WorkspaceState, ClientTerminalError> {
    let outbound = remote_workspace_action(request, cols, rows)?;
    let mut remote =
        request_remote_workspace_action(headers, selector, cols, rows, &outbound).await?;
    if request.session_backend == Some(SessionBackend::Herdr) {
        let (tab_id, pane_id) = remote_workspace_active_ids(&remote).ok_or_else(|| {
            ClientTerminalError::bad_gateway(
                "remote client did not return the created Herdr terminal",
            )
        })?;
        remote_programs
            .mark_pending(selector, pane_id, RemoteProgramKind::Herdr)
            .map_err(|error| remote_program_persistence_error(selector, pane_id, &error))?;
        let rename = remote_herdr_rename_action(tab_id, cols, rows);
        remote = request_remote_workspace_action(headers, selector, cols, rows, &rename).await?;
    }
    let workspace = convert_remote_workspace(selector, remote, remote_programs)?;
    info!(
        selector,
        action = ?request.action,
        tabs = workspace.tabs.len(),
        active_tab = workspace.active_tab_id.as_deref().unwrap_or_default(),
        "remote client workspace action decoded"
    );
    Ok(workspace)
}

async fn request_remote_workspace_action(
    headers: &HeaderMap,
    selector: &str,
    cols: u16,
    rows: u16,
    outbound: &RemoteWorkspaceActionRequest,
) -> Result<RemoteWorkspaceState, ClientTerminalError> {
    let payload = serde_json::to_vec(&outbound).map_err(|error| {
        ClientTerminalError::bad_request(format!("invalid workspace action: {error}"))
    })?;
    let query = [("cols", cols.to_string()), ("rows", rows.to_string())];
    let body = client_terminal_json(
        headers,
        selector,
        Method::POST,
        "/workspace",
        &query,
        Some(payload),
    )
    .await?;
    serde_json::from_slice::<RemoteWorkspaceState>(&body).map_err(|error| {
        ClientTerminalError::bad_gateway(format!("invalid remote workspace response: {error}"))
    })
}

pub(crate) async fn create_session(
    headers: &HeaderMap,
    selector: &str,
    cols: u16,
    rows: u16,
    output_limit: usize,
    metadata: HashMap<String, String>,
    remote_programs: &RemoteProgramStore,
) -> Result<Session, ClientTerminalError> {
    let request = remote_session_action_request(
        selector,
        WorkspaceAction::CreateTab,
        cols,
        rows,
        output_limit,
    );
    let workspace =
        apply_workspace_action(headers, selector, cols, rows, &request, remote_programs).await?;
    workspace_active_session(&workspace, metadata)
        .ok_or_else(|| ClientTerminalError::bad_gateway("remote client did not create a session"))
}

pub(crate) async fn close_session(
    headers: &HeaderMap,
    selector: &str,
    session_id: &str,
    cols: u16,
    rows: u16,
    output_limit: usize,
    remote_programs: &RemoteProgramStore,
) -> Result<(), ClientTerminalError> {
    let workspace = get_workspace(headers, selector, cols, rows, remote_programs).await?;
    let tab_id = workspace_tab_id_for_pane(&workspace, session_id).ok_or_else(|| {
        ClientTerminalError::new(StatusCode::NOT_FOUND, "remote terminal session not found")
    })?;
    let mut request = remote_session_action_request(
        selector,
        WorkspaceAction::ClosePane,
        cols,
        rows,
        output_limit,
    );
    request.tab_id = Some(tab_id.to_owned());
    request.pane_id = Some(session_id.to_owned());
    apply_workspace_action(headers, selector, cols, rows, &request, remote_programs).await?;
    Ok(())
}

pub(crate) async fn list_sessions(
    headers: &HeaderMap,
    selector: &str,
    cols: u16,
    rows: u16,
    remote_programs: &RemoteProgramStore,
) -> Result<Vec<Session>, ClientTerminalError> {
    let workspace = get_workspace(headers, selector, cols, rows, remote_programs).await?;
    Ok(workspace_sessions(&workspace))
}

pub(crate) async fn connect_terminal(
    headers: &HeaderMap,
    selector: &str,
    pane_id: &str,
    options: RemoteTerminalConnectOptions<'_>,
    remote_programs: Arc<RemoteProgramStore>,
) -> Result<RemoteTerminalConnection, ClientTerminalError> {
    let pane_id = pane_id.trim();
    if pane_id.is_empty() || pane_id.len() > 256 || pane_id.chars().any(char::is_control) {
        return Err(ClientTerminalError::bad_request("pane_id is required"));
    }
    let dial = client_terminal_dial_info(headers, selector).await?;
    let mut url = client_terminal_url(&dial.ticket, "/ws")?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("pane", pane_id);
        query.append_pair("cols", &options.cols.to_string());
        query.append_pair("rows", &options.rows.to_string());
        for (key, value) in [
            ("fg", terminal_theme_color(options.foreground)),
            ("bg", terminal_theme_color(options.background)),
            ("cursor", terminal_theme_color(options.cursor)),
        ] {
            if let Some(value) = value {
                query.append_pair(key, value);
            }
        }
        query.append_pair("ticket", &dial.ticket.ticket);
    }
    let safe_url = sanitize_client_terminal_url(&url);
    let websocket_url = websocket_terminal_url(&url)?;
    info!(
        selector,
        pane_id,
        target = %safe_url,
        "connecting remote client terminal websocket"
    );
    let mut request = websocket_url
        .as_str()
        .into_client_request()
        .map_err(|_| ClientTerminalError::bad_gateway("invalid remote terminal request"))?;
    request.headers_mut().insert(
        "lzc_dapi_auth_token",
        tokio_tungstenite::tungstenite::http::HeaderValue::from_str(
            dial.auth_token.expose_secret(),
        )
        .map_err(|_| ClientTerminalError::bad_gateway("invalid device auth token"))?,
    );
    let connector = websocket_tls_connector()?;
    let program_state = remote_programs.program_state(selector, pane_id);
    Ok(RemoteTerminalConnection {
        request,
        connector,
        selector: selector.to_owned(),
        pane_id: pane_id.to_owned(),
        replay_after: options.replay_after,
        safe_url,
        ticket: secrecy::SecretString::from(dial.ticket.ticket),
        auth_token: dial.auth_token,
        program_state,
        remote_programs,
    })
}

#[allow(clippy::too_many_lines)]
pub(crate) async fn relay_terminal_socket(
    mut browser: WebSocket,
    remote: RemoteTerminalConnection,
) -> anyhow::Result<()> {
    let RemoteTerminalConnection {
        request,
        connector,
        selector,
        pane_id,
        replay_after,
        safe_url,
        ticket,
        auth_token,
        program_state,
        remote_programs,
    } = remote;
    let socket = match timeout(
        CLIENT_TERMINAL_TIMEOUT,
        tokio_tungstenite::connect_async_tls_with_config(request, None, true, Some(connector)),
    )
    .await
    {
        Err(_) => {
            let failure = classify_remote_websocket_failure(
                None,
                "",
                "remote client terminal connection timed out",
            );
            warn!(selector, pane_id, target = %safe_url, "remote client terminal websocket timed out");
            send_remote_websocket_failure(&mut browser, &failure).await?;
            return Ok(());
        }
        Ok(Err(error)) => {
            let (status, body) = remote_websocket_error_response(&error);
            let body =
                redact_sensitive_text(&body, ticket.expose_secret(), auth_token.expose_secret());
            let technical_message = redact_sensitive_text(
                &error.to_string(),
                ticket.expose_secret(),
                auth_token.expose_secret(),
            );
            let failure = classify_remote_websocket_failure(status, &body, &technical_message);
            warn!(
                selector,
                pane_id,
                target = %safe_url,
                status = status.map(|value| value.as_u16()).unwrap_or_default(),
                error = %failure.technical_message,
                "remote client terminal websocket failed"
            );
            send_remote_websocket_failure(&mut browser, &failure).await?;
            return Ok(());
        }
        Ok(Ok((socket, _))) => socket,
    };
    info!(selector, pane_id, target = %safe_url, "remote client terminal websocket connected");
    let (mut browser_sink, mut browser_stream) = browser.split();
    let (remote_sink, mut remote_stream) = socket.split();
    let remote_sink = Arc::new(tokio::sync::Mutex::new(remote_sink));
    let browser_remote_sink = Arc::clone(&remote_sink);
    let mut bootstrap = matches!(
        program_state,
        Some((RemoteProgramKind::Herdr, RemoteBootstrapState::Pending))
    )
    .then(RemoteHerdrBootstrap::pending);

    let browser_to_remote = async {
        while let Some(message) = browser_stream.next().await {
            let message = message?;
            let message = browser_message_to_remote(message);
            browser_remote_sink.lock().await.send(message).await?;
        }
        Ok::<(), anyhow::Error>(())
    };

    let remote_to_browser = async {
        while let Some(message) = remote_stream.next().await {
            let message = message?;
            let bootstrap_action = bootstrap
                .as_mut()
                .and_then(|state| {
                    remote_bootstrap_event(&message).map(|event| state.observe(event))
                })
                .unwrap_or(RemoteBootstrapAction::None);
            let Some(message) =
                remote_message_to_browser(message, &selector, &pane_id, replay_after)?
            else {
                break;
            };
            match bootstrap_action {
                RemoteBootstrapAction::SendHerdr => {
                    let mut sink = remote_sink.lock().await;
                    browser_sink.send(message).await?;
                    sink.send(remote_herdr_launch_message()?).await?;
                    if let Some(state) = bootstrap.as_mut() {
                        state.mark_sent();
                    }
                    if let Err(error) = remote_programs.mark_sent(&selector, &pane_id) {
                        warn!(
                            error = %error,
                            selector,
                            pane_id,
                            "failed to persist completed remote Herdr bootstrap"
                        );
                    }
                }
                RemoteBootstrapAction::RevertPending => {
                    browser_sink.send(message).await?;
                    if let Err(error) =
                        remote_programs.mark_pending_after_rejection(&selector, &pane_id)
                    {
                        warn!(
                            error = %error,
                            selector,
                            pane_id,
                            "failed to restore pending remote Herdr bootstrap"
                        );
                    }
                }
                RemoteBootstrapAction::None => browser_sink.send(message).await?,
            }
        }
        Ok::<(), anyhow::Error>(())
    };

    tokio::select! {
        result = browser_to_remote => result,
        result = remote_to_browser => result,
    }
}

fn remote_bootstrap_event(message: &RemoteMessage) -> Option<RemoteBootstrapEvent> {
    match message {
        RemoteMessage::Binary(bytes) if !bytes.is_empty() => {
            Some(RemoteBootstrapEvent::TerminalOutput)
        }
        RemoteMessage::Text(text) => {
            let value = serde_json::from_str::<serde_json::Value>(text.as_str()).ok()?;
            match value.get("type").and_then(serde_json::Value::as_str) {
                Some("history-replay-start") => Some(RemoteBootstrapEvent::ReplayStart),
                Some("history-replay-complete") => Some(RemoteBootstrapEvent::ReplayComplete),
                Some("error")
                    if value.get("message").and_then(serde_json::Value::as_str)
                        == Some("terminal control is held by another client") =>
                {
                    Some(RemoteBootstrapEvent::ControlRejected)
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn remote_herdr_launch_message() -> Result<RemoteMessage, serde_json::Error> {
    serde_json::to_string(&serde_json::json!({
        "type": "input",
        "data": REMOTE_HERDR_LAUNCH,
    }))
    .map(|message| RemoteMessage::Text(message.into()))
}

fn remote_websocket_error_response(
    error: &tokio_tungstenite::tungstenite::Error,
) -> (Option<StatusCode>, String) {
    let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
        return (None, String::new());
    };
    let body = response
        .body()
        .as_deref()
        .map(String::from_utf8_lossy)
        .map(|value| value.chars().take(2048).collect())
        .unwrap_or_default();
    (Some(response.status()), body)
}

async fn send_remote_websocket_failure(
    browser: &mut WebSocket,
    failure: &RemoteWebSocketFailure,
) -> anyhow::Result<()> {
    let payload = serde_json::to_string(&remote_websocket_failure_payload(failure))?;
    browser.send(BrowserMessage::Text(payload.into())).await?;
    Ok(())
}

fn remote_websocket_failure_payload(failure: &RemoteWebSocketFailure) -> serde_json::Value {
    serde_json::json!({
        "type": "process-exit",
        "exit_code": -1,
        "message": failure.user_message,
        "technical_message": failure.technical_message,
        "error_code": failure.error_code,
        "retryable": true,
    })
}

fn browser_message_to_remote(message: BrowserMessage) -> RemoteMessage {
    match message {
        BrowserMessage::Text(text) => RemoteMessage::Text(text.as_str().into()),
        BrowserMessage::Binary(bytes) => RemoteMessage::Binary(bytes),
        BrowserMessage::Ping(bytes) => RemoteMessage::Ping(bytes),
        BrowserMessage::Pong(bytes) => RemoteMessage::Pong(bytes),
        BrowserMessage::Close(_) => RemoteMessage::Close(None),
    }
}

fn remote_message_to_browser(
    message: RemoteMessage,
    selector: &str,
    pane_id: &str,
    replay_after: u64,
) -> Result<Option<BrowserMessage>, ClientTerminalError> {
    match message {
        RemoteMessage::Text(text) => Ok(Some(BrowserMessage::Text(
            translate_remote_control(text.as_str(), selector, pane_id, replay_after)?.into(),
        ))),
        RemoteMessage::Binary(bytes) => Ok(Some(BrowserMessage::Binary(bytes))),
        RemoteMessage::Ping(bytes) => Ok(Some(BrowserMessage::Ping(bytes))),
        RemoteMessage::Pong(bytes) => Ok(Some(BrowserMessage::Pong(bytes))),
        RemoteMessage::Close(_) => Ok(Some(BrowserMessage::Close(None))),
        RemoteMessage::Frame(_) => Ok(None),
    }
}

fn websocket_tls_connector() -> Result<Connector, ClientTerminalError> {
    let provider = rustls23::crypto::ring::default_provider();
    let verifier = Arc::new(SkipServerCertificateVerification(provider.clone()));
    let config = rustls23::ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

fn websocket_terminal_url(url: &Url) -> Result<Url, ClientTerminalError> {
    let mut websocket = url.clone();
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => {
            return Err(ClientTerminalError::bad_gateway(
                "invalid remote terminal URL",
            ));
        }
    };
    websocket
        .set_scheme(scheme)
        .map_err(|()| ClientTerminalError::bad_gateway("invalid remote terminal URL"))?;
    Ok(websocket)
}

fn terminal_theme_color(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    (value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(value)
}

fn classify_remote_websocket_failure(
    status: Option<StatusCode>,
    body: &str,
    technical_message: &str,
) -> RemoteWebSocketFailure {
    let body = body.trim();
    let mut failure = RemoteWebSocketFailure {
        user_message: technical_message.to_owned(),
        technical_message: technical_message.to_owned(),
        error_code: "client_terminal_websocket_dial_failed",
    };
    let Some(status) = status else {
        return failure;
    };
    failure.technical_message = format!("{technical_message}; target_status={status}");
    if !body.is_empty() {
        failure.technical_message.push_str("; target_body=");
        failure.technical_message.push_str(body);
    }
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        "instance is not accessible by current account".clone_into(&mut failure.user_message);
        failure.error_code = "client_terminal_forbidden";
    } else if !body.is_empty() {
        failure.user_message = format!(
            "Client terminal connection failed (target_status={}): {body}",
            status.as_u16()
        );
    } else {
        failure.user_message = format!(
            "Client terminal connection failed. Please restart the desktop client or turn LightOS access off and on again. (target_status={})",
            status.as_u16()
        );
    }
    if status == StatusCode::BAD_GATEWAY {
        failure.error_code = "client_terminal_service_unavailable";
    }
    failure
}

fn translate_remote_control(
    text: &str,
    selector: &str,
    pane_id: &str,
    replay_after: u64,
) -> Result<String, ClientTerminalError> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(text.to_owned());
    };
    let Some(kind) = value.get("type").and_then(serde_json::Value::as_str) else {
        return Ok(text.to_owned());
    };
    if !matches!(kind, "history-replay-start" | "history-replay-complete") {
        return Ok(text.to_owned());
    }
    let remote_selector = value
        .get("selector")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    let remote_pane = value
        .get("pane_id")
        .or_else(|| value.get("paneId"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    if (!remote_selector.is_empty() || !remote_pane.is_empty())
        && (remote_selector != selector || remote_pane != pane_id)
    {
        return Err(ClientTerminalError::bad_gateway(
            "remote terminal replay identity mismatch",
        ));
    }
    let translated = if kind == "history-replay-start" {
        let allow_generated_input = value
            .get("allow_generated_input")
            .or_else(|| value.get("allowGeneratedInput"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        serde_json::json!({
            "type": "replay-start",
            "session_id": pane_id,
            "selector": selector,
            "pane_id": pane_id,
            "replay_after": replay_after,
            "allow_generated_input": allow_generated_input,
        })
    } else {
        serde_json::json!({
            "type": "replay-complete",
            "session_id": pane_id,
            "selector": selector,
            "pane_id": pane_id,
            "last_sequence": replay_after,
        })
    };
    serde_json::to_string(&translated)
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))
}

async fn client_terminal_json(
    headers: &HeaderMap,
    selector: &str,
    method: Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<Vec<u8>>,
) -> Result<Vec<u8>, ClientTerminalError> {
    let method_name = method.as_str().to_owned();
    info!(selector, method = %method_name, path, "remote client terminal request started");
    let dial = client_terminal_dial_info(headers, selector).await?;
    let mut url = client_terminal_url(&dial.ticket, path)?;
    if url.scheme() != dial.device_api_url.scheme()
        || url.host_str() != dial.device_api_url.host_str()
        || url.port_or_known_default() != dial.device_api_url.port_or_known_default()
    {
        return Err(ClientTerminalError::bad_gateway(
            "client terminal target origin mismatch",
        ));
    }
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            if !value.is_empty() && value != "0" {
                pairs.append_pair(key, value);
            }
        }
        pairs.append_pair("ticket", &dial.ticket.ticket);
    }
    let safe_url = sanitize_client_terminal_url(&url);
    let client = reqwest::Client::builder()
        .timeout(CLIENT_TERMINAL_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    let mut request = client
        .request(method, url)
        .header(
            "lzc_dapi_auth_token",
            HeaderValue::from_str(dial.auth_token.expose_secret())
                .map_err(|_| ClientTerminalError::bad_gateway("invalid device auth token"))?,
        )
        .header("accept", "application/json");
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body);
    }
    let response = request.send().await.map_err(|error| {
        let error = redact_sensitive_text(
            &error.to_string(),
            &dial.ticket.ticket,
            dial.auth_token.expose_secret(),
        );
        warn!(
            selector,
            method = %method_name,
            path,
            target = %safe_url,
            error = %error,
            "remote client terminal request failed"
        );
        ClientTerminalError::bad_gateway(format!(
            "remote client terminal request failed: {safe_url}"
        ))
    })?;
    let status = response.status();
    info!(
        selector,
        method = %method_name,
        path,
        target = %safe_url,
        %status,
        "remote client terminal response received"
    );
    let bytes = read_limited_body(
        response,
        MAX_WORKSPACE_RESPONSE_BYTES,
        "remote workspace response",
    )
    .await
    .map_err(ClientTerminalError::bad_gateway)?;
    if let Some(error) = remote_access_error(status) {
        return Err(error);
    }
    if !status.is_success() {
        let detail = redact_sensitive_text(
            String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).trim(),
            &dial.ticket.ticket,
            dial.auth_token.expose_secret(),
        );
        return Err(ClientTerminalError::bad_gateway(if detail.is_empty() {
            format!("remote client terminal returned {status}")
        } else {
            format!("remote client terminal returned {status}: {detail}")
        }));
    }
    Ok(bytes)
}

async fn client_terminal_dial_info(
    headers: &HeaderMap,
    selector: &str,
) -> Result<ClientTerminalDialInfo, ClientTerminalError> {
    let client_id = authorize_client(headers, selector).await?;
    info!(selector, client_id, "remote client visibility authorized");
    let ticket = request_terminal_ticket(headers, &client_id).await?;
    let ticket = validate_ticket(ticket, &client_id)?;
    let device_api_url = Url::parse(&ticket.device_api_url)
        .map_err(|_| ClientTerminalError::bad_gateway("invalid client terminal device URL"))?;
    let device_origin = device_api_url.origin().ascii_serialization();
    info!(
        selector,
        client_id,
        service = %ticket.terminal_service_name,
        device_origin,
        "remote client terminal ticket validated"
    );
    let credentials = ClientCredentials::load(CredentialPaths::runtime())
        .await
        .map_err(|error| {
            ClientTerminalError::bad_gateway(format!(
                "failed to load LazyCat device credentials: {error}"
            ))
        })?;
    let token_provider = await_client_terminal_boundary(
        CLIENT_TERMINAL_TIMEOUT,
        TokenProvider::connect(device_api_url.as_str(), credentials),
        "LazyCat device authentication connection timed out",
    )
    .await?
    .map_err(|error| {
        ClientTerminalError::bad_gateway(format!(
            "failed to connect LazyCat device authentication: {error}"
        ))
    })?;
    let auth_token = await_client_terminal_boundary(
        CLIENT_TERMINAL_TIMEOUT,
        token_provider.token(),
        "LazyCat device authentication token timed out",
    )
    .await?
    .map_err(|error| {
        ClientTerminalError::bad_gateway(format!(
            "failed to resolve LazyCat device authentication: {error}"
        ))
    })?;
    info!(
        selector,
        client_id, device_origin, "remote client device authentication resolved"
    );
    let auth_token = secrecy::SecretString::from(auth_token.expose_secret().to_owned());
    Ok(ClientTerminalDialInfo {
        ticket,
        device_api_url,
        auth_token,
    })
}

async fn request_terminal_ticket(
    headers: &HeaderMap,
    client_id: &str,
) -> Result<ClientTerminalTicket, ClientTerminalError> {
    let account_id = current_request_account_id(headers)
        .ok_or_else(|| ClientTerminalError::unauthorized("account id is required"))?;
    let info = lightos::admin_info().await.map_err(|error| {
        ClientTerminalError::bad_gateway(
            error
                .message
                .unwrap_or_else(|| "failed to resolve LightOS admin info".to_owned()),
        )
    })?;
    let base_url = resolve_admin_base_url(&info.base_url);
    let url = build_admin_url(&base_url, "/api/client-instances/terminal-ticket")
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    let admin_origin = url.origin().ascii_serialization();
    info!(
        client_id,
        admin_origin, "requesting remote client terminal ticket"
    );
    let mut upstream_headers =
        build_upstream_headers(headers, &account_id).map_err(ClientTerminalError::bad_gateway)?;
    upstream_headers.insert("content-type", HeaderValue::from_static("application/json"));
    let client = reqwest::Client::builder()
        .timeout(CLIENT_TERMINAL_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    let response = client
        .post(url)
        .headers(upstream_headers)
        .json(&ClientTerminalTicketRequest { id: client_id })
        .send()
        .await
        .map_err(|error| {
            warn!(client_id, admin_origin, error = %error, "remote client terminal ticket request failed");
            ClientTerminalError::bad_gateway(error.to_string())
        })?;
    let status = response.status();
    info!(client_id, admin_origin, %status, "remote client terminal ticket response received");
    let body = read_limited_body(
        response,
        MAX_TICKET_RESPONSE_BYTES,
        "client terminal ticket response",
    )
    .await
    .map_err(ClientTerminalError::bad_gateway)?;
    if let Some(error) = remote_access_error(status) {
        return Err(error);
    }
    if !status.is_success() {
        return Err(ClientTerminalError::bad_gateway(format!(
            "client terminal ticket request returned {status}"
        )));
    }
    serde_json::from_slice(&body).map_err(|error| {
        ClientTerminalError::bad_gateway(format!("invalid client terminal ticket: {error}"))
    })
}

fn remote_access_error(status: StatusCode) -> Option<ClientTerminalError> {
    let message = "instance is not accessible by current account";
    match status {
        StatusCode::UNAUTHORIZED => Some(ClientTerminalError::unauthorized(message)),
        StatusCode::FORBIDDEN => Some(ClientTerminalError::forbidden(message)),
        _ => None,
    }
}

fn validate_ticket(
    ticket: ClientTerminalTicket,
    expected_client_id: &str,
) -> Result<ClientTerminalTicket, ClientTerminalError> {
    if ticket.client_instance_id.trim() != expected_client_id {
        return Err(ClientTerminalError::bad_gateway(
            "client terminal ticket does not match requested client",
        ));
    }
    let device_url = Url::parse(ticket.device_api_url.trim())
        .map_err(|_| ClientTerminalError::bad_gateway("invalid client terminal device URL"))?;
    if !matches!(device_url.scheme(), "http" | "https") || device_url.host_str().is_none() {
        return Err(ClientTerminalError::bad_gateway(
            "invalid client terminal device URL",
        ));
    }
    let service = ticket.terminal_service_name.trim();
    if service.is_empty()
        || service.len() > 256
        || !service
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(ClientTerminalError::bad_gateway(
            "invalid client terminal service name",
        ));
    }
    if ticket.ticket.trim().is_empty() || ticket.ticket.len() > 8192 {
        return Err(ClientTerminalError::bad_gateway(
            "invalid client terminal ticket",
        ));
    }
    Ok(ticket)
}

fn client_terminal_url(
    ticket: &ClientTerminalTicket,
    request_path: &str,
) -> Result<Url, ClientTerminalError> {
    let mut url = Url::parse(ticket.device_api_url.trim())
        .map_err(|_| ClientTerminalError::bad_gateway("invalid client terminal device URL"))?;
    let base_path = url.path().trim_end_matches('/');
    let path = request_path.trim_start_matches('/');
    url.set_path(&format!(
        "{base_path}/s/{}/{}",
        ticket.terminal_service_name.trim(),
        path
    ));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn sanitize_client_terminal_url(url: &Url) -> String {
    let mut redacted = url.clone();
    let pairs = redacted
        .query_pairs()
        .map(|(key, value)| {
            if key == "ticket" {
                (key.into_owned(), "[REDACTED]".to_owned())
            } else {
                (key.into_owned(), value.into_owned())
            }
        })
        .collect::<Vec<_>>();
    redacted.set_query(None);
    if !pairs.is_empty() {
        redacted.query_pairs_mut().extend_pairs(pairs);
    }
    redacted.to_string()
}

fn redact_sensitive_text(text: &str, ticket: &str, auth_token: &str) -> String {
    let mut redacted = text.to_owned();
    for secret in [ticket, auth_token] {
        if !secret.is_empty() {
            redacted = redacted.replace(secret, "[REDACTED]");
        }
    }
    redacted
}

fn convert_remote_workspace(
    selector: &str,
    remote: RemoteWorkspaceState,
    remote_programs: &RemoteProgramStore,
) -> Result<WorkspaceState, ClientTerminalError> {
    let pane_ids = remote
        .tabs
        .iter()
        .flat_map(|tab| &tab.panes)
        .map(|pane| pane.id.trim())
        .filter(|pane_id| !pane_id.is_empty())
        .collect::<Vec<_>>();
    remote_programs
        .reconcile_selector(selector, pane_ids)
        .map_err(|error| {
            warn!(error = %error, selector, "failed to reconcile remote terminal program metadata");
            ClientTerminalError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to update remote terminal metadata",
            )
        })?;
    Ok(WorkspaceState {
        selector: selector.to_owned(),
        active_tab_id: non_empty(remote.active_tab_id),
        tabs: remote
            .tabs
            .into_iter()
            .filter(|tab| !tab.id.trim().is_empty())
            .map(|tab| {
                let label = if tab.label.trim().is_empty() {
                    tab.id.clone()
                } else {
                    tab.label.trim().to_owned()
                };
                WorkspaceTabState {
                    id: tab.id,
                    label: label.clone(),
                    custom_label: tab.custom_label.then_some(label),
                    pinned: false,
                    pinned_order: None,
                    active_pane_id: non_empty(tab.active_pane_id),
                    layout: tab.layout.map(remote_layout_to_workspace),
                    panes: tab
                        .panes
                        .into_iter()
                        .filter(|pane| !pane.id.trim().is_empty())
                        .map(|pane| WorkspacePaneState {
                            session_id: pane.id.clone(),
                            program_kind: remote_programs.program_kind(selector, &pane.id).map(
                                |kind| match kind {
                                    RemoteProgramKind::Herdr => "herdr".to_owned(),
                                },
                            ),
                            id: pane.id,
                            status: if pane.exited { "exited" } else { "running" }.to_owned(),
                            session_backend: "webshell".to_owned(),
                            terminal_reply_authority: None,
                            herdr_output_sequence: None,
                            cols: pane.cols,
                            rows: pane.rows,
                        })
                        .collect(),
                }
            })
            .collect(),
    })
}

fn remote_workspace_active_ids(remote: &RemoteWorkspaceState) -> Option<(&str, &str)> {
    let active_tab_id = remote.active_tab_id.trim();
    let tab = remote
        .tabs
        .iter()
        .find(|tab| !active_tab_id.is_empty() && tab.id.trim() == active_tab_id)
        .or_else(|| {
            remote
                .tabs
                .iter()
                .rev()
                .find(|tab| !tab.id.trim().is_empty())
        })?;
    let active_pane_id = tab.active_pane_id.trim();
    let pane = tab
        .panes
        .iter()
        .find(|pane| !active_pane_id.is_empty() && pane.id.trim() == active_pane_id)
        .or_else(|| {
            tab.panes
                .iter()
                .rev()
                .find(|pane| !pane.id.trim().is_empty())
        })?;
    Some((tab.id.trim(), pane.id.trim()))
}

fn remote_program_persistence_error(
    selector: &str,
    pane_id: &str,
    error: &io::Error,
) -> ClientTerminalError {
    warn!(error = %error, selector, pane_id, "failed to persist remote terminal program metadata");
    ClientTerminalError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "failed to update remote terminal metadata",
    )
}

fn remote_session_action_request(
    selector: &str,
    action: WorkspaceAction,
    cols: u16,
    rows: u16,
    output_limit: usize,
) -> WorkspaceActionRequest {
    WorkspaceActionRequest {
        name: selector.to_owned(),
        action,
        tab_id: None,
        pane_id: None,
        direction: None,
        label: None,
        layout: None,
        active_pane_id: None,
        cols: Some(cols),
        rows: Some(rows),
        output_limit: Some(output_limit),
        auto_restart: None,
        session_backend: Some(SessionBackend::Webshell),
        pinned: None,
        pinned_order: None,
    }
}

fn workspace_active_session(
    workspace: &WorkspaceState,
    metadata: HashMap<String, String>,
) -> Option<Session> {
    let tab = workspace
        .active_tab_id
        .as_deref()
        .and_then(|tab_id| workspace.tabs.iter().find(|tab| tab.id == tab_id))
        .or_else(|| workspace.tabs.last())?;
    let pane = tab
        .active_pane_id
        .as_deref()
        .and_then(|pane_id| tab.panes.iter().find(|pane| pane.id == pane_id))
        .or_else(|| tab.panes.last())?;
    Some(session_from_workspace_pane(
        &workspace.selector,
        pane,
        metadata,
    ))
}

fn workspace_sessions(workspace: &WorkspaceState) -> Vec<Session> {
    workspace
        .tabs
        .iter()
        .flat_map(|tab| &tab.panes)
        .map(|pane| {
            session_from_workspace_pane(
                &workspace.selector,
                pane,
                HashMap::from([("sessionBackend".to_owned(), "webshell".to_owned())]),
            )
        })
        .collect()
}

fn workspace_tab_id_for_pane<'a>(workspace: &'a WorkspaceState, pane_id: &str) -> Option<&'a str> {
    workspace
        .tabs
        .iter()
        .find(|tab| tab.panes.iter().any(|pane| pane.id == pane_id))
        .map(|tab| tab.id.as_str())
}

fn session_from_workspace_pane(
    selector: &str,
    pane: &WorkspacePaneState,
    metadata: HashMap<String, String>,
) -> Session {
    Session {
        id: Some(pane.session_id.clone()),
        selector: Some(selector.to_owned()),
        status: Some(pane.status.clone()),
        cols: Some(i32::from(pane.cols)),
        rows: Some(i32::from(pane.rows)),
        metadata,
        ..Default::default()
    }
}

fn remote_workspace_action(
    request: &WorkspaceActionRequest,
    cols: u16,
    rows: u16,
) -> Result<RemoteWorkspaceActionRequest, ClientTerminalError> {
    if request.session_backend.is_some_and(|backend| {
        backend != SessionBackend::Webshell
            && !(backend == SessionBackend::Herdr && request.action == WorkspaceAction::CreateTab)
    }) {
        return Err(ClientTerminalError::bad_request(
            "remote clients support the native WebShell backend only",
        ));
    }
    let action = match request.action {
        WorkspaceAction::CreateTab => "create_tab",
        WorkspaceAction::CloseTab => "close_tab",
        WorkspaceAction::RenameTab => "rename_tab",
        WorkspaceAction::ActivateTab => "activate_tab",
        WorkspaceAction::SplitPane => "split_pane",
        WorkspaceAction::ClosePane => "close_pane",
        WorkspaceAction::ActivatePane => "activate_pane",
        WorkspaceAction::PromotePaneToTab => "move_pane_to_tab",
        WorkspaceAction::UpdateLayout => "update_layout",
        WorkspaceAction::SetTabPinned => {
            return Err(ClientTerminalError::bad_request(
                "remote clients do not support pinned terminal tabs",
            ));
        }
    };
    Ok(RemoteWorkspaceActionRequest {
        action,
        tab_id: request.tab_id.clone().unwrap_or_default(),
        pane_id: request.pane_id.clone().unwrap_or_default(),
        direction: request
            .direction
            .map(remote_split_direction)
            .unwrap_or_default()
            .to_owned(),
        label: request.label.clone().unwrap_or_default(),
        layout: request.layout.as_ref().map(workspace_layout_to_remote),
        active_pane_id: request.active_pane_id.clone().unwrap_or_default(),
        cols,
        rows,
    })
}

fn remote_herdr_rename_action(tab_id: &str, cols: u16, rows: u16) -> RemoteWorkspaceActionRequest {
    RemoteWorkspaceActionRequest {
        action: "rename_tab",
        tab_id: tab_id.to_owned(),
        pane_id: String::new(),
        direction: String::new(),
        label: "Herdr".to_owned(),
        layout: None,
        active_pane_id: String::new(),
        cols,
        rows,
    }
}

fn remote_split_direction(direction: SplitDirection) -> &'static str {
    match direction {
        SplitDirection::Left | SplitDirection::Right => "vertical",
        SplitDirection::Up | SplitDirection::Down => "horizontal",
    }
}

fn remote_layout_to_workspace(node: RemoteWorkspaceLayoutNode) -> WorkspaceLayoutNode {
    match node {
        RemoteWorkspaceLayoutNode::Leaf { pane_id, .. } => WorkspaceLayoutNode::Pane { pane_id },
        RemoteWorkspaceLayoutNode::Split {
            direction,
            children,
            ..
        } => WorkspaceLayoutNode::Split {
            axis: match direction {
                RemoteSplitDirection::Vertical => SplitAxis::Columns,
                RemoteSplitDirection::Horizontal => SplitAxis::Rows,
            },
            children: children
                .into_iter()
                .map(remote_layout_to_workspace)
                .collect(),
        },
    }
}

fn workspace_layout_to_remote(node: &WorkspaceLayoutNode) -> RemoteWorkspaceLayoutNode {
    workspace_layout_to_remote_with_size(node, None)
}

fn workspace_layout_to_remote_with_size(
    node: &WorkspaceLayoutNode,
    size: Option<f64>,
) -> RemoteWorkspaceLayoutNode {
    match node {
        WorkspaceLayoutNode::Pane { pane_id } => RemoteWorkspaceLayoutNode::Leaf {
            pane_id: pane_id.clone(),
            size,
        },
        WorkspaceLayoutNode::Split { axis, children } => {
            let child_size = u32::try_from(children.len())
                .ok()
                .filter(|count| *count > 0)
                .map(|count| 100.0 / f64::from(count));
            RemoteWorkspaceLayoutNode::Split {
                direction: match axis {
                    SplitAxis::Rows => RemoteSplitDirection::Horizontal,
                    SplitAxis::Columns => RemoteSplitDirection::Vertical,
                },
                children: children
                    .iter()
                    .map(|child| workspace_layout_to_remote_with_size(child, child_size))
                    .collect(),
                size,
            }
        }
    }
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::future::pending;
    use std::sync::Arc;
    use std::time::Duration;

    use axum::http::StatusCode;

    use super::{
        ClientTerminalTicket, RemoteBootstrapAction, RemoteBootstrapEvent, RemoteHerdrBootstrap,
        RemoteWorkspaceState, authorize_client_id, await_client_terminal_boundary,
        classify_remote_websocket_failure, client_terminal_url, convert_remote_workspace,
        redact_sensitive_text, remote_access_error, remote_herdr_launch_message,
        remote_herdr_rename_action, remote_session_action_request,
        remote_websocket_failure_payload, remote_workspace_action, sanitize_client_terminal_url,
        terminal_theme_color, translate_remote_control, validate_ticket, websocket_terminal_url,
        workspace_active_session, workspace_sessions, workspace_tab_id_for_pane,
    };
    use crate::database::AppDatabase;
    use crate::lightos_admin::ClientInstanceSummary;
    use crate::remote_program::{RemoteProgramKind, RemoteProgramStore};
    use crate::workspace::{
        SessionBackend, SplitAxis, SplitDirection, WorkspaceAction, WorkspaceActionRequest,
        WorkspaceLayoutNode,
    };

    fn ticket() -> ClientTerminalTicket {
        ClientTerminalTicket {
            client_instance_id: "client-a".to_owned(),
            device_api_url: "https://device.example/root".to_owned(),
            terminal_service_name: "cloud.lazycat.lightos.client-terminal.client-a".to_owned(),
            ticket: "terminal-secret".to_owned(),
        }
    }

    fn remote_program_store() -> RemoteProgramStore {
        let database = Arc::new(
            AppDatabase::open(std::env::temp_dir().join(format!(
                "lazycat-neko-webshell-client-terminal-programs-{}.db",
                uuid::Uuid::new_v4()
            )))
            .expect("test database"),
        );
        RemoteProgramStore::load(database).expect("test remote programs")
    }

    #[test]
    fn validates_ticket_and_builds_redacted_remote_url() {
        let ticket = validate_ticket(ticket(), "client-a").expect("validated ticket");
        let mut url = client_terminal_url(&ticket, "/workspace").expect("workspace URL");
        url.query_pairs_mut().append_pair("ticket", &ticket.ticket);

        assert_eq!(
            url.as_str(),
            "https://device.example/root/s/cloud.lazycat.lightos.client-terminal.client-a/workspace?ticket=terminal-secret"
        );
        assert_eq!(
            sanitize_client_terminal_url(&url),
            "https://device.example/root/s/cloud.lazycat.lightos.client-terminal.client-a/workspace?ticket=%5BREDACTED%5D"
        );
    }

    #[test]
    fn rejects_ticket_for_a_different_client() {
        let error = validate_ticket(ticket(), "client-b").expect_err("mismatched ticket");
        assert!(error.to_string().contains("does not match"));
        assert!(!error.to_string().contains("terminal-secret"));
    }

    #[test]
    fn redacts_ticket_and_device_auth_token_from_remote_errors() {
        let redacted = redact_sensitive_text(
            "request ticket=terminal-secret token=device-auth-secret",
            "terminal-secret",
            "device-auth-secret",
        );
        assert_eq!(redacted, "request ticket=[REDACTED] token=[REDACTED]");
    }

    #[test]
    fn preserves_remote_authentication_and_authorization_statuses() {
        let unauthorized = remote_access_error(StatusCode::UNAUTHORIZED)
            .expect("401 must produce an access error");
        assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);

        let forbidden =
            remote_access_error(StatusCode::FORBIDDEN).expect("403 must produce an access error");
        assert_eq!(forbidden.status, StatusCode::FORBIDDEN);

        assert!(remote_access_error(StatusCode::BAD_GATEWAY).is_none());
    }

    #[tokio::test]
    async fn times_out_a_stalled_device_authentication_boundary() {
        let error = await_client_terminal_boundary(
            Duration::ZERO,
            pending::<()>(),
            "device authentication timed out",
        )
        .await
        .expect_err("pending authentication must time out");

        assert_eq!(error.status, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(error.message, "device authentication timed out");
    }

    #[test]
    fn classifies_remote_websocket_failures_like_the_go_provider() {
        let unavailable = classify_remote_websocket_failure(
            Some(StatusCode::BAD_GATEWAY),
            "upstream unavailable",
            "websocket: bad handshake",
        );
        assert_eq!(
            unavailable.error_code,
            "client_terminal_service_unavailable"
        );
        assert!(unavailable.user_message.contains("target_status=502"));
        assert!(unavailable.user_message.contains("upstream unavailable"));
        assert!(
            unavailable
                .technical_message
                .contains("target_body=upstream unavailable")
        );
        assert_eq!(
            remote_websocket_failure_payload(&unavailable),
            serde_json::json!({
                "type": "process-exit",
                "exit_code": -1,
                "message": unavailable.user_message,
                "technical_message": unavailable.technical_message,
                "error_code": "client_terminal_service_unavailable",
                "retryable": true,
            })
        );

        let forbidden = classify_remote_websocket_failure(
            Some(StatusCode::FORBIDDEN),
            "forbidden",
            "websocket: bad handshake",
        );
        assert_eq!(forbidden.error_code, "client_terminal_forbidden");
        assert_eq!(
            forbidden.user_message,
            "instance is not accessible by current account"
        );
    }

    #[test]
    fn converts_remote_terminal_urls_to_websocket_urls() {
        let secure = reqwest::Url::parse("https://device.example/terminal?ticket=secret")
            .expect("secure URL");
        let plain = reqwest::Url::parse("http://127.0.0.1:8080/terminal").expect("plain URL");

        assert_eq!(
            websocket_terminal_url(&secure).expect("wss URL").scheme(),
            "wss"
        );
        assert_eq!(
            websocket_terminal_url(&plain).expect("ws URL").scheme(),
            "ws"
        );
    }

    #[test]
    fn forwards_only_safe_terminal_theme_colors() {
        assert_eq!(terminal_theme_color(Some(" #aBc123 ")), Some("#aBc123"));
        assert_eq!(terminal_theme_color(Some("rgba(0,0,0,0.5)")), None);
        assert_eq!(terminal_theme_color(Some("#123456?ticket=secret")), None);
        assert_eq!(terminal_theme_color(None), None);
    }

    #[test]
    fn translates_official_history_replay_controls_for_the_current_frontend() {
        let start = translate_remote_control(
            r#"{"type":"history-replay-start","selector":"client:client-a","pane_id":"pane-1","allow_generated_input":true}"#,
            "client:client-a",
            "pane-1",
            12,
        )
        .expect("translated start");
        let start: serde_json::Value = serde_json::from_str(&start).expect("start JSON");
        assert_eq!(start["type"], "replay-start");
        assert_eq!(start["selector"], "client:client-a");
        assert_eq!(start["session_id"], "pane-1");
        assert_eq!(start["replay_after"], 12);
        assert_eq!(start["allow_generated_input"], true);

        let complete = translate_remote_control(
            r#"{"type":"history-replay-complete","selector":"client:client-a","pane_id":"pane-1"}"#,
            "client:client-a",
            "pane-1",
            12,
        )
        .expect("translated complete");
        let complete: serde_json::Value = serde_json::from_str(&complete).expect("complete JSON");
        assert_eq!(complete["type"], "replay-complete");
        assert_eq!(complete["last_sequence"], 12);

        assert_eq!(
            translate_remote_control(
                r#"{"type":"process-exit","exit_code":7}"#,
                "client:client-a",
                "pane-1",
                12,
            )
            .expect("unchanged process exit"),
            r#"{"type":"process-exit","exit_code":7}"#
        );

        let error = translate_remote_control(
            r#"{"type":"history-replay-start","pane_id":"pane-other"}"#,
            "client:client-a",
            "pane-1",
            12,
        )
        .expect_err("mismatched replay must be rejected");
        assert!(error.to_string().contains("identity mismatch"));

        let error = translate_remote_control(
            r#"{"type":"history-replay-start","selector":"client:client-b","pane_id":"pane-1"}"#,
            "client:client-a",
            "pane-1",
            12,
        )
        .expect_err("mismatched selector must be rejected");
        assert!(error.to_string().contains("identity mismatch"));
    }

    #[test]
    fn converts_official_remote_workspace_to_native_webshell_state() {
        let remote: RemoteWorkspaceState = serde_json::from_str(
            r#"{
                "selector":"remote-internal",
                "active_tab_id":"tab-1",
                "tabs":[{
                    "id":"tab-1",
                    "label":"Build",
                    "custom_label":true,
                    "active_pane_id":"pane-1",
                    "layout":{
                        "type":"split",
                        "direction":"vertical",
                        "children":[
                            {"type":"leaf","paneId":"pane-1","size":50},
                            {
                                "type":"split",
                                "direction":"horizontal",
                                "size":50,
                                "children":[
                                    {"type":"leaf","paneId":"pane-2","size":50},
                                    {"type":"leaf","paneId":"pane-3","size":50}
                                ]
                            }
                        ]
                    },
                    "panes":[
                        {"id":"pane-1","cols":120,"rows":32,"exited":false,"exit_code":0},
                        {"id":"pane-2","cols":80,"rows":24,"exited":true,"exit_code":7},
                        {"id":"pane-3","cols":80,"rows":24,"exited":false,"exit_code":0}
                    ]
                }]
            }"#,
        )
        .expect("remote workspace");

        let store = remote_program_store();
        store
            .mark_pending("client:client-a", "pane-2", RemoteProgramKind::Herdr)
            .expect("pending Herdr metadata");
        let workspace = convert_remote_workspace("client:client-a", remote, &store)
            .expect("converted workspace");

        assert_eq!(workspace.selector, "client:client-a");
        assert_eq!(workspace.active_tab_id.as_deref(), Some("tab-1"));
        assert_eq!(workspace.tabs[0].custom_label.as_deref(), Some("Build"));
        assert_eq!(workspace.tabs[0].panes[0].session_id, "pane-1");
        assert_eq!(workspace.tabs[0].panes[0].session_backend, "webshell");
        assert!(
            workspace.tabs[0]
                .panes
                .iter()
                .all(|pane| pane.terminal_reply_authority.is_none())
        );
        assert_eq!(
            workspace.tabs[0].panes[1].program_kind.as_deref(),
            Some("herdr")
        );
        assert_eq!(workspace.tabs[0].panes[0].status, "running");
        assert_eq!(workspace.tabs[0].panes[1].status, "exited");
        assert_eq!(
            serde_json::to_value(workspace.tabs[0].layout.as_ref().expect("layout"))
                .expect("layout JSON"),
            serde_json::json!({
                "type": "split",
                "axis": "columns",
                "children": [
                    {"type": "pane", "paneId": "pane-1"},
                    {
                        "type": "split",
                        "axis": "rows",
                        "children": [
                            {"type": "pane", "paneId": "pane-2"},
                            {"type": "pane", "paneId": "pane-3"}
                        ]
                    }
                ]
            })
        );
    }

    #[test]
    fn remote_workspace_sessions_preserve_proto_selector_and_active_pane() {
        let remote = serde_json::from_value::<RemoteWorkspaceState>(serde_json::json!({
            "selector": "client-a",
            "active_tab_id": "tab-a",
            "tabs": [{
                "id": "tab-a",
                "label": "Shell",
                "active_pane_id": "pane-b",
                "panes": [
                    {"id": "pane-a", "cols": 80, "rows": 24},
                    {"id": "pane-b", "cols": 120, "rows": 32}
                ]
            }]
        }))
        .expect("remote workspace");
        let store = remote_program_store();
        let workspace = convert_remote_workspace("client:client-a", remote, &store)
            .expect("converted workspace");

        let active = workspace_active_session(&workspace, HashMap::new()).expect("active session");
        assert_eq!(active.id.as_deref(), Some("pane-b"));
        assert_eq!(active.selector.as_deref(), Some("client:client-a"));
        assert_eq!(active.cols, Some(120));
        assert_eq!(active.rows, Some(32));

        let sessions = workspace_sessions(&workspace);
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().all(|session| {
            session.selector.as_deref() == Some("client:client-a")
                && session.metadata.get("sessionBackend").map(String::as_str) == Some("webshell")
        }));

        assert_eq!(
            workspace_tab_id_for_pane(&workspace, "pane-b"),
            Some("tab-a")
        );
        assert_eq!(workspace_tab_id_for_pane(&workspace, "pane-missing"), None);
    }

    #[test]
    fn remote_proto_create_session_uses_native_workspace_action() {
        let request = remote_session_action_request(
            "client:client-a",
            WorkspaceAction::CreateTab,
            120,
            32,
            4096,
        );

        assert_eq!(request.name, "client:client-a");
        assert_eq!(request.action, WorkspaceAction::CreateTab);
        assert_eq!(request.session_backend, Some(SessionBackend::Webshell));
        assert_eq!(request.cols, Some(120));
        assert_eq!(request.rows, Some(32));
        assert_eq!(request.output_limit, Some(4096));
    }

    #[test]
    fn remote_herdr_create_uses_native_create_tab() {
        let mut request = remote_session_action_request(
            "client:client-a",
            WorkspaceAction::CreateTab,
            120,
            32,
            5000,
        );
        request.session_backend = Some(SessionBackend::Herdr);
        let outbound = remote_workspace_action(&request, 120, 32).unwrap();
        assert_eq!(outbound.action, "create_tab");
        let rename = remote_herdr_rename_action("tab-1", 120, 32);
        assert_eq!(rename.action, "rename_tab");
        assert_eq!(rename.tab_id, "tab-1");
        assert_eq!(rename.label, "Herdr");
    }

    #[test]
    fn remote_herdr_is_rejected_for_non_create_actions() {
        let mut request = remote_session_action_request(
            "client:client-a",
            WorkspaceAction::SplitPane,
            120,
            32,
            5000,
        );
        request.session_backend = Some(SessionBackend::Herdr);
        request.tab_id = Some("tab-1".to_owned());
        request.pane_id = Some("pane-1".to_owned());
        request.direction = Some(SplitDirection::Right);
        let error = remote_workspace_action(&request, 120, 32)
            .expect_err("remote Herdr split must remain unsupported");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn remote_herdr_bootstrap_waits_for_replay_complete_and_runs_once() {
        let mut bootstrap = RemoteHerdrBootstrap::pending();
        assert_eq!(
            bootstrap.observe(RemoteBootstrapEvent::ReplayStart),
            RemoteBootstrapAction::None,
        );
        assert_eq!(
            bootstrap.observe(RemoteBootstrapEvent::ReplayComplete),
            RemoteBootstrapAction::SendHerdr,
        );
        bootstrap.mark_sent();
        assert_eq!(
            bootstrap.observe(RemoteBootstrapEvent::ControlRejected),
            RemoteBootstrapAction::RevertPending,
        );
        assert_eq!(
            bootstrap.observe(RemoteBootstrapEvent::ReplayComplete),
            RemoteBootstrapAction::None,
        );

        let mut running = RemoteHerdrBootstrap::pending();
        assert_eq!(
            running.observe(RemoteBootstrapEvent::ReplayComplete),
            RemoteBootstrapAction::SendHerdr,
        );
        running.mark_sent();
        assert_eq!(
            running.observe(RemoteBootstrapEvent::TerminalOutput),
            RemoteBootstrapAction::None,
        );
        assert_eq!(
            running.observe(RemoteBootstrapEvent::ControlRejected),
            RemoteBootstrapAction::None,
        );
    }

    #[test]
    fn remote_herdr_bootstrap_uses_normal_terminal_input() {
        let tokio_tungstenite::tungstenite::Message::Text(payload) =
            remote_herdr_launch_message().expect("bootstrap message")
        else {
            panic!("bootstrap must be a text control message");
        };
        let value =
            serde_json::from_str::<serde_json::Value>(payload.as_str()).expect("bootstrap JSON");
        assert_eq!(value["type"], "input");
        assert_eq!(
            value["data"],
            "if command -v herdr >/dev/null 2>&1; then exec herdr; elif [ -x \"$HOME/.local/bin/herdr\" ]; then exec \"$HOME/.local/bin/herdr\"; else printf '%s\\n' 'Herdr is not installed on this remote device.'; exit 127; fi\r"
        );
    }

    #[test]
    fn authorizes_only_visible_remote_clients() {
        let visible = vec![ClientInstanceSummary {
            id: "client-a".to_owned(),
            name: "Alice PC".to_owned(),
            platform: "darwin".to_owned(),
            status: "running".to_owned(),
            owner_user_id: "alice".to_owned(),
        }];

        assert_eq!(
            authorize_client_id("client:client-a", &visible).expect("visible client"),
            "client-a"
        );
        let error = authorize_client_id("client:client-b", &visible).expect_err("hidden client");
        assert_eq!(error.status, axum::http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn forwards_only_supported_remote_workspace_actions() {
        let request = WorkspaceActionRequest {
            name: "client:client-a".to_owned(),
            action: WorkspaceAction::CreateTab,
            tab_id: None,
            pane_id: None,
            direction: None,
            label: Some("Build".to_owned()),
            layout: None,
            active_pane_id: None,
            cols: Some(120),
            rows: Some(32),
            output_limit: None,
            auto_restart: None,
            session_backend: Some(SessionBackend::Webshell),
            pinned: None,
            pinned_order: None,
        };
        let outbound = remote_workspace_action(&request, 120, 32).expect("remote action");
        let value = serde_json::to_value(outbound).expect("action JSON");
        assert_eq!(value["action"], "create_tab");
        assert_eq!(value["label"], "Build");
        assert_eq!(value["cols"], 120);
        assert!(value.get("name").is_none());

        let layout_request = WorkspaceActionRequest {
            name: "client:client-a".to_owned(),
            action: WorkspaceAction::UpdateLayout,
            tab_id: Some("tab-1".to_owned()),
            pane_id: None,
            direction: None,
            label: None,
            layout: Some(WorkspaceLayoutNode::Split {
                axis: SplitAxis::Columns,
                children: vec![
                    WorkspaceLayoutNode::Pane {
                        pane_id: "pane-1".to_owned(),
                    },
                    WorkspaceLayoutNode::Pane {
                        pane_id: "pane-2".to_owned(),
                    },
                ],
            }),
            active_pane_id: Some("pane-2".to_owned()),
            cols: Some(120),
            rows: Some(32),
            output_limit: None,
            auto_restart: None,
            session_backend: Some(SessionBackend::Webshell),
            pinned: None,
            pinned_order: None,
        };
        let layout =
            remote_workspace_action(&layout_request, 120, 32).expect("remote layout action");
        let layout = serde_json::to_value(layout).expect("layout action JSON");
        assert_eq!(
            layout["layout"],
            serde_json::json!({
                "type": "split",
                "direction": "vertical",
                "children": [
                    {"type": "leaf", "paneId": "pane-1", "size": 50.0},
                    {"type": "leaf", "paneId": "pane-2", "size": 50.0}
                ]
            })
        );

        let unsupported = WorkspaceActionRequest {
            session_backend: Some(SessionBackend::Zellij),
            ..request
        };
        let error = remote_workspace_action(&unsupported, 120, 32)
            .expect_err("zellij must not be forwarded to a remote client");
        assert!(error.to_string().contains("native WebShell"));
    }

    #[test]
    fn translates_pane_promotion_to_the_go_workspace_action() {
        let request = WorkspaceActionRequest {
            name: "client:client-a".to_owned(),
            action: WorkspaceAction::PromotePaneToTab,
            tab_id: Some("tab-1".to_owned()),
            pane_id: Some("pane-2".to_owned()),
            direction: None,
            label: None,
            layout: None,
            active_pane_id: None,
            cols: Some(120),
            rows: Some(32),
            output_limit: None,
            auto_restart: None,
            session_backend: Some(SessionBackend::Webshell),
            pinned: None,
            pinned_order: None,
        };

        let outbound = remote_workspace_action(&request, 120, 32).expect("remote action");
        let value = serde_json::to_value(outbound).expect("action JSON");

        assert_eq!(value["action"], "move_pane_to_tab");
        assert_eq!(value["tab_id"], "tab-1");
        assert_eq!(value["pane_id"], "pane-2");
    }

    #[test]
    fn translates_directional_splits_to_the_go_workspace_axis() {
        for (direction, expected) in [
            (crate::workspace::SplitDirection::Left, "vertical"),
            (crate::workspace::SplitDirection::Right, "vertical"),
            (crate::workspace::SplitDirection::Up, "horizontal"),
            (crate::workspace::SplitDirection::Down, "horizontal"),
        ] {
            let request = WorkspaceActionRequest {
                name: "client:client-a".to_owned(),
                action: WorkspaceAction::SplitPane,
                tab_id: Some("tab-1".to_owned()),
                pane_id: Some("pane-1".to_owned()),
                direction: Some(direction),
                label: None,
                layout: None,
                active_pane_id: None,
                cols: Some(120),
                rows: Some(32),
                output_limit: None,
                auto_restart: None,
                session_backend: Some(SessionBackend::Webshell),
                pinned: None,
                pinned_order: None,
            };

            let outbound = remote_workspace_action(&request, 120, 32).expect("remote action");
            let value = serde_json::to_value(outbound).expect("action JSON");
            assert_eq!(value["direction"], expected);
        }
    }
}
