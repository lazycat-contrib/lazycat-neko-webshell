use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{Arc, RwLockReadGuard};
use std::time::Duration;

use buffa::MessageField;
use connectrpc::{ConnectError, RequestContext, Response as ConnectResponse, ServiceResult};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::agent_client::ensure_agent;
use crate::client_terminal;
use crate::config::{
    APP_ID, APP_NAME, DEFAULT_COLS, DEFAULT_OUTPUT_FRAME_LIMIT, DEFAULT_ROWS, LIGHTOSCTL, MAX_COLS,
    MAX_ROWS,
};
use crate::database::{TunnelProviderProfile, TunnelProviderProfileUpsert};
use crate::lightos;
use crate::lightos_admin;
use crate::plugins::{file_transfer, lightos_port_forward, tunnel};
use crate::proto::lazycat::webshell::v1::{
    AgentPaneState, AgentWorkspaceAction, AgentWorkspaceActionType, AgentWorkspaceState,
    Capability, CapabilityService, CloseSessionResponse, ConfigurePluginResponse,
    CreateSessionResponse, GetProviderResponse, InvokePluginResponse, ListInstancesResponse,
    ListPluginsResponse, ListSessionsResponse, OwnedCloseSessionRequestView,
    OwnedConfigurePluginRequestView, OwnedCreateSessionRequestView, OwnedGetProviderRequestView,
    OwnedInvokePluginRequestView, OwnedListInstancesRequestView, OwnedListPluginsRequestView,
    OwnedListSessionsRequestView, OwnedReleaseControlRequestView, OwnedRequestControlRequestView,
    PluginDescriptor, ProviderDescriptor, ReleaseControlResponse, RequestControlResponse, Session,
};
use crate::ssh_backend;
use crate::state::{
    AppState, METADATA_LOGIN_USER, PluginRecord, SessionRecord, host_from_selector,
    output_frame_limit_from_metadata,
};
use crate::tty_init::lightos_features_enabled;
use crate::validation::{normalize_dimension, required_field, validate_selector};
use crate::workspace::{WorkspaceSessionError, close_workspace_session};

