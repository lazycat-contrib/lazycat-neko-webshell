use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow};
use axum::Json;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{broadcast, oneshot};
use tokio::time::{MissedTickBehavior, interval, timeout};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::agent_client::ensure_agent;
use crate::agent_protocol::{
    detach_frame, history_recording_frame, input_frame, read_agent_frame_async, resize_frame,
    write_agent_frame_async,
};
use crate::client_terminal;
use crate::config::{DEFAULT_COLS, DEFAULT_ROWS, LIGHTOSCTL, MAX_CLIPBOARD_IMAGE_BYTES};
use crate::lightos;
use crate::lightos_admin;
use crate::proto::lazycat::webshell::v1::{
    AgentControlType, AgentFrame, AgentFrameType, AgentWorkspaceState,
};
use crate::ssh_backend;
use crate::state::{AppState, mark_session_status, sync_session_login_user};
use crate::terminal_control::TerminalControlSnapshot;
use crate::terminal_manager::{
    CONNECTION_TERMINAL_CLOSE_TIMEOUT, ManagedTerminal, OutputBuffer, OutputFrame, OutputSnapshot,
    RetryableConnectionTerminalError, TerminalEvent, TerminalSpec,
};
use crate::tty_init::lightos_features_enabled;
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};

type TerminalSender = SplitSink<WebSocket, Message>;
type TerminalReceiver = SplitStream<WebSocket>;

const CLIPBOARD_IMAGE_STAGE_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECTION_TERMINAL_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(45);
const CONNECTION_TERMINAL_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const CONNECTION_TERMINAL_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_REPLAY_DEFERRED_MESSAGES: usize = 64;
const MAX_REPLAY_DEFERRED_BYTES: usize = 512 * 1024;
const TERMINAL_SOCKET_SEND_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_WEBSOCKET_MAX_MESSAGE_BYTES: usize = MAX_CLIPBOARD_IMAGE_BYTES;

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    session_id: Option<String>,
    name: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    restart: Option<String>,
    replay: Option<String>,
    after: Option<u64>,
    output_limit: Option<usize>,
    terminal_reply_authority: Option<String>,
    pane_id: Option<String>,
    backend: Option<String>,
    control_mode: Option<String>,
    fg: Option<String>,
    bg: Option<String>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ClipboardImageUploadQuery {
    name: String,
    extension: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    ClipboardImage { extension: String, size: usize },
    RestartPolicy { enabled: bool },
    OutputBuffer { limit: usize },
    HistoryRecording { enabled: bool },
    TakeControl { request_id: Option<String> },
    ReleaseControl { request_id: Option<String> },
    Close,
}

#[derive(Debug)]
struct PendingClipboardImage {
    extension: String,
    size: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardImageUploadResponse {
    path: String,
    size: usize,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum TerminalServerMessage<'a> {
    Ready {
        session_id: &'a str,
        selector: &'a str,
        cols: u16,
        rows: u16,
    },
    Error {
        message: String,
        fatal: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        retryable: Option<bool>,
    },
    ProcessExit {
        exit_code: i32,
        message: Option<String>,
    },
    SessionStopped {
        message: String,
    },
    OutputSequence {
        sequence: u64,
    },
    ReplayStart {
        session_id: &'a str,
        selector: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        pane_id: Option<&'a str>,
        replay_after: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        replay_mode: Option<&'a str>,
        #[serde(skip_serializing_if = "is_false")]
        replay_gap: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        oldest_sequence: Option<u64>,
    },
    ReplayComplete {
        session_id: &'a str,
        selector: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        pane_id: Option<&'a str>,
        last_sequence: u64,
    },
    ControlState {
        session_id: &'a str,
        connection_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        controller_id: Option<&'a str>,
        controller: bool,
        connection_count: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        control_action: Option<&'a str>,
    },
}

fn is_false(value: &bool) -> bool {
    !*value
}

enum TerminalAttachTarget {
    Agent(AgentTerminalAttachTarget),
    Managed(ManagedTerminalAttachTarget),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClientReplyAuthority {
    Client,
    Server,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedTerminalLifetime {
    Persistent,
    Connection,
}

impl ManagedTerminalLifetime {
    fn replay_enabled(self, requested: bool) -> bool {
        requested || self == Self::Connection
    }

    fn replay_after(self, requested: u64) -> u64 {
        match self {
            Self::Persistent => requested,
            Self::Connection => 0,
        }
    }

    fn marks_spawn_failure_stopped(self) -> bool {
        self == Self::Persistent
    }
}

fn managed_terminal_lifetime(backend: &str) -> ManagedTerminalLifetime {
    if backend == "herdr" {
        ManagedTerminalLifetime::Connection
    } else {
        ManagedTerminalLifetime::Persistent
    }
}

fn validate_terminal_backend(requested: &str, persisted: &str) -> anyhow::Result<()> {
    if requested == persisted {
        return Ok(());
    }
    Err(anyhow!(
        "terminal backend mismatch: requested {requested}, session uses {persisted}"
    ))
}

struct ManagedTerminalAttachTarget {
    spec: TerminalSpec,
    allow_spawn: bool,
    resize_existing: bool,
    replay: bool,
    replay_after: u64,
    lifetime: ManagedTerminalLifetime,
    pane_id: Option<String>,
    output: Option<Arc<OutputBuffer>>,
    control: TerminalControlGuard,
    client_reply_authority: ClientReplyAuthority,
}

struct AgentTerminalAttachTarget {
    selector: String,
    username: String,
    pane_id: Option<String>,
    cols: u16,
    rows: u16,
    replay_after: u64,
    output_limit: usize,
    control: TerminalControlGuard,
    client_reply_authority: ClientReplyAuthority,
}

#[derive(Clone, Debug)]
struct TerminalControlGuard {
    enabled: bool,
    session_id: String,
    connection_id: String,
    controller_on_attach: bool,
}

struct TerminalControlLease {
    state: Arc<AppState>,
    control: TerminalControlGuard,
}

impl TerminalControlLease {
    fn new(state: Arc<AppState>, control: TerminalControlGuard) -> Self {
        Self { state, control }
    }
}

impl Drop for TerminalControlLease {
    fn drop(&mut self) {
        self.control.disconnect(&self.state);
    }
}

impl TerminalControlGuard {
    fn disabled() -> Self {
        Self {
            enabled: false,
            session_id: String::new(),
            connection_id: String::new(),
            controller_on_attach: true,
        }
    }

    fn allows_write(&self, state: &AppState) -> bool {
        !self.enabled
            || state
                .terminal_control
                .is_controller(&self.session_id, &self.connection_id)
    }

    fn allows_attach_resize(&self) -> bool {
        !self.enabled || self.controller_on_attach
    }

    fn take_control(&self, state: &AppState) -> anyhow::Result<Option<TerminalControlSnapshot>> {
        if !self.enabled {
            return Ok(None);
        }
        state
            .terminal_control
            .take_control(&self.session_id, &self.connection_id)
            .map(Some)
    }

    fn release_control(&self, state: &AppState) -> anyhow::Result<Option<TerminalControlSnapshot>> {
        if !self.enabled {
            return Ok(None);
        }
        state
            .terminal_control
            .release_control(&self.session_id, &self.connection_id)
            .map(Some)
    }

    fn disconnect(&self, state: &AppState) {
        if !self.enabled {
            return;
        }
        let _ = state
            .terminal_control
            .disconnect(&self.session_id, &self.connection_id);
    }

    fn subscribe(&self, state: &AppState) -> Option<broadcast::Receiver<()>> {
        if !self.enabled {
            return None;
        }
        state.terminal_control.subscribe(&self.session_id)
    }
}

struct TerminalReplayContext<'a> {
    session_id: &'a str,
    selector: &'a str,
    cols: u16,
    rows: u16,
    replay: bool,
    replay_after: u64,
    pane_id: Option<&'a str>,
    output: &'a OutputBuffer,
    connection_id: Option<&'a str>,
}

struct ReplayInputCapture {
    receiver: TerminalReceiver,
    deferred: VecDeque<Message>,
}

enum ReplayInputDisposition {
    Handled,
    Deferred {
        message: Message,
        blocks_input: bool,
    },
}

pub async fn terminal_ws(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "invalid websocket origin").into_response();
    }
    let ws = ws.max_message_size(TERMINAL_WEBSOCKET_MAX_MESSAGE_BYTES);

    if query
        .name
        .as_deref()
        .is_some_and(lightos_admin::is_client_selector)
    {
        let selector = query.name.as_deref().unwrap_or_default().trim();
        let backend = query.backend.as_deref().unwrap_or("webshell").trim();
        if backend != "webshell" {
            return (
                StatusCode::BAD_REQUEST,
                "remote clients support the native WebShell backend only",
            )
                .into_response();
        }
        let pane_id = query.pane_id.as_deref().unwrap_or_default().trim();
        let cols = query.cols.unwrap_or(DEFAULT_COLS);
        let rows = query.rows.unwrap_or(DEFAULT_ROWS);
        if let Err(error) = validate_size(cols, rows) {
            return (StatusCode::BAD_REQUEST, error.to_string()).into_response();
        }
        let remote = match client_terminal::connect_terminal(
            &headers,
            selector,
            pane_id,
            client_terminal::RemoteTerminalConnectOptions {
                cols,
                rows,
                replay_after: query.after.unwrap_or(0),
                foreground: query.fg.as_deref(),
                background: query.bg.as_deref(),
                cursor: query.cursor.as_deref(),
            },
            Arc::clone(&state.remote_programs),
        )
        .await
        {
            Ok(remote) => remote,
            Err(error) => return error.into_response(),
        };
        return ws.on_upgrade(move |socket| async move {
            if let Err(error) = client_terminal::relay_terminal_socket(socket, remote).await {
                warn!(error = %error, "remote client terminal websocket ended with error");
            }
        });
    }

    let client_reply_authority =
        match parse_client_reply_authority(query.terminal_reply_authority.as_deref()) {
            Ok(authority) => authority,
            Err(error) => {
                return (StatusCode::UPGRADE_REQUIRED, error.to_string()).into_response();
            }
        };

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_terminal_socket(socket, state, query, client_reply_authority).await
        {
            warn!(error = %err, "terminal websocket ended with error");
        }
    })
}

