use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ContentBlock, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::schemars::{JsonSchema, schema_for};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::config::{
    DEFAULT_COLS, DEFAULT_ROWS, MCP_TERMINAL_DEFAULT_READ_BYTES, MCP_TERMINAL_MAX_WAIT_MS,
};
use crate::ssh_backend;
use crate::state::AppState;

use super::principal::McpPrincipal;
use super::service::TerminalControlService;
use super::types::{ControlAccess, TerminalBackend, TerminalCapability, TerminalMcpError};

const SERVER_NAME: &str = "lazycat-neko-webshell-terminal";
const PRODUCTION_HOST: &str = "app.community.lazycat.webshell.neko.lzcx";

#[derive(Clone)]
pub struct TerminalMcpServer {
    state: Arc<AppState>,
    terminal: TerminalControlService,
}

impl TerminalMcpServer {
    pub fn new(state: Arc<AppState>) -> Self {
        Self {
            terminal: TerminalControlService::new(Arc::clone(&state)),
            state,
        }
    }

    #[allow(clippy::too_many_lines)] // Keeps the MCP tool-name dispatch table in one auditable location.
    async fn dispatch(
        &self,
        name: &str,
        arguments: Option<Map<String, Value>>,
        principal: &McpPrincipal,
    ) -> CallToolResult {
        let result = match name {
            "terminal_list_sessions" => {
                let input = match parse_arguments::<ListSessionsInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                self.terminal
                    .list_sessions(
                        principal,
                        input.backend,
                        input.status.as_deref(),
                        input.selector.as_deref(),
                    )
                    .await
                    .map(|sessions| {
                        tool_success(json!({ "sessions": sessions }), "Terminal sessions listed")
                    })
            }
            "terminal_read" => {
                let input = match parse_arguments::<ReadInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                self.terminal
                    .read(
                        principal,
                        &input.session_id,
                        input.pane_id.as_deref(),
                        input.after_sequence,
                        input.wait_ms,
                        input.max_bytes,
                    )
                    .await
                    .map(|read| tool_success(json!(read), "Terminal output read"))
            }
            "terminal_request_control" => {
                let input = match parse_arguments::<RequestControlInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                self.terminal
                    .request_control(
                        principal,
                        &input.session_id,
                        input.pane_id.as_deref(),
                        input.capability,
                        &input.reason,
                    )
                    .await
                    .map(|access| match access {
                        ControlAccess::Granted(grant) => tool_success(
                            json!({ "decision": "approved", "grant": grant }),
                            "Terminal control granted",
                        ),
                        ControlAccess::ApprovalRequired(request) => tool_success(
                            json!({ "decision": "pending", "request": request }),
                            "Terminal-side approval required",
                        ),
                    })
            }
            "terminal_wait_for_control" => {
                let input = match parse_arguments::<WaitControlInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                self.state
                    .terminal_mcp
                    .wait_for_control(
                        principal,
                        &input.request_id,
                        Duration::from_millis(input.wait_ms.min(MCP_TERMINAL_MAX_WAIT_MS)),
                    )
                    .await
                    .map(|decision| {
                        tool_success(
                            json!({ "decision": decision }),
                            "Terminal control decision received",
                        )
                    })
            }
            "terminal_send_text" => {
                let input = match parse_arguments::<SendTextInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                self.terminal
                    .send_text(
                        principal,
                        &input.session_id,
                        input.pane_id.as_deref(),
                        &input.text,
                        input.append_enter,
                        &input.reason,
                    )
                    .await
                    .map(|()| tool_success(json!({ "ok": true }), "Terminal text sent"))
            }
            "terminal_send_keys" => {
                let input = match parse_arguments::<SendKeysInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                self.terminal
                    .send_keys(
                        principal,
                        &input.session_id,
                        input.pane_id.as_deref(),
                        &input.keys,
                        &input.reason,
                    )
                    .await
                    .map(|()| tool_success(json!({ "ok": true }), "Terminal keys sent"))
            }
            "terminal_send_input" => {
                let input = match parse_arguments::<SendInputInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                let Ok(data) = BASE64_STANDARD.decode(input.data_base64.trim()) else {
                    return tool_error(TerminalMcpError::invalid_input(
                        "dataBase64 must be valid base64",
                    ));
                };
                self.terminal
                    .send_input(
                        principal,
                        &input.session_id,
                        input.pane_id.as_deref(),
                        data,
                        &input.reason,
                    )
                    .await
                    .map(|()| tool_success(json!({ "ok": true }), "Terminal input sent"))
            }
            "terminal_resize" => {
                let input = match parse_arguments::<ResizeInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                self.terminal
                    .resize(
                        principal,
                        &input.session_id,
                        input.pane_id.as_deref(),
                        input.cols,
                        input.rows,
                        &input.reason,
                    )
                    .await
                    .map(|()| tool_success(json!({ "ok": true }), "Terminal resized"))
            }
            "terminal_revoke_control" => {
                let input = match parse_arguments::<RevokeControlInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                Ok(tool_success(
                    json!({
                        "revoked": self.terminal.revoke_control(principal, &input.grant_id),
                    }),
                    "Terminal control released",
                ))
            }
            "terminal_create_session" => {
                let input = match parse_arguments::<CreateSessionInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                let selector = match input.selector_for_backend() {
                    Ok(selector) => selector,
                    Err(error) => return tool_error(error),
                };
                self.terminal
                    .create_session(
                        principal,
                        input.backend,
                        &selector,
                        input.cols,
                        input.rows,
                        input.title.as_deref(),
                        &input.reason,
                    )
                    .await
                    .map(|session| {
                        tool_success(json!({ "session": session }), "Terminal session created")
                    })
            }
            "terminal_close_session" => {
                let input = match parse_arguments::<CloseSessionInput>(arguments) {
                    Ok(input) => input,
                    Err(error) => return tool_error(error),
                };
                self.terminal
                    .close_session(
                        principal,
                        &input.session_id,
                        input.pane_id.as_deref(),
                        &input.reason,
                    )
                    .await
                    .map(|()| tool_success(json!({ "closed": true }), "Terminal session closed"))
            }
            _ => Err(TerminalMcpError::invalid_input("unknown terminal tool")),
        };
        result.unwrap_or_else(tool_error)
    }