const PLUGIN_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const TUNNEL_PROVIDER_PROFILES_METADATA: &str = "tunnelProviderProfiles";
const TUNNEL_NGROK_PROFILE_ID_METADATA: &str = "ngrokProfileId";
const TUNNEL_NGROK_AUTHTOKEN_METADATA: &str = "ngrokAuthtoken";
const TUNNEL_PROVIDER_NGROK: &str = "ngrok";
const MAX_TUNNEL_PROVIDER_PROFILES: usize = 16;

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

    fn session_record_optional(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionRecord>, ConnectError> {
        Ok(self.sessions_read()?.get(session_id).cloned())
    }

    async fn session_record_for_plugin(
        &self,
        session_id: &str,
        metadata: &HashMap<String, String>,
    ) -> Result<SessionRecord, ConnectError> {
        if let Some(session) = self.session_record_optional(session_id)? {
            return Ok(session);
        }
        agent_session_record_from_metadata(session_id, metadata).await
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
            if !plugin_available_in_current_runtime(plugin) {
                return Err(ConnectError::not_found(format!(
                    "plugin is not available in this runtime: {plugin_id}"
                )));
            }
            if !plugin.enabled {
                return Err(ConnectError::failed_precondition(format!(
                    "plugin is disabled: {plugin_id}"
                )));
            }
        }

        let session = self
            .session_record_for_plugin(session_id, &metadata)
            .await?;

        match plugin_id {
            "file-transfer" => {
                authorize_session_target(&self.state, &session, true).await?;
                invoke_file_transfer_plugin(
                    &self.state,
                    &session,
                    operation,
                    content_type,
                    &payload,
                    &metadata,
                )
                .await
            }
            "ai-chat" => {
                authorize_session_target(&self.state, &session, false).await?;
                Self::invoke_ai_chat_plugin(&session, operation)
            }
            lightos_port_forward::PLUGIN_ID => {
                authorize_lightos_session_target(&session, true).await?;
                self.invoke_lightos_port_forward_plugin(&session, operation, metadata)
                    .await
            }
            tunnel::PLUGIN_ID => self.invoke_public_tunnel_plugin(operation, metadata).await,
            _ => Err(ConnectError::unimplemented(format!(
                "plugin has no runtime implementation: {plugin_id}"
            ))),
        }
    }

    fn invoke_ai_chat_plugin(
        session: &SessionRecord,
        operation: &str,
    ) -> ServiceResult<InvokePluginResponse> {
        match operation {
            "default" | "status" => plugin_json_response(
                "complete",
                &serde_json::json!({
                    "sessionId": session.id,
                    "selector": session.selector,
                    "status": session.status,
                    "plugin": "ai-chat",
                    "transport": "action-websocket",
                }),
                HashMap::new(),
            ),
            _ => Err(ConnectError::invalid_argument(format!(
                "unsupported ai-chat operation: {operation}"
            ))),
        }
    }

    async fn invoke_lightos_port_forward_plugin(
        &self,
        session: &SessionRecord,
        operation: &str,
        metadata: HashMap<String, String>,
    ) -> ServiceResult<InvokePluginResponse> {
        let manager = Arc::clone(&self.state.lightos_port_forwards);
        let session = session.clone();
        let operation = operation.to_owned();
        let payload =
            tokio::task::spawn_blocking(move || manager.invoke(&session, &operation, &metadata))
                .await
                .map_err(|err| ConnectError::internal(format!("plugin task failed: {err}")))?
                .map_err(|err| ConnectError::failed_precondition(err.to_string()))?;
        plugin_json_response("complete", &payload, HashMap::new())
    }

    async fn invoke_public_tunnel_plugin(
        &self,
        operation: &str,
        mut metadata: HashMap<String, String>,
    ) -> ServiceResult<InvokePluginResponse> {
        let operation = operation.trim().to_owned();
        let ngrok_profile_id = if operation == "start"
            && metadata.get("provider").map(String::as_str).map(str::trim)
                == Some(TUNNEL_PROVIDER_NGROK)
        {
            metadata.remove(TUNNEL_NGROK_AUTHTOKEN_METADATA);
            let profile_id = metadata
                .get(TUNNEL_NGROK_PROFILE_ID_METADATA)
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ConnectError::invalid_argument("metadata.ngrokProfileId is required")
                })?
                .to_owned();
            let profile = self
                .state
                .database()
                .load_tunnel_provider_profile(&profile_id)
                .map_err(|err| ConnectError::internal(err.to_string()))?
                .ok_or_else(|| ConnectError::not_found("ngrok profile not found"))?;
            if profile.provider != TUNNEL_PROVIDER_NGROK {
                return Err(ConnectError::invalid_argument(
                    "tunnel provider profile is not ngrok",
                ));
            }
            if !profile.enabled {
                return Err(ConnectError::failed_precondition(
                    "ngrok profile is disabled",
                ));
            }
            let authtoken = ngrok_authtoken_from_secret(&profile.secret_json).ok_or_else(|| {
                ConnectError::failed_precondition("ngrok profile is not configured")
            })?;
            metadata.insert(TUNNEL_NGROK_AUTHTOKEN_METADATA.to_owned(), authtoken);
            Some(profile_id)
        } else {
            metadata.remove(TUNNEL_NGROK_AUTHTOKEN_METADATA);
            None
        };
        let manager = Arc::clone(&self.state.public_tunnels);
        let operation_for_task = operation.clone();
        let response = tokio::task::spawn_blocking(move || {
            manager.invoke_metadata(&operation_for_task, metadata)
        })
        .await
        .map_err(|err| ConnectError::internal(format!("plugin task failed: {err}")))?
        .map_err(|err| ConnectError::failed_precondition(err.to_string()))?;
        if operation == "start" {
            if let Some(profile_id) = ngrok_profile_id {
                self.state
                    .database()
                    .mark_tunnel_provider_profile_used(&profile_id)
                    .map_err(|err| ConnectError::internal(err.to_string()))?;
            }
        }
        plugin_response(
            &response.status,
            &response.content_type,
            response.payload,
            response.metadata,
        )
    }

    fn plugin_descriptor(&self, plugin: &PluginRecord) -> Result<PluginDescriptor, ConnectError> {
        let mut descriptor = plugin.to_proto();
        if plugin.id == tunnel::PLUGIN_ID {
            descriptor.metadata.extend(self.public_tunnel_metadata()?);
        }
        Ok(descriptor)
    }

    fn public_tunnel_metadata(&self) -> Result<HashMap<String, String>, ConnectError> {
        let profiles = self
            .state
            .database()
            .list_tunnel_provider_profiles(Some(TUNNEL_PROVIDER_NGROK))
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        let summaries = profiles
            .iter()
            .map(tunnel_provider_profile_summary)
            .collect::<Vec<_>>();
        let profiles_json = serde_json::to_string(&summaries)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        Ok(HashMap::from([
            (TUNNEL_PROVIDER_PROFILES_METADATA.to_owned(), profiles_json),
            ("ngrokProfileCount".to_owned(), summaries.len().to_string()),
        ]))
    }

    fn replace_tunnel_provider_profiles(&self, profiles_json: &str) -> Result<(), ConnectError> {
        let inputs = serde_json::from_str::<Vec<TunnelProviderProfileInput>>(profiles_json)
            .map_err(|err| {
                ConnectError::invalid_argument(format!("invalid tunnel provider profiles: {err}"))
            })?;
        if inputs.len() > MAX_TUNNEL_PROVIDER_PROFILES {
            return Err(ConnectError::invalid_argument(format!(
                "at most {MAX_TUNNEL_PROVIDER_PROFILES} tunnel provider profiles are supported"
            )));
        }
        let existing = self
            .state
            .database()
            .list_tunnel_provider_profiles(Some(TUNNEL_PROVIDER_NGROK))
            .map_err(|err| ConnectError::internal(err.to_string()))?
            .into_iter()
            .map(|profile| (profile.id.clone(), profile))
            .collect::<HashMap<_, _>>();
        let mut seen = std::collections::HashSet::new();
        let mut upserts = Vec::with_capacity(inputs.len());
        for input in inputs {
            let provider = input.provider.trim();
            if provider != TUNNEL_PROVIDER_NGROK {
                return Err(ConnectError::invalid_argument(
                    "only ngrok tunnel provider profiles are supported",
                ));
            }
            let id = input.id.trim();
            if !valid_profile_id(id) {
                return Err(ConnectError::invalid_argument(
                    "invalid tunnel provider profile id",
                ));
            }
            if !seen.insert(id.to_owned()) {
                return Err(ConnectError::invalid_argument(
                    "duplicate tunnel provider profile id",
                ));
            }
            let name = input.name.trim();
            if name.is_empty() || name.len() > 80 {
                return Err(ConnectError::invalid_argument(
                    "tunnel provider profile name must be 1-80 bytes",
                ));
            }
            let authtoken = input
                .authtoken
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if authtoken.is_none()
                && existing
                    .get(id)
                    .and_then(|profile| ngrok_authtoken_from_secret(&profile.secret_json))
                    .is_none()
            {
                return Err(ConnectError::invalid_argument(
                    "ngrok authtoken is required for new profiles",
                ));
            }
            let secret_json =
                authtoken.map(|value| serde_json::json!({ "authtoken": value }).to_string());
            upserts.push(TunnelProviderProfileUpsert {
                id: id.to_owned(),
                provider: provider.to_owned(),
                name: name.to_owned(),
                enabled: input.enabled.unwrap_or(true),
                config_json: "{}".to_owned(),
                secret_json,
            });
        }
        self.state
            .database()
            .replace_tunnel_provider_profiles(TUNNEL_PROVIDER_NGROK, &upserts)
            .map_err(|err| ConnectError::internal(err.to_string()))
    }
}

