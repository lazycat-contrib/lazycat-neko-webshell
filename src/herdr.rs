use std::time::Duration;

use anyhow::anyhow;
use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;
use tracing::warn;

use crate::config::LIGHTOSCTL;
use crate::lightos;
use crate::validation::validate_selector;

const HERDR_API_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_HERDR_SOCKET_REQUEST_BYTES: usize = 1024 * 1024;
const HERDR_SOCKET_BRIDGE_TIMEOUT_SECONDS: u64 = 5;
const SUPPORTED_HERDR_PROTOCOL_VERSION: u32 = 14;
const SUPPORTED_HERDR_SOURCE_VERSION: &str = "0.7.0";

type HerdrSocketSender = SplitSink<WebSocket, Message>;

const ALLOWED_HERDR_METHODS: &[&str] = &[
    "ping",
    "server.stop",
    "server.live_handoff",
    "server.reload_config",
    "server.agent_manifests",
    "server.reload_agent_manifests",
    "notification.show",
    "client.window_title.set",
    "client.window_title.clear",
    "workspace.create",
    "workspace.list",
    "workspace.get",
    "workspace.focus",
    "workspace.rename",
    "workspace.close",
    "worktree.list",
    "worktree.create",
    "worktree.open",
    "worktree.remove",
    "tab.create",
    "tab.list",
    "tab.get",
    "tab.focus",
    "tab.rename",
    "tab.close",
    "pane.split",
    "pane.swap",
    "pane.move",
    "pane.zoom",
    "pane.layout",
    "pane.process_info",
    "pane.neighbor",
    "pane.edges",
    "pane.focus_direction",
    "pane.resize",
    "pane.list",
    "pane.current",
    "pane.get",
    "pane.rename",
    "pane.send_text",
    "pane.send_keys",
    "pane.send_input",
    "pane.read",
    "pane.report_agent",
    "pane.report_agent_session",
    "pane.report_metadata",
    "pane.clear_agent_authority",
    "pane.release_agent",
    "pane.close",
    "pane.wait_for_output",
    "layout.export",
    "layout.apply",
    "agent.list",
    "agent.get",
    "agent.read",
    "agent.explain",
    "agent.send",
    "agent.rename",
    "agent.focus",
    "agent.start",
    "events.subscribe",
    "events.wait",
    "integration.install",
    "integration.uninstall",
    "plugin.link",
    "plugin.list",
    "plugin.unlink",
    "plugin.enable",
    "plugin.disable",
    "plugin.action.list",
    "plugin.action.invoke",
    "plugin.log.list",
    "plugin.pane.open",
    "plugin.pane.focus",
    "plugin.pane.close",
];

#[derive(Debug, Deserialize)]
pub struct HerdrQuery {
    name: String,
}