pub async fn upload_clipboard_image(
    Query(query): Query<ClipboardImageUploadQuery>,
    body: Bytes,
) -> Response {
    let selector = query.name.trim();
    if selector.is_empty() {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    }
    if ssh_backend::is_ssh_selector(selector) {
        return (
            StatusCode::BAD_REQUEST,
            "clipboard image staging is not supported for SSH terminals",
        )
            .into_response();
    }
    if !lightos_features_enabled() {
        return (StatusCode::NOT_FOUND, "LightOS integration is disabled").into_response();
    }
    if let Err(err) = validate_selector(selector) {
        return (
            StatusCode::BAD_REQUEST,
            err.message
                .unwrap_or_else(|| "invalid LightOS selector".to_owned()),
        )
            .into_response();
    }
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "clipboard image payload is empty").into_response();
    }
    if body.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            format!("clipboard image exceeds {MAX_CLIPBOARD_IMAGE_BYTES} bytes"),
        )
            .into_response();
    }
    if let Err(err) = authorize_terminal_selector(selector, true).await {
        return (StatusCode::FORBIDDEN, err.to_string()).into_response();
    }

    let extension = query.extension.as_deref().unwrap_or("png");
    let remote_path = remote_clipboard_image_path(extension);
    match stage_clipboard_image(selector, &remote_path, body.as_ref()).await {
        Ok(()) => (
            StatusCode::CREATED,
            Json(ClipboardImageUploadResponse {
                path: remote_path,
                size: body.len(),
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            format!("failed to stage clipboard image: {err}"),
        )
            .into_response(),
    }
}

#[allow(clippy::too_many_lines)] // Keeps managed-terminal setup and cleanup ordering auditable.
async fn handle_terminal_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    query: TerminalQuery,
    client_reply_authority: ClientReplyAuthority,
) -> anyhow::Result<()> {
    let (mut sender, receiver) = socket.split();
    let connection_scoped_request = query
        .backend
        .as_deref()
        .is_some_and(|backend| backend.trim() == "herdr");
    let target = match resolve_terminal_target(&state, &query, client_reply_authority).await {
        Ok(target) => target,
        Err(err) => {
            let message = err.to_string();
            let _ = send_terminal_error_with_policy(
                &mut sender,
                message,
                true,
                connection_scoped_request,
            )
            .await;
            return Err(err);
        }
    };
    let target = match target {
        TerminalAttachTarget::Agent(target) => {
            return serve_agent_terminal(sender, receiver, state, target).await;
        }
        TerminalAttachTarget::Managed(target) => {
            if target.client_reply_authority != ClientReplyAuthority::Server {
                let error =
                    anyhow!("terminal client reply authority is stale; reload the application");
                target.control.disconnect(&state);
                send_terminal_error_with_policy(
                    &mut sender,
                    error.to_string(),
                    true,
                    target.lifetime == ManagedTerminalLifetime::Connection,
                )
                .await?;
                return Err(error);
            }
            target
        }
    };
    let ready_cols = target.spec.cols;
    let ready_rows = target.spec.rows;
    let replay_after = target.replay_after;
    let replay = target.replay;
    let lifetime = target.lifetime;
    let persisted_replay_output = target.output;
    let pane_id = target.pane_id.clone();
    let allow_spawn = target.allow_spawn;
    let resize_existing = target.resize_existing;
    let control = target.control.clone();
    let session_id = target.spec.session_id.clone();
    let target_selector = target.spec.selector.clone();
    let terminal_result = match lifetime {
        ManagedTerminalLifetime::Persistent => state
            .sessions
            .open_terminal(target.spec, allow_spawn, resize_existing)
            .map(|terminal| (terminal, None)),
        ManagedTerminalLifetime::Connection if allow_spawn => state
            .sessions
            .open_connection_terminal(target.spec)
            .map(|(connection_id, terminal)| (terminal, Some(connection_id))),
        ManagedTerminalLifetime::Connection => Err(anyhow!("terminal process is not running")),
    };
    let (terminal, connection_id) = match terminal_result {
        Ok(terminal) => terminal,
        Err(err) => {
            if !allow_spawn
                && replay
                && let Some(replay_output) = persisted_replay_output.as_deref()
            {
                let replay_context = TerminalReplayContext {
                    session_id: &session_id,
                    selector: &target_selector,
                    cols: ready_cols,
                    rows: ready_rows,
                    replay,
                    replay_after,
                    pane_id: pane_id.as_deref(),
                    output: replay_output,
                    connection_id: None,
                };
                replay_stopped_terminal(&mut sender, &replay_context).await?;
                control.disconnect(&state);
                return Ok(());
            }
            if allow_spawn && lifetime.marks_spawn_failure_stopped() {
                state.sessions.mark_status(&session_id, "stopped");
            }
            let message = err.to_string();
            control.disconnect(&state);
            let retryable_open = lifetime == ManagedTerminalLifetime::Connection
                && err
                    .downcast_ref::<RetryableConnectionTerminalError>()
                    .is_some();
            let _ = send_terminal_error_with_policy(
                &mut sender,
                message,
                !retryable_open,
                lifetime == ManagedTerminalLifetime::Connection,
            )
            .await;
            return Err(err);
        }
    };
    let replay_output = match lifetime {
        ManagedTerminalLifetime::Persistent => persisted_replay_output
            .ok_or_else(|| anyhow!("persistent terminal replay buffer is unavailable"))?,
        ManagedTerminalLifetime::Connection => terminal.output_buffer(),
    };
    let replay_context = TerminalReplayContext {
        session_id: &session_id,
        selector: &target_selector,
        cols: ready_cols,
        rows: ready_rows,
        replay,
        replay_after,
        pane_id: pane_id.as_deref(),
        output: replay_output.as_ref(),
        connection_id: connection_id.as_deref(),
    };
    let serve_result = serve_open_terminal(
        sender,
        receiver,
        Arc::clone(&state),
        Arc::clone(&terminal),
        &replay_context,
        control,
        lifetime,
    )
    .await;
    if let Some(connection_id) = connection_id {
        let cleanup_state = Arc::clone(&state);
        let close_session_id = session_id.clone();
        let close_task = tokio::task::spawn_blocking(move || {
            let closed = terminal.close_connection(CONNECTION_TERMINAL_CLOSE_TIMEOUT);
            let released = cleanup_state
                .sessions
                .release_connection_terminal(&session_id, &connection_id);
            drop(released);
            closed
        });
        match timeout(CONNECTION_TERMINAL_CLOSE_TIMEOUT, close_task).await {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => {
                warn!(
                    session_id = %close_session_id,
                    "connection terminal cleanup completed with detached workers"
                );
            }
            Ok(Err(error)) => {
                warn!(
                    session_id = %close_session_id,
                    error = %error,
                    "connection terminal cleanup task failed"
                );
            }
            Err(_) => {
                warn!(
                    session_id = %close_session_id,
                    "connection terminal cleanup exceeded timeout"
                );
            }
        }
    }
    serve_result
}