    fn enabled(&self) -> bool {
        self.state
            .plugins
            .read()
            .ok()
            .and_then(|plugins| plugins.get(super::PLUGIN_ID).map(|plugin| plugin.enabled))
            .unwrap_or(false)
    }
}

impl ServerHandler for TerminalMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "List and read terminal sessions first. Terminal writes and lifecycle changes are enforced by Terminal-side policy and may require approval.",
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: if self.enabled() {
                terminal_tools()
            } else {
                Vec::new()
            },
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if !self.enabled() {
            return Ok(tool_error(TerminalMcpError::disabled()));
        }
        let principal = context
            .extensions
            .get::<http::request::Parts>()
            .ok_or_else(TerminalMcpError::unauthenticated)
            .and_then(McpPrincipal::from_parts);
        let principal = match principal {
            Ok(principal) => principal,
            Err(error) => return Ok(tool_error(error)),
        };
        Ok(self
            .dispatch(&request.name, request.arguments, &principal)
            .await)
    }
}

pub fn streamable_http_service(
    state: Arc<AppState>,
) -> StreamableHttpService<TerminalMcpServer, LocalSessionManager> {
    let factory_state = state;
    StreamableHttpService::new(
        move || Ok(TerminalMcpServer::new(Arc::clone(&factory_state))),
        Arc::default(),
        StreamableHttpServerConfig::default()
            .with_stateful_mode(false)
            .with_json_response(true)
            .with_sse_keep_alive(None)
            .with_allowed_hosts([PRODUCTION_HOST, "localhost", "127.0.0.1", "::1"]),
    )
}

