use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use buffa::MessageField;
use connectrpc::{ConnectError, RequestContext, Response as ConnectResponse, ServiceResult};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::config::{APP_ID, APP_NAME, DEFAULT_COLS, DEFAULT_ROWS, LIGHTOSCTL, MAX_COLS, MAX_ROWS};
use crate::lightos;
use crate::proto::lazycat::webshell::v1::{
    Capability, CapabilityService, CloseSessionResponse, ConfigurePluginResponse, ControlLease,
    CreateSessionResponse, GetProviderResponse, InvokePluginResponse, ListInstancesResponse,
    ListPluginsResponse, ListSessionsResponse, OwnedCloseSessionRequestView,
    OwnedConfigurePluginRequestView, OwnedCreateSessionRequestView, OwnedGetProviderRequestView,
    OwnedInvokePluginRequestView, OwnedListInstancesRequestView, OwnedListPluginsRequestView,
    OwnedListSessionsRequestView, OwnedReleaseControlRequestView, OwnedRequestControlRequestView,
    ProviderDescriptor, ReleaseControlResponse, RequestControlResponse,
};
use crate::state::{
    AppState, PluginRecord, SessionRecord, bool_flag, output_frame_limit_from_metadata,
};
use crate::validation::{normalize_dimension, required_field, validate_selector};
use crate::workspace::{
    SessionBackend, WorkspaceSessionError, WorkspaceTerminalDefaults, close_workspace_session,
    create_workspace_session,
};

const PLUGIN_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

pub struct CapabilityServiceImpl {
    state: Arc<AppState>,
}