#[allow(clippy::too_many_lines)] // Keeps replay and live connection lifecycle in one ordered flow.
async fn serve_open_terminal(
    mut sender: TerminalSender,
    mut receiver: TerminalReceiver,
    state: Arc<AppState>,
    terminal: Arc<ManagedTerminal>,
    replay_context: &TerminalReplayContext<'_>,
    control: TerminalControlGuard,
    lifetime: ManagedTerminalLifetime,
) -> anyhow::Result<()> {
    let _control_lease = TerminalControlLease::new(Arc::clone(&state), control.clone());
    let bounded_send = lifetime == ManagedTerminalLifetime::Connection;
    let mut event_rx = terminal.subscribe();
    let mut control_rx = control.subscribe(&state);
    send_control_with_policy(
        &mut sender,
        &TerminalServerMessage::Ready {
            session_id: terminal.session_id(),
            selector: terminal.selector(),
            cols: replay_context.cols,
            rows: replay_context.rows,
        },
        bounded_send,
    )
    .await?;
    send_terminal_control_state_with_policy(&mut sender, &state, &control, bounded_send).await?;
    if let Some(info) = terminal.exit_info() {
        if lifetime == ManagedTerminalLifetime::Persistent {
            mark_session_status(&state, terminal.session_id(), "exited");
            state.sessions.forget_terminal(terminal.session_id());
        }
        send_terminal_process_exit(&mut sender, info, bounded_send).await?;
        return Ok(());
    }
    if lifetime == ManagedTerminalLifetime::Persistent {
        mark_session_status(&state, terminal.session_id(), "running");
    }

    let mut last_sent_sequence = replay_context.replay_after;
    let mut pending_clipboard_image = None;
    let bootstrap_deadline = (lifetime == ManagedTerminalLifetime::Connection)
        .then(|| Instant::now() + CONNECTION_TERMINAL_BOOTSTRAP_TIMEOUT);
    if replay_context.replay {
        let (replay_done_tx, replay_done_rx) = oneshot::channel();
        let mut replay_input_task = tokio::spawn(capture_input_during_replay(
            receiver,
            Arc::clone(&state),
            Arc::clone(&terminal),
            control.clone(),
            replay_done_rx,
        ));
        let replay = send_replay_snapshot(
            &mut sender,
            &terminal,
            replay_context.pane_id,
            replay_context.output,
            replay_context.replay_after,
            lifetime == ManagedTerminalLifetime::Connection,
        );
        let replay_result = if let Some(deadline) = bootstrap_deadline {
            if let Ok(result) =
                timeout(deadline.saturating_duration_since(Instant::now()), replay).await
            {
                result
            } else {
                let _ = replay_done_tx.send(());
                replay_input_task.abort();
                let _ = replay_input_task.await;
                return Err(report_connection_bootstrap_timeout(&mut sender).await);
            }
        } else {
            replay.await
        };
        let _ = replay_done_tx.send(());
        let captured = if let Some(deadline) = bootstrap_deadline {
            if let Ok(result) = timeout(
                deadline.saturating_duration_since(Instant::now()),
                &mut replay_input_task,
            )
            .await
            {
                result.context("failed to capture terminal input during replay")??
            } else {
                let error = report_connection_bootstrap_timeout(&mut sender).await;
                replay_input_task.abort();
                let _ = replay_input_task.await;
                return Err(error);
            }
        } else {
            replay_input_task
                .await
                .context("failed to capture terminal input during replay")??
        };
        receiver = captured.receiver;
        let Some(sequence) = replay_result? else {
            return Ok(());
        };
        last_sent_sequence = sequence;
        for message in captured.deferred {
            let deferred = handle_terminal_client_message(
                &mut sender,
                &state,
                &terminal,
                &control,
                &mut pending_clipboard_image,
                message,
                bounded_send,
            );
            let keep_open = if let Some(deadline) = bootstrap_deadline {
                match timeout(deadline.saturating_duration_since(Instant::now()), deferred).await {
                    Ok(result) => result?,
                    Err(_) => {
                        return Err(report_connection_bootstrap_timeout(&mut sender).await);
                    }
                }
            } else {
                deferred.await?
            };
            if !keep_open {
                return Ok(());
            }
        }
    }
    if lifetime == ManagedTerminalLifetime::Connection {
        replay_context.output.disable_transient_history();
        if let Some(connection_id) = replay_context.connection_id {
            state
                .sessions
                .mark_connection_terminal_running(terminal.session_id(), connection_id);
        }
    }

    let mut heartbeat = (lifetime == ManagedTerminalLifetime::Connection).then(|| {
        let mut heartbeat = interval(CONNECTION_TERMINAL_HEARTBEAT_INTERVAL);
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        heartbeat
    });
    if let Some(heartbeat) = heartbeat.as_mut() {
        heartbeat.tick().await;
    }
    let mut client_last_seen = Instant::now();
    loop {
        tokio::select! {
            event = event_rx.recv() => {
                if !handle_terminal_event(
                    &mut sender,
                    &state,
                    &terminal,
                    event,
                    &mut last_sent_sequence,
                    lifetime == ManagedTerminalLifetime::Persistent,
                ).await? {
                    break;
                }
            }
            update = recv_terminal_control_update(&mut control_rx) => {
                match update {
                    Some(Ok(()) | Err(broadcast::error::RecvError::Lagged(_))) => {
                        send_terminal_control_state_with_policy(
                            &mut sender,
                            &state,
                            &control,
                            bounded_send,
                        ).await?;
                    }
                    Some(Err(broadcast::error::RecvError::Closed)) | None => {}
                }
            }
            message = receiver.next() => {
                let Some(message) = message else {
                    break;
                };
                client_last_seen = Instant::now();
                if !handle_terminal_client_message(
                    &mut sender,
                    &state,
                    &terminal,
                    &control,
                    &mut pending_clipboard_image,
                    message?,
                    bounded_send,
                ).await? {
                    break;
                }
            }
            () = connection_terminal_heartbeat_tick(&mut heartbeat) => {
                if client_last_seen.elapsed() >= CONNECTION_TERMINAL_IDLE_TIMEOUT {
                    warn!(
                        session_id = terminal.session_id(),
                        "closing idle connection terminal"
                    );
                    break;
                }
                if send_connection_terminal_message(&mut sender, Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
            else => break,
        }
    }

    Ok(())
}

async fn capture_input_during_replay(
    mut receiver: TerminalReceiver,
    state: Arc<AppState>,
    terminal: Arc<ManagedTerminal>,
    control: TerminalControlGuard,
    mut replay_done: oneshot::Receiver<()>,
) -> anyhow::Result<ReplayInputCapture> {
    let mut deferred = VecDeque::new();
    let mut deferred_bytes = 0;
    let mut input_blocked = false;
    loop {
        tokio::select! {
            _ = &mut replay_done => break,
            message = receiver.next() => {
                let Some(message) = message else {
                    break;
                };
                let message = message?;
                if input_blocked {
                    let stop_capture = is_terminal_close_message(&message);
                    push_replay_deferred_message(&mut deferred, &mut deferred_bytes, message)?;
                    if stop_capture {
                        break;
                    }
                    continue;
                }
                match handle_input_during_replay(&state, &terminal, &control, message)? {
                    ReplayInputDisposition::Handled => {}
                    ReplayInputDisposition::Deferred { message, blocks_input } => {
                        let stop_capture = is_terminal_close_message(&message);
                        input_blocked = blocks_input;
                        push_replay_deferred_message(&mut deferred, &mut deferred_bytes, message)?;
                        if stop_capture {
                            break;
                        }
                    }
                }
            }
        }
    }
    Ok(ReplayInputCapture { receiver, deferred })
}

fn push_replay_deferred_message(
    deferred: &mut VecDeque<Message>,
    deferred_bytes: &mut usize,
    message: Message,
) -> anyhow::Result<()> {
    let message_bytes = terminal_message_bytes(&message);
    if deferred.len() >= MAX_REPLAY_DEFERRED_MESSAGES
        || deferred_bytes.saturating_add(message_bytes) > MAX_REPLAY_DEFERRED_BYTES
    {
        return Err(anyhow!(
            "terminal replay input queue exceeded its bounded window"
        ));
    }
    *deferred_bytes = deferred_bytes.saturating_add(message_bytes);
    deferred.push_back(message);
    Ok(())
}

fn terminal_message_bytes(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(data) | Message::Ping(data) | Message::Pong(data) => data.len(),
        Message::Close(frame) => frame.as_ref().map_or(0, |frame| frame.reason.len()),
    }
}

fn is_terminal_close_message(message: &Message) -> bool {
    match message {
        Message::Close(_) => true,
        Message::Text(text) => serde_json::from_str::<TerminalClientMessage>(text)
            .is_ok_and(|message| matches!(message, TerminalClientMessage::Close)),
        Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => false,
    }
}

fn handle_input_during_replay(
    state: &AppState,
    terminal: &ManagedTerminal,
    control: &TerminalControlGuard,
    message: Message,
) -> anyhow::Result<ReplayInputDisposition> {
    match message {
        Message::Binary(data) if control.allows_write(state) => {
            terminal.write_input(data.to_vec())?;
            Ok(ReplayInputDisposition::Handled)
        }
        Message::Text(text) if text.starts_with("input:") && control.allows_write(state) => {
            let data = text.strip_prefix("input:").unwrap_or_default();
            terminal.write_input(data.as_bytes().to_vec())?;
            Ok(ReplayInputDisposition::Handled)
        }
        Message::Text(text) if text.starts_with("resize:") && control.allows_write(state) => {
            let size = text.strip_prefix("resize:").unwrap_or_default();
            let (cols, rows) = parse_resize_payload(size)?;
            terminal.resize(cols, rows)?;
            state
                .sessions
                .persist_resize(terminal.session_id(), cols, rows)?;
            Ok(ReplayInputDisposition::Handled)
        }
        Message::Text(text) => {
            let Ok(control_message) = serde_json::from_str::<TerminalClientMessage>(&text) else {
                return Ok(ReplayInputDisposition::Deferred {
                    message: Message::Text(text),
                    blocks_input: false,
                });
            };
            let handled = match control_message {
                TerminalClientMessage::Input { data } if control.allows_write(state) => {
                    terminal.write_input(data.into_bytes())?;
                    true
                }
                TerminalClientMessage::Resize { cols, rows } if control.allows_write(state) => {
                    terminal.resize(cols, rows)?;
                    state
                        .sessions
                        .persist_resize(terminal.session_id(), cols, rows)?;
                    true
                }
                TerminalClientMessage::RestartPolicy { enabled } => {
                    state
                        .sessions
                        .set_restartable(terminal.session_id(), enabled)?;
                    true
                }
                TerminalClientMessage::OutputBuffer { limit } => {
                    let limit = state
                        .sessions
                        .set_output_frame_limit(terminal.session_id(), limit)?;
                    terminal.set_output_frame_limit(limit);
                    true
                }
                TerminalClientMessage::HistoryRecording { enabled } => {
                    terminal.set_history_recording(enabled);
                    true
                }
                TerminalClientMessage::Input { .. } | TerminalClientMessage::Resize { .. } => false,
                TerminalClientMessage::ClipboardImage { .. }
                | TerminalClientMessage::TakeControl { .. }
                | TerminalClientMessage::ReleaseControl { .. }
                | TerminalClientMessage::Close => {
                    return Ok(ReplayInputDisposition::Deferred {
                        message: Message::Text(text),
                        blocks_input: true,
                    });
                }
            };
            if handled {
                Ok(ReplayInputDisposition::Handled)
            } else {
                Ok(ReplayInputDisposition::Deferred {
                    message: Message::Text(text),
                    blocks_input: false,
                })
            }
        }
        Message::Pong(_) => Ok(ReplayInputDisposition::Handled),
        message @ Message::Close(_) => Ok(ReplayInputDisposition::Deferred {
            message,
            blocks_input: true,
        }),
        message @ (Message::Ping(_) | Message::Binary(_)) => Ok(ReplayInputDisposition::Deferred {
            message,
            blocks_input: false,
        }),
    }
}

#[allow(clippy::too_many_lines)] // Connection lifecycle stays linear so cleanup ordering remains explicit.
async fn serve_agent_terminal(
    mut sender: TerminalSender,
    mut receiver: TerminalReceiver,
    state: Arc<AppState>,
    target: AgentTerminalAttachTarget,
) -> anyhow::Result<()> {
    let _control_lease = TerminalControlLease::new(Arc::clone(&state), target.control.clone());
    let agent = match ensure_agent(&target.selector, &target.username).await {
        Ok(agent) => agent,
        Err(err) => {
            send_terminal_error(
                &mut sender,
                format!("failed to start webshell agent: {err}"),
                true,
            )
            .await?;
            return Err(err);
        }
    };
    let pane_id = target.pane_id.as_deref().unwrap_or_default();
    let agent_state = agent
        .state(target.cols, target.rows, target.output_limit)
        .await
        .context("failed to read webshell agent reply authority")?;
    let actual_reply_authority = agent_pane_reply_authority(&agent_state, pane_id)
        .ok_or_else(|| anyhow!("unknown agent pane id"))?;
    if actual_reply_authority != target.client_reply_authority {
        let error = anyhow!("terminal client reply authority is stale; reload the application");
        send_terminal_error(&mut sender, error.to_string(), true).await?;
        return Err(error);
    }
    let mut command = agent.attach_command(
        pane_id,
        target.cols,
        target.rows,
        target.output_limit,
        target.replay_after,
    );
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return Err(anyhow!("failed to start webshell agent attach: {err}")),
    };
    let Some(mut stdin) = child.stdin.take() else {
        return Err(anyhow!("failed to open agent attach stdin"));
    };
    let Some(mut stdout) = child.stdout.take() else {
        return Err(anyhow!("failed to open agent attach stdout"));
    };
    let mut stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_string(&mut text).await;
        }
        text
    });
    let mut wait_task = tokio::spawn(async move { child.wait().await });
    let mut pending_clipboard_image = None;
    let mut control_rx = target.control.subscribe(&state);
    send_terminal_control_state(&mut sender, &state, &target.control).await?;

    loop {
        tokio::select! {
            frame = read_agent_frame_async(&mut stdout) => {
                match frame {
                    Ok(frame) => {
                        if !handle_agent_frame(&mut sender, &target, frame).await? {
                            break;
                        }
                    }
                    Err(err) => {
                        if err.kind() != std::io::ErrorKind::UnexpectedEof {
                            send_terminal_error(&mut sender, format!("agent attach stream failed: {err}"), true).await?;
                        }
                        break;
                    }
                }
            }
            update = recv_terminal_control_update(&mut control_rx) => {
                match update {
                    Some(Ok(()) | Err(broadcast::error::RecvError::Lagged(_))) => {
                        send_terminal_control_state(&mut sender, &state, &target.control).await?;
                    }
                    Some(Err(broadcast::error::RecvError::Closed)) | None => {}
                }
            }
            Some(message) = receiver.next() => {
                if !handle_agent_client_message(
                    &mut sender,
                    &state,
                    &target,
                    &mut stdin,
                    &mut pending_clipboard_image,
                    message?,
                ).await? {
                    break;
                }
            }
            result = &mut wait_task => {
                match result {
                    Ok(Ok(status)) => {
                        if !status.success() {
                            let stderr = stderr_task.await.unwrap_or_default();
                            send_terminal_error(&mut sender, stderr.trim().to_owned(), true).await?;
                        }
                    }
                    Ok(Err(err)) => {
                        send_terminal_error(&mut sender, format!("agent attach exited: {err}"), true).await?;
                    }
                    Err(err) => {
                        send_terminal_error(&mut sender, format!("agent attach wait failed: {err}"), true).await?;
                    }
                }
                break;
            }
            else => break,
        }
    }

    let _ = write_agent_frame_async(&mut stdin, &detach_frame()).await;
    Ok(())
}