fn terminal_tools() -> Vec<Tool> {
    vec![
        tool::<ListSessionsInput>(
            "terminal_list_sessions",
            "List visible WebShell, SSH, and Herdr terminal sessions",
            true,
            false,
        ),
        tool::<ReadInput>(
            "terminal_read",
            "Read bounded terminal output after a sequence cursor, optionally waiting for new output",
            true,
            false,
        ),
        tool::<RequestControlInput>(
            "terminal_request_control",
            "Request or inspect Terminal-side control authorization for a session",
            false,
            false,
        ),
        tool::<WaitControlInput>(
            "terminal_wait_for_control",
            "Wait for a Terminal-side control approval or denial",
            true,
            false,
        ),
        tool::<SendTextInput>(
            "terminal_send_text",
            "Send bounded UTF-8 text to an authorized terminal session",
            false,
            false,
        ),
        tool::<SendKeysInput>(
            "terminal_send_keys",
            "Send allowlisted named terminal keys to an authorized session",
            false,
            false,
        ),
        tool::<SendInputInput>(
            "terminal_send_input",
            "Send bounded base64-encoded raw input to an authorized terminal session",
            false,
            false,
        ),
        tool::<ResizeInput>(
            "terminal_resize",
            "Resize an authorized terminal or Herdr pane",
            false,
            false,
        ),
        tool::<RevokeControlInput>(
            "terminal_revoke_control",
            "Release a control grant owned by this caller",
            false,
            false,
        ),
        tool::<CreateSessionInput>(
            "terminal_create_session",
            "Create a WebShell or SSH session using an authorized target or stored SSH profile",
            false,
            false,
        ),
        tool::<CloseSessionInput>(
            "terminal_close_session",
            "Close a WebShell or SSH session subject to terminate authorization",
            false,
            true,
        ),
    ]
}

fn tool<T: JsonSchema>(
    name: &'static str,
    description: &'static str,
    read_only: bool,
    destructive: bool,
) -> Tool {
    let schema =
        serde_json::to_value(schema_for!(T)).unwrap_or_else(|_| json!({ "type": "object" }));
    let schema = schema.as_object().cloned().unwrap_or_default();
    Tool::new(name, description, Arc::new(schema)).with_annotations(
        ToolAnnotations::new()
            .read_only(read_only)
            .destructive(destructive)
            .idempotent(false)
            .open_world(false),
    )
}

fn parse_arguments<T: DeserializeOwned>(
    arguments: Option<Map<String, Value>>,
) -> Result<T, TerminalMcpError> {
    serde_json::from_value(Value::Object(arguments.unwrap_or_default()))
        .map_err(|_| TerminalMcpError::invalid_input("tool arguments do not match the schema"))
}

fn tool_success(value: Value, summary: impl Into<String>) -> CallToolResult {
    let mut result = CallToolResult::success(vec![ContentBlock::text(summary.into())]);
    result.structured_content = Some(value);
    result
}

fn tool_error(error: TerminalMcpError) -> CallToolResult {
    let mut detail = json!({
        "error": {
            "code": error.code,
            "message": error.message,
        }
    });
    if let Some(request_id) = error.request_id
        && let Some(object) = detail.get_mut("error").and_then(Value::as_object_mut)
    {
        object.insert("requestId".to_owned(), Value::String(request_id));
    }
    let mut result = CallToolResult::error(vec![ContentBlock::text(format!(
        "{}: {}",
        detail["error"]["code"].as_str().unwrap_or("TERMINAL_ERROR"),
        detail["error"]["message"]
            .as_str()
            .unwrap_or("Terminal operation failed")
    ))]);
    result.structured_content = Some(detail);
    result
}

fn default_read_bytes() -> usize {
    MCP_TERMINAL_DEFAULT_READ_BYTES
}

fn default_cols() -> u16 {
    DEFAULT_COLS
}

