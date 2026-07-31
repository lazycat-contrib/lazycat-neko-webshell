use std::sync::LazyLock;
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
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;
use tracing::warn;

use crate::config::LIGHTOSCTL;
use crate::lightos;
use crate::ssh_backend;
use crate::tty_init::lightos_features_enabled;
use crate::validation::validate_selector;

const HERDR_API_TIMEOUT: Duration = Duration::from_secs(6);
const HERDR_LONG_REQUEST_TIMEOUT_MAX_MS: u64 = 300_000;
const HERDR_REQUEST_TIMEOUT_OVERHEAD: Duration = Duration::from_secs(2);
const MAX_HERDR_SOCKET_REQUEST_BYTES: usize = 1024 * 1024;
const HERDR_SOCKET_BRIDGE_TIMEOUT_SECONDS: u64 = 5;
const MIN_SUPPORTED_HERDR_PROTOCOL_VERSION: u32 = 14;
const HERDR_SOCKET_CONTRACT_JSON: &str = include_str!("herdr_socket_contract.json");
static HERDR_SOCKET_CONTRACT: LazyLock<HerdrSocketContract> = LazyLock::new(|| {
    let contract: HerdrSocketContract = serde_json::from_str(HERDR_SOCKET_CONTRACT_JSON)
        .expect("embedded Herdr socket contract must be valid JSON");
    assert!(
        !contract.methods.is_empty() && !contract.subscriptions.is_empty(),
        "embedded Herdr socket contract must list methods and subscriptions"
    );
    contract
});

type HerdrSocketSender = SplitSink<WebSocket, Message>;