#[derive(Debug, Deserialize)]
pub struct HerdrActionRequest {
    name: String,
    action: HerdrAction,
    workspace_id: Option<String>,
    tab_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HerdrSocketRequest {
    name: String,
    method: String,
    #[serde(default = "empty_json_object")]
    params: Value,
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HerdrOutputSequenceRequest {
    name: String,
    session_id: String,
    sequence: u64,
}

#[derive(Debug, Serialize)]
pub struct HerdrOutputSequenceResponse {
    session_id: String,
    sequence: u64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HerdrAction {
    FocusWorkspace,
    FocusTab,
    CreateTab,
    CloseWorkspace,
    CreateWorkspace,
}

#[derive(Debug, Serialize)]
pub struct HerdrBridgeState {
    selector: String,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    herdr_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    herdr_protocol: Option<u32>,
    supported_herdr_version: &'static str,
    supported_protocol: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_compatible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<HerdrCapabilitiesInfo>,
    workspaces: Vec<HerdrWorkspaceInfo>,
    tabs: Vec<HerdrTabInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HerdrCapabilitiesInfo {
    live_handoff: bool,
}

#[derive(Debug, Serialize)]
pub struct HerdrWorkspaceInfo {
    workspace_id: String,
    number: usize,
    label: String,
    focused: bool,
    active_tab_id: String,
    tab_count: usize,
    pane_count: usize,
}

#[derive(Debug, Serialize)]
pub struct HerdrTabInfo {
    tab_id: String,
    workspace_id: String,
    number: usize,
    label: String,
    focused: bool,
    pane_count: usize,
}

struct AuthorizedHerdrTarget {
    selector: String,
    login_user: String,
}

#[derive(Clone, Debug, Default)]
struct HerdrPingInfo {
    version: Option<String>,
    protocol: Option<u32>,
    capabilities: Option<HerdrCapabilitiesInfo>,
}

#[derive(Debug)]
pub(crate) struct HerdrBridgeError {
    status: StatusCode,
    message: String,
}

pub(crate) async fn get_herdr_state(
    Query(query): Query<HerdrQuery>,
) -> Result<Json<HerdrBridgeState>, HerdrBridgeError> {
    let target = authorize_herdr_target(&query.name).await?;
    Ok(Json(snapshot_herdr_state(&target).await))
}

pub(crate) async fn post_herdr_action(
    State(_state): State<std::sync::Arc<crate::state::AppState>>,
    Json(request): Json<HerdrActionRequest>,
) -> Result<Json<HerdrBridgeState>, HerdrBridgeError> {
    let target = authorize_herdr_target(&request.name).await?;
    match request.action {
        HerdrAction::FocusWorkspace => {
            let workspace_id = required_id(request.workspace_id.as_deref(), "workspace_id")?;
            run_herdr_request(
                &target,
                "workspace.focus",
                json!({ "workspace_id": workspace_id }),
            )
            .await?;
        }
        HerdrAction::FocusTab => {
            let tab_id = required_id(request.tab_id.as_deref(), "tab_id")?;
            run_herdr_request(&target, "tab.focus", json!({ "tab_id": tab_id })).await?;
        }
        HerdrAction::CreateTab => {
            run_herdr_request(
                &target,
                "tab.create",
                json!({
                    "workspace_id": request.workspace_id,
                    "focus": true,
                }),
            )
            .await?;
        }
        HerdrAction::CloseWorkspace => {
            let workspace_id = required_id(request.workspace_id.as_deref(), "workspace_id")?;
            run_herdr_request(
                &target,
                "workspace.close",
                json!({ "workspace_id": workspace_id }),
            )
            .await?;
        }
        HerdrAction::CreateWorkspace => {
            run_herdr_request(
                &target,
                "workspace.create",
                json!({
                    "focus": true,
                }),
            )
            .await?;
        }
    }
    Ok(Json(snapshot_herdr_state(&target).await))
}

pub(crate) async fn post_herdr_socket(
    Json(request): Json<HerdrSocketRequest>,
) -> Result<Json<Value>, HerdrBridgeError> {
    let target = authorize_herdr_target(&request.name).await?;
    validate_herdr_method(&request.method)?;
    let request_id = request
        .id
        .unwrap_or_else(|| format!("lazycat-webshell:{}", request.method));
    let response = run_herdr_request_raw(
        &target,
        &request.method,
        normalize_herdr_params(request.params),
    )
    .await
    .map(|mut response| {
        if let Some(object) = response.as_object_mut() {
            object
                .entry("id")
                .or_insert_with(|| Value::String(request_id));
        }
        response
    })?;
    Ok(Json(response))
}

pub(crate) async fn post_herdr_output_sequence(
    State(state): State<std::sync::Arc<crate::state::AppState>>,
    Json(request): Json<HerdrOutputSequenceRequest>,
) -> Result<Json<HerdrOutputSequenceResponse>, HerdrBridgeError> {
    let target = authorize_herdr_target(&request.name).await?;
    let session_id = request.session_id.trim();
    authorize_herdr_output_sequence_session(&state, &target.selector, session_id)?;
    let sequence = state
        .database()
        .store_herdr_output_sequence(session_id, request.sequence)
        .map_err(|err| database_error("failed to persist Herdr output sequence", err))?;
    Ok(Json(HerdrOutputSequenceResponse {
        session_id: session_id.to_owned(),
        sequence,
    }))
}

pub(crate) async fn herdr_ws(
    headers: HeaderMap,
    Query(query): Query<HerdrQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "invalid websocket origin").into_response();
    }
    let target = match authorize_herdr_target(&query.name).await {
        Ok(target) => target,
        Err(err) => return err.into_response(),
    };

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_herdr_socket(socket, target).await {
            warn!(error = %err, "Herdr socket bridge ended with error");
        }
    })
}