impl CapabilityServiceImpl {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn sessions_read(
        &self,
    ) -> Result<RwLockReadGuard<'_, HashMap<String, SessionRecord>>, ConnectError> {
        self.state
            .sessions
            .read()
            .map_err(|_| ConnectError::internal("session store lock poisoned"))
    }

    fn sessions_write(
        &self,
    ) -> Result<RwLockWriteGuard<'_, HashMap<String, SessionRecord>>, ConnectError> {
        self.state
            .sessions
            .write()
            .map_err(|_| ConnectError::internal("session store lock poisoned"))
    }

    fn session_record(&self, session_id: &str) -> Result<SessionRecord, ConnectError> {
        self.sessions_read()?
            .get(session_id)
            .cloned()
            .ok_or_else(|| ConnectError::not_found("session not found"))
    }

    pub async fn invoke_plugin_runtime(
        &self,
        plugin_id: &str,
        session_id: &str,
        operation: &str,
        content_type: &str,
        payload: Vec<u8>,
        metadata: HashMap<String, String>,
    ) -> ServiceResult<InvokePluginResponse> {
        {
            let plugins = self
                .state
                .plugins
                .read()
                .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
            let Some(plugin) = plugins.get(plugin_id) else {
                return Err(ConnectError::not_found(format!(
                    "plugin is not registered: {plugin_id}"
                )));
            };
            if !plugin.enabled {
                return Err(ConnectError::failed_precondition(format!(
                    "plugin is disabled: {plugin_id}"
                )));
            }
        }

        let session = self.session_record(session_id)?;
        lightos::authorize_selector(&session.selector, true).await?;

        match plugin_id {
            "file-transfer" => {
                invoke_file_transfer_plugin(&session, operation, content_type, &payload, &metadata)
                    .await
            }
            "ai-control" => self.invoke_control_plugin(&session, operation, &metadata),
            _ => Err(ConnectError::unimplemented(format!(
                "plugin has no runtime implementation: {plugin_id}"
            ))),
        }
    }

    fn invoke_control_plugin(
        &self,
        session: &SessionRecord,
        operation: &str,
        metadata: &HashMap<String, String>,
    ) -> ServiceResult<InvokePluginResponse> {
        match operation {
            "default" | "observe" | "status" => plugin_json_response(
                "complete",
                &serde_json::json!({
                    "sessionId": session.id,
                    "selector": session.selector,
                    "status": session.status,
                    "control": session.control,
                }),
                HashMap::new(),
            ),
            "request_control" | "request-lease" => {
                let actor_id = metadata
                    .get("actorId")
                    .or_else(|| metadata.get("actor_id"))
                    .map_or("ai-control", String::as_str)
                    .trim();
                let actor_kind = metadata
                    .get("actorKind")
                    .or_else(|| metadata.get("actor_kind"))
                    .map_or("ai", String::as_str)
                    .trim();
                if actor_id.is_empty() || actor_kind.is_empty() {
                    return Err(ConnectError::invalid_argument(
                        "actorId and actorKind must not be empty",
                    ));
                }
                let lease = ControlLease {
                    lease_id: Some(Uuid::new_v4().to_string()),
                    actor_id: Some(actor_id.to_owned()),
                    actor_kind: Some(actor_kind.to_owned()),
                    status: Some("active".to_owned()),
                    ..Default::default()
                };
                let snapshot = {
                    let mut sessions = self.sessions_write()?;
                    let Some(record) = sessions.get_mut(&session.id) else {
                        return Err(ConnectError::not_found("session not found"));
                    };
                    record.control = Some(lease.clone());
                    sessions.clone()
                };
                self.state
                    .persist_sessions_snapshot(&snapshot)
                    .map_err(|err| ConnectError::internal(err.to_string()))?;
                plugin_json_response(
                    "complete",
                    &serde_json::json!({
                        "sessionId": session.id,
                        "lease": lease,
                    }),
                    HashMap::new(),
                )
            }
            "release_control" | "release-lease" => {
                let lease_id = metadata
                    .get("leaseId")
                    .or_else(|| metadata.get("lease_id"))
                    .map(String::as_str)
                    .unwrap_or_default()
                    .trim();
                if lease_id.is_empty() {
                    return Err(ConnectError::invalid_argument("leaseId is required"));
                }
                let snapshot = {
                    let mut sessions = self.sessions_write()?;
                    let Some(record) = sessions.get_mut(&session.id) else {
                        return Err(ConnectError::not_found("session not found"));
                    };
                    let current = record
                        .control
                        .as_ref()
                        .and_then(|lease| lease.lease_id.as_deref());
                    if current != Some(lease_id) {
                        return Err(ConnectError::failed_precondition(
                            "leaseId does not match active control lease",
                        ));
                    }
                    record.control = None;
                    sessions.clone()
                };
                self.state
                    .persist_sessions_snapshot(&snapshot)
                    .map_err(|err| ConnectError::internal(err.to_string()))?;
                plugin_json_response(
                    "complete",
                    &serde_json::json!({
                        "sessionId": session.id,
                        "status": "released",
                    }),
                    HashMap::new(),
                )
            }
            _ => Err(ConnectError::invalid_argument(format!(
                "unsupported ai-control operation: {operation}"
            ))),
        }
    }
}

impl CapabilityService for CapabilityServiceImpl {
    async fn list_instances(
        &self,
        _ctx: RequestContext,
        _request: OwnedListInstancesRequestView,
    ) -> ServiceResult<ListInstancesResponse> {
        let instances = lightos::list_instances().await?;
        ConnectResponse::ok(ListInstancesResponse {
            instances,
            ..Default::default()
        })
    }

    async fn get_provider(
        &self,
        _ctx: RequestContext,
        _request: OwnedGetProviderRequestView,
    ) -> ServiceResult<GetProviderResponse> {
        ConnectResponse::ok(GetProviderResponse {
            provider: MessageField::some(provider_descriptor()),
            ..Default::default()
        })
    }