fn default_rows() -> u16 {
    DEFAULT_ROWS
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListSessionsInput {
    backend: Option<TerminalBackend>,
    status: Option<String>,
    selector: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    session_id: String,
    pane_id: Option<String>,
    #[serde(default)]
    after_sequence: u64,
    #[serde(default)]
    wait_ms: u64,
    #[serde(default = "default_read_bytes")]
    max_bytes: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestControlInput {
    session_id: String,
    pane_id: Option<String>,
    capability: TerminalCapability,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitControlInput {
    request_id: String,
    #[serde(default)]
    wait_ms: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendTextInput {
    session_id: String,
    pane_id: Option<String>,
    text: String,
    #[serde(default)]
    append_enter: bool,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendKeysInput {
    session_id: String,
    pane_id: Option<String>,
    keys: Vec<String>,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendInputInput {
    session_id: String,
    pane_id: Option<String>,
    data_base64: String,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResizeInput {
    session_id: String,
    pane_id: Option<String>,
    cols: u16,
    rows: u16,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevokeControlInput {
    grant_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSessionInput {
    backend: TerminalBackend,
    selector: Option<String>,
    profile_id: Option<String>,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
    title: Option<String>,
    #[serde(default)]
    reason: String,
}

impl CreateSessionInput {
    fn selector_for_backend(&self) -> Result<String, TerminalMcpError> {
        if self.backend == TerminalBackend::Ssh
            && let Some(profile_id) = self.profile_id.as_deref()
        {
            let selector = ssh_backend::selector_for_profile_id(profile_id);
            if !selector.starts_with('@') {
                return Ok(selector);
            }
        }
        self.selector
            .as_deref()
            .map(str::trim)
            .filter(|selector| !selector.is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| TerminalMcpError::invalid_input("selector or profileId is required"))
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseSessionInput {
    session_id: String,
    pane_id: Option<String>,
    #[serde(default)]
    reason: String,
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use uuid::Uuid;

    use super::*;
    use crate::router::build_app;
    use crate::state::{PluginRecord, SessionRecord};

    fn test_state(enabled: bool) -> Arc<AppState> {
        let state = Arc::new(AppState::new_for_test(
            std::env::temp_dir().join(format!("terminal-mcp-server-{}.db", Uuid::new_v4())),
        ));
        state.plugins.write().unwrap().insert(
            super::super::PLUGIN_ID.to_owned(),
            PluginRecord {
                id: super::super::PLUGIN_ID.to_owned(),
                kind: "integration".to_owned(),
                display_name: "Terminal MCP".to_owned(),
                description: String::new(),
                scopes: Vec::new(),
                accepted_content_types: Vec::new(),
                produced_content_types: Vec::new(),
                input_schema_json: "{}".to_owned(),
                output_schema_json: "{}".to_owned(),
                enabled,
                metadata: HashMap::from([
                    ("defaultPolicy".to_owned(), "confirm".to_owned()),
                    ("trustedCallers".to_owned(), "[]".to_owned()),
                    ("deniedCallers".to_owned(), "[]".to_owned()),
                ]),
            },
        );
        state
    }

    async fn spawn_app(
        state: Arc<AppState>,
    ) -> (reqwest::Client, String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, build_app(state)).await.unwrap();
        });
        (
            reqwest::Client::new(),
            format!("http://{address}/mcp"),
            handle,
        )
    }

    async fn post_mcp(client: &reqwest::Client, url: &str, body: Value, identity: bool) -> Value {
        let mut request = client
            .post(url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .json(&body);
        if identity {
            request = request
                .header("x-hc-user-ticket", "lazycat-ticket")
                .header("x-hc-user-id", "lazycat")
                .header("x-hc-source", "cloud.lazycat.app.agent");
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        response.json().await.unwrap()
    }

    #[test]
    fn exposes_stable_prefixed_tool_names() {
        let names = terminal_tools()
            .into_iter()
            .map(|tool| tool.name.into_owned())
            .collect::<Vec<_>>();

        assert_eq!(names.len(), 11);
        assert!(names.iter().all(|name| name.starts_with("terminal_")));
        assert!(names.contains(&"terminal_list_sessions".to_owned()));
        assert!(names.contains(&"terminal_close_session".to_owned()));
    }

    #[test]
    fn structured_errors_keep_machine_readable_codes() {
        let result = tool_error(TerminalMcpError::approval_required("request-one"));

        assert_eq!(result.is_error, Some(true));
        assert_eq!(
            result.structured_content.as_ref().unwrap()["error"]["code"],
            "CONTROL_APPROVAL_REQUIRED"
        );
        assert_eq!(
            result.structured_content.as_ref().unwrap()["error"]["requestId"],
            "request-one"
        );
    }

    #[test]
    fn read_defaults_are_bounded() {
        let input = parse_arguments::<ReadInput>(Some(Map::from_iter([(
            "sessionId".to_owned(),
            Value::String("session-one".to_owned()),
        )])))
        .unwrap();

        assert_eq!(input.max_bytes, MCP_TERMINAL_DEFAULT_READ_BYTES);
        assert!(input.max_bytes <= crate::config::MCP_TERMINAL_MAX_READ_BYTES);
        assert_eq!(input.wait_ms, 0);
    }

    #[test]
    fn lazycat_resource_layout_publishes_terminal_mcp() {
        let build = include_str!("../../../lzc-build.yml");
        let provider = include_str!("../../../resources/mcp-providers/terminal-control/mcp.yml");
        let package = include_str!("../../../package.yml");

        assert!(build.contains("kind: lightos.webshell\n    source: ./resources/lightos.webshell"));
        assert!(build.contains("kind: mcp-providers\n    source: ./resources/mcp-providers"));
        assert_eq!(provider.trim(), "endpoint: /mcp");
        assert!(package_supports_resource_exports(package));
    }

    #[tokio::test]
    async fn streamable_http_initializes_and_lists_tools_dynamically() {
        let state = test_state(false);
        let (client, url, handle) = spawn_app(Arc::clone(&state)).await;
        let initialize = post_mcp(
            &client,
            &url,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "1" }
                }
            }),
            false,
        )
        .await;
        assert_eq!(initialize["result"]["serverInfo"]["name"], SERVER_NAME);

        let disabled = post_mcp(
            &client,
            &url,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
            false,
        )
        .await;
        assert_eq!(disabled["result"]["tools"].as_array().unwrap().len(), 0);

        state
            .plugins
            .write()
            .unwrap()
            .get_mut(super::super::PLUGIN_ID)
            .unwrap()
            .enabled = true;
        let enabled = post_mcp(
            &client,
            &url,
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {} }),
            false,
        )
        .await;
        assert_eq!(enabled["result"]["tools"].as_array().unwrap().len(), 11);
        handle.abort();
    }

    #[tokio::test]
    async fn tool_calls_require_lazycat_identity() {
        let (client, url, handle) = spawn_app(test_state(true)).await;
        let response = post_mcp(
            &client,
            &url,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "terminal_list_sessions",
                    "arguments": {}
                }
            }),
            false,
        )
        .await;

        assert_eq!(
            response["result"]["structuredContent"]["error"]["code"],
            "UNAUTHENTICATED_CALLER"
        );
        assert_eq!(response["result"]["isError"], true);
        handle.abort();
    }

    #[tokio::test]
    async fn tool_calls_reject_projected_identity_without_lazycat_ticket() {
        let (client, url, handle) = spawn_app(test_state(true)).await;
        let response = client
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("x-hc-user-id", "lazycat")
            .header("x-hc-source", "cloud.lazycat.app.agent")
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "terminal_list_sessions",
                    "arguments": {}
                }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let response = response.json::<Value>().await.unwrap();

        assert_eq!(
            response["result"]["structuredContent"]["error"]["code"],
            "UNAUTHENTICATED_CALLER"
        );
        assert_eq!(response["result"]["isError"], true);
        handle.abort();
    }

    #[tokio::test]
    async fn denied_write_requests_terminal_approval_before_starting_a_pty() {
        let state = test_state(true);
        state.sessions.write().unwrap().insert(
            "session-one".to_owned(),
            SessionRecord {
                id: "session-one".to_owned(),
                host: "local".to_owned(),
                selector: "device@owner".to_owned(),
                status: "running".to_owned(),
                cols: 120,
                rows: 32,
                command: "/bin/sh".to_owned(),
                args: Vec::new(),
                metadata: HashMap::from([("sessionBackend".to_owned(), "webshell".to_owned())]),
            },
        );
        let (client, url, handle) = spawn_app(Arc::clone(&state)).await;
        let response = post_mcp(
            &client,
            &url,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "terminal_send_text",
                    "arguments": {
                        "sessionId": "session-one",
                        "text": "uptime",
                        "appendEnter": true,
                        "reason": "maintain server"
                    }
                }
            }),
            true,
        )
        .await;

        assert_eq!(
            response["result"]["structuredContent"]["error"]["code"],
            "CONTROL_APPROVAL_REQUIRED"
        );
        assert_eq!(state.terminal_mcp.pending_requests().len(), 1);
        assert!(state.sessions.terminal("session-one").unwrap().is_none());
        handle.abort();
    }

    fn package_supports_resource_exports(package: &str) -> bool {
        let Some(version) = package.lines().find_map(|line| {
            line.trim()
                .strip_prefix("min_os_version:")
                .map(str::trim)
                .map(|value| value.strip_prefix('v').unwrap_or(value))
        }) else {
            return false;
        };
        let mut parts = version
            .split('.')
            .filter_map(|part| part.parse::<u64>().ok());
        let actual = (
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
        );
        actual >= (1, 5, 2)
    }
}