async fn authorize_herdr_target(selector: &str) -> Result<AuthorizedHerdrTarget, HerdrBridgeError> {
    let selector = selector.trim();
    validate_selector(selector).map_err(|err| HerdrBridgeError {
        status: StatusCode::BAD_REQUEST,
        message: err
            .message
            .unwrap_or_else(|| "invalid LightOS selector".to_owned()),
    })?;
    let login_user = lightos::login_user_for_selector(selector, true)
        .await
        .map_err(|err| HerdrBridgeError {
            status: StatusCode::FORBIDDEN,
            message: err
                .message
                .unwrap_or_else(|| "selector is not authorized".to_owned()),
        })?;
    Ok(AuthorizedHerdrTarget {
        selector: selector.to_owned(),
        login_user,
    })
}

async fn snapshot_herdr_state(target: &AuthorizedHerdrTarget) -> HerdrBridgeState {
    let ping_info = match run_herdr_request(target, "ping", json!({})).await {
        Ok(response) => parse_herdr_ping(&response),
        Err(err) => {
            return build_herdr_state(
                target,
                false,
                Some(err.message),
                HerdrPingInfo::default(),
                Vec::new(),
                Vec::new(),
            );
        }
    };

    let workspaces = match run_herdr_request(target, "workspace.list", json!({})).await {
        Ok(response) => parse_workspaces(&response),
        Err(err) => {
            return build_herdr_state(
                target,
                true,
                Some(err.message),
                ping_info,
                Vec::new(),
                Vec::new(),
            );
        }
    };
    let focused_workspace = workspaces
        .iter()
        .find(|workspace| workspace.focused)
        .or_else(|| workspaces.first());
    let tabs = if let Some(workspace) = focused_workspace {
        match run_herdr_request(
            target,
            "tab.list",
            json!({ "workspace_id": workspace.workspace_id }),
        )
        .await
        {
            Ok(response) => parse_tabs(&response),
            Err(err) => {
                warn!(
                    error = %err.message,
                    selector = %target.selector,
                    "failed to list Herdr tabs"
                );
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    build_herdr_state(target, true, None, ping_info, workspaces, tabs)
}

fn build_herdr_state(
    target: &AuthorizedHerdrTarget,
    available: bool,
    message: Option<String>,
    ping_info: HerdrPingInfo,
    workspaces: Vec<HerdrWorkspaceInfo>,
    tabs: Vec<HerdrTabInfo>,
) -> HerdrBridgeState {
    HerdrBridgeState {
        selector: target.selector.clone(),
        available,
        message,
        herdr_version: ping_info.version,
        herdr_protocol: ping_info.protocol,
        supported_herdr_version: SUPPORTED_HERDR_SOURCE_VERSION,
        supported_protocol: SUPPORTED_HERDR_PROTOCOL_VERSION,
        protocol_compatible: ping_info
            .protocol
            .map(|protocol| protocol == SUPPORTED_HERDR_PROTOCOL_VERSION),
        capabilities: ping_info.capabilities,
        workspaces,
        tabs,
    }
}

async fn run_herdr_request(
    target: &AuthorizedHerdrTarget,
    method: &str,
    params: Value,
) -> Result<Value, HerdrBridgeError> {
    let response = run_herdr_request_raw(target, method, params).await?;
    if let Some(error) = response.get("error") {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_GATEWAY,
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Herdr socket request failed")
                .to_owned(),
        });
    }
    Ok(response)
}

async fn run_herdr_request_raw(
    target: &AuthorizedHerdrTarget,
    method: &str,
    params: Value,
) -> Result<Value, HerdrBridgeError> {
    validate_herdr_method(method)?;
    let request = json!({
        "id": format!("lazycat-webshell:{method}"),
        "method": method,
        "params": normalize_herdr_params(params),
    });
    let script = herdr_socket_script(&target.login_user, &request.to_string());
    let mut command = Command::new(LIGHTOSCTL);
    command.args([
        "exec",
        "-i",
        target.selector.as_str(),
        "/bin/sh",
        "-lc",
        script.as_str(),
    ]);
    let output = timeout(HERDR_API_TIMEOUT, command.output())
        .await
        .map_err(|_| HerdrBridgeError {
            status: StatusCode::GATEWAY_TIMEOUT,
            message: "Herdr socket request timed out".to_owned(),
        })?
        .map_err(|err| HerdrBridgeError {
            status: StatusCode::BAD_GATEWAY,
            message: format!("failed to enter target instance: {err}"),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_GATEWAY,
            message: format!("Herdr bridge command failed: {detail}"),
        });
    }
    if stdout.is_empty() {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_GATEWAY,
            message: "Herdr socket returned an empty response".to_owned(),
        });
    }
    let response = serde_json::from_str::<Value>(&stdout).map_err(|err| HerdrBridgeError {
        status: StatusCode::BAD_GATEWAY,
        message: format!("invalid Herdr socket response: {err}"),
    })?;
    Ok(response)
}

