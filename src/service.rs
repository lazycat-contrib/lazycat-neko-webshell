#[cfg(test)]
use crate::plugin::resources::targets::agent_fallback_session_record;
pub(crate) use crate::plugin::resources::targets::authorize_file_session;
#[cfg(test)]
use crate::state::METADATA_LOGIN_USER;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLockReadGuard};

use buffa::MessageField;
use connectrpc::{
    ConnectError, RequestContext, Response as ConnectResponse, ServiceRequest, ServiceResult,
};
use uuid::Uuid;

use crate::agent_client::ensure_agent;
use crate::client_terminal;
use crate::config::{
    APP_ID, APP_NAME, DEFAULT_COLS, DEFAULT_OUTPUT_FRAME_LIMIT, DEFAULT_ROWS, MAX_COLS, MAX_ROWS,
};
use crate::lightos;
use crate::lightos_admin;
use crate::plugin::settings::plugin_available_in_current_runtime;
#[cfg(test)]
use crate::proto::lazycat::webshell::v1::OwnedCreateSessionRequestView;
use crate::proto::lazycat::webshell::v1::{
    AgentPaneState, AgentWorkspaceAction, AgentWorkspaceActionType, AgentWorkspaceState,
    Capability, CapabilityService, CloseSessionRequest, CloseSessionResponse,
    ConfigurePluginRequest, ConfigurePluginResponse, CreateSessionRequest, CreateSessionResponse,
    GetProviderRequest, GetProviderResponse, InvokePluginRequest, InvokePluginResponse,
    ListInstancesRequest, ListInstancesResponse, ListPluginsRequest, ListPluginsResponse,
    ListSessionsRequest, ListSessionsResponse, ProviderDescriptor, ReleaseControlRequest,
    ReleaseControlResponse, RequestControlRequest, RequestControlResponse, Session,
};
use crate::ssh_backend;
use crate::state::{AppState, SessionRecord, output_frame_limit_from_metadata};
use crate::tty_init::lightos_features_enabled;
use crate::validation::{normalize_dimension, required_field, validate_selector};
use crate::workspace::{WorkspaceSessionError, close_workspace_session};

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

    pub async fn invoke_plugin_runtime(
        &self,
        plugin_id: &str,
        session_id: &str,
        operation: &str,
        content_type: &str,
        payload: Vec<u8>,
        metadata: HashMap<String, String>,
    ) -> ServiceResult<InvokePluginResponse> {
        self.state.plugin.require_enabled(plugin_id)?;
        let runtime = self.state.plugin.runtime(&self.state).await?;
        let reply = runtime
            .invoke(
                plugin_id,
                neko_plugin::InvokeRequest {
                    target: neko_plugin::TargetRequest {
                        session_id: session_id.to_owned(),
                        metadata,
                    },
                    operation: operation.to_owned(),
                    content_type: content_type.to_owned(),
                    payload,
                },
            )
            .await
            .map_err(crate::plugin::resources::connect_error)?;
        ConnectResponse::ok(InvokePluginResponse {
            invocation_id: Some(Uuid::new_v4().to_string()),
            status: Some(reply.status),
            content_type: Some(reply.content_type),
            payload: Some(reply.payload),
            metadata: reply.metadata.into_iter().collect(),
            ..Default::default()
        })
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
        metadata: metadata.into_iter().collect(),
        ..Default::default()
    }
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