#[derive(Debug, Deserialize)]
struct HerdrSocketContract {
    source_version: String,
    source_revision: String,
    protocol: u32,
    schema_version: u32,
    methods: Vec<String>,
    subscriptions: Vec<String>,
}

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
    pane_id: Option<String>,
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
    FocusPane,
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
    supported_herdr_version: String,
    supported_protocol: u32,
    socket_schema_version: u32,
    socket_source_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_compatible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<HerdrCapabilitiesInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    focused_workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    focused_tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    focused_pane_id: Option<String>,
    workspaces: Vec<HerdrWorkspaceInfo>,
    tabs: Vec<HerdrTabInfo>,
    panes: Vec<HerdrPaneInfo>,
    agents: Vec<HerdrAgentInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HerdrCapabilitiesInfo {
    live_handoff: bool,
    detached_server_daemon: bool,
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
    tokens: Map<String, Value>,
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

#[derive(Debug, Serialize)]
pub struct HerdrPaneInfo {
    pane_id: String,
    workspace_id: String,
    tab_id: String,
    focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_title_stripped: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    agent_status: String,
    tokens: Map<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct HerdrAgentInfo {
    terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_agent: Option<String>,
    agent_status: String,
    workspace_id: String,
    tab_id: String,
    pane_id: String,
    focused: bool,
    revision: u64,
    launch_pending: bool,
    interactive_ready: bool,
    state_change_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_title_stripped: Option<String>,
    tokens: Map<String, Value>,
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

#[derive(Debug, Default)]
struct HerdrBridgeResources {
    focused_workspace_id: Option<String>,
    focused_tab_id: Option<String>,
    focused_pane_id: Option<String>,
    workspaces: Vec<HerdrWorkspaceInfo>,
    tabs: Vec<HerdrTabInfo>,
    panes: Vec<HerdrPaneInfo>,
    agents: Vec<HerdrAgentInfo>,
}

#[derive(Debug)]
pub(crate) struct HerdrBridgeError {
    status: StatusCode,
    message: String,
}

#[derive(Clone, Debug)]
pub(crate) enum HerdrTerminalOperation {
    Snapshot,
    Read {
        pane_id: String,
    },
    WaitForOutput {
        pane_id: String,
        after_sequence: u64,
        timeout_ms: u64,
    },
    SendText {
        pane_id: String,
        text: String,
    },
    SendKeys {
        pane_id: String,
        keys: Vec<String>,
    },
    SendInput {
        pane_id: String,
        data_base64: String,
    },
    Resize {
        pane_id: String,
        cols: u16,
        rows: u16,
    },
}

pub(crate) async fn run_terminal_mcp_operation(
    state: &crate::state::AppState,
    session_id: &str,
    operation: HerdrTerminalOperation,
) -> Result<Value, String> {
    let selector = {
        let sessions = state
            .sessions
            .read()
            .map_err(|_| "session store is unavailable".to_owned())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "Herdr session not found".to_owned())?;
        if session
            .metadata
            .get("sessionBackend")
            .is_none_or(|backend| backend != "herdr")
        {
            return Err("session is not a Herdr session".to_owned());
        }
        session.selector.clone()
    };
    authorize_herdr_output_sequence_session(state, &selector, session_id)
        .map_err(|err| err.message)?;
    let target = authorize_herdr_target(&selector)
        .await
        .map_err(|err| err.message)?;

    let (method, params, pane_id) = terminal_mcp_operation_request(operation);
    if let Some(pane_id) = pane_id {
        run_herdr_request(&target, "pane.get", json!({ "pane_id": pane_id }))
            .await
            .map_err(|err| err.message)?;
    }
    run_herdr_request(&target, method, params)
        .await
        .map_err(|err| err.message)
}

fn terminal_mcp_operation_request(
    operation: HerdrTerminalOperation,
) -> (&'static str, Value, Option<String>) {
    match operation {
        HerdrTerminalOperation::Snapshot => ("session.snapshot", json!({}), None),
        HerdrTerminalOperation::Read { pane_id } => (
            "pane.read",
            json!({ "pane_id": pane_id, "source": "recent" }),
            Some(pane_id),
        ),
        HerdrTerminalOperation::WaitForOutput {
            pane_id,
            after_sequence,
            timeout_ms,
        } => (
            "pane.wait_for_output",
            json!({
                "pane_id": pane_id,
                "after_sequence": after_sequence,
                "timeout_ms": timeout_ms,
            }),
            Some(pane_id),
        ),
        HerdrTerminalOperation::SendText { pane_id, text } => (
            "pane.send_text",
            json!({ "pane_id": pane_id, "text": text }),
            Some(pane_id),
        ),
        HerdrTerminalOperation::SendKeys { pane_id, keys } => (
            "pane.send_keys",
            json!({ "pane_id": pane_id, "keys": keys }),
            Some(pane_id),
        ),
        HerdrTerminalOperation::SendInput {
            pane_id,
            data_base64,
        } => (
            "pane.send_input",
            json!({ "pane_id": pane_id, "data_base64": data_base64 }),
            Some(pane_id),
        ),
        HerdrTerminalOperation::Resize {
            pane_id,
            cols,
            rows,
        } => (
            "pane.resize",
            json!({ "pane_id": pane_id, "cols": cols, "rows": rows }),
            Some(pane_id),
        ),
    }
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
        HerdrAction::FocusPane => {
            let pane_id = required_id(request.pane_id.as_deref(), "pane_id")?;
            let ping = run_herdr_request(&target, "ping", json!({})).await?;
            let (method, params) =
                herdr_pane_focus_request(parse_herdr_ping(&ping).protocol, &pane_id);
            run_herdr_request(&target, method, params).await?;
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
        .map_err(|err| database_error("failed to persist Herdr output sequence", &err))?;
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
    if ssh_backend::is_ssh_selector(selector) {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_REQUEST,
            message: "Herdr is only available for LightOS targets".to_owned(),
        });
    }
    if !lightos_features_enabled() {
        return Err(HerdrBridgeError {
            status: StatusCode::NOT_FOUND,
            message: "LightOS integration is disabled".to_owned(),
        });
    }
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
                HerdrBridgeResources::default(),
            );
        }
    };

    if ping_info
        .protocol
        .is_some_and(herdr_protocol_supports_session_snapshot)
    {
        match run_herdr_request(target, "session.snapshot", json!({})).await {
            Ok(response) => {
                return build_herdr_state(
                    target,
                    true,
                    None,
                    ping_info,
                    parse_herdr_session_snapshot(&response),
                );
            }
            Err(err) => {
                warn!(
                    error = %err.message,
                    selector = %target.selector,
                    "failed to read Herdr session snapshot; falling back to list requests"
                );
            }
        }
    }

    let workspaces = match run_herdr_request(target, "workspace.list", json!({})).await {
        Ok(response) => parse_workspaces(&response),
        Err(err) => {
            return build_herdr_state(
                target,
                true,
                Some(err.message),
                ping_info,
                HerdrBridgeResources::default(),
            );
        }
    };
    let tabs = match run_herdr_request(target, "tab.list", json!({})).await {
        Ok(response) => parse_tabs(&response),
        Err(err) => {
            warn!(
                error = %err.message,
                selector = %target.selector,
                "failed to list Herdr tabs"
            );
            Vec::new()
        }
    };
    let panes = match run_herdr_request(target, "pane.list", json!({})).await {
        Ok(response) => parse_panes(&response),
        Err(err) => {
            warn!(
                error = %err.message,
                selector = %target.selector,
                "failed to list Herdr panes"
            );
            Vec::new()
        }
    };

    build_herdr_state(
        target,
        true,
        None,
        ping_info,
        HerdrBridgeResources {
            workspaces,
            tabs,
            panes,
            ..HerdrBridgeResources::default()
        },
    )
}