fn agent_pane_reply_authority(
    state: &AgentWorkspaceState,
    requested_pane_id: &str,
) -> Option<ClientReplyAuthority> {
    let pane_id = if requested_pane_id.trim().is_empty() {
        let active_tab_id = state.active_tab_id.as_deref()?;
        state
            .tabs
            .iter()
            .find(|tab| tab.id.as_deref() == Some(active_tab_id))?
            .active_pane_id
            .as_deref()?
    } else {
        requested_pane_id.trim()
    };
    state
        .tabs
        .iter()
        .flat_map(|tab| &tab.panes)
        .find(|pane| pane.id.as_deref() == Some(pane_id))
        .map(|pane| {
            if pane.terminal_reply_authority.as_deref() == Some("server") {
                ClientReplyAuthority::Server
            } else {
                ClientReplyAuthority::Client
            }
        })
}

async fn handle_agent_frame(
    sender: &mut TerminalSender,
    target: &AgentTerminalAttachTarget,
    frame: AgentFrame,
) -> anyhow::Result<bool> {
    match frame.r#type.as_ref().and_then(buffa::EnumValue::as_known) {
        Some(AgentFrameType::AGENT_FRAME_TYPE_BINARY) => {
            if sender
                .send(Message::Binary(frame.payload.unwrap_or_default().into()))
                .await
                .is_err()
            {
                return Ok(false);
            }
            if let Some(sequence) = frame.sequence.and_then(|value| u64::try_from(value).ok()) {
                send_control(sender, &TerminalServerMessage::OutputSequence { sequence }).await?;
            }
        }
        Some(AgentFrameType::AGENT_FRAME_TYPE_TEXT) if frame.control.is_set() => {
            return handle_agent_control_frame(sender, target, frame).await;
        }
        Some(AgentFrameType::AGENT_FRAME_TYPE_TEXT) => {
            let payload = frame.payload.unwrap_or_default();
            let text = String::from_utf8_lossy(&payload).into_owned();
            if sender.send(Message::Text(text.into())).await.is_err() {
                return Ok(false);
            }
        }
        _ => {}
    }
    Ok(true)
}

async fn handle_agent_control_frame(
    sender: &mut TerminalSender,
    target: &AgentTerminalAttachTarget,
    frame: AgentFrame,
) -> anyhow::Result<bool> {
    let Some(control) = frame.control.into_option() else {
        return Ok(true);
    };
    match control.r#type.as_ref().and_then(buffa::EnumValue::as_known) {
        Some(AgentControlType::AGENT_CONTROL_TYPE_REPLAY_START) => {
            let session_id = control.session_id.as_deref().unwrap_or_default();
            let selector = control.selector.as_deref().unwrap_or(&target.selector);
            send_control(
                sender,
                &TerminalServerMessage::Ready {
                    session_id,
                    selector,
                    cols: target.cols,
                    rows: target.rows,
                },
            )
            .await?;
            send_control(
                sender,
                &TerminalServerMessage::ReplayStart {
                    session_id,
                    selector,
                    pane_id: control.pane_id.as_deref(),
                    replay_after: control
                        .replay_after
                        .and_then(|value| u64::try_from(value).ok())
                        .unwrap_or(0),
                    replay_mode: control
                        .replay_mode
                        .as_deref()
                        .filter(|value| !value.is_empty()),
                    replay_gap: control.replay_gap.unwrap_or(false),
                    oldest_sequence: control
                        .oldest_sequence
                        .and_then(|value| u64::try_from(value).ok()),
                },
            )
            .await?;
        }
        Some(AgentControlType::AGENT_CONTROL_TYPE_REPLAY_COMPLETE) => {
            send_control(
                sender,
                &TerminalServerMessage::ReplayComplete {
                    session_id: control.session_id.as_deref().unwrap_or_default(),
                    selector: control.selector.as_deref().unwrap_or(&target.selector),
                    pane_id: control.pane_id.as_deref(),
                    last_sequence: control
                        .last_sequence
                        .and_then(|value| u64::try_from(value).ok())
                        .unwrap_or(0),
                },
            )
            .await?;
        }
        Some(AgentControlType::AGENT_CONTROL_TYPE_PROCESS_EXIT) => {
            send_control(
                sender,
                &TerminalServerMessage::ProcessExit {
                    exit_code: control.exit_code.unwrap_or(-1),
                    message: control.message,
                },
            )
            .await?;
            return Ok(false);
        }
        _ => {}
    }
    Ok(true)
}

async fn handle_agent_client_message<W>(
    sender: &mut TerminalSender,
    state: &AppState,
    target: &AgentTerminalAttachTarget,
    stdin: &mut W,
    pending_clipboard_image: &mut Option<PendingClipboardImage>,
    message: Message,
) -> anyhow::Result<bool>
where
    W: AsyncWrite + Unpin,
{
    match message {
        Message::Binary(data) => {
            if !target.control.allows_write(state) {
                pending_clipboard_image.take();
                send_terminal_error(
                    sender,
                    "terminal control is held by another client".to_owned(),
                    false,
                )
                .await?;
                return Ok(true);
            }
            if let Some(pending) = pending_clipboard_image.take() {
                match stage_clipboard_image_path_for_agent(target, &pending, data.as_ref()).await {
                    Ok(path) => {
                        write_agent_frame_async(stdin, &input_frame(path.into_bytes())).await?;
                    }
                    Err(err) => {
                        warn!(error = %err, "failed to paste clipboard image through agent");
                        send_terminal_error(sender, err.to_string(), false).await?;
                    }
                }
                return Ok(true);
            }
            write_agent_frame_async(stdin, &input_frame(data.to_vec())).await?;
            Ok(true)
        }
        Message::Text(text) => {
            handle_agent_control_message(
                sender,
                state,
                target,
                stdin,
                pending_clipboard_image,
                &text,
            )
            .await
        }
        Message::Close(_) => Ok(false),
        Message::Ping(payload) => {
            let _ = sender.send(Message::Pong(payload)).await;
            Ok(true)
        }
        Message::Pong(_) => Ok(true),
    }
}

#[allow(clippy::too_many_lines)] // Centralizes validation and replies for the agent control protocol.
async fn handle_agent_control_message<W>(
    sender: &mut TerminalSender,
    state: &AppState,
    target: &AgentTerminalAttachTarget,
    stdin: &mut W,
    pending_clipboard_image: &mut Option<PendingClipboardImage>,
    text: &str,
) -> anyhow::Result<bool>
where
    W: AsyncWrite + Unpin,
{
    if pending_clipboard_image.is_some() {
        pending_clipboard_image.take();
        return Err(anyhow!("clipboard image binary frame expected"));
    }

    if let Some(rest) = text.strip_prefix("input:") {
        if !target.control.allows_write(state) {
            send_terminal_error(
                sender,
                "terminal control is held by another client".to_owned(),
                false,
            )
            .await?;
            return Ok(true);
        }
        write_agent_frame_async(stdin, &input_frame(rest.as_bytes().to_vec())).await?;
        return Ok(true);
    }

    if let Some(rest) = text.strip_prefix("resize:") {
        if !target.control.allows_write(state) {
            send_terminal_error(
                sender,
                "terminal control is held by another client".to_owned(),
                false,
            )
            .await?;
            return Ok(true);
        }
        let (cols, rows) = parse_resize_payload(rest)?;
        write_agent_frame_async(stdin, &resize_frame(cols, rows)).await?;
        return Ok(true);
    }

    match serde_json::from_str::<TerminalClientMessage>(text) {
        Ok(TerminalClientMessage::Input { data }) => {
            if !target.control.allows_write(state) {
                send_terminal_error(
                    sender,
                    "terminal control is held by another client".to_owned(),
                    false,
                )
                .await?;
                return Ok(true);
            }
            write_agent_frame_async(stdin, &input_frame(data.into_bytes())).await?;
            Ok(true)
        }
        Ok(TerminalClientMessage::Resize { cols, rows }) => {
            if !target.control.allows_write(state) {
                send_terminal_error(
                    sender,
                    "terminal control is held by another client".to_owned(),
                    false,
                )
                .await?;
                return Ok(true);
            }
            write_agent_frame_async(stdin, &resize_frame(cols, rows)).await?;
            Ok(true)
        }
        Ok(TerminalClientMessage::ClipboardImage { extension, size }) => {
            if !target.control.allows_write(state) {
                send_terminal_error(
                    sender,
                    "terminal control is held by another client".to_owned(),
                    false,
                )
                .await?;
                return Ok(true);
            }
            if size == 0 {
                return Err(anyhow!("clipboard image payload is empty"));
            }
            if size > MAX_CLIPBOARD_IMAGE_BYTES {
                return Err(anyhow!(
                    "clipboard image exceeds {MAX_CLIPBOARD_IMAGE_BYTES} bytes"
                ));
            }
            *pending_clipboard_image = Some(PendingClipboardImage { extension, size });
            Ok(true)
        }
        Ok(TerminalClientMessage::HistoryRecording { enabled }) => {
            write_agent_frame_async(stdin, &history_recording_frame(enabled)).await?;
            Ok(true)
        }
        Ok(TerminalClientMessage::TakeControl { request_id }) => {
            match target.control.take_control(state) {
                Ok(Some(snapshot)) => {
                    debug!(
                        session_id = snapshot.session_id,
                        connection_id = snapshot.connection_id,
                        controller_id = snapshot.controller_id.as_deref().unwrap_or(""),
                        "terminal control taken"
                    );
                    send_terminal_control_snapshot(
                        sender,
                        &snapshot,
                        request_id.as_deref(),
                        Some("take-control"),
                    )
                    .await?;
                }
                Ok(None) => {
                    send_terminal_control_state(sender, state, &target.control).await?;
                }
                Err(err) => {
                    warn!(error = %err, "failed to take terminal control");
                    send_terminal_error(
                        sender,
                        "failed to take terminal control".to_owned(),
                        false,
                    )
                    .await?;
                }
            }
            Ok(true)
        }
        Ok(TerminalClientMessage::ReleaseControl { request_id }) => {
            match target.control.release_control(state) {
                Ok(Some(snapshot)) => {
                    send_terminal_control_snapshot(
                        sender,
                        &snapshot,
                        request_id.as_deref(),
                        Some("release-control"),
                    )
                    .await?;
                }
                Ok(None) => {
                    send_terminal_control_state(sender, state, &target.control).await?;
                }
                Err(err) => {
                    warn!(error = %err, "failed to release terminal control");
                    send_terminal_error(
                        sender,
                        "failed to release terminal control".to_owned(),
                        false,
                    )
                    .await?;
                }
            }
            Ok(true)
        }
        Ok(
            TerminalClientMessage::RestartPolicy { .. }
            | TerminalClientMessage::OutputBuffer { .. },
        ) => Ok(true),
        Ok(TerminalClientMessage::Close) => {
            write_agent_frame_async(stdin, &detach_frame()).await?;
            Ok(false)
        }
        Err(_) => {
            warn!(message = ?text, "ignored non-control agent websocket text frame");
            Ok(true)
        }
    }
}