impl CapabilityService for CapabilityServiceImpl {
    async fn list_instances(
        &self,
        ctx: RequestContext,
        _request: ServiceRequest<'_, ListInstancesRequest>,
    ) -> ServiceResult<ListInstancesResponse> {
        let mut instances = if lightos_features_enabled() {
            lightos_admin::list_visible_instances(ctx.headers())
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
        _request: ServiceRequest<'_, GetProviderRequest>,
    ) -> ServiceResult<GetProviderResponse> {
        ConnectResponse::ok(GetProviderResponse {
            provider: MessageField::some(provider_descriptor()),
            ..Default::default()
        })
    }

    async fn create_session(
        &self,
        ctx: RequestContext,
        request: ServiceRequest<'_, CreateSessionRequest>,
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
                ctx.headers(),
                selector,
                cols,
                rows,
                output_limit,
                metadata,
                self.state.as_ref(),
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
                &self.state.agent_control,
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
        request: ServiceRequest<'_, CloseSessionRequest>,
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
                ctx.headers(),
                selector,
                &session_id,
                DEFAULT_COLS,
                DEFAULT_ROWS,
                DEFAULT_OUTPUT_FRAME_LIMIT,
                self.state.as_ref(),
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
        close_agent_session(&self.state, selector, &session_id).await?;
        ConnectResponse::ok(CloseSessionResponse {
            session_id: Some(session_id),
            status: Some("closed".to_owned()),
            ..Default::default()
        })
    }

    async fn list_sessions(
        &self,
        ctx: RequestContext,
        request: ServiceRequest<'_, ListSessionsRequest>,
    ) -> ServiceResult<ListSessionsResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(selector) = selector.filter(|value| lightos_admin::is_client_selector(value)) {
            if !lightos_features_enabled() {
                return Err(ConnectError::not_found("LightOS integration is disabled"));
            }
            let sessions = client_terminal::list_sessions(
                ctx.headers(),
                selector,
                DEFAULT_COLS,
                DEFAULT_ROWS,
                self.state.as_ref(),
            )
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
        _request: ServiceRequest<'_, ListPluginsRequest>,
    ) -> ServiceResult<ListPluginsResponse> {
        self.state.plugin.runtime(&self.state).await?;
        let plugin_records = self
            .state
            .plugin
            .settings
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?
            .values()
            .filter(|plugin| plugin_available_in_current_runtime(plugin))
            .cloned()
            .collect::<Vec<_>>();
        let plugins = plugin_records
            .iter()
            .map(|plugin| self.state.plugin.descriptor(plugin))
            .collect();
        ConnectResponse::ok(ListPluginsResponse {
            plugins,
            ..Default::default()
        })
    }

    async fn configure_plugin(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, ConfigurePluginRequest>,
    ) -> ServiceResult<ConfigurePluginResponse> {
        let plugin_id = required_field(request.plugin_id, "plugin_id")?;
        let request_metadata = request
            .metadata
            .iter()
            .map(|entry| (entry.0.to_owned(), entry.1.to_owned()))
            .collect::<HashMap<_, _>>();
        let plugin = self
            .state
            .plugin
            .configure(
                &self.state,
                plugin_id,
                request.enabled.unwrap_or(false),
                request_metadata,
            )
            .await?;
        ConnectResponse::ok(ConfigurePluginResponse {
            plugin: MessageField::some(plugin),
            ..Default::default()
        })
    }

    async fn invoke_plugin(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, InvokePluginRequest>,
    ) -> ServiceResult<InvokePluginResponse> {
        let plugin_id = required_field(request.plugin_id, "plugin_id")?;
        {
            let plugins = self
                .state
                .plugin
                .settings
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
        request: ServiceRequest<'_, RequestControlRequest>,
    ) -> ServiceResult<RequestControlResponse> {
        let _ = request;
        Err(ConnectError::unimplemented(
            "terminal control is managed by websocket connections",
        ))
    }

    async fn release_control(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, ReleaseControlRequest>,
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

async fn close_agent_session(
    state: &AppState,
    selector: &str,
    session_id: &str,
) -> Result<(), ConnectError> {
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
            &state.agent_control,
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
        let request =
            ServiceRequest::<CreateSessionRequest>::from_parts(request.reborrow(), request.bytes());

        let error = service
            .create_session(RequestContext::default(), request)
            .await
            .expect_err("missing account context must be rejected");

        assert_eq!(error.code, connectrpc::ErrorCode::Unauthenticated);
        assert_eq!(error.message.as_deref(), Some("account id is required"));
    }

    fn test_app_state() -> AppState {
        AppState::new_for_test(std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-service-test-{}.db",
            Uuid::new_v4()
        )))
    }
}