fn parse_herdr_session_snapshot(response: &Value) -> HerdrBridgeResources {
    let focused_workspace_id = parse_snapshot_focus_id(response, "focused_workspace_id");
    let focused_tab_id = parse_snapshot_focus_id(response, "focused_tab_id");
    let focused_pane_id = parse_snapshot_focus_id(response, "focused_pane_id");
    let mut workspaces = parse_workspaces(response);
    let mut tabs = parse_tabs(response);
    let mut panes = parse_panes(response);
    let mut agents = parse_agents(response);
    if let Some(focused_id) = focused_workspace_id.as_deref() {
        for workspace in &mut workspaces {
            workspace.focused = workspace.workspace_id == focused_id;
        }
    }
    if let Some(focused_id) = focused_tab_id.as_deref() {
        for tab in &mut tabs {
            tab.focused = tab.tab_id == focused_id;
        }
    }
    if let Some(focused_id) = focused_pane_id.as_deref() {
        for pane in &mut panes {
            pane.focused = pane.pane_id == focused_id;
        }
        for agent in &mut agents {
            agent.focused = agent.pane_id == focused_id;
        }
    }
    HerdrBridgeResources {
        focused_workspace_id,
        focused_tab_id,
        focused_pane_id,
        workspaces,
        tabs,
        panes,
        agents,
    }
}

fn build_herdr_state(
    target: &AuthorizedHerdrTarget,
    available: bool,
    message: Option<String>,
    ping_info: HerdrPingInfo,
    resources: HerdrBridgeResources,
) -> HerdrBridgeState {
    HerdrBridgeState {
        selector: target.selector.clone(),
        available,
        message,
        herdr_version: ping_info.version,
        herdr_protocol: ping_info.protocol,
        supported_herdr_version: HERDR_SOCKET_CONTRACT.source_version.clone(),
        supported_protocol: HERDR_SOCKET_CONTRACT.protocol,
        socket_schema_version: HERDR_SOCKET_CONTRACT.schema_version,
        socket_source_revision: HERDR_SOCKET_CONTRACT.source_revision.clone(),
        protocol_compatible: ping_info.protocol.map(herdr_protocol_is_supported),
        capabilities: ping_info.capabilities,
        focused_workspace_id: resources.focused_workspace_id,
        focused_tab_id: resources.focused_tab_id,
        focused_pane_id: resources.focused_pane_id,
        workspaces: resources.workspaces,
        tabs: resources.tabs,
        panes: resources.panes,
        agents: resources.agents,
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
    let params = normalize_herdr_request_params(method, params);
    let request_timeout = herdr_request_timeout(method, &params);
    let request = json!({
        "id": format!("lazycat-webshell:{method}"),
        "method": method,
        "params": params,
    });
    let script = herdr_socket_script(
        &target.login_user,
        &request.to_string(),
        herdr_socket_timeout_seconds(request_timeout),
    );
    let mut command = Command::new(LIGHTOSCTL);
    command.args([
        "exec",
        "-i",
        target.selector.as_str(),
        "/bin/sh",
        "-lc",
        script.as_str(),
    ]);
    command.kill_on_drop(true);
    let output = timeout(request_timeout, command.output())
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
    let method = method.trim();
    HERDR_SOCKET_CONTRACT
        .methods
        .iter()
        .any(|allowed| allowed == method)
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
    if session
        .metadata
        .get("sessionBackend")
        .is_none_or(|backend| backend != "herdr")
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

fn database_error(context: &str, err: &std::io::Error) -> HerdrBridgeError {
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

fn normalize_herdr_request_params(method: &str, params: Value) -> Value {
    let mut params = normalize_herdr_params(params);
    match method {
        "agent.prompt" => {
            if let Some(wait) = params
                .as_object_mut()
                .and_then(|params| params.get_mut("wait"))
                .and_then(Value::as_object_mut)
            {
                cap_herdr_wait_timeout(wait);
            }
        }
        "agent.wait" | "events.wait" | "pane.wait_for_output" => {
            if let Some(params) = params.as_object_mut() {
                cap_herdr_wait_timeout(params);
            }
        }
        _ => {}
    }
    params
}

fn cap_herdr_wait_timeout(params: &mut Map<String, Value>) {
    match params.get("timeout_ms") {
        None | Some(Value::Null) => {
            params.insert(
                "timeout_ms".to_owned(),
                Value::from(HERDR_LONG_REQUEST_TIMEOUT_MAX_MS),
            );
        }
        Some(value) => {
            let Some(timeout_ms) = value.as_u64() else {
                return;
            };
            if timeout_ms > HERDR_LONG_REQUEST_TIMEOUT_MAX_MS {
                params.insert(
                    "timeout_ms".to_owned(),
                    Value::from(HERDR_LONG_REQUEST_TIMEOUT_MAX_MS),
                );
            }
        }
    }
}

fn empty_json_object() -> Value {
    json!({})
}

fn herdr_socket_script(
    login_user: &str,
    request_json: &str,
    socket_timeout_seconds: u64,
) -> String {
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
client.settimeout({socket_timeout_seconds})
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
  printf '%s\n' "$request_json" | socat -t {socket_timeout_seconds} - "UNIX-CONNECT:$socket_path" | sed -n '1p'
elif command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -q -- ' -U\|-U '; then
  printf '%s\n' "$request_json" | nc -U "$socket_path" | sed -n '1p'
else
  printf '%s\n' '{{"id":"lazycat-webshell","error":{{"code":"unavailable","message":"python3, socat, or nc -U is required for Herdr socket access"}}}}'
fi"#,
        herdr_socket_prelude(login_user),
    )
}

fn herdr_request_timeout(method: &str, params: &Value) -> Duration {
    let requested_ms = match method {
        "agent.prompt" => params.get("wait").and_then(Value::as_object).map(|wait| {
            wait.get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(HERDR_LONG_REQUEST_TIMEOUT_MAX_MS)
        }),
        "agent.wait" | "events.wait" | "pane.wait_for_output" => Some(
            params
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(HERDR_LONG_REQUEST_TIMEOUT_MAX_MS),
        ),
        _ => None,
    };
    let Some(requested_ms) = requested_ms else {
        return HERDR_API_TIMEOUT;
    };
    let bounded = Duration::from_millis(requested_ms.min(HERDR_LONG_REQUEST_TIMEOUT_MAX_MS))
        .saturating_add(HERDR_REQUEST_TIMEOUT_OVERHEAD);
    HERDR_API_TIMEOUT.max(bounded)
}

fn herdr_socket_timeout_seconds(request_timeout: Duration) -> u64 {
    request_timeout
        .as_secs()
        .saturating_sub(1)
        .max(HERDR_SOCKET_BRIDGE_TIMEOUT_SECONDS)
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
    herdr_result_collection(response, "workspaces")
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some(HerdrWorkspaceInfo {
                workspace_id: value.get("workspace_id")?.as_str()?.to_owned(),
                number: json_usize(value, "number"),
                label: value
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
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
                tokens: json_string_map(value, "tokens"),
            })
        })
        .collect()
}