async fn stage_clipboard_image_path_for_agent(
    target: &AgentTerminalAttachTarget,
    pending: &PendingClipboardImage,
    data: &[u8],
) -> anyhow::Result<String> {
    if data.is_empty() {
        return Err(anyhow!("clipboard image payload is empty"));
    }
    if data.len() != pending.size {
        return Err(anyhow!(
            "clipboard image size mismatch: expected {} bytes, got {} bytes",
            pending.size,
            data.len()
        ));
    }
    if data.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err(anyhow!(
            "clipboard image exceeds {MAX_CLIPBOARD_IMAGE_BYTES} bytes"
        ));
    }

    let remote_path = remote_clipboard_image_path(&pending.extension);
    stage_clipboard_image(&target.selector, &remote_path, data).await?;
    Ok(remote_path)
}

async fn replay_stopped_terminal(
    sender: &mut TerminalSender,
    replay_context: &TerminalReplayContext<'_>,
) -> anyhow::Result<()> {
    send_control(
        sender,
        &TerminalServerMessage::Ready {
            session_id: replay_context.session_id,
            selector: replay_context.selector,
            cols: replay_context.cols,
            rows: replay_context.rows,
        },
    )
    .await?;
    let _ = send_replay_snapshot_for_target(
        sender,
        replay_context.session_id,
        replay_context.selector,
        replay_context.pane_id,
        replay_context.output,
        replay_context.replay_after,
    )
    .await?;
    send_control(
        sender,
        &TerminalServerMessage::SessionStopped {
            message: "terminal session is stopped".to_owned(),
        },
    )
    .await
}

async fn handle_terminal_client_message(
    sender: &mut TerminalSender,
    state: &AppState,
    terminal: &ManagedTerminal,
    control: &TerminalControlGuard,
    pending_clipboard_image: &mut Option<PendingClipboardImage>,
    message: Message,
    bounded_send: bool,
) -> anyhow::Result<bool> {
    match message {
        Message::Binary(data) => {
            if !control.allows_write(state) {
                pending_clipboard_image.take();
                send_terminal_error_with_policy(
                    sender,
                    "terminal control is held by another client".to_owned(),
                    false,
                    bounded_send,
                )
                .await?;
                return Ok(true);
            }
            if let Some(pending) = pending_clipboard_image.take() {
                if let Err(err) = paste_clipboard_image_path(
                    terminal,
                    &pending.extension,
                    pending.size,
                    data.as_ref(),
                )
                .await
                {
                    warn!(error = %err, "failed to paste clipboard image");
                    send_terminal_error_with_policy(sender, err.to_string(), false, bounded_send)
                        .await?;
                }
                return Ok(true);
            }
            terminal.write_input(data.to_vec())?;
            Ok(true)
        }
        Message::Text(text) => {
            handle_terminal_control_message(
                sender,
                state,
                &text,
                terminal,
                control,
                pending_clipboard_image,
                bounded_send,
            )
            .await
        }
        Message::Close(_) => Ok(false),
        Message::Ping(payload) => {
            let _ = send_terminal_message_with_policy(sender, Message::Pong(payload), bounded_send)
                .await;
            Ok(true)
        }
        Message::Pong(_) => Ok(true),
    }
}

async fn handle_terminal_event(
    sender: &mut TerminalSender,
    state: &AppState,
    terminal: &ManagedTerminal,
    event: Result<TerminalEvent, broadcast::error::RecvError>,
    last_sent_sequence: &mut u64,
    persist_session_exit: bool,
) -> anyhow::Result<bool> {
    match event {
        Ok(TerminalEvent::Output(frame)) => {
            if frame.sequence <= *last_sent_sequence {
                return Ok(true);
            }
            if !send_output_frame(sender, &frame, !persist_session_exit).await? {
                return Ok(false);
            }
            *last_sent_sequence = frame.sequence;
            Ok(true)
        }
        Ok(TerminalEvent::Exit(info)) => {
            if persist_session_exit {
                mark_session_status(state, terminal.session_id(), "exited");
                state.sessions.forget_terminal(terminal.session_id());
            }
            send_terminal_process_exit(sender, info, !persist_session_exit).await?;
            Ok(false)
        }
        Ok(TerminalEvent::Error(message)) => {
            send_terminal_error_with_policy(sender, message, true, !persist_session_exit).await?;
            Ok(false)
        }
        Err(broadcast::error::RecvError::Lagged(_)) => {
            send_terminal_error_with_policy(
                sender,
                "terminal output backlog exceeded; reconnecting".to_owned(),
                false,
                !persist_session_exit,
            )
            .await?;
            Ok(false)
        }
        Err(broadcast::error::RecvError::Closed) => Ok(false),
    }
}

async fn send_terminal_process_exit(
    sender: &mut TerminalSender,
    info: crate::terminal_manager::ExitInfo,
    bounded_send: bool,
) -> anyhow::Result<()> {
    send_control_with_policy(
        sender,
        &TerminalServerMessage::ProcessExit {
            exit_code: info.exit_code,
            message: info.message,
        },
        bounded_send,
    )
    .await
}

async fn send_replay_snapshot(
    sender: &mut TerminalSender,
    terminal: &ManagedTerminal,
    pane_id: Option<&str>,
    output: &OutputBuffer,
    replay_after: u64,
    bounded_send: bool,
) -> anyhow::Result<Option<u64>> {
    let snapshot = output.snapshot_after_bounded(replay_after, usize::MAX, usize::MAX);
    if let Err(error) = validate_replay_snapshot(&snapshot, bounded_send) {
        let _ =
            send_nonretryable_terminal_error_with_policy(sender, error.to_string(), bounded_send)
                .await;
        return Err(error);
    }
    send_control_with_policy(
        sender,
        &TerminalServerMessage::ReplayStart {
            session_id: terminal.session_id(),
            selector: terminal.selector(),
            pane_id,
            replay_after,
            replay_mode: Some(if replay_after == 0 {
                "tail"
            } else if snapshot.replay_gap {
                "gap"
            } else {
                "delta"
            }),
            replay_gap: snapshot.replay_gap && replay_after > 0,
            oldest_sequence: snapshot.oldest_sequence,
        },
        bounded_send,
    )
    .await?;

    let frames = snapshot.frames;
    let last_sequence = snapshot.last_sequence;
    info!(
        session_id = terminal.session_id(),
        selector = terminal.selector(),
        pane_id = pane_id.unwrap_or(""),
        replay_after,
        last_sequence,
        frame_count = frames.len(),
        truncated = snapshot.truncated,
        replay_gap = snapshot.replay_gap,
        "replaying terminal output history"
    );
    let mut last_sent_sequence = last_sequence;
    for frame in frames {
        if !send_output_frame(sender, &frame, bounded_send).await? {
            return Ok(None);
        }
        last_sent_sequence = last_sent_sequence.max(frame.sequence);
    }

    send_control_with_policy(
        sender,
        &TerminalServerMessage::ReplayComplete {
            session_id: terminal.session_id(),
            selector: terminal.selector(),
            pane_id,
            last_sequence,
        },
        bounded_send,
    )
    .await?;
    Ok(Some(last_sent_sequence))
}

fn validate_replay_snapshot(
    snapshot: &OutputSnapshot,
    require_complete: bool,
) -> anyhow::Result<()> {
    if require_complete && snapshot.replay_gap {
        return Err(anyhow!(
            "connection terminal initial output exceeded its replay window"
        ));
    }
    Ok(())
}

async fn report_connection_bootstrap_timeout(sender: &mut TerminalSender) -> anyhow::Error {
    let message = "connection terminal bootstrap timed out before a complete screen was delivered";
    let _ = send_terminal_error_with_policy(sender, message.to_owned(), true, true).await;
    anyhow!(message)
}

async fn send_replay_snapshot_for_target(
    sender: &mut TerminalSender,
    session_id: &str,
    selector: &str,
    pane_id: Option<&str>,
    output: &OutputBuffer,
    replay_after: u64,
) -> anyhow::Result<Option<u64>> {
    let snapshot = output.snapshot_after_bounded(replay_after, usize::MAX, usize::MAX);
    send_control(
        sender,
        &TerminalServerMessage::ReplayStart {
            session_id,
            selector,
            pane_id,
            replay_after,
            replay_mode: Some(if replay_after == 0 {
                "tail"
            } else if snapshot.replay_gap {
                "gap"
            } else {
                "delta"
            }),
            replay_gap: snapshot.replay_gap && replay_after > 0,
            oldest_sequence: snapshot.oldest_sequence,
        },
    )
    .await?;

    let frames = snapshot.frames;
    let last_sequence = snapshot.last_sequence;
    info!(
        session_id = session_id,
        selector = selector,
        pane_id = pane_id.unwrap_or(""),
        replay_after,
        last_sequence,
        frame_count = frames.len(),
        truncated = snapshot.truncated,
        replay_gap = snapshot.replay_gap,
        "replaying stopped terminal output history"
    );
    let mut last_sent_sequence = last_sequence;
    for frame in frames {
        if !send_output_frame(sender, &frame, false).await? {
            return Ok(None);
        }
        last_sent_sequence = last_sent_sequence.max(frame.sequence);
    }

    send_control(
        sender,
        &TerminalServerMessage::ReplayComplete {
            session_id,
            selector,
            pane_id,
            last_sequence,
        },
    )
    .await?;
    Ok(Some(last_sent_sequence))
}