fn agent_workspace_active_session(
    workspace: &AgentWorkspaceState,
    metadata: HashMap<String, String>,
) -> Option<Session> {
    let active_tab = workspace.active_tab_id.as_deref();
    let tab = active_tab
        .and_then(|tab_id| {
            workspace
                .tabs
                .iter()
                .find(|tab| tab.id.as_deref() == Some(tab_id))
        })
        .or_else(|| workspace.tabs.last())?;
    let active_pane = tab.active_pane_id.as_deref();
    let pane = active_pane
        .and_then(|pane_id| {
            tab.panes
                .iter()
                .find(|pane| pane.id.as_deref() == Some(pane_id))
        })
        .or_else(|| tab.panes.last())?;
    Some(session_from_agent_pane(
        workspace.selector.as_deref().unwrap_or_default(),
        pane,
        metadata,
    ))
}

fn session_from_agent_pane(
    selector: &str,
    pane: &AgentPaneState,
    metadata: HashMap<String, String>,
) -> Session {
    Session {
        id: pane.session_id.clone(),
        selector: Some(selector.to_owned()),
        status: pane.status.clone().or_else(|| Some("running".to_owned())),
        cols: pane.cols,
        rows: pane.rows,
        metadata,
        ..Default::default()
    }
}

async fn agent_session_record_from_metadata(
    session_id: &str,
    metadata: &HashMap<String, String>,
) -> Result<SessionRecord, ConnectError> {
    let selector = metadata
        .get("selector")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ConnectError::not_found("session not found"))?;
    if ssh_backend::is_ssh_selector(selector) {
        return Err(ConnectError::not_found("session not found"));
    }
    validate_selector(selector)?;
    if !lightos_features_enabled() {
        return Err(ConnectError::not_found("LightOS integration is disabled"));
    }
    let login_user = lightos::login_user_for_selector(selector, true).await?;
    Ok(agent_fallback_session_record(
        session_id,
        selector,
        &login_user,
    ))
}