fn parse_panes(response: &Value) -> Vec<HerdrPaneInfo> {
    herdr_result_collection(response, "panes")
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some(HerdrPaneInfo {
                pane_id: value.get("pane_id")?.as_str()?.to_owned(),
                workspace_id: value.get("workspace_id")?.as_str()?.to_owned(),
                tab_id: value.get("tab_id")?.as_str()?.to_owned(),
                focused: value
                    .get("focused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                title: json_optional_string(value, "title"),
                terminal_title: json_optional_string(value, "terminal_title"),
                terminal_title_stripped: json_optional_string(value, "terminal_title_stripped"),
                display_agent: json_optional_string(value, "display_agent"),
                agent: json_optional_string(value, "agent"),
                agent_status: value
                    .get("agent_status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                tokens: json_string_map(value, "tokens"),
            })
        })
        .collect()
}

fn parse_agents(response: &Value) -> Vec<HerdrAgentInfo> {
    herdr_result_collection(response, "agents")
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some(HerdrAgentInfo {
                terminal_id: value.get("terminal_id")?.as_str()?.to_owned(),
                name: json_optional_string(value, "name"),
                agent: json_optional_string(value, "agent"),
                display_agent: json_optional_string(value, "display_agent"),
                agent_status: value.get("agent_status")?.as_str()?.to_owned(),
                workspace_id: value.get("workspace_id")?.as_str()?.to_owned(),
                tab_id: value.get("tab_id")?.as_str()?.to_owned(),
                pane_id: value.get("pane_id")?.as_str()?.to_owned(),
                focused: value.get("focused")?.as_bool()?,
                revision: value.get("revision")?.as_u64()?,
                launch_pending: json_optional_bool(value, "launch_pending", false)?,
                interactive_ready: json_optional_bool(value, "interactive_ready", false)?,
                state_change_seq: json_optional_u64(value, "state_change_seq", 0)?,
                title: json_optional_string(value, "title"),
                terminal_title: json_optional_string(value, "terminal_title"),
                terminal_title_stripped: json_optional_string(value, "terminal_title_stripped"),
                tokens: json_string_map(value, "tokens"),
            })
        })
        .collect()
}