#[allow(clippy::too_many_lines)] // Centralizes validation and replies for the provider control protocol.
async fn handle_terminal_control_message(
    sender: &mut TerminalSender,
    state: &AppState,
    text: &str,
    terminal: &ManagedTerminal,
    control: &TerminalControlGuard,
    pending_clipboard_image: &mut Option<PendingClipboardImage>,
    bounded_send: bool,
) -> anyhow::Result<bool> {
    if pending_clipboard_image.is_some() {
        pending_clipboard_image.take();
        return Err(anyhow!("clipboard image binary frame expected"));
    }

    if let Some(rest) = text.strip_prefix("input:") {
        if !control.allows_write(state) {
            send_terminal_error_with_policy(
                sender,
                "terminal control is held by another client".to_owned(),
                false,
                bounded_send,
            )
            .await?;
            return Ok(true);
        }
        terminal.write_input(rest.as_bytes().to_vec())?;
        return Ok(true);
    }

    if let Some(rest) = text.strip_prefix("resize:") {
        if !control.allows_write(state) {
            send_terminal_error_with_policy(
                sender,
                "terminal control is held by another client".to_owned(),
                false,
                bounded_send,
            )
            .await?;
            return Ok(true);
        }
        let (cols, rows) = parse_resize_payload(rest)?;
        terminal.resize(cols, rows)?;
        return Ok(true);
    }

    match serde_json::from_str::<TerminalClientMessage>(text) {
        Ok(TerminalClientMessage::Input { data }) => {
            if !control.allows_write(state) {
                send_terminal_error_with_policy(
                    sender,
                    "terminal control is held by another client".to_owned(),
                    false,
                    bounded_send,
                )
                .await?;
                return Ok(true);
            }
            terminal.write_input(data.into_bytes())?;
            Ok(true)
        }
        Ok(TerminalClientMessage::Resize { cols, rows }) => {
            if !control.allows_write(state) {
                send_terminal_error_with_policy(
                    sender,
                    "terminal control is held by another client".to_owned(),
                    false,
                    bounded_send,
                )
                .await?;
                return Ok(true);
            }
            terminal.resize(cols, rows)?;
            state
                .sessions
                .persist_resize(terminal.session_id(), cols, rows)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::ClipboardImage { extension, size }) => {
            if !control.allows_write(state) {
                send_terminal_error_with_policy(
                    sender,
                    "terminal control is held by another client".to_owned(),
                    false,
                    bounded_send,
                )
                .await?;
                return Ok(true);
            }
            if size == 0 {
                return Err(anyhow!("clipboard image payload is empty"));
            }
            if size > MAX_CLIPBOARD_IMAGE_BYTES {
                return Err(anyhow!(
                    "clipboard image exceeds {MAX_CLIPBOARD_IMAGE_BYTES} bytes"
                ));
            }
            *pending_clipboard_image = Some(PendingClipboardImage { extension, size });
            Ok(true)
        }
        Ok(TerminalClientMessage::RestartPolicy { enabled }) => {
            state
                .sessions
                .set_restartable(terminal.session_id(), enabled)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::OutputBuffer { limit }) => {
            let limit = state
                .sessions
                .set_output_frame_limit(terminal.session_id(), limit)?;
            terminal.set_output_frame_limit(limit);
            Ok(true)
        }
        Ok(TerminalClientMessage::HistoryRecording { enabled }) => {
            terminal.set_history_recording(enabled);
            Ok(true)
        }
        Ok(TerminalClientMessage::TakeControl { request_id }) => {
            match control.take_control(state) {
                Ok(Some(snapshot)) => {
                    debug!(
                        session_id = snapshot.session_id,
                        connection_id = snapshot.connection_id,
                        controller_id = snapshot.controller_id.as_deref().unwrap_or(""),
                        "terminal control taken"
                    );
                    send_terminal_control_snapshot_with_policy(
                        sender,
                        &snapshot,
                        request_id.as_deref(),
                        Some("take-control"),
                        bounded_send,
                    )
                    .await?;
                }
                Ok(None) => {
                    send_terminal_control_state_with_policy(sender, state, control, bounded_send)
                        .await?;
                }
                Err(err) => {
                    warn!(error = %err, "failed to take terminal control");
                    send_terminal_error_with_policy(
                        sender,
                        "failed to take terminal control".to_owned(),
                        false,
                        bounded_send,
                    )
                    .await?;
                }
            }
            Ok(true)
        }
        Ok(TerminalClientMessage::ReleaseControl { request_id }) => {
            match control.release_control(state) {
                Ok(Some(snapshot)) => {
                    send_terminal_control_snapshot_with_policy(
                        sender,
                        &snapshot,
                        request_id.as_deref(),
                        Some("release-control"),
                        bounded_send,
                    )
                    .await?;
                }
                Ok(None) => {
                    send_terminal_control_state_with_policy(sender, state, control, bounded_send)
                        .await?;
                }
                Err(err) => {
                    warn!(error = %err, "failed to release terminal control");
                    send_terminal_error_with_policy(
                        sender,
                        "failed to release terminal control".to_owned(),
                        false,
                        bounded_send,
                    )
                    .await?;
                }
            }
            Ok(true)
        }
        Ok(TerminalClientMessage::Close) => Ok(false),
        Err(_) => {
            warn!(message = ?text, "ignored non-control websocket text frame");
            Ok(true)
        }
    }
}

async fn paste_clipboard_image_path(
    terminal: &ManagedTerminal,
    extension: &str,
    expected_size: usize,
    data: &[u8],
) -> anyhow::Result<()> {
    if ssh_backend::is_ssh_selector(terminal.selector()) || !lightos_features_enabled() {
        return Err(anyhow!(
            "clipboard image staging is not supported for this terminal backend"
        ));
    }
    if data.is_empty() {
        return Err(anyhow!("clipboard image payload is empty"));
    }
    if data.len() != expected_size {
        return Err(anyhow!(
            "clipboard image size mismatch: expected {} bytes, got {} bytes",
            expected_size,
            data.len()
        ));
    }
    if data.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err(anyhow!(
            "clipboard image exceeds {MAX_CLIPBOARD_IMAGE_BYTES} bytes"
        ));
    }

    let remote_path = remote_clipboard_image_path(extension);
    stage_clipboard_image(terminal.selector(), &remote_path, data).await?;
    info!(
        session_id = %terminal.session_id(),
        selector = %terminal.selector(),
        bytes = data.len(),
        path = %remote_path,
        "staged clipboard image in target instance"
    );
    terminal.write_input(remote_path.into_bytes())?;
    Ok(())
}

async fn stage_clipboard_image(
    selector: &str,
    remote_path: &str,
    data: &[u8],
) -> anyhow::Result<()> {
    let script = clipboard_image_stage_script(remote_path);
    let mut command = Command::new(LIGHTOSCTL);
    command
        .args(["exec", "-i", selector, "/bin/sh", "-lc", script.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = timeout(CLIPBOARD_IMAGE_STAGE_TIMEOUT, async move {
        let mut child = command
            .spawn()
            .map_err(|err| anyhow!("failed to enter target instance: {err}"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("failed to open clipboard image upload stream"))?;
        stdin
            .write_all(data)
            .await
            .map_err(|err| anyhow!("failed to upload clipboard image: {err}"))?;
        drop(stdin);
        child
            .wait_with_output()
            .await
            .map_err(|err| anyhow!("clipboard image upload failed: {err}"))
    })
    .await
    .map_err(|_| anyhow!("clipboard image upload timed out"))??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(anyhow!("clipboard image upload command failed: {detail}"));
    }
    Ok(())
}

fn clipboard_image_stage_script(remote_path: &str) -> String {
    let remote_path = shell_quote(remote_path);
    format!(
        r#"set -eu
path={remote_path}
dir="${{path%/*}}"
mkdir -p "$dir"
chmod 1777 "$dir" 2>/dev/null || true
umask 022
cat > "$path"
chmod 0644 "$path" 2>/dev/null || true
printf '%s' "$path"
"#
    )
}

fn remote_clipboard_image_path(extension: &str) -> String {
    format!(
        "/tmp/lazycat-webshell-clipboard-images/paste-{}.{}",
        Uuid::new_v4().simple(),
        sanitize_clipboard_image_extension(extension)
    )
}

fn sanitize_clipboard_image_extension(extension: &str) -> &'static str {
    match extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        _ => "png",
    }
}

fn shell_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\"'\"'");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

fn parse_resize_payload(rest: &str) -> anyhow::Result<(u16, u16)> {
    let (cols, rows) = rest
        .split_once(',')
        .ok_or_else(|| anyhow!("resize message must be resize:<cols>,<rows>"))?;
    let cols = cols.trim().parse::<u16>()?;
    let rows = rows.trim().parse::<u16>()?;
    validate_size(cols, rows)?;
    Ok((cols, rows))
}

async fn recv_terminal_control_update(
    receiver: &mut Option<broadcast::Receiver<()>>,
) -> Option<Result<(), broadcast::error::RecvError>> {
    match receiver {
        Some(receiver) => Some(receiver.recv().await),
        None => std::future::pending().await,
    }
}

async fn connection_terminal_heartbeat_tick(heartbeat: &mut Option<tokio::time::Interval>) {
    match heartbeat {
        Some(heartbeat) => {
            heartbeat.tick().await;
        }
        None => std::future::pending().await,
    }
}

async fn send_terminal_control_state(
    sender: &mut TerminalSender,
    state: &AppState,
    control: &TerminalControlGuard,
) -> anyhow::Result<()> {
    send_terminal_control_state_with_policy(sender, state, control, false).await
}

async fn send_terminal_control_state_with_policy(
    sender: &mut TerminalSender,
    state: &AppState,
    control: &TerminalControlGuard,
    bounded: bool,
) -> anyhow::Result<()> {
    if !control.enabled {
        return Ok(());
    }
    let Some(snapshot) = state
        .terminal_control
        .snapshot(&control.session_id, &control.connection_id)?
    else {
        return Ok(());
    };
    send_terminal_control_snapshot_with_policy(sender, &snapshot, None, None, bounded).await
}

async fn send_terminal_control_snapshot(
    sender: &mut TerminalSender,
    snapshot: &TerminalControlSnapshot,
    request_id: Option<&str>,
    control_action: Option<&str>,
) -> anyhow::Result<()> {
    send_terminal_control_snapshot_with_policy(sender, snapshot, request_id, control_action, false)
        .await
}

async fn send_terminal_control_snapshot_with_policy(
    sender: &mut TerminalSender,
    snapshot: &TerminalControlSnapshot,
    request_id: Option<&str>,
    control_action: Option<&str>,
    bounded: bool,
) -> anyhow::Result<()> {
    send_control_with_policy(
        sender,
        &TerminalServerMessage::ControlState {
            session_id: &snapshot.session_id,
            connection_id: &snapshot.connection_id,
            controller_id: snapshot.controller_id.as_deref(),
            controller: snapshot.is_controller,
            connection_count: snapshot.connection_count,
            request_id,
            control_action,
        },
        bounded,
    )
    .await
}

async fn send_control(
    sender: &mut TerminalSender,
    message: &TerminalServerMessage<'_>,
) -> anyhow::Result<()> {
    send_control_with_policy(sender, message, false).await
}

async fn send_control_with_policy(
    sender: &mut TerminalSender,
    message: &TerminalServerMessage<'_>,
    bounded: bool,
) -> anyhow::Result<()> {
    let text = serde_json::to_string(message)?;
    send_terminal_message_with_policy(sender, Message::Text(text.into()), bounded).await
}