async fn handle_herdr_socket(
    socket: WebSocket,
    target: AuthorizedHerdrTarget,
) -> anyhow::Result<()> {
    let mut command = Command::new(LIGHTOSCTL);
    command
        .args([
            "exec",
            "-i",
            target.selector.as_str(),
            "/bin/sh",
            "-lc",
            herdr_socket_stream_script(&target.login_user).as_str(),
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn()?;
    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Herdr bridge stdin is unavailable"))?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Herdr bridge stdout is unavailable"))?;
    let child_stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Herdr bridge stderr is unavailable"))?;

    let (mut sender, mut receiver) = socket.split();
    let mut stdout_lines = BufReader::new(child_stdout).lines();
    let mut stderr_lines = BufReader::new(child_stderr).lines();

    loop {
        tokio::select! {
            line = stdout_lines.next_line() => {
                match line? {
                    Some(line) => sender.send(Message::Text(line.into())).await?,
                    None => break,
                }
            }
            line = stderr_lines.next_line() => {
                match line? {
                    Some(line) if !line.trim().is_empty() => {
                        warn!(selector = %target.selector, message = %line, "Herdr socket bridge stderr");
                    }
                    Some(_) | None => {}
                }
            }
            message = receiver.next() => {
                if !handle_herdr_socket_client_message(
                    &mut sender,
                    &mut child_stdin,
                    &target.selector,
                    message,
                ).await? {
                    break;
                }
            }
            else => break,
        }
    }

    let _ = child.start_kill();
    let _ = timeout(Duration::from_secs(1), child.wait()).await;
    Ok(())
}

async fn handle_herdr_socket_client_message(
    sender: &mut HerdrSocketSender,
    child_stdin: &mut tokio::process::ChildStdin,
    selector: &str,
    message: Option<Result<Message, axum::Error>>,
) -> anyhow::Result<bool> {
    let Some(message) = message else {
        return Ok(false);
    };
    match message? {
        Message::Text(text) => {
            let text = text.to_string();
            if text.len() > MAX_HERDR_SOCKET_REQUEST_BYTES {
                sender
                    .send(Message::Text(
                        herdr_wire_error(
                            None,
                            "request_too_large",
                            "Herdr socket request is too large",
                        )
                        .into(),
                    ))
                    .await?;
                return Ok(true);
            }
            match validate_herdr_wire_request(&text) {
                Ok(()) => {
                    child_stdin.write_all(text.as_bytes()).await?;
                    if !text.ends_with('\n') {
                        child_stdin.write_all(b"\n").await?;
                    }
                    child_stdin.flush().await?;
                }
                Err(error) => {
                    sender.send(Message::Text(error.into())).await?;
                }
            }
            Ok(true)
        }
        Message::Binary(_) => {
            sender
                .send(Message::Text(
                    herdr_wire_error(
                        None,
                        "invalid_request",
                        "Herdr socket bridge accepts JSON text only",
                    )
                    .into(),
                ))
                .await?;
            Ok(true)
        }
        Message::Ping(payload) => {
            sender.send(Message::Pong(payload)).await?;
            Ok(true)
        }
        Message::Pong(_) => Ok(true),
        Message::Close(_) => {
            warn!(selector = %selector, "Herdr socket bridge closed by client");
            Ok(false)
        }
    }
}