fn json_optional_bool(value: &Value, key: &str, default: bool) -> Option<bool> {
    value.get(key).map_or(Some(default), Value::as_bool)
}

fn json_optional_u64(value: &Value, key: &str, default: u64) -> Option<u64> {
    value.get(key).map_or(Some(default), Value::as_u64)
}

fn parse_tabs(response: &Value) -> Vec<HerdrTabInfo> {
    herdr_result_collection(response, "tabs")
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
                    .unwrap_or_default()
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

fn herdr_result_collection<'a>(response: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    let result = response.get("result")?;
    result.get(key).and_then(Value::as_array).or_else(|| {
        result
            .get("snapshot")
            .and_then(|snapshot| snapshot.get(key))
            .and_then(Value::as_array)
    })
}

fn parse_snapshot_focus_id(response: &Value, key: &str) -> Option<String> {
    response
        .get("result")?
        .get("snapshot")?
        .get(key)?
        .as_str()
        .map(ToOwned::to_owned)
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
        detached_server_daemon: value
            .get("detached_server_daemon")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn herdr_protocol_is_supported(protocol: u32) -> bool {
    (MIN_SUPPORTED_HERDR_PROTOCOL_VERSION..=HERDR_SOCKET_CONTRACT.protocol).contains(&protocol)
}

fn herdr_protocol_supports_session_snapshot(protocol: u32) -> bool {
    protocol >= 16
}

fn herdr_pane_focus_request(protocol: Option<u32>, pane_id: &str) -> (&'static str, Value) {
    if protocol.is_some_and(|protocol| protocol < 16) {
        ("agent.focus", json!({ "target": pane_id }))
    } else {
        ("pane.focus", json!({ "pane_id": pane_id }))
    }
}

fn json_usize(value: &Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|number| usize::try_from(number).ok())
        .unwrap_or(0)
}