    async fn create_session(
        &self,
        _ctx: RequestContext,
        request: OwnedCreateSessionRequestView,
    ) -> ServiceResult<CreateSessionResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ConnectError::invalid_argument("selector is required"))?;
        validate_selector(selector)?;
        let login_user = lightos::login_user_for_selector(selector, true).await?;
        let cols = normalize_dimension(request.cols, DEFAULT_COLS, MAX_COLS, "cols")?;
        let rows = normalize_dimension(request.rows, DEFAULT_ROWS, MAX_ROWS, "rows")?;
        let metadata: HashMap<String, String> = request
            .metadata
            .iter()
            .map(|entry| (entry.0.to_owned(), entry.1.to_owned()))
            .collect();
        let restartable = metadata
            .get("autoRestart")
            .or_else(|| metadata.get("restartable"))
            .and_then(|value| bool_flag(value))
            .unwrap_or(false);
        let output_limit = output_frame_limit_from_metadata(&metadata);
        let defaults = WorkspaceTerminalDefaults::new(
            cols,
            rows,
            output_limit,
            restartable,
            &login_user,
            SessionBackend::Webshell,
        );
        let created = create_workspace_session(&self.state, selector, &defaults, metadata)
            .map_err(connect_workspace_error)?;
        let mut record = created.session;
        if let Err(err) = self
            .state
            .sessions
            .open_terminal(record.terminal_spec(cols, rows), true)
        {
            if let Ok(closed) = close_workspace_session(&self.state, &record.id) {
                self.state
                    .sessions
                    .close_sessions(closed.closed_session_ids.iter().map(String::as_str));
            }
            return Err(ConnectError::internal(err.to_string()));
        }
        self.state.sessions.mark_status(&record.id, "running");
        "running".clone_into(&mut record.status);
        let session = record.to_proto();
        ConnectResponse::ok(CreateSessionResponse {
            session: MessageField::some(session),
            ..Default::default()
        })
    }

    async fn close_session(
        &self,
        _ctx: RequestContext,
        request: OwnedCloseSessionRequestView,
    ) -> ServiceResult<CloseSessionResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        let closed =
            close_workspace_session(&self.state, session_id).map_err(connect_workspace_error)?;
        self.state
            .sessions
            .close_sessions(closed.closed_session_ids.iter().map(String::as_str));
        ConnectResponse::ok(CloseSessionResponse {
            session_id: Some(closed.session_id),
            status: Some(closed.status),
            ..Default::default()
        })
    }

    async fn list_sessions(
        &self,
        _ctx: RequestContext,
        request: OwnedListSessionsRequestView,
    ) -> ServiceResult<ListSessionsResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(selector) = selector {
            lightos::authorize_selector(selector, false).await?;
        }
        let visible_selectors = if selector.is_none() {
            Some(lightos::authorized_selectors().await?)
        } else {
            None
        };
        let sessions = self.sessions_read()?;
        let sessions = sessions
            .values()
            .filter(|session| selector.is_none_or(|value| session.selector == value))
            .filter(|session| {
                visible_selectors
                    .as_ref()
                    .is_none_or(|selectors| selectors.contains(&session.selector))
            })
            .map(SessionRecord::to_proto)
            .collect();
        ConnectResponse::ok(ListSessionsResponse {
            sessions,
            ..Default::default()
        })
    }

    async fn list_plugins(
        &self,
        _ctx: RequestContext,
        _request: OwnedListPluginsRequestView,
    ) -> ServiceResult<ListPluginsResponse> {
        let plugins = self
            .state
            .plugins
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?
            .values()
            .map(PluginRecord::to_proto)
            .collect();
        ConnectResponse::ok(ListPluginsResponse {
            plugins,
            ..Default::default()
        })
    }

    async fn configure_plugin(
        &self,
        _ctx: RequestContext,
        request: OwnedConfigurePluginRequestView,
    ) -> ServiceResult<ConfigurePluginResponse> {
        let plugin_id = required_field(request.plugin_id, "plugin_id")?;
        let (plugin, snapshot) = {
            let mut plugins = self
                .state
                .plugins
                .write()
                .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
            let Some(plugin) = plugins.get_mut(plugin_id) else {
                return Err(ConnectError::not_found("plugin not found"));
            };
            plugin.enabled = request.enabled.unwrap_or(false);
            for entry in &request.metadata {
                plugin
                    .metadata
                    .insert(entry.0.to_owned(), entry.1.to_owned());
            }
            (plugin.to_proto(), plugins.clone())
        };
        self.state
            .persist_plugins_snapshot(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        ConnectResponse::ok(ConfigurePluginResponse {
            plugin: MessageField::some(plugin),
            ..Default::default()
        })
    }

    async fn invoke_plugin(
        &self,
        _ctx: RequestContext,
        request: OwnedInvokePluginRequestView,
    ) -> ServiceResult<InvokePluginResponse> {
        let plugin_id = required_field(request.plugin_id, "plugin_id")?;
        {
            let plugins = self
                .state
                .plugins
                .read()
                .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
            let Some(plugin) = plugins.get(plugin_id) else {
                return Err(ConnectError::not_found(format!(
                    "plugin is not registered: {plugin_id}"
                )));
            };
            if !plugin.enabled {
                return Err(ConnectError::failed_precondition(format!(
                    "plugin is disabled: {plugin_id}"
                )));
            }
        }

        let session_id = required_field(request.session_id, "session_id")?.to_owned();
        let operation = request
            .operation
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("default")
            .to_owned();
        let content_type = request
            .content_type
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let payload = request.payload.map_or_else(Vec::new, ToOwned::to_owned);
        let metadata: HashMap<String, String> = request
            .metadata
            .iter()
            .map(|entry| (entry.0.to_owned(), entry.1.to_owned()))
            .collect();
        self.invoke_plugin_runtime(
            plugin_id,
            &session_id,
            &operation,
            &content_type,
            payload,
            metadata,
        )
        .await
    }

    async fn request_control(
        &self,
        _ctx: RequestContext,
        request: OwnedRequestControlRequestView,
    ) -> ServiceResult<RequestControlResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        let actor_id = request.actor_id.unwrap_or("anonymous").trim();
        let actor_kind = request.actor_kind.unwrap_or("human").trim();
        if actor_id.is_empty() || actor_kind.is_empty() {
            return Err(ConnectError::invalid_argument(
                "actor_id and actor_kind must not be empty",
            ));
        }

        let lease = ControlLease {
            lease_id: Some(Uuid::new_v4().to_string()),
            actor_id: Some(actor_id.to_owned()),
            actor_kind: Some(actor_kind.to_owned()),
            status: Some("active".to_owned()),
            ..Default::default()
        };
        let snapshot = {
            let mut sessions = self.sessions_write()?;
            let Some(session) = sessions.get_mut(session_id) else {
                return Err(ConnectError::not_found("session not found"));
            };
            session.control = Some(lease.clone());
            sessions.clone()
        };
        self.state
            .persist_sessions_snapshot(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        ConnectResponse::ok(RequestControlResponse {
            lease: MessageField::some(lease),
            ..Default::default()
        })
    }

    async fn release_control(
        &self,
        _ctx: RequestContext,
        request: OwnedReleaseControlRequestView,
    ) -> ServiceResult<ReleaseControlResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        let lease_id = required_field(request.lease_id, "lease_id")?;
        let snapshot = {
            let mut sessions = self.sessions_write()?;
            let Some(session) = sessions.get_mut(session_id) else {
                return Err(ConnectError::not_found("session not found"));
            };
            let current = session
                .control
                .as_ref()
                .and_then(|lease| lease.lease_id.as_deref());
            if current != Some(lease_id) {
                return Err(ConnectError::failed_precondition(
                    "lease_id does not match active control lease",
                ));
            }
            session.control = None;
            sessions.clone()
        };
        self.state
            .persist_sessions_snapshot(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        ConnectResponse::ok(ReleaseControlResponse {
            session_id: Some(session_id.to_owned()),
            status: Some("released".to_owned()),
            ..Default::default()
        })
    }
}