fn validate_herdr_wire_request(text: &str) -> Result<(), String> {
    let value = serde_json::from_str::<Value>(text)
        .map_err(|err| herdr_wire_error(None, "invalid_json", &format!("invalid JSON: {err}")))?;
    let id = herdr_request_id(&value);
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return Err(herdr_wire_error(
            id.as_deref(),
            "invalid_request",
            "method is required",
        ));
    };
    validate_herdr_method(method)
        .map_err(|err| herdr_wire_error(id.as_deref(), "method_not_allowed", &err.message))
}

fn herdr_request_id(value: &Value) -> Option<String> {
    value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn herdr_wire_error(id: Option<&str>, code: &str, message: &str) -> String {
    json!({
        "id": id.unwrap_or("lazycat-webshell:error"),
        "error": {
            "code": code,
            "message": message,
        },
    })
    .to_string()
}

fn validate_herdr_method(method: &str) -> Result<(), HerdrBridgeError> {
    let method = method.trim();
    if is_allowed_herdr_method(method) {
        return Ok(());
    }
    Err(HerdrBridgeError {
        status: StatusCode::BAD_REQUEST,
        message: format!("Herdr socket method is not allowed: {method}"),
    })
}

fn is_allowed_herdr_method(method: &str) -> bool {
    ALLOWED_HERDR_METHODS.contains(&method.trim())
}

fn authorize_herdr_output_sequence_session(
    state: &crate::state::AppState,
    selector: &str,
    session_id: &str,
) -> Result<(), HerdrBridgeError> {
    if session_id.is_empty() {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_REQUEST,
            message: "session_id is required".to_owned(),
        });
    }
    let sessions = state.sessions.read().map_err(|_| HerdrBridgeError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "session store lock poisoned".to_owned(),
    })?;
    let Some(session) = sessions.get(session_id) else {
        return Err(HerdrBridgeError {
            status: StatusCode::NOT_FOUND,
            message: "Herdr session not found".to_owned(),
        });
    };
    if session.selector != selector {
        return Err(HerdrBridgeError {
            status: StatusCode::FORBIDDEN,
            message: "Herdr session does not belong to the selected instance".to_owned(),
        });
    }
    if !session
        .metadata
        .get("sessionBackend")
        .is_some_and(|backend| backend == "herdr")
    {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_REQUEST,
            message: "session is not a Herdr session".to_owned(),
        });
    }
    drop(sessions);

    let workspaces = state.workspaces.read().map_err(|_| HerdrBridgeError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "workspace store lock poisoned".to_owned(),
    })?;
    let in_workspace = workspaces.get(selector).is_some_and(|workspace| {
        workspace
            .tabs
            .iter()
            .any(|tab| tab.panes.iter().any(|pane| pane.session_id == session_id))
    });
    if !in_workspace {
        return Err(HerdrBridgeError {
            status: StatusCode::NOT_FOUND,
            message: "Herdr session is not attached to the workspace".to_owned(),
        });
    }
    Ok(())
}