fn json_optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn json_string_map(value: &Value, key: &str) -> Map<String, Value> {
    value
        .get(key)
        .and_then(Value::as_object)
        .map(|tokens| {
            tokens
                .iter()
                .filter(|(_, value)| value.is_string())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
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
    use serde_json::{Value, json};

    use super::{
        HERDR_SOCKET_CONTRACT, HerdrTerminalOperation, MIN_SUPPORTED_HERDR_PROTOCOL_VERSION,
        herdr_pane_focus_request, herdr_protocol_is_supported,
        herdr_protocol_supports_session_snapshot, herdr_request_timeout, is_allowed_herdr_method,
        normalize_herdr_request_params, parse_agents, parse_herdr_ping,
        parse_herdr_session_snapshot, parse_panes, parse_tabs, parse_workspaces, shell_quote,
        terminal_mcp_operation_request, validate_herdr_wire_request,
    };

    #[test]
    fn terminal_mcp_operations_map_only_to_typed_pane_methods() {
        let cases = [
            (
                HerdrTerminalOperation::Read {
                    pane_id: "pane-1".to_owned(),
                },
                "pane.read",
            ),
            (
                HerdrTerminalOperation::SendText {
                    pane_id: "pane-1".to_owned(),
                    text: "hello".to_owned(),
                },
                "pane.send_text",
            ),
            (
                HerdrTerminalOperation::SendKeys {
                    pane_id: "pane-1".to_owned(),
                    keys: vec!["Enter".to_owned()],
                },
                "pane.send_keys",
            ),
            (
                HerdrTerminalOperation::SendInput {
                    pane_id: "pane-1".to_owned(),
                    data_base64: "AA==".to_owned(),
                },
                "pane.send_input",
            ),
            (
                HerdrTerminalOperation::Resize {
                    pane_id: "pane-1".to_owned(),
                    cols: 120,
                    rows: 32,
                },
                "pane.resize",
            ),
        ];

        for (operation, expected) in cases {
            assert_eq!(terminal_mcp_operation_request(operation).0, expected);
        }
    }

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
    fn leaves_missing_workspace_and_tab_labels_for_frontend_localization() {
        let workspaces = parse_workspaces(&json!({
            "result": { "workspaces": [{ "workspace_id": "w1", "number": 1 }] }
        }));
        let tabs = parse_tabs(&json!({
            "result": { "tabs": [{ "tab_id": "t1", "workspace_id": "w1", "number": 1 }] }
        }));

        assert_eq!(workspaces[0].label, "");
        assert_eq!(tabs[0].label, "");
    }

    #[test]
    fn parses_workspace_and_tab_lists_from_herdr_snapshot_response() {
        let response = json!({
            "result": {
                "type": "session_snapshot",
                "snapshot": {
                    "focused_workspace_id": "w1",
                    "workspaces": [{
                        "workspace_id": "w1",
                        "number": 1,
                        "label": "repo",
                        "focused": true,
                        "active_tab_id": "w1:t1",
                        "tab_count": 1,
                        "pane_count": 1,
                        "tokens": { "summary": "review ready" }
                    }],
                    "tabs": [{
                        "tab_id": "w1:t1",
                        "workspace_id": "w1",
                        "number": 1,
                        "label": "main",
                        "focused": true,
                        "pane_count": 1
                    }],
                    "panes": [{
                        "pane_id": "w1:p1",
                        "terminal_id": "term-1",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "focused": true,
                        "title": "Refactor auth",
                        "terminal_title": "⠋ Codex",
                        "terminal_title_stripped": "Codex",
                        "display_agent": "Codex auth",
                        "agent": "codex",
                        "agent_status": "working",
                        "tokens": { "model": "gpt-5" },
                        "revision": 3
                    }],
                    "agents": [{
                        "terminal_id": "term-1",
                        "name": "reviewer",
                        "agent": "codex",
                        "display_agent": "Codex review",
                        "agent_status": "working",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "pane_id": "w1:p1",
                        "focused": true,
                        "revision": 4,
                        "launch_pending": false,
                        "interactive_ready": true,
                        "state_change_seq": 12,
                        "title": "Review auth",
                        "tokens": { "model": "gpt-5" }
                    }]
                }
            }
        });

        let workspaces = parse_workspaces(&response);
        let tabs = parse_tabs(&response);
        let panes = parse_panes(&response);
        let agents = parse_agents(&response);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].workspace_id, "w1");
        assert_eq!(
            workspaces[0].tokens.get("summary").and_then(Value::as_str),
            Some("review ready")
        );
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].tab_id, "w1:t1");
        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0].pane_id, "w1:p1");
        assert_eq!(panes[0].terminal_title_stripped.as_deref(), Some("Codex"));
        assert_eq!(panes[0].agent_status, "working");
        assert_eq!(
            panes[0].tokens.get("model").and_then(Value::as_str),
            Some("gpt-5")
        );
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].pane_id, "w1:p1");
        assert_eq!(agents[0].name.as_deref(), Some("reviewer"));
        assert!(agents[0].interactive_ready);
        assert!(!agents[0].launch_pending);
        assert_eq!(agents[0].state_change_seq, 12);
    }

    #[test]
    fn snapshot_keeps_tabs_from_background_workspaces_for_jump_navigation() {
        let response = json!({
            "result": {
                "type": "session_snapshot",
                "snapshot": {
                    "focused_workspace_id": "w1",
                    "workspaces": [
                        {
                            "workspace_id": "w1",
                            "number": 1,
                            "label": "current",
                            "focused": true,
                            "active_tab_id": "w1:t1",
                            "tab_count": 1,
                            "pane_count": 1
                        },
                        {
                            "workspace_id": "w2",
                            "number": 2,
                            "label": "background",
                            "focused": false,
                            "active_tab_id": "w2:t1",
                            "tab_count": 1,
                            "pane_count": 1
                        }
                    ],
                    "tabs": [
                        {
                            "tab_id": "w1:t1",
                            "workspace_id": "w1",
                            "number": 1,
                            "label": "one",
                            "focused": true,
                            "pane_count": 1
                        },
                        {
                            "tab_id": "w2:t1",
                            "workspace_id": "w2",
                            "number": 1,
                            "label": "two",
                            "focused": true,
                            "pane_count": 1
                        }
                    ]
                }
            }
        });

        let resources = parse_herdr_session_snapshot(&response);
        assert_eq!(resources.tabs.len(), 2);
        assert_eq!(resources.tabs[1].workspace_id, "w2");
    }

    #[test]
    fn session_snapshot_prefers_authoritative_top_level_focus_ids() {
        let resources = parse_herdr_session_snapshot(&json!({
            "result": {
                "type": "session_snapshot",
                "snapshot": {
                    "focused_workspace_id": "w2",
                    "focused_tab_id": "w2:t1",
                    "focused_pane_id": "w2:p1",
                    "workspaces": [
                        {
                            "workspace_id": "w1",
                            "number": 1,
                            "label": "one",
                            "focused": true,
                            "active_tab_id": "w1:t1",
                            "tab_count": 1,
                            "pane_count": 1
                        },
                        {
                            "workspace_id": "w2",
                            "number": 2,
                            "label": "two",
                            "focused": false,
                            "active_tab_id": "w2:t1",
                            "tab_count": 1,
                            "pane_count": 1
                        }
                    ],
                    "tabs": [
                        {
                            "tab_id": "w1:t1",
                            "workspace_id": "w1",
                            "number": 1,
                            "label": "one",
                            "focused": true,
                            "pane_count": 1
                        },
                        {
                            "tab_id": "w2:t1",
                            "workspace_id": "w2",
                            "number": 1,
                            "label": "two",
                            "focused": false,
                            "pane_count": 1
                        }
                    ],
                    "panes": [
                        {
                            "pane_id": "w1:p1",
                            "workspace_id": "w1",
                            "tab_id": "w1:t1",
                            "focused": true
                        },
                        {
                            "pane_id": "w2:p1",
                            "workspace_id": "w2",
                            "tab_id": "w2:t1",
                            "focused": false
                        }
                    ]
                }
            }
        }));

        assert_eq!(resources.focused_workspace_id.as_deref(), Some("w2"));
        assert_eq!(resources.focused_tab_id.as_deref(), Some("w2:t1"));
        assert_eq!(resources.focused_pane_id.as_deref(), Some("w2:p1"));
        assert_eq!(
            resources
                .workspaces
                .iter()
                .filter(|workspace| workspace.focused)
                .map(|workspace| workspace.workspace_id.as_str())
                .collect::<Vec<_>>(),
            ["w2"]
        );
        assert_eq!(
            resources
                .tabs
                .iter()
                .filter(|tab| tab.focused)
                .map(|tab| tab.tab_id.as_str())
                .collect::<Vec<_>>(),
            ["w2:t1"]
        );
        assert_eq!(
            resources
                .panes
                .iter()
                .filter(|pane| pane.focused)
                .map(|pane| pane.pane_id.as_str())
                .collect::<Vec<_>>(),
            ["w2:p1"]
        );
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("dev'user"), "'dev'\"'\"'user'");
    }

    #[test]
    fn herdr_socket_allowlist_covers_documented_methods() {
        assert_eq!(MIN_SUPPORTED_HERDR_PROTOCOL_VERSION, 14);
        assert_eq!(HERDR_SOCKET_CONTRACT.protocol, 17);
        assert_eq!(HERDR_SOCKET_CONTRACT.schema_version, 1);
        assert_eq!(HERDR_SOCKET_CONTRACT.source_version, "0.7.5");
        assert_eq!(
            HERDR_SOCKET_CONTRACT.source_revision,
            "0f161fac287011b3e216383e2b8482f049fd6a7b"
        );
        assert_eq!(HERDR_SOCKET_CONTRACT.methods.len(), 89);
        assert_eq!(HERDR_SOCKET_CONTRACT.subscriptions.len(), 26);
        for method in [
            "session.snapshot",
            "workspace.report_metadata",
            "pane.graphics.set",
            "pane.graphics.clear",
            "pane.graphics.info",
            "popup.close",
            "agent.send_keys",
            "agent.prompt",
            "agent.wait",
            "agent.view.set",
            "agent.view.clear",
        ] {
            assert!(
                is_allowed_herdr_method(method),
                "{method} should be allowed"
            );
        }
        for method in &HERDR_SOCKET_CONTRACT.methods {
            assert!(
                is_allowed_herdr_method(method),
                "{method} should be allowed"
            );
        }
        assert!(!is_allowed_herdr_method("agent.send"));
        assert!(!is_allowed_herdr_method("pane.graphics.stream"));
        assert!(!is_allowed_herdr_method("workspace.delete"));
        assert!(!is_allowed_herdr_method("../../../bin/sh"));
    }

    #[test]
    fn classifies_supported_herdr_protocols() {
        assert!(!herdr_protocol_is_supported(13));
        assert!(herdr_protocol_is_supported(14));
        assert!(herdr_protocol_is_supported(16));
        assert!(herdr_protocol_is_supported(17));
        assert!(!herdr_protocol_is_supported(18));
        assert!(!herdr_protocol_supports_session_snapshot(14));
        assert!(herdr_protocol_supports_session_snapshot(16));
        assert!(herdr_protocol_supports_session_snapshot(17));
    }

    #[test]
    fn pane_focus_uses_the_legacy_agent_action_before_protocol_16() {
        assert_eq!(
            herdr_pane_focus_request(Some(14), "w2:p2"),
            ("agent.focus", json!({ "target": "w2:p2" }))
        );
        assert_eq!(
            herdr_pane_focus_request(Some(16), "w2:p2"),
            ("pane.focus", json!({ "pane_id": "w2:p2" }))
        );
    }

    #[test]
    fn parses_herdr_ping_protocol_metadata() {
        let ping = parse_herdr_ping(&json!({
            "result": {
                "type": "pong",
                "version": "0.7.5",
                "protocol": 17,
                "capabilities": {
                    "live_handoff": true,
                    "detached_server_daemon": true
                }
            }
        }));
        assert_eq!(ping.version.as_deref(), Some("0.7.5"));
        assert_eq!(ping.protocol, Some(17));
        assert!(
            ping.capabilities
                .as_ref()
                .is_some_and(|capabilities| capabilities.live_handoff)
        );
        assert!(
            ping.capabilities
                .as_ref()
                .is_some_and(|capabilities| capabilities.detached_server_daemon)
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

    #[test]
    fn derives_bounded_timeouts_for_long_running_herdr_methods() {
        assert_eq!(
            herdr_request_timeout("ping", &json!({})),
            std::time::Duration::from_secs(6)
        );
        assert_eq!(
            herdr_request_timeout("agent.wait", &json!({ "timeout_ms": 120_000 })),
            std::time::Duration::from_secs(122)
        );
        assert_eq!(
            herdr_request_timeout(
                "agent.prompt",
                &json!({ "wait": { "until": ["done", "blocked"], "timeout_ms": 120_000 } })
            ),
            std::time::Duration::from_secs(122)
        );
        assert_eq!(
            herdr_request_timeout("agent.wait", &json!({ "timeout_ms": 600_000 })),
            std::time::Duration::from_secs(302)
        );
        assert_eq!(
            herdr_request_timeout("agent.prompt", &json!({ "wait": {} })),
            std::time::Duration::from_secs(302)
        );
        assert_eq!(
            herdr_request_timeout("agent.prompt", &json!({})),
            std::time::Duration::from_secs(6)
        );
    }

    #[test]
    fn caps_wait_timeouts_in_the_request_sent_to_herdr() {
        assert_eq!(
            normalize_herdr_request_params("agent.wait", json!({})),
            json!({ "timeout_ms": 300_000 })
        );
        assert_eq!(
            normalize_herdr_request_params("events.wait", json!({ "timeout_ms": 600_000 })),
            json!({ "timeout_ms": 300_000 })
        );
        assert_eq!(
            normalize_herdr_request_params("agent.prompt", json!({ "wait": {} })),
            json!({ "wait": { "timeout_ms": 300_000 } })
        );
        assert_eq!(
            normalize_herdr_request_params("agent.prompt", json!({})),
            json!({})
        );
    }

    #[test]
    fn rejects_agent_snapshots_with_invalid_defaulted_field_types() {
        let response = json!({
            "result": {
                "agents": [
                    {
                        "terminal_id": "term-valid",
                        "agent_status": "idle",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "pane_id": "w1:p1",
                        "focused": false,
                        "revision": 1
                    },
                    {
                        "terminal_id": "term-invalid-focused",
                        "agent_status": "working",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "pane_id": "w1:p2",
                        "focused": "yes",
                        "revision": 2
                    },
                    {
                        "terminal_id": "term-invalid-revision",
                        "agent_status": "working",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "pane_id": "w1:p3",
                        "focused": false,
                        "revision": "two"
                    },
                    {
                        "terminal_id": "term-invalid-launch",
                        "agent_status": "working",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "pane_id": "w1:p4",
                        "focused": false,
                        "revision": 3,
                        "launch_pending": "yes"
                    },
                    {
                        "terminal_id": "term-invalid-ready",
                        "agent_status": "working",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "pane_id": "w1:p5",
                        "focused": false,
                        "revision": 4,
                        "interactive_ready": "yes"
                    },
                    {
                        "terminal_id": "term-invalid-sequence",
                        "agent_status": "working",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "pane_id": "w1:p6",
                        "focused": false,
                        "revision": 5,
                        "state_change_seq": "five"
                    }
                ]
            }
        });

        let agents = parse_agents(&response);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].terminal_id, "term-valid");
        assert!(!agents[0].interactive_ready);
        assert_eq!(agents[0].state_change_seq, 0);
    }
}