fn agent_fallback_session_record(
    session_id: &str,
    selector: &str,
    login_user: &str,
) -> SessionRecord {
    let host = host_from_selector(selector);
    let mut metadata = HashMap::from([
        ("host".to_owned(), host.clone()),
        ("restartable".to_owned(), "false".to_owned()),
        ("sessionBackend".to_owned(), "webshell".to_owned()),
        (
            "outputBufferLimit".to_owned(),
            DEFAULT_OUTPUT_FRAME_LIMIT.to_string(),
        ),
    ]);
    let login_user = login_user.trim();
    if !login_user.is_empty() {
        metadata.insert(METADATA_LOGIN_USER.to_owned(), login_user.to_owned());
    }
    SessionRecord {
        id: session_id.to_owned(),
        host,
        selector: selector.to_owned(),
        status: "running".to_owned(),
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        command: "/bin/sh".to_owned(),
        args: Vec::new(),
        metadata,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelProviderProfileInput {
    id: String,
    provider: String,
    name: String,
    enabled: Option<bool>,
    authtoken: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelProviderProfileSummary {
    id: String,
    provider: String,
    name: String,
    enabled: bool,
    configured: bool,
    created_at_ms: u64,
    updated_at_ms: u64,
    last_used_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelNgrokSecret {
    authtoken: Option<String>,
}

fn tunnel_provider_profile_summary(
    profile: &TunnelProviderProfile,
) -> TunnelProviderProfileSummary {
    let _ = &profile.config_json;
    TunnelProviderProfileSummary {
        id: profile.id.clone(),
        provider: profile.provider.clone(),
        name: profile.name.clone(),
        enabled: profile.enabled,
        configured: ngrok_authtoken_from_secret(&profile.secret_json).is_some(),
        created_at_ms: profile.created_at_ms,
        updated_at_ms: profile.updated_at_ms,
        last_used_at_ms: profile.last_used_at_ms,
    }
}

fn ngrok_authtoken_from_secret(secret_json: &str) -> Option<String> {
    serde_json::from_str::<TunnelNgrokSecret>(secret_json)
        .ok()
        .and_then(|secret| secret.authtoken)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn valid_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

async fn authorize_session_target(
    state: &AppState,
    session: &SessionRecord,
    require_running: bool,
) -> Result<(), ConnectError> {
    if ssh_backend::is_ssh_selector(&session.selector) {
        ssh_backend::load_enabled_profile(&state.database(), &session.selector)?;
        return Ok(());
    }
    authorize_lightos_session_target(session, require_running).await
}

async fn authorize_lightos_session_target(
    session: &SessionRecord,
    require_running: bool,
) -> Result<(), ConnectError> {
    if !lightos_features_enabled() {
        return Err(ConnectError::not_found("LightOS integration is disabled"));
    }
    lightos::authorize_selector(&session.selector, require_running).await
}

async fn authorize_selector_for_listing(
    state: &AppState,
    selector: &str,
) -> Result<(), ConnectError> {
    validate_selector(selector)?;
    if ssh_backend::is_ssh_selector(selector) {
        ssh_backend::load_enabled_profile(&state.database(), selector)?;
        return Ok(());
    }
    if !lightos_features_enabled() {
        return Err(ConnectError::not_found("LightOS integration is disabled"));
    }
    lightos::authorize_selector(selector, false).await
}

async fn visible_session_selectors(state: &AppState) -> Result<HashSet<String>, ConnectError> {
    let mut selectors = if lightos_features_enabled() {
        lightos::authorized_selectors().await?
    } else {
        HashSet::new()
    };
    for instance in ssh_backend::list_profile_instances(&state.database())
        .map_err(|err| ConnectError::internal(err.to_string()))?
    {
        if let Some(selector) = instance.selector {
            selectors.insert(selector);
        }
    }
    Ok(selectors)
}

fn plugin_available_in_current_runtime(plugin: &PluginRecord) -> bool {
    match plugin.metadata.get("requiresRuntime").map(String::as_str) {
        Some("lightos") => lightos_features_enabled(),
        _ => true,
    }
}

impl CapabilityService for CapabilityServiceImpl {
    async fn list_instances(
        &self,
        ctx: RequestContext,
        _request: OwnedListInstancesRequestView,
    ) -> ServiceResult<ListInstancesResponse> {
        let mut instances = if lightos_features_enabled() {
            lightos_admin::list_visible_instances(&ctx.headers)
                .await
                .map_err(lightos_admin_connect_error)?
        } else {
            Vec::new()
        };
        let mut ssh_instances = ssh_backend::list_profile_instances(&self.state.database())
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        instances.append(&mut ssh_instances);
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
        ctx: RequestContext,
        request: OwnedCreateSessionRequestView,
    ) -> ServiceResult<CreateSessionResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ConnectError::invalid_argument("selector is required"))?;
        if ssh_backend::is_ssh_selector(selector) {
            return Err(ConnectError::failed_precondition(
                "SSH sessions are managed through workspace terminals",
            ));
        }
        if !lightos_features_enabled() {
            return Err(ConnectError::not_found("LightOS integration is disabled"));
        }
        let cols = normalize_dimension(request.cols, DEFAULT_COLS, MAX_COLS, "cols")?;
        let rows = normalize_dimension(request.rows, DEFAULT_ROWS, MAX_ROWS, "rows")?;
        let metadata: HashMap<String, String> = request
            .metadata
            .iter()
            .map(|entry| (entry.0.to_owned(), entry.1.to_owned()))
            .collect();
        let output_limit = output_frame_limit_from_metadata(&metadata);
        if lightos_admin::is_client_selector(selector) {
            let session = client_terminal::create_session(
                &ctx.headers,
                selector,
                cols,
                rows,
                output_limit,
                metadata,
            )
            .await
            .map_err(client_terminal_connect_error)?;
            return ConnectResponse::ok(CreateSessionResponse {
                session: MessageField::some(session),
                ..Default::default()
            });
        }
        validate_selector(selector)?;
        let login_user = lightos::login_user_for_selector(selector, true).await?;
        let agent = ensure_agent(selector, &login_user)
            .await
            .map_err(|err| ConnectError::unavailable(err.to_string()))?;
        let workspace = agent
            .action(
                cols,
                rows,
                output_limit,
                AgentWorkspaceAction {
                    action: Some(
                        AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CREATE_TAB.into(),
                    ),
                    ..Default::default()
                },
            )
            .await
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        let session = agent_workspace_active_session(&workspace, metadata)
            .ok_or_else(|| ConnectError::internal("agent did not create a session"))?;
        ConnectResponse::ok(CreateSessionResponse {
            session: MessageField::some(session),
            ..Default::default()
        })
    }

    async fn close_session(
        &self,
        ctx: RequestContext,
        request: OwnedCloseSessionRequestView,
    ) -> ServiceResult<CloseSessionResponse> {
        let session_id = required_field(request.session_id, "session_id")?.to_owned();
        let requested_selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(selector) =
            requested_selector.filter(|value| lightos_admin::is_client_selector(value))
        {
            if !lightos_features_enabled() {
                return Err(ConnectError::not_found("LightOS integration is disabled"));
            }
            client_terminal::close_session(
                &ctx.headers,
                selector,
                &session_id,
                DEFAULT_COLS,
                DEFAULT_ROWS,
                DEFAULT_OUTPUT_FRAME_LIMIT,
            )
            .await
            .map_err(client_terminal_connect_error)?;
            return ConnectResponse::ok(CloseSessionResponse {
                session_id: Some(session_id),
                status: Some("closed".to_owned()),
                ..Default::default()
            });
        }
        match close_workspace_session(&self.state, &session_id) {
            Ok(closed) => {
                self.state
                    .sessions
                    .close_sessions(closed.closed_session_ids.iter().map(String::as_str));
                return ConnectResponse::ok(CloseSessionResponse {
                    session_id: Some(closed.session_id),
                    status: Some(closed.status),
                    ..Default::default()
                });
            }
            Err(WorkspaceSessionError::NotFound(_)) => {}
            Err(error) => return Err(connect_workspace_error(error)),
        }
        let selector = requested_selector.ok_or_else(|| {
            ConnectError::invalid_argument("selector is required to close agent-managed sessions")
        })?;
        close_agent_session(selector, &session_id).await?;
        ConnectResponse::ok(CloseSessionResponse {
            session_id: Some(session_id),
            status: Some("closed".to_owned()),
            ..Default::default()
        })
    }

    async fn list_sessions(
        &self,
        ctx: RequestContext,
        request: OwnedListSessionsRequestView,
    ) -> ServiceResult<ListSessionsResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(selector) = selector.filter(|value| lightos_admin::is_client_selector(value)) {
            if !lightos_features_enabled() {
                return Err(ConnectError::not_found("LightOS integration is disabled"));
            }
            let sessions =
                client_terminal::list_sessions(&ctx.headers, selector, DEFAULT_COLS, DEFAULT_ROWS)
                    .await
                    .map_err(client_terminal_connect_error)?;
            return ConnectResponse::ok(ListSessionsResponse {
                sessions,
                ..Default::default()
            });
        }
        if let Some(selector) = selector {
            authorize_selector_for_listing(&self.state, selector).await?;
        }
        let visible_selectors = if selector.is_none() {
            Some(visible_session_selectors(&self.state).await?)
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
        let plugin_records = self
            .state
            .plugins
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?
            .values()
            .filter(|plugin| plugin_available_in_current_runtime(plugin))
            .cloned()
            .collect::<Vec<_>>();
        let plugins = plugin_records
            .iter()
            .map(|plugin| self.plugin_descriptor(plugin))
            .collect::<Result<Vec<_>, _>>()?;
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
        let request_metadata = request
            .metadata
            .iter()
            .map(|entry| (entry.0.to_owned(), entry.1.to_owned()))
            .collect::<HashMap<_, _>>();
        if plugin_id == tunnel::PLUGIN_ID {
            if let Some(profiles_json) = request_metadata.get(TUNNEL_PROVIDER_PROFILES_METADATA) {
                self.replace_tunnel_provider_profiles(profiles_json)?;
            }
        }
        let (plugin, snapshot) = {
            let mut plugins = self
                .state
                .plugins
                .write()
                .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
            let Some(plugin) = plugins.get_mut(plugin_id) else {
                return Err(ConnectError::not_found("plugin not found"));
            };
            if !plugin_available_in_current_runtime(plugin) {
                return Err(ConnectError::not_found("plugin not found"));
            }
            plugin.enabled = request.enabled.unwrap_or(false);
            for (key, value) in &request_metadata {
                if plugin_id == tunnel::PLUGIN_ID
                    && matches!(
                        key.as_str(),
                        TUNNEL_PROVIDER_PROFILES_METADATA
                            | TUNNEL_NGROK_AUTHTOKEN_METADATA
                            | "ngrokConfigured"
                    )
                {
                    continue;
                }
                plugin.metadata.insert(key.to_owned(), value.to_owned());
            }
            if plugin_id == tunnel::PLUGIN_ID {
                plugin.metadata.remove(TUNNEL_NGROK_AUTHTOKEN_METADATA);
                plugin.metadata.remove("ngrokConfigured");
                plugin.metadata.remove(TUNNEL_PROVIDER_PROFILES_METADATA);
            }
            (plugin.clone(), plugins.clone())
        };
        self.state
            .persist_plugins_snapshot(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        let plugin = self.plugin_descriptor(&plugin)?;
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
            if !plugin_available_in_current_runtime(plugin) {
                return Err(ConnectError::not_found(format!(
                    "plugin is not available in this runtime: {plugin_id}"
                )));
            }
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
        let _ = request;
        Err(ConnectError::unimplemented(
            "terminal control is managed by websocket connections",
        ))
    }

    async fn release_control(
        &self,
        _ctx: RequestContext,
        request: OwnedReleaseControlRequestView,
    ) -> ServiceResult<ReleaseControlResponse> {
        let _ = request;
        Err(ConnectError::unimplemented(
            "terminal control is managed by websocket connections",
        ))
    }
}

fn lightos_admin_connect_error(error: lightos_admin::LightOsAdminError) -> ConnectError {
    match error.status {
        axum::http::StatusCode::UNAUTHORIZED => ConnectError::unauthenticated(error.message),
        axum::http::StatusCode::FORBIDDEN => ConnectError::permission_denied(error.message),
        _ => ConnectError::unavailable(error.message),
    }
}

fn client_terminal_connect_error(error: client_terminal::ClientTerminalError) -> ConnectError {
    match error.status {
        axum::http::StatusCode::BAD_REQUEST => ConnectError::invalid_argument(error.message),
        axum::http::StatusCode::UNAUTHORIZED => ConnectError::unauthenticated(error.message),
        axum::http::StatusCode::FORBIDDEN => ConnectError::permission_denied(error.message),
        axum::http::StatusCode::NOT_FOUND => ConnectError::not_found(error.message),
        axum::http::StatusCode::GATEWAY_TIMEOUT => ConnectError::deadline_exceeded(error.message),
        _ => ConnectError::unavailable(error.message),
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
        ],
        ..Default::default()
    }
}

async fn invoke_file_transfer_plugin(
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    content_type: &str,
    payload: &[u8],
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    match operation {
        "default" | "list" => invoke_file_list(state, session, operation, metadata).await,
        "read" | "download" => {
            invoke_file_read(state, session, operation, content_type, metadata).await
        }
        "write" | "upload" => invoke_file_write(state, session, operation, payload, metadata).await,
        "upload_begin" => invoke_file_upload_begin(state, session, metadata),
        "upload_chunk" => invoke_file_upload_chunk(state, session, payload, metadata),
        "upload_finish" => invoke_file_upload_finish(state, session, metadata).await,
        "upload_cancel" => invoke_file_upload_cancel(state, session, metadata),
        "stat" => invoke_file_stat(state, session, operation, metadata).await,
        _ => Err(ConnectError::invalid_argument(format!(
            "unsupported file-transfer operation: {operation}"
        ))),
    }
}

async fn invoke_file_list(
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = metadata.get("path").map_or(".", String::as_str);
    let script = format!(
        r#"path={}
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${{path#~/}}" ;;
esac
if [ ! -e "$path" ]; then
  echo "path not found: $path" >&2
  exit 2
fi
if [ -d "$path" ]; then
  find "$path" -maxdepth 1 -mindepth 1 -printf '%f\t%y\t%s\t%n\t%l\n' | sort
else
  find "$path" -maxdepth 0 -printf '%f\t%y\t%s\t%n\t%l\n'
fi"#,
        shell_quote(path)
    );
    let output = run_session_script(state, session, &script, &[]).await?;
    plugin_response(
        "complete",
        "text/plain",
        output,
        HashMap::from([("operation".to_owned(), operation.to_owned())]),
    )
}

async fn invoke_file_read(
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    content_type: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = format!(
        r#"path={}
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${{path#~/}}" ;;
esac
if [ ! -f "$path" ]; then
  echo "file not found: $path" >&2
  exit 2
fi
cat -- "$path""#,
        shell_quote(path)
    );
    let output = run_session_script(state, session, &script, &[]).await?;
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
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    payload: &[u8],
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = file_write_script(path);
    let output = run_session_script(state, session, &script, payload).await?;
    plugin_response(
        "complete",
        "application/json",
        output,
        plugin_path_metadata(operation, path),
    )
}

fn file_write_script(path: &str) -> String {
    format!(
        r#"path={}
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${{path#~/}}" ;;
esac
parent="${{path%/*}}"
if [ "$parent" = "$path" ]; then
  parent="."
fi
if [ -z "$parent" ]; then
  parent="/"
fi
mkdir -p "$parent"
tmp="$path.webshell-upload.$$"
cat > "$tmp"
mv -f "$tmp" "$path"
bytes="$(wc -c < "$path" | tr -d ' ')"
printf '{{"path":%s,"bytes":%s}}\n' "$(printf '%s' "$path" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" "$bytes""#,
        shell_quote(path)
    )
}

fn invoke_file_upload_begin(
    state: &AppState,
    session: &SessionRecord,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let size = required_usize_metadata(metadata, "size")?;
    let name = metadata
        .get("name")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| file_name_from_path(path));
    let progress = state
        .file_uploads
        .begin(&session.id, path, name, size)
        .map_err(|err| map_file_transfer_error(err, "upload_begin"))?;
    plugin_json_response(
        "uploading",
        &progress,
        plugin_path_metadata("upload_begin", path),
    )
}

fn invoke_file_upload_chunk(
    state: &AppState,
    session: &SessionRecord,
    payload: &[u8],
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let upload_id = required_metadata(metadata, "uploadId")?;
    let offset = required_usize_metadata(metadata, "offset")?;
    let progress = state
        .file_uploads
        .append(&session.id, upload_id, offset, payload)
        .map_err(|err| map_file_transfer_error(err, "upload_chunk"))?;
    plugin_json_response(
        "uploading",
        &progress,
        HashMap::from([("operation".to_owned(), "upload_chunk".to_owned())]),
    )
}

async fn invoke_file_upload_finish(
    state: &AppState,
    session: &SessionRecord,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let upload_id = required_metadata(metadata, "uploadId")?;
    let finished = state
        .file_uploads
        .finish(&session.id, upload_id)
        .map_err(|err| map_file_transfer_error(err, "upload_finish"))?;
    let metadata = HashMap::from([("path".to_owned(), finished.path.clone())]);
    invoke_file_write(state, session, "upload", &finished.data, &metadata).await
}

fn invoke_file_upload_cancel(
    state: &AppState,
    session: &SessionRecord,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let upload_id = required_metadata(metadata, "uploadId")?;
    let result = state
        .file_uploads
        .cancel(&session.id, upload_id)
        .map_err(|err| map_file_transfer_error(err, "upload_cancel"))?;
    plugin_json_response(
        "cancelled",
        &result,
        HashMap::from([("operation".to_owned(), "upload_cancel".to_owned())]),
    )
}

async fn invoke_file_stat(
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = format!(
        r#"path={}
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${{path#~/}}" ;;
esac
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
    let output = run_session_script(state, session, &script, &[]).await?;
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

async fn run_session_script(
    state: &AppState,
    session: &SessionRecord,
    script: &str,
    stdin: &[u8],
) -> Result<Vec<u8>, ConnectError> {
    if ssh_backend::is_ssh_selector(&session.selector) {
        let profile = ssh_backend::load_enabled_profile(&state.database(), &session.selector)?;
        ssh_backend::mark_profile_used(&state.database(), &session.selector);
        return ssh_backend::run_profile_script(&profile, script, stdin).await;
    }
    if !lightos_features_enabled() {
        return Err(ConnectError::not_found("LightOS integration is disabled"));
    }
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
        if !stdin.is_empty()
            && let Err(err) = child_stdin.write_all(stdin).await
        {
            let _ = child.kill().await;
            return Err(ConnectError::unavailable(format!(
                "plugin command input failed: {err}"
            )));
        }
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

fn required_usize_metadata(
    metadata: &HashMap<String, String>,
    key: &str,
) -> Result<usize, ConnectError> {
    required_metadata(metadata, key)?
        .parse::<usize>()
        .map_err(|_| ConnectError::invalid_argument(format!("metadata.{key} must be a number")))
}

fn map_file_transfer_error(error: ConnectError, operation: &str) -> ConnectError {
    let message = error.to_string();
    if message.contains("file size is outside the supported transfer limit") {
        ConnectError::invalid_argument(format!(
            "{message}; max upload size is {} MB",
            file_transfer::MAX_FILE_TRANSFER_BYTES / 1024 / 1024
        ))
    } else {
        ConnectError::invalid_argument(format!("{operation} failed: {message}"))
    }
}

fn file_name_from_path(path: &str) -> &str {
    path.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("upload")
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

async fn close_agent_session(selector: &str, session_id: &str) -> Result<(), ConnectError> {
    if ssh_backend::is_ssh_selector(selector) {
        return Err(ConnectError::failed_precondition(
            "SSH sessions are managed by the workspace store",
        ));
    }
    if !lightos_features_enabled() {
        return Err(ConnectError::not_found("LightOS integration is disabled"));
    }
    validate_selector(selector)?;
    let login_user = lightos::login_user_for_selector(selector, true).await?;
    let agent = ensure_agent(selector, &login_user)
        .await
        .map_err(|err| ConnectError::unavailable(err.to_string()))?;
    agent
        .close_session(
            session_id,
            DEFAULT_COLS,
            DEFAULT_ROWS,
            DEFAULT_OUTPUT_FRAME_LIMIT,
        )
        .await
        .map(|_| ())
        .map_err(|err| {
            let message = err.to_string();
            if message.contains("session not found") {
                ConnectError::not_found(message)
            } else {
                ConnectError::internal(message)
            }
        })
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

    #[test]
    fn agent_fallback_session_record_uses_webshell_backend_and_login_user() {
        let session = agent_fallback_session_record("agent-session", "demo@owner", "dev");

        assert_eq!(session.id, "agent-session");
        assert_eq!(session.host, "demo");
        assert_eq!(session.selector, "demo@owner");
        assert_eq!(
            session.metadata.get("sessionBackend").map(String::as_str),
            Some("webshell")
        );
        assert_eq!(
            session
                .metadata
                .get(METADATA_LOGIN_USER)
                .map(String::as_str),
            Some("dev")
        );
    }

    #[tokio::test]
    async fn proto_create_session_routes_remote_clients_through_account_authentication() {
        let service = CapabilityServiceImpl::new(Arc::new(test_app_state()));
        let request = OwnedCreateSessionRequestView::from_owned(
            &crate::proto::lazycat::webshell::v1::CreateSessionRequest {
                selector: Some("client:client-a".to_owned()),
                cols: Some(120),
                rows: Some(32),
                ..Default::default()
            },
        )
        .expect("owned create-session request");

        let error = service
            .create_session(RequestContext::default(), request)
            .await
            .expect_err("missing account context must be rejected");

        assert_eq!(error.code, connectrpc::ErrorCode::Unauthenticated);
        assert_eq!(error.message.as_deref(), Some("account id is required"));
    }

    #[tokio::test]
    async fn file_transfer_rejects_unknown_operation_before_running_commands() {
        let state = test_app_state();
        let session = test_session(HashMap::new());

        let error = invoke_file_transfer_plugin(
            &state,
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
    fn file_transfer_write_script_uses_portable_parent_directory() {
        let script = file_write_script("/tmp/lazycat-webshell-uploads/a/b.txt");

        assert!(script.contains("parent=\"${path%/*}\""));
        assert!(script.contains("mkdir -p \"$parent\""));
        assert!(script.contains("mv -f \"$tmp\" \"$path\""));
        assert!(!script.contains("dirname --"));
        assert!(!script.contains("mkdir -p --"));
        assert!(!script.contains("mv -f --"));
    }

    #[test]
    fn ai_chat_plugin_reports_action_websocket_transport() {
        let state = Arc::new(test_app_state());
        let session = test_session(HashMap::new());
        state
            .sessions
            .write()
            .unwrap()
            .insert(session.id.clone(), session.clone());
        let response = CapabilityServiceImpl::invoke_ai_chat_plugin(&session, "status")
            .unwrap()
            .body;
        assert_eq!(response.status.as_deref(), Some("complete"));
        let value =
            serde_json::from_slice::<serde_json::Value>(response.payload.as_deref().unwrap())
                .unwrap();
        assert_eq!(value["plugin"], "ai-chat");
        assert_eq!(value["transport"], "action-websocket");
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