async fn send_connection_terminal_message(
    sender: &mut TerminalSender,
    message: Message,
) -> anyhow::Result<()> {
    send_terminal_message_with_policy(sender, message, true).await
}

async fn send_terminal_message_with_policy(
    sender: &mut TerminalSender,
    message: Message,
    bounded: bool,
) -> anyhow::Result<()> {
    if bounded {
        timeout(TERMINAL_SOCKET_SEND_TIMEOUT, sender.send(message))
            .await
            .map_err(|_| anyhow!("terminal websocket send timed out"))??;
        return Ok(());
    }
    sender.send(message).await?;
    Ok(())
}

async fn send_terminal_error(
    sender: &mut TerminalSender,
    message: String,
    fatal: bool,
) -> anyhow::Result<()> {
    send_terminal_error_with_policy(sender, message, fatal, false).await
}

async fn send_terminal_error_with_policy(
    sender: &mut TerminalSender,
    message: String,
    fatal: bool,
    bounded: bool,
) -> anyhow::Result<()> {
    send_control_with_policy(
        sender,
        &TerminalServerMessage::Error {
            message,
            fatal,
            retryable: None,
        },
        bounded,
    )
    .await
}

async fn send_nonretryable_terminal_error_with_policy(
    sender: &mut TerminalSender,
    message: String,
    bounded: bool,
) -> anyhow::Result<()> {
    send_control_with_policy(
        sender,
        &TerminalServerMessage::Error {
            message,
            fatal: true,
            retryable: Some(false),
        },
        bounded,
    )
    .await
}

async fn send_output_frame(
    sender: &mut TerminalSender,
    frame: &OutputFrame,
    bounded: bool,
) -> anyhow::Result<bool> {
    if send_terminal_message_with_policy(sender, Message::Binary(frame.data.clone()), bounded)
        .await
        .is_err()
    {
        return Ok(false);
    }
    send_control_with_policy(
        sender,
        &TerminalServerMessage::OutputSequence {
            sequence: frame.sequence,
        },
        bounded,
    )
    .await?;
    Ok(true)
}

#[allow(clippy::too_many_lines)] // Keeps authority and backend selection in one auditable decision path.
async fn resolve_terminal_target(
    state: &AppState,
    query: &TerminalQuery,
    client_reply_authority: ClientReplyAuthority,
) -> anyhow::Result<TerminalAttachTarget> {
    let restart = parse_query_bool(query.restart.as_deref(), "restart")?;
    let replay = parse_query_bool(query.replay.as_deref(), "replay")?.unwrap_or(true);
    let replay_after = query.after.unwrap_or(0);
    let pane_id = query
        .pane_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let backend = query
        .backend
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("webshell");
    if backend == "webshell" {
        let selector = query
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("name is required for webshell agent attach"))?;
        if ssh_backend::is_ssh_selector(selector) {
            return Err(anyhow!("SSH profile selectors must use the ssh backend"));
        }
        validate_selector(selector).map_err(|err| anyhow!(err.message.unwrap_or_default()))?;
        let session_id = query
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(query.pane_id.as_deref())
            .unwrap_or_default()
            .to_owned();
        let username = authorize_terminal_selector(selector, true).await?;
        let control = terminal_control_guard(state, query, &session_id)?;
        let (cols, rows) = match agent_attach_size(state, query, &session_id, &control) {
            Ok(size) => size,
            Err(err) => {
                control.disconnect(state);
                return Err(err);
            }
        };
        if let Err(err) = validate_size(cols, rows) {
            control.disconnect(state);
            return Err(err);
        }
        let output_limit = normalize_output_frame_limit(query.output_limit);
        return Ok(TerminalAttachTarget::Agent(AgentTerminalAttachTarget {
            selector: selector.to_owned(),
            username,
            pane_id,
            cols,
            rows,
            replay_after: if replay { replay_after } else { u64::MAX },
            output_limit,
            control,
            client_reply_authority,
        }));
    }

    if let Some(session_id) = query
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let control = terminal_control_guard(state, query, session_id)?;
        let (spec, status, persisted_backend) = match persisted_terminal_target(
            state,
            query,
            session_id,
            restart,
            control.allows_attach_resize(),
        ) {
            Ok(target) => target,
            Err(err) => {
                control.disconnect(state);
                return Err(err);
            }
        };
        if let Err(error) = validate_terminal_backend(backend, &persisted_backend) {
            control.disconnect(state);
            return Err(error);
        }
        let allow_spawn =
            restart.unwrap_or(false) || matches!(status.as_str(), "running" | "starting");
        if ssh_backend::is_ssh_selector(&spec.selector) {
            if backend != "ssh" {
                control.disconnect(state);
                return Err(anyhow!(
                    "SSH profile terminal attach requires the ssh backend"
                ));
            }
            let spec = match refresh_persisted_ssh_terminal_profile(state, session_id, spec) {
                Ok(spec) => spec,
                Err(err) => {
                    control.disconnect(state);
                    return Err(err);
                }
            };
            let output = state.output_buffer(session_id, spec.output_frame_limit)?;
            return Ok(TerminalAttachTarget::Managed(ManagedTerminalAttachTarget {
                spec,
                allow_spawn,
                resize_existing: control.allows_attach_resize(),
                replay,
                replay_after,
                lifetime: ManagedTerminalLifetime::Persistent,
                pane_id,
                output: Some(output),
                control,
                client_reply_authority,
            }));
        }
        if backend == "ssh" {
            control.disconnect(state);
            return Err(anyhow!("ssh backend requires an SSH profile selector"));
        }
        let login_user = match authorize_terminal_selector(&spec.selector, allow_spawn).await {
            Ok(login_user) => login_user,
            Err(err) => {
                control.disconnect(state);
                return Err(err);
            }
        };
        let spec = match refresh_persisted_terminal_login_user(state, session_id, spec, &login_user)
        {
            Ok(spec) => spec,
            Err(err) => {
                control.disconnect(state);
                return Err(err);
            }
        };
        let lifetime = managed_terminal_lifetime(backend);
        let output = if lifetime == ManagedTerminalLifetime::Persistent {
            Some(state.output_buffer(session_id, spec.output_frame_limit)?)
        } else {
            None
        };
        return Ok(TerminalAttachTarget::Managed(ManagedTerminalAttachTarget {
            spec,
            allow_spawn,
            resize_existing: control.allows_attach_resize(),
            replay: lifetime.replay_enabled(replay),
            replay_after: lifetime.replay_after(replay_after),
            lifetime,
            pane_id,
            output,
            control,
            client_reply_authority,
        }));
    }

    Err(anyhow!(
        "session_id is required for {backend} terminal attach"
    ))
}

fn terminal_control_guard(
    state: &AppState,
    query: &TerminalQuery,
    session_id: &str,
) -> anyhow::Result<TerminalControlGuard> {
    let control_mode = query
        .control_mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if control_mode != Some("single") {
        return Ok(TerminalControlGuard::disabled());
    }
    let snapshot = state.terminal_control.connect(session_id)?;
    Ok(TerminalControlGuard {
        enabled: true,
        session_id: session_id.trim().to_owned(),
        connection_id: snapshot.connection_id,
        controller_on_attach: snapshot.is_controller,
    })
}

fn agent_attach_size(
    state: &AppState,
    query: &TerminalQuery,
    session_id: &str,
    control: &TerminalControlGuard,
) -> anyhow::Result<(u16, u16)> {
    if control.allows_attach_resize() {
        return Ok((
            query.cols.unwrap_or(DEFAULT_COLS),
            query.rows.unwrap_or(DEFAULT_ROWS),
        ));
    }
    if let Some((cols, rows)) = state.sessions.read().ok().and_then(|sessions| {
        sessions
            .get(session_id)
            .map(|session| (session.cols, session.rows))
    }) {
        validate_size(cols, rows)?;
        return Ok((cols, rows));
    }
    Ok((
        query.cols.unwrap_or(DEFAULT_COLS),
        query.rows.unwrap_or(DEFAULT_ROWS),
    ))
}

fn persisted_terminal_target(
    state: &AppState,
    query: &TerminalQuery,
    session_id: &str,
    restart: Option<bool>,
    allow_query_resize: bool,
) -> anyhow::Result<(TerminalSpec, String, String)> {
    let mut snapshot = None;
    let target = {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session id"))?;
        let cols = if allow_query_resize {
            query.cols.unwrap_or(session.cols)
        } else {
            session.cols
        };
        let rows = if allow_query_resize {
            query.rows.unwrap_or(session.rows)
        } else {
            session.rows
        };
        validate_size(cols, rows)?;

        let mut changed = false;
        if session.cols != cols || session.rows != rows {
            session.cols = cols;
            session.rows = rows;
            changed = true;
        }
        if let Some(restartable) = restart {
            session.set_restartable(restartable);
            changed = true;
        }

        let mut spec = session.terminal_spec(cols, rows);
        if let Some(output_limit) = query.output_limit {
            spec.output_frame_limit = normalize_output_frame_limit(Some(output_limit));
            session.metadata.insert(
                "outputBufferLimit".to_owned(),
                spec.output_frame_limit.to_string(),
            );
            changed = true;
        }
        let status = session.status.clone();
        let backend = terminal_backend_from_metadata(&session.metadata).to_owned();
        if changed {
            snapshot = Some(sessions.clone());
        }
        (spec, status, backend)
    };
    if let Some(snapshot) = snapshot {
        state.persist_sessions_snapshot(&snapshot)?;
    }
    Ok(target)
}

fn terminal_backend_from_metadata(metadata: &HashMap<String, String>) -> &str {
    metadata
        .get("sessionBackend")
        .map(String::as_str)
        .filter(|backend| matches!(*backend, "webshell" | "herdr" | "zellij" | "ssh"))
        .unwrap_or("webshell")
}

fn refresh_persisted_terminal_login_user(
    state: &AppState,
    session_id: &str,
    mut spec: TerminalSpec,
    login_user: &str,
) -> anyhow::Result<TerminalSpec> {
    let mut snapshot = None;
    {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        if let Some(session) = sessions.get_mut(session_id) {
            let changed = sync_session_login_user(session, login_user);
            spec = session.terminal_spec(spec.cols, spec.rows);
            if changed {
                snapshot = Some(sessions.clone());
            }
        }
    }
    if let Some(snapshot) = snapshot {
        state.persist_sessions_snapshot(&snapshot)?;
    }
    Ok(spec)
}