fn provider_descriptor() -> ProviderDescriptor {
    ProviderDescriptor {
        id: Some(APP_ID.to_owned()),
        display_name: Some(APP_NAME.to_owned()),
        version: Some(env!("CARGO_PKG_VERSION").to_owned()),
        capabilities: vec![
            Capability {
                id: Some("terminal.session".to_owned()),
                kind: Some("session".to_owned()),
                display_name: Some("Terminal sessions".to_owned()),
                description: Some("Create and control terminal sessions for selected LightOS instances".to_owned()),
                transports: vec!["connect".to_owned(), "websocket".to_owned()],
                schema_json: Some(r#"{"dataPlane":"ws:/ws/terminal","controlPlane":"connect:lazycat.webshell.v1.CapabilityService"}"#.to_owned()),
                ..Default::default()
            },
            Capability {
                id: Some("plugin.invoke".to_owned()),
                kind: Some("plugin".to_owned()),
                display_name: Some("Generic plugin invocation".to_owned()),
                description: Some("Opaque plugin descriptors and payloads for future file transfer, remote shell, AI control, and human operation extensions".to_owned()),
                transports: vec!["connect".to_owned()],
                schema_json: Some(r#"{"pluginId":"string","operation":"string","contentType":"string","payload":"bytes","metadata":"map<string,string>"}"#.to_owned()),
                ..Default::default()
            },
            Capability {
                id: Some("control.lease".to_owned()),
                kind: Some("control".to_owned()),
                display_name: Some("Control leases".to_owned()),
                description: Some("Coordinate human, AI, and system actors without encoding actor-specific behavior in the terminal protocol".to_owned()),
                transports: vec!["connect".to_owned()],
                schema_json: Some(r#"{"actorId":"string","actorKind":"human|ai|system|custom","status":"active|released"}"#.to_owned()),
                ..Default::default()
            },
        ],
        ..Default::default()
    }
}

async fn invoke_file_transfer_plugin(
    session: &SessionRecord,
    operation: &str,
    content_type: &str,
    payload: &[u8],
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    match operation {
        "default" | "list" => invoke_file_list(session, operation, metadata).await,
        "read" | "download" => invoke_file_read(session, operation, content_type, metadata).await,
        "write" | "upload" => invoke_file_write(session, operation, payload, metadata).await,
        "stat" => invoke_file_stat(session, operation, metadata).await,
        _ => Err(ConnectError::invalid_argument(format!(
            "unsupported file-transfer operation: {operation}"
        ))),
    }
}

async fn invoke_file_list(
    session: &SessionRecord,
    operation: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = metadata.get("path").map_or(".", String::as_str);
    let script = format!(
        r#"path={}
if [ ! -e "$path" ]; then
  echo "path not found: $path" >&2
  exit 2
fi
if [ -d "$path" ]; then
  find "$path" -maxdepth 1 -mindepth 1 -printf '%f\t%y\t%s\n' | sort
else
  ls -ld -- "$path"
fi"#,
        shell_quote(path)
    );
    let output = run_instance_script(session, &script, &[]).await?;
    plugin_response(
        "complete",
        "text/plain",
        output,
        HashMap::from([("operation".to_owned(), operation.to_owned())]),
    )
}

async fn invoke_file_read(
    session: &SessionRecord,
    operation: &str,
    content_type: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = format!(
        r#"path={}
if [ ! -f "$path" ]; then
  echo "file not found: $path" >&2
  exit 2
fi
cat -- "$path""#,
        shell_quote(path)
    );
    let output = run_instance_script(session, &script, &[]).await?;
    plugin_response(
        "complete",
        if content_type == "application/json" {
            "application/octet-stream"
        } else {
            content_type
        },
        output,
        plugin_path_metadata(operation, path),
    )
}

async fn invoke_file_write(
    session: &SessionRecord,
    operation: &str,
    payload: &[u8],
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = format!(
        r#"path={}
parent="$(dirname -- "$path")"
mkdir -p -- "$parent"
tmp="$path.webshell-upload.$$"
cat > "$tmp"
mv -f -- "$tmp" "$path"
bytes="$(wc -c < "$path" | tr -d ' ')"
printf '{{"path":%s,"bytes":%s}}\n' "$(printf '%s' "$path" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" "$bytes""#,
        shell_quote(path)
    );
    let output = run_instance_script(session, &script, payload).await?;
    plugin_response(
        "complete",
        "application/json",
        output,
        plugin_path_metadata(operation, path),
    )
}

async fn invoke_file_stat(
    session: &SessionRecord,
    operation: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = format!(
        r#"path={}
if [ ! -e "$path" ]; then
  echo "path not found: $path" >&2
  exit 2
fi
if command -v stat >/dev/null 2>&1; then
  stat -- "$path"
else
  ls -ld -- "$path"
fi"#,
        shell_quote(path)
    );
    let output = run_instance_script(session, &script, &[]).await?;
    plugin_response(
        "complete",
        "text/plain",
        output,
        plugin_path_metadata(operation, path),
    )
}

fn plugin_path_metadata(operation: &str, path: &str) -> HashMap<String, String> {
    HashMap::from([
        ("operation".to_owned(), operation.to_owned()),
        ("path".to_owned(), path.to_owned()),
    ])
}

async fn run_instance_script(
    session: &SessionRecord,
    script: &str,
    stdin: &[u8],
) -> Result<Vec<u8>, ConnectError> {
    let script = script_for_session_user(session, script);
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command
        .args([
            "exec",
            "-i",
            session.selector.as_str(),
            "/bin/sh",
            "-lc",
            script.as_str(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;
    if let Some(mut child_stdin) = child.stdin.take() {
        let input = stdin.to_vec();
        tokio::spawn(async move {
            if !input.is_empty() {
                let _ = child_stdin.write_all(&input).await;
            }
        });
    }
    let output = tokio::time::timeout(PLUGIN_COMMAND_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("plugin command timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("plugin command failed: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "plugin command exited with {}: {detail}",
            output.status
        )));
    }
    Ok(output.stdout)
}

fn script_for_session_user(session: &SessionRecord, script: &str) -> String {
    let login_user = session
        .metadata
        .get("loginUser")
        .map(String::as_str)
        .unwrap_or_default()
        .trim();
    let script = format!(
        "if [ -f /run/catlink/shell-env.sh ]; then . /run/catlink/shell-env.sh; fi\n{script}"
    );
    if login_user.is_empty() || login_user == "root" {
        return script;
    }
    let quoted_user = shell_quote(login_user);
    let quoted_script = shell_quote(&script);
    format!(
        r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
user={quoted_user}
uid="$(id -u "$user" 2>/dev/null)" || exit 127
gid="$(id -g "$user" 2>/dev/null)" || exit 127
entry="$(getent passwd "$user" 2>/dev/null)" || exit 127
home="$(printf '%s\n' "$entry" | cut -d: -f6)"
if [ -z "$home" ]; then home=/; fi
if command -v setpriv >/dev/null 2>&1; then
  exec env HOME="$home" USER="$user" LOGNAME="$user" setpriv --reuid "$uid" --regid "$gid" --init-groups /bin/sh -lc {quoted_script}
fi
if command -v su >/dev/null 2>&1; then
  exec su -s /bin/sh "$user" -c {quoted_script}
fi
/bin/sh -lc {quoted_script}"#
    )
}

fn required_metadata<'a>(
    metadata: &'a HashMap<String, String>,
    key: &str,
) -> Result<&'a str, ConnectError> {
    metadata
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ConnectError::invalid_argument(format!("metadata.{key} is required")))
}

fn plugin_json_response(
    status: &str,
    payload: &serde_json::Value,
    metadata: HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    plugin_response(
        status,
        "application/json",
        serde_json::to_vec(payload).map_err(|err| ConnectError::internal(err.to_string()))?,
        metadata,
    )
}

fn plugin_response(
    status: &str,
    content_type: &str,
    payload: Vec<u8>,
    metadata: HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    ConnectResponse::ok(InvokePluginResponse {
        invocation_id: Some(Uuid::new_v4().to_string()),
        status: Some(status.to_owned()),
        content_type: Some(content_type.to_owned()),
        payload: Some(payload),
        metadata,
        ..Default::default()
    })
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

fn connect_workspace_error(error: WorkspaceSessionError) -> ConnectError {
    match error {
        WorkspaceSessionError::NotFound(message) => ConnectError::not_found(message),
        WorkspaceSessionError::Internal(message) => ConnectError::internal(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DEFAULT_COLS, DEFAULT_ROWS};

    #[test]
    fn service_shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("dev'user"), "'dev'\"'\"'user'");
    }

    #[test]
    fn plugin_script_runs_as_session_login_user_when_present() {
        let session = test_session(HashMap::from([(
            "loginUser".to_owned(),
            "dev'user".to_owned(),
        )]));

        let script = script_for_session_user(&session, "printf ok");

        assert!(script.contains("user='dev'\"'\"'user'"));
        assert!(script.contains("/run/catlink/shell-env.sh"));
        assert!(script.contains("setpriv --reuid \"$uid\""));
        assert!(script.contains("exec su -s /bin/sh \"$user\""));
    }

    #[tokio::test]
    async fn file_transfer_rejects_unknown_operation_before_running_commands() {
        let session = test_session(HashMap::new());

        let error = invoke_file_transfer_plugin(
            &session,
            "delete",
            "application/octet-stream",
            &[],
            &HashMap::new(),
        )
        .await
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("unsupported file-transfer operation")
        );
    }

    #[test]
    fn control_plugin_observes_requests_and_releases_leases() {
        let state = Arc::new(test_app_state());
        let session = test_session(HashMap::new());
        state
            .sessions
            .write()
            .unwrap()
            .insert(session.id.clone(), session.clone());
        let service = CapabilityServiceImpl::new(Arc::clone(&state));

        let observed = service
            .invoke_control_plugin(&session, "observe", &HashMap::new())
            .unwrap()
            .body;
        assert_eq!(observed.status.as_deref(), Some("complete"));

        service
            .invoke_control_plugin(
                &session,
                "request_control",
                &HashMap::from([
                    ("actorId".to_owned(), "codex".to_owned()),
                    ("actorKind".to_owned(), "ai".to_owned()),
                ]),
            )
            .unwrap();
        let lease_id = state
            .sessions
            .read()
            .unwrap()
            .get(&session.id)
            .and_then(|record| record.control.as_ref())
            .and_then(|lease| lease.lease_id.as_deref())
            .expect("active control lease")
            .to_owned();

        service
            .invoke_control_plugin(
                &session,
                "release_control",
                &HashMap::from([("leaseId".to_owned(), lease_id)]),
            )
            .unwrap();

        assert!(
            state
                .sessions
                .read()
                .unwrap()
                .get(&session.id)
                .is_some_and(|record| record.control.is_none())
        );
    }

    fn test_session(metadata: HashMap<String, String>) -> SessionRecord {
        SessionRecord {
            id: Uuid::new_v4().to_string(),
            host: "demo".to_owned(),
            selector: "demo@owner".to_owned(),
            status: "running".to_owned(),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            command: "/bin/sh".to_owned(),
            args: vec!["-lc".to_owned(), "true".to_owned()],
            control: None,
            metadata,
        }
    }

    fn test_app_state() -> AppState {
        AppState::new_for_test(std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-service-test-{}.db",
            Uuid::new_v4()
        )))
    }
}
