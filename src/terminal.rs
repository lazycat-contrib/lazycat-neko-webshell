use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
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
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::broadcast;
use tokio::time::timeout;
use tracing::{info, warn};
use uuid::Uuid;

use crate::config::{DEFAULT_COLS, DEFAULT_ROWS, LIGHTOSCTL, MAX_CLIPBOARD_IMAGE_BYTES};
use crate::lightos;
use crate::state::{
    AppState, bool_flag, default_session_command_for_user, host_from_selector, mark_session_status,
    sync_session_login_user,
};
use crate::terminal_manager::{
    ManagedTerminal, OutputBuffer, OutputFrame, TerminalEvent, TerminalSpec,
};
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};

type TerminalSender = SplitSink<WebSocket, Message>;
type TerminalReceiver = SplitStream<WebSocket>;

const CLIPBOARD_IMAGE_STAGE_TIMEOUT: Duration = Duration::from_secs(15);

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
    pane_id: Option<String>,
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
    },
    ReplayComplete {
        session_id: &'a str,
        selector: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        pane_id: Option<&'a str>,
        last_sequence: u64,
    },
}

struct TerminalAttachTarget {
    spec: TerminalSpec,
    allow_spawn: bool,
    replay: bool,
    replay_after: u64,
    pane_id: Option<String>,
    output: Arc<OutputBuffer>,
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

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_terminal_socket(socket, state, query).await {
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

async fn handle_terminal_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    query: TerminalQuery,
) -> anyhow::Result<()> {
    let (mut sender, receiver) = socket.split();
    let target = match resolve_terminal_target(&state, &query).await {
        Ok(target) => target,
        Err(err) => {
            let message = err.to_string();
            let _ = send_terminal_error(&mut sender, message, true).await;
            return Err(err);
        }
    };
    let ready_cols = target.spec.cols;
    let ready_rows = target.spec.rows;
    let replay_after = target.replay_after;
    let replay = target.replay;
    let replay_output = Arc::clone(&target.output);
    let pane_id = target.pane_id.clone();
    let allow_spawn = target.allow_spawn;
    let session_id = target.spec.session_id.clone();
    let target_selector = target.spec.selector.clone();
    let replay_context = TerminalReplayContext {
        session_id: &session_id,
        selector: &target_selector,
        cols: ready_cols,
        rows: ready_rows,
        replay,
        replay_after,
        pane_id: pane_id.as_deref(),
        output: replay_output.as_ref(),
    };
    let terminal = match state.sessions.open_terminal(target.spec, allow_spawn) {
        Ok(terminal) => terminal,
        Err(err) => {
            if !allow_spawn && replay {
                replay_stopped_terminal(&mut sender, &replay_context).await?;
                return Ok(());
            }
            if allow_spawn {
                state.sessions.mark_status(&session_id, "stopped");
            }
            let message = err.to_string();
            let _ = send_terminal_error(&mut sender, message, true).await;
            return Err(err);
        }
    };
    serve_open_terminal(sender, receiver, state, terminal, &replay_context).await
}

async fn serve_open_terminal(
    mut sender: TerminalSender,
    mut receiver: TerminalReceiver,
    state: Arc<AppState>,
    terminal: Arc<ManagedTerminal>,
    replay_context: &TerminalReplayContext<'_>,
) -> anyhow::Result<()> {
    mark_session_status(&state, terminal.session_id(), "running");
    let mut event_rx = terminal.subscribe();
    send_control(
        &mut sender,
        &TerminalServerMessage::Ready {
            session_id: terminal.session_id(),
            selector: terminal.selector(),
            cols: replay_context.cols,
            rows: replay_context.rows,
        },
    )
    .await?;

    let mut last_sent_sequence = replay_context.replay_after;
    if replay_context.replay {
        let Some(sequence) = send_replay_snapshot(
            &mut sender,
            &terminal,
            replay_context.pane_id,
            replay_context.output,
            replay_context.replay_after,
        )
        .await?
        else {
            return Ok(());
        };
        last_sent_sequence = sequence;
    }

    let mut pending_clipboard_image = None;
    loop {
        tokio::select! {
            event = event_rx.recv() => {
                if !handle_terminal_event(
                    &mut sender,
                    &state,
                    &terminal,
                    event,
                    &mut last_sent_sequence,
                ).await? {
                    break;
                }
            }
            Some(message) = receiver.next() => {
                if !handle_terminal_client_message(
                    &mut sender,
                    &state,
                    &terminal,
                    &mut pending_clipboard_image,
                    message?,
                ).await? {
                    break;
                }
            }
            else => break,
        }
    }

    Ok(())
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
    pending_clipboard_image: &mut Option<PendingClipboardImage>,
    message: Message,
) -> anyhow::Result<bool> {
    match message {
        Message::Binary(data) => {
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
                    send_terminal_error(sender, err.to_string(), false).await?;
                }
                return Ok(true);
            }
            terminal.write_input(data.to_vec())?;
            Ok(true)
        }
        Message::Text(text) => {
            handle_terminal_control_message(state, &text, terminal, pending_clipboard_image)
        }
        Message::Close(_) => Ok(false),
        Message::Ping(payload) => {
            let _ = sender.send(Message::Pong(payload)).await;
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
) -> anyhow::Result<bool> {
    match event {
        Ok(TerminalEvent::Output(frame)) => {
            if frame.sequence <= *last_sent_sequence {
                return Ok(true);
            }
            if !send_output_frame(sender, &frame).await? {
                return Ok(false);
            }
            *last_sent_sequence = frame.sequence;
            Ok(true)
        }
        Ok(TerminalEvent::Exit(info)) => {
            mark_session_status(state, terminal.session_id(), "exited");
            state.sessions.forget_terminal(terminal.session_id());
            send_control(
                sender,
                &TerminalServerMessage::ProcessExit {
                    exit_code: info.exit_code,
                    message: info.message,
                },
            )
            .await?;
            Ok(false)
        }
        Ok(TerminalEvent::Error(message)) => {
            send_terminal_error(sender, message, true).await?;
            Ok(false)
        }
        Err(broadcast::error::RecvError::Lagged(_)) => {
            send_terminal_error(
                sender,
                "terminal output backlog exceeded; reconnecting".to_owned(),
                false,
            )
            .await?;
            Ok(false)
        }
        Err(broadcast::error::RecvError::Closed) => Ok(false),
    }
}

async fn send_replay_snapshot(
    sender: &mut TerminalSender,
    terminal: &ManagedTerminal,
    pane_id: Option<&str>,
    output: &OutputBuffer,
    replay_after: u64,
) -> anyhow::Result<Option<u64>> {
    send_control(
        sender,
        &TerminalServerMessage::ReplayStart {
            session_id: terminal.session_id(),
            selector: terminal.selector(),
            pane_id,
            replay_after,
        },
    )
    .await?;

    let (frames, last_sequence) = output.snapshot_after(replay_after);
    info!(
        session_id = terminal.session_id(),
        selector = terminal.selector(),
        pane_id = pane_id.unwrap_or(""),
        replay_after,
        last_sequence,
        frame_count = frames.len(),
        "replaying terminal output history"
    );
    let mut last_sent_sequence = replay_after.max(last_sequence);
    for frame in frames {
        if !send_output_frame(sender, &frame).await? {
            return Ok(None);
        }
        last_sent_sequence = last_sent_sequence.max(frame.sequence);
    }

    send_control(
        sender,
        &TerminalServerMessage::ReplayComplete {
            session_id: terminal.session_id(),
            selector: terminal.selector(),
            pane_id,
            last_sequence,
        },
    )
    .await?;
    Ok(Some(last_sent_sequence))
}

async fn send_replay_snapshot_for_target(
    sender: &mut TerminalSender,
    session_id: &str,
    selector: &str,
    pane_id: Option<&str>,
    output: &OutputBuffer,
    replay_after: u64,
) -> anyhow::Result<Option<u64>> {
    send_control(
        sender,
        &TerminalServerMessage::ReplayStart {
            session_id,
            selector,
            pane_id,
            replay_after,
        },
    )
    .await?;

    let (frames, last_sequence) = output.snapshot_after(replay_after);
    info!(
        session_id = session_id,
        selector = selector,
        pane_id = pane_id.unwrap_or(""),
        replay_after,
        last_sequence,
        frame_count = frames.len(),
        "replaying stopped terminal output history"
    );
    let mut last_sent_sequence = replay_after.max(last_sequence);
    for frame in frames {
        if !send_output_frame(sender, &frame).await? {
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

fn handle_terminal_control_message(
    state: &AppState,
    text: &str,
    terminal: &ManagedTerminal,
    pending_clipboard_image: &mut Option<PendingClipboardImage>,
) -> anyhow::Result<bool> {
    if pending_clipboard_image.is_some() {
        pending_clipboard_image.take();
        return Err(anyhow!("clipboard image binary frame expected"));
    }

    if let Some(rest) = text.strip_prefix("input:") {
        terminal.write_input(rest.as_bytes().to_vec())?;
        return Ok(true);
    }

    if let Some(rest) = text.strip_prefix("resize:") {
        let (cols, rows) = parse_resize_payload(rest)?;
        terminal.resize(cols, rows)?;
        return Ok(true);
    }

    match serde_json::from_str::<TerminalClientMessage>(text) {
        Ok(TerminalClientMessage::Input { data }) => {
            terminal.write_input(data.into_bytes())?;
            Ok(true)
        }
        Ok(TerminalClientMessage::Resize { cols, rows }) => {
            terminal.resize(cols, rows)?;
            state
                .sessions
                .persist_resize(terminal.session_id(), cols, rows)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::ClipboardImage { extension, size }) => {
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
    let mut child = Command::new(LIGHTOSCTL)
        .args(["exec", "-i", selector, "/bin/sh", "-lc", script.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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

    let output = timeout(CLIPBOARD_IMAGE_STAGE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("clipboard image upload timed out"))?
        .map_err(|err| anyhow!("clipboard image upload failed: {err}"))?;
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

async fn send_control(
    sender: &mut TerminalSender,
    message: &TerminalServerMessage<'_>,
) -> anyhow::Result<()> {
    let text = serde_json::to_string(message)?;
    sender.send(Message::Text(text.into())).await?;
    Ok(())
}

async fn send_terminal_error(
    sender: &mut TerminalSender,
    message: String,
    fatal: bool,
) -> anyhow::Result<()> {
    send_control(sender, &TerminalServerMessage::Error { message, fatal }).await
}

async fn send_output_frame(
    sender: &mut TerminalSender,
    frame: &OutputFrame,
) -> anyhow::Result<bool> {
    if sender
        .send(Message::Binary(frame.data.clone().into()))
        .await
        .is_err()
    {
        return Ok(false);
    }
    send_control(
        sender,
        &TerminalServerMessage::OutputSequence {
            sequence: frame.sequence,
        },
    )
    .await?;
    Ok(true)
}

async fn resolve_terminal_target(
    state: &AppState,
    query: &TerminalQuery,
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
    if let Some(session_id) = query
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let (spec, status) = persisted_terminal_target(state, query, session_id, restart)?;
        let allow_spawn =
            restart.unwrap_or(false) || matches!(status.as_str(), "running" | "starting");
        let login_user = authorize_terminal_selector(&spec.selector, allow_spawn).await?;
        let spec = refresh_persisted_terminal_login_user(state, session_id, spec, &login_user)?;
        let output = state.output_buffer(session_id, spec.output_frame_limit);
        return Ok(TerminalAttachTarget {
            spec,
            allow_spawn,
            replay,
            replay_after,
            pane_id,
            output,
        });
    }

    let selector = query
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("name or session_id is required"))?;
    validate_selector(selector).map_err(|err| anyhow!(err.message.unwrap_or_default()))?;
    let cols = query.cols.unwrap_or(DEFAULT_COLS);
    let rows = query.rows.unwrap_or(DEFAULT_ROWS);
    validate_size(cols, rows)?;
    let host = host_from_selector(selector);
    let login_user = authorize_terminal_selector(selector, true).await?;
    let (command, args) = default_session_command_for_user(selector, &login_user);
    let output_limit = normalize_output_frame_limit(query.output_limit);
    let session_id = Uuid::new_v4().to_string();
    let output = state.output_buffer(&session_id, output_limit);
    Ok(TerminalAttachTarget {
        spec: TerminalSpec {
            session_id,
            host,
            selector: selector.to_owned(),
            command,
            args,
            cols,
            rows,
            output_frame_limit: output_limit,
        },
        allow_spawn: true,
        replay,
        replay_after,
        pane_id,
        output,
    })
}

fn persisted_terminal_target(
    state: &AppState,
    query: &TerminalQuery,
    session_id: &str,
    restart: Option<bool>,
) -> anyhow::Result<(TerminalSpec, String)> {
    let mut snapshot = None;
    let target = {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session id"))?;
        let cols = query.cols.unwrap_or(session.cols);
        let rows = query.rows.unwrap_or(session.rows);
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
        if changed {
            snapshot = Some(sessions.clone());
        }
        (spec, status)
    };
    if let Some(snapshot) = snapshot {
        state.persist_sessions_snapshot(&snapshot)?;
    }
    Ok(target)
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

async fn authorize_terminal_selector(
    selector: &str,
    require_running: bool,
) -> anyhow::Result<String> {
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
        .map(|value| bool_flag(value).ok_or_else(|| anyhow!("{name} must be a boolean")))
        .transpose()
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
    use axum::http::header::{HOST, ORIGIN};
    use axum::http::{HeaderMap, HeaderValue};

    use super::{clipboard_image_stage_script, origin_allowed, sanitize_clipboard_image_extension};

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
}