fn refresh_persisted_ssh_terminal_profile(
    state: &AppState,
    session_id: &str,
    mut spec: TerminalSpec,
) -> anyhow::Result<TerminalSpec> {
    let profile =
        ssh_backend::load_enabled_profile(&state.database(), &spec.selector).map_err(|err| {
            anyhow!(
                err.message
                    .unwrap_or_else(|| "SSH profile is not available".to_owned())
            )
        })?;
    let (command, args) = ssh_backend::terminal_command_for_profile(&profile);
    let login_user = profile.login_user();
    ssh_backend::mark_profile_used(&state.database(), &spec.selector);

    let mut snapshot = None;
    {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        if let Some(session) = sessions.get_mut(session_id) {
            let mut changed = false;
            if session.command != command {
                session.command = command;
                changed = true;
            }
            if session.args != args {
                session.args = args;
                changed = true;
            }
            match (
                login_user.trim().is_empty(),
                session.metadata.get("loginUser"),
            ) {
                (true, Some(_)) => {
                    session.metadata.remove("loginUser");
                    changed = true;
                }
                (false, Some(value)) if value == login_user.trim() => {}
                (false, _) => {
                    session
                        .metadata
                        .insert("loginUser".to_owned(), login_user.trim().to_owned());
                    changed = true;
                }
                (true, None) => {}
            }
            if session
                .metadata
                .insert("sessionBackend".to_owned(), "ssh".to_owned())
                .as_deref()
                != Some("ssh")
            {
                changed = true;
            }
            spec = session.terminal_spec(spec.cols, spec.rows);
            if changed {
                snapshot = Some(sessions.clone());
            }
        }
    }
    if let Some(snapshot) = snapshot {
        state.persist_sessions_snapshot(&snapshot)?;
    }
    Ok(spec)
}

async fn authorize_terminal_selector(
    selector: &str,
    require_running: bool,
) -> anyhow::Result<String> {
    if !lightos_features_enabled() {
        return Err(anyhow!("LightOS integration is disabled"));
    }
    lightos::login_user_for_selector(selector, require_running)
        .await
        .map_err(|err| {
            anyhow!(
                err.message
                    .unwrap_or_else(|| "selector is not authorized".to_owned())
            )
        })
}

fn parse_query_bool(value: Option<&str>, name: &str) -> anyhow::Result<Option<bool>> {
    value
        .map(|value| parse_bool_flag(value).ok_or_else(|| anyhow!("{name} must be a boolean")))
        .transpose()
}

fn parse_client_reply_authority(value: Option<&str>) -> anyhow::Result<ClientReplyAuthority> {
    match value.map(str::trim) {
        Some("client") => Ok(ClientReplyAuthority::Client),
        Some("server") => Ok(ClientReplyAuthority::Server),
        _ => Err(anyhow!(
            "terminal client update required: missing reply-authority capability"
        )),
    }
}

fn parse_bool_flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };
    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    origin
        .parse::<Uri>()
        .ok()
        .and_then(|uri| uri.authority().map(|authority| authority.as_str() == host))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use axum::extract::ws::Message;
    use axum::http::header::{HOST, ORIGIN};
    use axum::http::{HeaderMap, HeaderValue};

    use super::{
        ClientReplyAuthority, MAX_REPLAY_DEFERRED_BYTES, MAX_REPLAY_DEFERRED_MESSAGES,
        ManagedTerminalLifetime, TerminalClientMessage, TerminalServerMessage,
        agent_pane_reply_authority, clipboard_image_stage_script, is_terminal_close_message,
        managed_terminal_lifetime, origin_allowed, parse_client_reply_authority,
        push_replay_deferred_message, sanitize_clipboard_image_extension, validate_replay_snapshot,
        validate_terminal_backend,
    };
    use crate::proto::lazycat::webshell::v1::{AgentPaneState, AgentTabState, AgentWorkspaceState};
    use crate::terminal_manager::OutputSnapshot;

    #[test]
    fn validates_origin_host_match() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("example.test"));
        headers.insert(ORIGIN, HeaderValue::from_static("https://example.test"));
        assert!(origin_allowed(&headers));

        headers.insert(ORIGIN, HeaderValue::from_static("https://other.test"));
        assert!(!origin_allowed(&headers));
    }

    #[test]
    fn sanitizes_clipboard_image_extensions() {
        assert_eq!(sanitize_clipboard_image_extension("PNG"), "png");
        assert_eq!(sanitize_clipboard_image_extension(".jpeg"), "jpg");
        assert_eq!(sanitize_clipboard_image_extension("webp"), "webp");
        assert_eq!(sanitize_clipboard_image_extension("sh"), "png");
    }

    #[test]
    fn clipboard_image_stage_script_quotes_remote_path() {
        let script = clipboard_image_stage_script("/tmp/a'b.png");
        assert!(script.contains("path='/tmp/a'\"'\"'b.png'"));
        assert!(script.contains("chmod 1777 \"$dir\""));
        assert!(script.contains("cat > \"$path\""));
        assert!(script.contains("chmod 0644 \"$path\""));
    }

    #[test]
    fn parses_terminal_control_messages_with_optional_request_id() {
        let legacy: TerminalClientMessage =
            serde_json::from_str(r#"{"type":"take-control"}"#).unwrap();
        assert!(matches!(
            legacy,
            TerminalClientMessage::TakeControl { request_id: None }
        ));

        let with_request: TerminalClientMessage =
            serde_json::from_str(r#"{"type":"release-control","request_id":"tc-1"}"#).unwrap();
        assert!(matches!(
            with_request,
            TerminalClientMessage::ReleaseControl {
                request_id: Some(request_id)
            } if request_id == "tc-1"
        ));
    }

    #[test]
    fn requires_explicit_client_reply_authority_capability() {
        assert_eq!(
            parse_client_reply_authority(Some("client")).unwrap(),
            ClientReplyAuthority::Client
        );
        assert_eq!(
            parse_client_reply_authority(Some("server")).unwrap(),
            ClientReplyAuthority::Server
        );
        assert!(parse_client_reply_authority(None).is_err());
        assert!(parse_client_reply_authority(Some("future")).is_err());
    }

    #[test]
    fn reads_reply_authority_from_the_attached_agent_pane() {
        let state = AgentWorkspaceState {
            active_tab_id: Some("tab-1".to_owned()),
            tabs: vec![AgentTabState {
                id: Some("tab-1".to_owned()),
                active_pane_id: Some("pane-1".to_owned()),
                panes: vec![AgentPaneState {
                    id: Some("pane-1".to_owned()),
                    terminal_reply_authority: Some("server".to_owned()),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

        assert_eq!(
            agent_pane_reply_authority(&state, "pane-1"),
            Some(ClientReplyAuthority::Server)
        );
        assert_eq!(
            agent_pane_reply_authority(&state, ""),
            Some(ClientReplyAuthority::Server)
        );
    }

    #[test]
    fn herdr_tui_is_scoped_to_one_browser_connection() {
        assert_eq!(
            managed_terminal_lifetime("herdr"),
            ManagedTerminalLifetime::Connection
        );
        assert_eq!(
            managed_terminal_lifetime("zellij"),
            ManagedTerminalLifetime::Persistent
        );
        assert_eq!(
            managed_terminal_lifetime("ssh"),
            ManagedTerminalLifetime::Persistent
        );
        assert!(ManagedTerminalLifetime::Connection.replay_enabled(false));
        assert!(ManagedTerminalLifetime::Connection.replay_enabled(true));
        assert!(!ManagedTerminalLifetime::Persistent.replay_enabled(false));
        assert!(ManagedTerminalLifetime::Persistent.replay_enabled(true));
        assert_eq!(ManagedTerminalLifetime::Connection.replay_after(42), 0);
        assert_eq!(ManagedTerminalLifetime::Persistent.replay_after(42), 42);
        assert!(!ManagedTerminalLifetime::Connection.marks_spawn_failure_stopped());
        assert!(ManagedTerminalLifetime::Persistent.marks_spawn_failure_stopped());
    }

    #[test]
    fn replay_deferred_messages_are_bounded_by_count_and_bytes() {
        let mut deferred = VecDeque::new();
        let mut deferred_bytes = 0;
        for _ in 0..MAX_REPLAY_DEFERRED_MESSAGES {
            push_replay_deferred_message(
                &mut deferred,
                &mut deferred_bytes,
                Message::Text("x".into()),
            )
            .unwrap();
        }
        assert!(
            push_replay_deferred_message(
                &mut deferred,
                &mut deferred_bytes,
                Message::Text("overflow".into()),
            )
            .is_err()
        );

        let mut deferred = VecDeque::new();
        let mut deferred_bytes = 0;
        assert!(
            push_replay_deferred_message(
                &mut deferred,
                &mut deferred_bytes,
                Message::Binary(vec![0; MAX_REPLAY_DEFERRED_BYTES + 1].into()),
            )
            .is_err()
        );
    }

    #[test]
    fn close_messages_stop_replay_input_capture() {
        assert!(is_terminal_close_message(&Message::Close(None)));
        assert!(is_terminal_close_message(&Message::Text(
            r#"{"type":"close"}"#.into()
        )));
        assert!(!is_terminal_close_message(&Message::Text(
            r#"{"type":"take-control"}"#.into()
        )));
    }

    #[test]
    fn connection_bootstrap_rejects_a_replay_gap_instead_of_sending_a_partial_screen() {
        let snapshot = OutputSnapshot {
            frames: Vec::new(),
            oldest_sequence: Some(3),
            last_sequence: 130,
            truncated: false,
            replay_gap: true,
        };

        assert!(snapshot.replay_gap);
        assert!(validate_replay_snapshot(&snapshot, true).is_err());
        assert!(validate_replay_snapshot(&snapshot, false).is_ok());
    }

    #[test]
    fn replay_start_serializes_optional_gap_metadata_without_changing_legacy_fields() {
        let value = serde_json::to_value(TerminalServerMessage::ReplayStart {
            session_id: "session-1",
            selector: "app@owner",
            pane_id: Some("pane-1"),
            replay_after: 42,
            replay_mode: Some("gap"),
            replay_gap: true,
            oldest_sequence: Some(100),
        })
        .expect("replay start JSON");

        assert_eq!(value["type"], "replay-start");
        assert_eq!(value["replay_after"], 42);
        assert_eq!(value["replay_mode"], "gap");
        assert_eq!(value["replay_gap"], true);
        assert_eq!(value["oldest_sequence"], 100);
    }

    #[test]
    fn terminal_errors_only_block_retry_when_explicitly_classified() {
        let generic = serde_json::to_value(TerminalServerMessage::Error {
            message: "temporary".to_owned(),
            fatal: true,
            retryable: None,
        })
        .unwrap();
        let nonretryable = serde_json::to_value(TerminalServerMessage::Error {
            message: "incomplete baseline".to_owned(),
            fatal: true,
            retryable: Some(false),
        })
        .unwrap();

        assert!(generic.get("retryable").is_none());
        assert_eq!(nonretryable["retryable"], false);
    }

    #[test]
    fn terminal_backend_must_match_the_persisted_session() {
        assert!(validate_terminal_backend("herdr", "herdr").is_ok());
        assert!(validate_terminal_backend("zellij", "zellij").is_ok());
        assert!(validate_terminal_backend("herdr", "webshell").is_err());
        assert!(validate_terminal_backend("zellij", "herdr").is_err());
    }
}