fn database_error(context: &str, err: std::io::Error) -> HerdrBridgeError {
    let status = if err.kind() == std::io::ErrorKind::InvalidData {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    HerdrBridgeError {
        status,
        message: format!("{context}: {err}"),
    }
}

fn normalize_herdr_params(params: Value) -> Value {
    if params.is_null() {
        empty_json_object()
    } else {
        params
    }
}

fn empty_json_object() -> Value {
    json!({})
}

fn herdr_socket_script(login_user: &str, request_json: &str) -> String {
    let request_json = shell_quote(request_json);
    format!(
        r#"{}
request_json={request_json}
export HERDR_WEB_REQUEST="$request_json"
export HERDR_WEB_SOCKET="$socket_path"
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import os
import socket
import sys

request = os.environ["HERDR_WEB_REQUEST"].encode("utf-8")
path = os.environ["HERDR_WEB_SOCKET"]
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(5)
client.connect(path)
client.sendall(request + b"\n")
chunks = []
while True:
    data = client.recv(65536)
    if not data:
        break
    chunks.append(data)
    if b"\n" in data:
        break
payload = b"".join(chunks).split(b"\n", 1)[0]
sys.stdout.buffer.write(payload + b"\n")
PY
elif command -v socat >/dev/null 2>&1; then
  printf '%s\n' "$request_json" | socat -t {HERDR_SOCKET_BRIDGE_TIMEOUT_SECONDS} - "UNIX-CONNECT:$socket_path" | sed -n '1p'
elif command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -q -- ' -U\|-U '; then
  printf '%s\n' "$request_json" | nc -U "$socket_path" | sed -n '1p'
else
  printf '%s\n' '{{"id":"lazycat-webshell","error":{{"code":"unavailable","message":"python3, socat, or nc -U is required for Herdr socket access"}}}}'
fi"#,
        herdr_socket_prelude(login_user),
    )
}

fn herdr_socket_stream_script(login_user: &str) -> String {
    format!(
        r#"{}
export HERDR_WEB_SOCKET="$socket_path"
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '{{"id":"lazycat-webshell","error":{{"code":"unavailable","message":"python3 is required for streaming Herdr socket access"}}}}'
  exit 0
fi
python3 - <<'PY'
import os
import selectors
import socket
import sys

path = os.environ["HERDR_WEB_SOCKET"]
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout({HERDR_SOCKET_BRIDGE_TIMEOUT_SECONDS})
client.connect(path)
client.setblocking(False)
stdin = sys.stdin.buffer
stdout = sys.stdout.buffer
selector = selectors.DefaultSelector()
selector.register(client, selectors.EVENT_READ, "socket")
selector.register(stdin, selectors.EVENT_READ, "stdin")

while True:
    for key, _ in selector.select():
        if key.data == "stdin":
            line = stdin.readline()
            if not line:
                sys.exit(0)
            client.sendall(line.rstrip(b"\n") + b"\n")
        else:
            data = client.recv(65536)
            if not data:
                sys.exit(0)
            stdout.write(data)
            stdout.flush()
PY"#,
        herdr_socket_prelude(login_user),
    )
}

fn herdr_socket_prelude(login_user: &str) -> String {
    let login_user = shell_quote(login_user.trim());
    format!(
        r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
login_user={login_user}
home_dir=""
if [ -n "$login_user" ]; then
  entry="$(getent passwd "$login_user" 2>/dev/null || true)"
  home_dir="$(printf '%s\n' "$entry" | cut -d: -f6)"
fi
if [ -z "$home_dir" ]; then
  home_dir="${{HOME:-/root}}"
fi
socket_path=""
check_socket() {{
  if [ -n "$1" ] && [ -S "$1" ]; then
    socket_path="$1"
    return 0
  fi
  return 1
}}
check_socket "${{HERDR_SOCKET_PATH:-}}" ||
check_socket "$home_dir/.config/herdr/herdr.sock" ||
check_socket "/root/.config/herdr/herdr.sock" ||
true
if [ -z "$socket_path" ]; then
  for candidate in "$home_dir"/.config/herdr/sessions/*/herdr.sock /root/.config/herdr/sessions/*/herdr.sock; do
    if [ -S "$candidate" ]; then
      socket_path="$candidate"
      break
    fi
  done
fi
if [ -z "$socket_path" ]; then
  printf '%s\n' '{{"id":"lazycat-webshell","error":{{"code":"unavailable","message":"Herdr socket not found"}}}}'
  exit 0
fi"#
    )
}

fn parse_workspaces(response: &Value) -> Vec<HerdrWorkspaceInfo> {
    response
        .get("result")
        .and_then(|result| result.get("workspaces"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some(HerdrWorkspaceInfo {
                workspace_id: value.get("workspace_id")?.as_str()?.to_owned(),
                number: json_usize(value, "number"),
                label: value
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("workspace")
                    .to_owned(),
                focused: value
                    .get("focused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                active_tab_id: value
                    .get("active_tab_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                tab_count: json_usize(value, "tab_count"),
                pane_count: json_usize(value, "pane_count"),
            })
        })
        .collect()
}

fn parse_tabs(response: &Value) -> Vec<HerdrTabInfo> {
    response
        .get("result")
        .and_then(|result| result.get("tabs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some(HerdrTabInfo {
                tab_id: value.get("tab_id")?.as_str()?.to_owned(),
                workspace_id: value.get("workspace_id")?.as_str()?.to_owned(),
                number: json_usize(value, "number"),
                label: value
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("tab")
                    .to_owned(),
                focused: value
                    .get("focused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                pane_count: json_usize(value, "pane_count"),
            })
        })
        .collect()
}

fn parse_herdr_ping(response: &Value) -> HerdrPingInfo {
    let Some(result) = response.get("result") else {
        return HerdrPingInfo::default();
    };
    HerdrPingInfo {
        version: result
            .get("version")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        protocol: result
            .get("protocol")
            .and_then(Value::as_u64)
            .and_then(|protocol| u32::try_from(protocol).ok()),
        capabilities: result
            .get("capabilities")
            .and_then(parse_herdr_capabilities),
    }
}

fn parse_herdr_capabilities(value: &Value) -> Option<HerdrCapabilitiesInfo> {
    if value.is_null() {
        return None;
    }
    Some(HerdrCapabilitiesInfo {
        live_handoff: value
            .get("live_handoff")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn json_usize(value: &Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|number| usize::try_from(number).ok())
        .unwrap_or(0)
}

fn required_id(value: Option<&str>, name: &str) -> Result<String, HerdrBridgeError> {
    let value = value.map(str::trim).unwrap_or_default();
    if value.is_empty() {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_REQUEST,
            message: format!("{name} is required"),
        });
    }
    Ok(value.to_owned())
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

impl IntoResponse for HerdrBridgeError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ALLOWED_HERDR_METHODS, SUPPORTED_HERDR_PROTOCOL_VERSION, SUPPORTED_HERDR_SOURCE_VERSION,
        is_allowed_herdr_method, parse_herdr_ping, parse_tabs, parse_workspaces, shell_quote,
        validate_herdr_wire_request,
    };

    #[test]
    fn parses_workspace_and_tab_lists_from_herdr_responses() {
        let workspaces = parse_workspaces(&json!({
            "result": {
                "type": "workspace_list",
                "workspaces": [{
                    "workspace_id": "w1",
                    "number": 1,
                    "label": "repo",
                    "focused": true,
                    "active_tab_id": "w1:t2",
                    "tab_count": 2,
                    "pane_count": 3
                }]
            }
        }));
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].workspace_id, "w1");
        assert!(workspaces[0].focused);

        let tabs = parse_tabs(&json!({
            "result": {
                "type": "tab_list",
                "tabs": [{
                    "tab_id": "w1:t2",
                    "workspace_id": "w1",
                    "number": 2,
                    "label": "tests",
                    "focused": true,
                    "pane_count": 1
                }]
            }
        }));
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].tab_id, "w1:t2");
        assert!(tabs[0].focused);
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("dev'user"), "'dev'\"'\"'user'");
    }

    #[test]
    fn herdr_socket_allowlist_covers_documented_methods() {
        assert_eq!(SUPPORTED_HERDR_PROTOCOL_VERSION, 14);
        assert_eq!(SUPPORTED_HERDR_SOURCE_VERSION, "0.7.0");
        assert!(ALLOWED_HERDR_METHODS.len() > 60);
        for method in ALLOWED_HERDR_METHODS {
            assert!(
                is_allowed_herdr_method(method),
                "{method} should be allowed"
            );
        }
        assert!(!is_allowed_herdr_method("workspace.delete"));
        assert!(!is_allowed_herdr_method("../../../bin/sh"));
    }

    #[test]
    fn parses_herdr_ping_protocol_metadata() {
        let ping = parse_herdr_ping(&json!({
            "result": {
                "type": "pong",
                "version": "0.7.0",
                "protocol": 14,
                "capabilities": {
                    "live_handoff": true
                }
            }
        }));
        assert_eq!(ping.version.as_deref(), Some("0.7.0"));
        assert_eq!(ping.protocol, Some(14));
        assert!(
            ping.capabilities
                .as_ref()
                .is_some_and(|capabilities| capabilities.live_handoff)
        );
    }

    #[test]
    fn validates_raw_herdr_socket_requests_before_proxying() {
        assert!(
            validate_herdr_wire_request(
                r#"{"id":"req_1","method":"pane.read","params":{"pane_id":"w1:p1","source":"recent"}}"#,
            )
            .is_ok()
        );

        let error =
            validate_herdr_wire_request(r#"{"id":"req_2","method":"not.real","params":{}}"#)
                .expect_err("unknown method should be rejected");
        assert!(error.contains("method_not_allowed"));
        assert!(error.contains("req_2"));
    }
}
