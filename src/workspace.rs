use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use buffa::MessageField;
use serde::{Deserialize, Serialize};
use tracing::warn;
use uuid::Uuid;

use crate::agent_client::ensure_agent;
use crate::config::{DEFAULT_COLS, DEFAULT_OUTPUT_FRAME_LIMIT, DEFAULT_ROWS, MAX_COLS, MAX_ROWS};
use crate::database::{AppDatabase, KV_KEY_WORKSPACES, KV_NAMESPACE_STATE};
use crate::lightos;
use crate::lightos_admin;
use crate::proto::lazycat::webshell::v1::{
    AgentLayoutNode, AgentLayoutNodeType, AgentSplitAxis, AgentSplitDirection,
    AgentWorkspaceAction, AgentWorkspaceActionType, AgentWorkspaceState,
};
use crate::ssh_backend;
use crate::state::{
    AppState, METADATA_LOGIN_USER, SessionRecord, default_session_command_for_user,
    host_from_selector, output_frame_limit_from_metadata, session_command_for_backend_id,
    sync_session_login_user,
};
use crate::tty_init::lightos_features_enabled;
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceRecord {
    pub selector: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub tabs: Vec<WorkspaceTab>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub tab_metadata: HashMap<String, WorkspaceTabMetadata>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceTabMetadata {
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_order: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceTab {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<WorkspaceLayoutNode>,
    #[serde(default)]
    pub panes: Vec<WorkspacePane>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspacePane {
    pub id: String,
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WorkspaceLayoutNode {
    Pane {
        #[serde(rename = "paneId")]
        pane_id: String,
    },
    Split {
        axis: SplitAxis,
        children: Vec<WorkspaceLayoutNode>,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitAxis {
    Rows,
    Columns,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceState {
    pub selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    pub tabs: Vec<WorkspaceTabState>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceTabState {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_label: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_order: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<WorkspaceLayoutNode>,
    pub panes: Vec<WorkspacePaneState>,
}

#[derive(Debug, Serialize)]
pub struct WorkspacePaneState {
    pub id: String,
    pub session_id: String,
    pub status: String,
    pub session_backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub herdr_output_sequence: Option<u64>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceQuery {
    name: String,
    cols: Option<u16>,
    rows: Option<u16>,
    output_limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceActionRequest {
    pub(crate) name: String,
    pub(crate) action: WorkspaceAction,
    pub(crate) tab_id: Option<String>,
    pub(crate) pane_id: Option<String>,
    pub(crate) direction: Option<SplitDirection>,
    pub(crate) label: Option<String>,
    pub(crate) layout: Option<WorkspaceLayoutNode>,
    pub(crate) active_pane_id: Option<String>,
    pub(crate) cols: Option<u16>,
    pub(crate) rows: Option<u16>,
    pub(crate) output_limit: Option<usize>,
    pub(crate) auto_restart: Option<bool>,
    pub(crate) session_backend: Option<SessionBackend>,
    pub(crate) pinned: Option<bool>,
    pub(crate) pinned_order: Option<u32>,
}

#[derive(Clone)]
pub(crate) struct WorkspaceTerminalDefaults {
    cols: u16,
    rows: u16,
    output_limit: usize,
    auto_restart: bool,
    login_user: String,
    session_backend: SessionBackend,
    command: String,
    args: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionBackend {
    Webshell,
    Herdr,
    Zellij,
    Ssh,
}

impl WorkspaceTerminalDefaults {
    pub(crate) fn new(
        state: &AppState,
        selector: &str,
        cols: u16,
        rows: u16,
        output_limit: usize,
        auto_restart: bool,
        login_user: &str,
        session_backend: SessionBackend,
    ) -> Result<Self, String> {
        let (command, args) =
            session_command_for_backend(state, selector, login_user, session_backend)?;
        Ok(Self {
            cols,
            rows,
            output_limit,
            auto_restart,
            login_user: login_user.trim().to_owned(),
            session_backend,
            command,
            args,
        })
    }
}

#[cfg(test)]
#[derive(Debug)]
pub struct CreatedWorkspaceSession {
    pub session: SessionRecord,
}

#[derive(Debug)]
pub struct ClosedWorkspaceSession {
    pub session_id: String,
    pub status: String,
    pub closed_session_ids: Vec<String>,
}

#[derive(Debug)]
pub enum WorkspaceSessionError {
    NotFound(String),
    Internal(String),
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAction {
    CreateTab,
    CloseTab,
    RenameTab,
    ActivateTab,
    SplitPane,
    ClosePane,
    ActivatePane,
    PromotePaneToTab,
    UpdateLayout,
    SetTabPinned,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedWorkspaceState {
    version: u32,
    workspaces: Vec<WorkspaceRecord>,
}

pub struct WorkspaceStore {
    database: Arc<AppDatabase>,
}

impl WorkspaceStore {
    pub fn new(database: Arc<AppDatabase>) -> Self {
        Self { database }
    }

    pub fn load(&self) -> io::Result<HashMap<String, WorkspaceRecord>> {
        match self
            .database
            .load_kv(KV_NAMESPACE_STATE, KV_KEY_WORKSPACES)?
        {
            Some(bytes) => Self::decode(&bytes),
            None => Ok(HashMap::new()),
        }
    }

    fn decode(bytes: &[u8]) -> io::Result<HashMap<String, WorkspaceRecord>> {
        let persisted = serde_json::from_slice::<PersistedWorkspaceState>(bytes)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
        let mut workspaces = HashMap::new();
        for mut workspace in persisted.workspaces {
            if validate_selector(&workspace.selector).is_err() {
                warn!(selector = %workspace.selector, "ignored invalid persisted workspace");
                continue;
            }
            workspace.repair();
            workspaces.insert(workspace.selector.clone(), workspace);
        }
        Ok(workspaces)
    }

    pub fn save(&self, workspaces: &HashMap<String, WorkspaceRecord>) -> io::Result<()> {
        if workspaces.is_empty() {
            return self
                .database
                .delete_kv(KV_NAMESPACE_STATE, KV_KEY_WORKSPACES);
        }
        let mut workspaces = workspaces.values().cloned().collect::<Vec<_>>();
        workspaces.sort_by(|left, right| left.selector.cmp(&right.selector));
        let persisted = PersistedWorkspaceState {
            version: 1,
            workspaces,
        };
        let bytes =
            serde_json::to_vec(&persisted).map_err(|err| io::Error::other(err.to_string()))?;
        self.database
            .store_kv(KV_NAMESPACE_STATE, KV_KEY_WORKSPACES, &bytes)
    }
}

pub async fn get_workspace(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    let selector = query.name.trim();
    let (cols, rows) = match request_size(query.cols, query.rows) {
        Ok(size) => size,
        Err(response) => return response.into_response(),
    };
    let output_limit = normalize_output_frame_limit(query.output_limit);

    if lightos_admin::is_client_selector(selector) {
        return match crate::client_terminal::get_workspace(&headers, selector, cols, rows).await {
            Ok(workspace) => Json(workspace).into_response(),
            Err(error) => error.into_response(),
        };
    }

    let login_user = match authorize_workspace_selector(&state, selector, true).await {
        Ok(login_user) => login_user,
        Err(response) => return response.into_response(),
    };

    if ssh_backend::is_ssh_selector(selector) {
        return Json(optional_backend_workspace_state(&state, selector)).into_response();
    }

    match standard_agent_workspace(
        &state,
        selector,
        &login_user,
        cols,
        rows,
        output_limit,
        false,
    )
    .await
    {
        Ok(workspace) => Json(workspace).into_response(),
        Err(message) => bad_gateway(message),
    }
}

pub async fn put_workspace_action(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<WorkspaceActionRequest>,
) -> Response {
    let selector = request.name.trim().to_owned();
    let (cols, rows) = match request_size(request.cols, request.rows) {
        Ok(size) => size,
        Err(response) => return response.into_response(),
    };

    if lightos_admin::is_client_selector(&selector) {
        return match crate::client_terminal::apply_workspace_action(
            &headers, &selector, cols, rows, &request,
        )
        .await
        {
            Ok(workspace) => Json(workspace).into_response(),
            Err(error) => error.into_response(),
        };
    }

    let login_user = match authorize_workspace_selector(&state, &selector, true).await {
        Ok(login_user) => login_user,
        Err(response) => return response.into_response(),
    };
    let output_limit = normalize_output_frame_limit(request.output_limit);
    let auto_restart = request.auto_restart.unwrap_or(false);

    if !workspace_action_uses_legacy_store(&state, &selector, &request) {
        let action = match agent_action_from_workspace_request(&request) {
            Ok(action) => action,
            Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
        };
        return match standard_agent_workspace_action(
            &state,
            &selector,
            &login_user,
            cols,
            rows,
            output_limit,
            action,
        )
        .await
        {
            Ok(workspace) => Json(workspace).into_response(),
            Err(message) => bad_gateway(message),
        };
    }

    let session_backend = request.session_backend.unwrap_or_else(|| {
        if ssh_backend::is_ssh_selector(&selector) {
            SessionBackend::Ssh
        } else {
            SessionBackend::Webshell
        }
    });
    let defaults = match WorkspaceTerminalDefaults::new(
        &state,
        &selector,
        cols,
        rows,
        output_limit,
        auto_restart,
        &login_user,
        session_backend,
    ) {
        Ok(defaults) => defaults,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };

    match apply_workspace_action(&state, &selector, &defaults, &request) {
        Ok((workspace, closed_sessions)) => {
            state
                .sessions
                .close_sessions(closed_sessions.iter().map(String::as_str));
            if ssh_backend::is_ssh_selector(&selector) {
                return Json(workspace).into_response();
            }
            match standard_agent_workspace(
                &state,
                &selector,
                &login_user,
                cols,
                rows,
                output_limit,
                true,
            )
            .await
            {
                Ok(workspace) => Json(workspace).into_response(),
                Err(message) => bad_gateway(message),
            }
        }
        Err(WorkspaceActionError::BadRequest(message)) => {
            (StatusCode::BAD_REQUEST, message).into_response()
        }
        Err(WorkspaceActionError::Internal(message)) => internal_error(message),
    }
}

async fn standard_agent_workspace(
    state: &AppState,
    selector: &str,
    login_user: &str,
    cols: u16,
    rows: u16,
    output_limit: usize,
    prefer_optional_active: bool,
) -> Result<WorkspaceState, String> {
    let agent = ensure_agent(selector, login_user)
        .await
        .map_err(|err| format!("failed to start webshell agent: {err}"))?;
    let agent_state = agent
        .state(cols, rows, output_limit)
        .await
        .map_err(|err| format!("failed to load webshell workspace: {err}"))?;
    Ok(merge_optional_backend_tabs(
        state,
        workspace_state_from_agent(agent_state),
        prefer_optional_active,
    ))
}

async fn standard_agent_workspace_action(
    state: &AppState,
    selector: &str,
    login_user: &str,
    cols: u16,
    rows: u16,
    output_limit: usize,
    action: AgentWorkspaceAction,
) -> Result<WorkspaceState, String> {
    let agent = ensure_agent(selector, login_user)
        .await
        .map_err(|err| format!("failed to start webshell agent: {err}"))?;
    let agent_state = agent
        .action(cols, rows, output_limit, action)
        .await
        .map_err(|err| format!("failed to update webshell workspace: {err}"))?;
    Ok(merge_optional_backend_tabs(
        state,
        workspace_state_from_agent(agent_state),
        false,
    ))
}

fn workspace_action_uses_legacy_store(
    state: &AppState,
    selector: &str,
    request: &WorkspaceActionRequest,
) -> bool {
    if ssh_backend::is_ssh_selector(selector) {
        return true;
    }
    if request.action == WorkspaceAction::SetTabPinned {
        return true;
    }
    match request.session_backend {
        Some(SessionBackend::Herdr | SessionBackend::Zellij | SessionBackend::Ssh) => return true,
        Some(SessionBackend::Webshell) => return false,
        None => {}
    }
    request_targets_optional_backend(state, selector, request)
}

fn request_targets_optional_backend(
    state: &AppState,
    selector: &str,
    request: &WorkspaceActionRequest,
) -> bool {
    let Ok(workspaces) = state.workspaces.read() else {
        return false;
    };
    let Some(workspace) = workspaces.get(selector) else {
        return false;
    };
    let Ok(sessions) = state.sessions.read() else {
        return false;
    };
    let tab_id = request
        .tab_id
        .as_deref()
        .or(workspace.active_tab_id.as_deref());
    let pane_id = request.pane_id.as_deref();
    workspace.tabs.iter().any(|tab| {
        if tab_id.is_some_and(|id| id != tab.id) {
            return false;
        }
        tab.panes.iter().any(|pane| {
            if pane_id.is_some_and(|id| id != pane.id) {
                return false;
            }
            let session = sessions.get(&pane.session_id);
            session_backend_from_session(session) != "webshell"
        })
    })
}

fn merge_optional_backend_tabs(
    state: &AppState,
    mut workspace: WorkspaceState,
    prefer_optional_active: bool,
) -> WorkspaceState {
    let optional = optional_backend_workspace_state(state, &workspace.selector);
    let optional_tab_ids = optional
        .tabs
        .iter()
        .map(|tab| tab.id.clone())
        .collect::<HashSet<_>>();
    let mut tabs = optional.tabs;
    tabs.extend(workspace.tabs);
    workspace.tabs = tabs;
    if prefer_optional_active
        && optional
            .active_tab_id
            .as_ref()
            .is_some_and(|tab_id| optional_tab_ids.contains(tab_id))
    {
        workspace.active_tab_id = optional.active_tab_id;
    }
    sync_workspace_tab_metadata(state, &mut workspace);
    workspace
}

fn sync_workspace_tab_metadata(state: &AppState, workspace: &mut WorkspaceState) {
    let selector = workspace.selector.clone();
    let tab_ids = workspace
        .tabs
        .iter()
        .map(|tab| tab.id.clone())
        .collect::<Vec<_>>();
    let workspace_snapshot = {
        let Ok(mut workspaces) = state.workspaces.write() else {
            sort_workspace_tabs(workspace);
            return;
        };
        let Some(record) = workspaces.get_mut(&selector) else {
            sort_workspace_tabs(workspace);
            return;
        };
        let changed = record.normalize_tab_metadata(Some(&tab_ids));
        record.apply_tab_metadata(workspace);
        sort_workspace_tabs(workspace);
        changed.then(|| workspaces.clone())
    };
    if let Some(workspaces) = workspace_snapshot
        && let Err(err) = state.persist_workspaces_snapshot(&workspaces)
    {
        warn!(error = %err, selector = %selector, "failed to persist normalized tab metadata");
    }
}

fn sort_workspace_tabs(workspace: &mut WorkspaceState) {
    let original_index = workspace
        .tabs
        .iter()
        .enumerate()
        .map(|(index, tab)| (tab.id.clone(), index))
        .collect::<HashMap<_, _>>();
    workspace.tabs.sort_by(|left, right| {
        tab_sort_key(left, &original_index).cmp(&tab_sort_key(right, &original_index))
    });
}

fn tab_sort_key(
    tab: &WorkspaceTabState,
    original_index: &HashMap<String, usize>,
) -> (u8, u32, usize) {
    let index = original_index.get(&tab.id).copied().unwrap_or(usize::MAX);
    if tab.pinned {
        (0, tab.pinned_order.unwrap_or(u32::MAX), index)
    } else {
        (1, u32::MAX, index)
    }
}

fn optional_backend_workspace_state(state: &AppState, selector: &str) -> WorkspaceState {
    let snapshot = {
        let Ok(workspaces) = state.workspaces.read() else {
            return empty_workspace_state(selector);
        };
        let Some(workspace) = workspaces.get(selector) else {
            return empty_workspace_state(selector);
        };
        let Ok(sessions) = state.sessions.read() else {
            return empty_workspace_state(selector);
        };
        workspace.snapshot(&sessions)
    };
    let mut filtered = snapshot;
    filtered.tabs.retain(|tab| {
        tab.panes
            .iter()
            .any(|pane| pane.session_backend != "webshell")
    });
    attach_herdr_output_sequences(state, &mut filtered);
    if !filtered
        .active_tab_id
        .as_deref()
        .is_some_and(|active| filtered.tabs.iter().any(|tab| tab.id == active))
    {
        filtered.active_tab_id = None;
    }
    filtered
}

fn attach_herdr_output_sequences(state: &AppState, workspace: &mut WorkspaceState) {
    let database = state.database();
    for pane in workspace
        .tabs
        .iter_mut()
        .flat_map(|tab| tab.panes.iter_mut())
        .filter(|pane| pane.session_backend == "herdr")
    {
        match database.load_herdr_output_sequence(&pane.session_id) {
            Ok(sequence) => pane.herdr_output_sequence = sequence,
            Err(err) => {
                warn!(
                    error = %err,
                    session_id = %pane.session_id,
                    "failed to load Herdr output sequence cursor"
                );
            }
        }
    }
}

fn empty_workspace_state(selector: &str) -> WorkspaceState {
    WorkspaceState {
        selector: selector.to_owned(),
        active_tab_id: None,
        tabs: Vec::new(),
    }
}

fn workspace_state_from_agent(state: AgentWorkspaceState) -> WorkspaceState {
    WorkspaceState {
        selector: state.selector.unwrap_or_default(),
        active_tab_id: state.active_tab_id,
        tabs: state
            .tabs
            .into_iter()
            .map(|tab| WorkspaceTabState {
                id: tab.id.unwrap_or_default(),
                label: tab.label.unwrap_or_default(),
                custom_label: tab.custom_label,
                pinned: false,
                pinned_order: None,
                active_pane_id: tab.active_pane_id,
                layout: tab
                    .layout
                    .into_option()
                    .and_then(workspace_layout_from_agent),
                panes: tab
                    .panes
                    .into_iter()
                    .map(|pane| WorkspacePaneState {
                        id: pane.id.unwrap_or_default(),
                        session_id: pane.session_id.unwrap_or_default(),
                        status: pane.status.unwrap_or_else(|| "stopped".to_owned()),
                        session_backend: pane
                            .session_backend
                            .unwrap_or_else(|| "webshell".to_owned()),
                        cols: i32_to_u16(pane.cols, DEFAULT_COLS),
                        rows: i32_to_u16(pane.rows, DEFAULT_ROWS),
                        herdr_output_sequence: None,
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn workspace_layout_from_agent(node: AgentLayoutNode) -> Option<WorkspaceLayoutNode> {
    match node.r#type.as_ref().and_then(|kind| kind.as_known()) {
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE) => node
            .pane_id
            .map(|pane_id| WorkspaceLayoutNode::Pane { pane_id }),
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT) => {
            Some(WorkspaceLayoutNode::Split {
                axis: match node.axis.as_ref().and_then(|axis| axis.as_known()) {
                    Some(AgentSplitAxis::AGENT_SPLIT_AXIS_COLUMNS) => SplitAxis::Columns,
                    _ => SplitAxis::Rows,
                },
                children: node
                    .children
                    .into_iter()
                    .filter_map(workspace_layout_from_agent)
                    .collect(),
            })
        }
        _ => None,
    }
}

fn agent_action_from_workspace_request(
    request: &WorkspaceActionRequest,
) -> Result<AgentWorkspaceAction, String> {
    if request.action == WorkspaceAction::SetTabPinned {
        return Err("set_tab_pinned is handled by workspace metadata".to_owned());
    }
    Ok(AgentWorkspaceAction {
        action: Some(agent_action_type(request.action).into()),
        tab_id: request.tab_id.clone(),
        pane_id: request.pane_id.clone(),
        direction: request.direction.map(agent_split_direction).map(Into::into),
        label: request.label.clone(),
        layout: request
            .layout
            .clone()
            .and_then(agent_layout_from_workspace)
            .map_or_else(MessageField::none, MessageField::some),
        active_pane_id: request.active_pane_id.clone(),
        ..Default::default()
    })
}

fn agent_action_type(action: WorkspaceAction) -> AgentWorkspaceActionType {
    match action {
        WorkspaceAction::CreateTab => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CREATE_TAB
        }
        WorkspaceAction::CloseTab => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CLOSE_TAB
        }
        WorkspaceAction::RenameTab => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_RENAME_TAB
        }
        WorkspaceAction::ActivateTab => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_ACTIVATE_TAB
        }
        WorkspaceAction::SplitPane => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_SPLIT_PANE
        }
        WorkspaceAction::ClosePane => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CLOSE_PANE
        }
        WorkspaceAction::ActivatePane => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_ACTIVATE_PANE
        }
        WorkspaceAction::PromotePaneToTab => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_PROMOTE_PANE_TO_TAB
        }
        WorkspaceAction::UpdateLayout => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_UPDATE_LAYOUT
        }
        WorkspaceAction::SetTabPinned => {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_UNSPECIFIED
        }
    }
}

fn agent_split_direction(direction: SplitDirection) -> AgentSplitDirection {
    match direction {
        SplitDirection::Up => AgentSplitDirection::AGENT_SPLIT_DIRECTION_UP,
        SplitDirection::Down => AgentSplitDirection::AGENT_SPLIT_DIRECTION_DOWN,
        SplitDirection::Left => AgentSplitDirection::AGENT_SPLIT_DIRECTION_LEFT,
        SplitDirection::Right => AgentSplitDirection::AGENT_SPLIT_DIRECTION_RIGHT,
    }
}

fn agent_layout_from_workspace(node: WorkspaceLayoutNode) -> Option<AgentLayoutNode> {
    match node {
        WorkspaceLayoutNode::Pane { pane_id } => Some(AgentLayoutNode {
            r#type: Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE.into()),
            pane_id: Some(pane_id),
            ..Default::default()
        }),
        WorkspaceLayoutNode::Split { axis, children } => Some(AgentLayoutNode {
            r#type: Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT.into()),
            axis: Some(
                match axis {
                    SplitAxis::Rows => AgentSplitAxis::AGENT_SPLIT_AXIS_ROWS,
                    SplitAxis::Columns => AgentSplitAxis::AGENT_SPLIT_AXIS_COLUMNS,
                }
                .into(),
            ),
            children: children
                .into_iter()
                .filter_map(agent_layout_from_workspace)
                .collect(),
            ..Default::default()
        }),
    }
}

fn i32_to_u16(value: Option<i32>, default_value: u16) -> u16 {
    value
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_value)
}

#[cfg(test)]
pub(crate) fn create_workspace_session(
    state: &AppState,
    selector: &str,
    defaults: &WorkspaceTerminalDefaults,
    metadata: HashMap<String, String>,
) -> Result<CreatedWorkspaceSession, WorkspaceSessionError> {
    let (session, workspace_snapshot, sessions_snapshot) = {
        let mut workspaces = state.workspaces.write().map_err(|_| {
            WorkspaceSessionError::Internal("workspace store lock poisoned".to_owned())
        })?;
        let mut sessions = state.sessions.write().map_err(|_| {
            WorkspaceSessionError::Internal("session store lock poisoned".to_owned())
        })?;
        let workspace = workspaces
            .entry(selector.to_owned())
            .or_insert_with(|| WorkspaceRecord::new(selector));
        workspace.repair();
        let session = workspace.create_tab_with_metadata(&mut sessions, defaults, metadata, None);
        (session, workspaces.clone(), sessions.clone())
    };
    persist_snapshots(state, Some(workspace_snapshot), Some(sessions_snapshot))
        .map_err(WorkspaceSessionError::Internal)?;
    Ok(CreatedWorkspaceSession { session })
}

pub fn close_workspace_session(
    state: &AppState,
    session_id: &str,
) -> Result<ClosedWorkspaceSession, WorkspaceSessionError> {
    let mut closed_session_ids = Vec::new();
    let (workspace_snapshot, sessions_snapshot) = {
        let mut workspaces = state.workspaces.write().map_err(|_| {
            WorkspaceSessionError::Internal("workspace store lock poisoned".to_owned())
        })?;
        let mut sessions = state.sessions.write().map_err(|_| {
            WorkspaceSessionError::Internal("session store lock poisoned".to_owned())
        })?;

        if let Some(selector) = workspace_selector_for_session(&workspaces, session_id) {
            let workspace = workspaces.get_mut(&selector).ok_or_else(|| {
                WorkspaceSessionError::Internal("workspace disappeared during close".to_owned())
            })?;
            workspace
                .close_session_pane(session_id, &mut sessions, &mut closed_session_ids)
                .map_err(WorkspaceSessionError::Internal)?;
            workspace.repair();
            (Some(workspaces.clone()), Some(sessions.clone()))
        } else {
            let Some(mut record) = sessions.remove(session_id) else {
                return Err(WorkspaceSessionError::NotFound(
                    "session not found".to_owned(),
                ));
            };
            "closed".clone_into(&mut record.status);
            closed_session_ids.push(session_id.to_owned());
            (None, Some(sessions.clone()))
        }
    };
    persist_snapshots(state, workspace_snapshot, sessions_snapshot)
        .map_err(WorkspaceSessionError::Internal)?;
    Ok(ClosedWorkspaceSession {
        session_id: session_id.to_owned(),
        status: "closed".to_owned(),
        closed_session_ids,
    })
}

fn apply_workspace_action(
    state: &AppState,
    selector: &str,
    defaults: &WorkspaceTerminalDefaults,
    request: &WorkspaceActionRequest,
) -> Result<(WorkspaceState, Vec<String>), WorkspaceActionError> {
    let mut closed_sessions = Vec::new();
    let (workspace, workspace_snapshot, sessions_snapshot) = {
        let mut workspaces = state.workspaces.write().map_err(|_| {
            WorkspaceActionError::Internal("workspace store lock poisoned".to_owned())
        })?;
        let mut sessions = state.sessions.write().map_err(|_| {
            WorkspaceActionError::Internal("session store lock poisoned".to_owned())
        })?;
        let workspace = workspaces
            .entry(selector.to_owned())
            .or_insert_with(|| WorkspaceRecord::new(selector));
        if request.action == WorkspaceAction::SetTabPinned {
            workspace.repair();
        } else if request.action == WorkspaceAction::CreateTab {
            workspace.repair();
        } else {
            workspace.ensure_ready(&mut sessions, defaults);
        }
        workspace
            .apply_action(request, &mut sessions, defaults, &mut closed_sessions)
            .map_err(WorkspaceActionError::BadRequest)?;
        let response = workspace.snapshot(&sessions);
        (response, workspaces.clone(), sessions.clone())
    };
    persist_snapshots(state, Some(workspace_snapshot), Some(sessions_snapshot))
        .map_err(WorkspaceActionError::Internal)?;
    Ok((workspace, closed_sessions))
}

fn persist_snapshots(
    state: &AppState,
    workspaces: Option<HashMap<String, WorkspaceRecord>>,
    sessions: Option<HashMap<String, SessionRecord>>,
) -> Result<(), String> {
    if let Some(workspaces) = workspaces {
        state
            .persist_workspaces_snapshot(&workspaces)
            .map_err(|err| format!("failed to persist workspaces: {err}"))?;
    }
    if let Some(sessions) = sessions {
        state
            .persist_sessions_snapshot(&sessions)
            .map_err(|err| format!("failed to persist sessions: {err}"))?;
    }
    Ok(())
}

impl WorkspaceRecord {
    fn new(selector: &str) -> Self {
        Self {
            selector: selector.to_owned(),
            active_tab_id: None,
            tabs: Vec::new(),
            tab_metadata: HashMap::new(),
        }
    }

    fn ensure_ready(
        &mut self,
        sessions: &mut HashMap<String, SessionRecord>,
        defaults: &WorkspaceTerminalDefaults,
    ) -> bool {
        self.repair();
        let mut changed = false;
        if self.tabs.is_empty() {
            self.create_tab(sessions, defaults, None);
            changed = true;
        }
        for tab in &mut self.tabs {
            for pane in &mut tab.panes {
                changed |= ensure_pane_session(sessions, &self.selector, pane, "stopped", defaults);
            }
        }
        changed
    }

    fn apply_action(
        &mut self,
        request: &WorkspaceActionRequest,
        sessions: &mut HashMap<String, SessionRecord>,
        defaults: &WorkspaceTerminalDefaults,
        closed_sessions: &mut Vec<String>,
    ) -> Result<(), String> {
        match request.action {
            WorkspaceAction::CreateTab => {
                self.create_tab(sessions, defaults, request.label.as_deref());
            }
            WorkspaceAction::CloseTab => {
                let tab_id = self.request_tab_id(request)?;
                self.close_tab(&tab_id, sessions, closed_sessions)?;
            }
            WorkspaceAction::RenameTab => {
                let tab_id = request
                    .tab_id
                    .as_deref()
                    .ok_or_else(|| "tab_id is required".to_owned())?;
                self.rename_tab(tab_id, request.label.as_deref())?;
            }
            WorkspaceAction::ActivateTab => {
                let tab_id = request
                    .tab_id
                    .as_deref()
                    .ok_or_else(|| "tab_id is required".to_owned())?;
                self.activate_tab(tab_id)?;
            }
            WorkspaceAction::SplitPane => {
                let tab_id = self.request_tab_id(request)?;
                let direction = request.direction.unwrap_or(SplitDirection::Down);
                self.split_pane(
                    &tab_id,
                    request.pane_id.as_deref(),
                    direction,
                    sessions,
                    defaults,
                )?;
            }
            WorkspaceAction::ClosePane => {
                let tab_id = self.request_tab_id(request)?;
                let pane_id = required_pane_id(request)?;
                self.close_pane(&tab_id, pane_id, sessions, closed_sessions)?;
            }
            WorkspaceAction::ActivatePane => {
                let tab_id = self.request_tab_id(request)?;
                let pane_id = required_pane_id(request)?;
                self.activate_pane(&tab_id, pane_id)?;
            }
            WorkspaceAction::PromotePaneToTab => {
                let tab_id = self.request_tab_id(request)?;
                let pane_id = required_pane_id(request)?;
                self.promote_pane_to_tab(&tab_id, pane_id)?;
            }
            WorkspaceAction::UpdateLayout => {
                let tab_id = self.request_tab_id(request)?;
                self.update_layout(
                    &tab_id,
                    request.layout.clone(),
                    request.active_pane_id.as_deref(),
                )?;
            }
            WorkspaceAction::SetTabPinned => {
                let tab_id = request
                    .tab_id
                    .as_deref()
                    .ok_or_else(|| "tab_id is required".to_owned())?;
                self.set_tab_pinned(
                    tab_id,
                    request.pinned.unwrap_or(false),
                    request.pinned_order,
                )?;
            }
        }
        self.repair();
        Ok(())
    }

    fn request_tab_id(&self, request: &WorkspaceActionRequest) -> Result<String, String> {
        request
            .tab_id
            .as_deref()
            .map(ToOwned::to_owned)
            .or_else(|| self.active_tab_id.clone())
            .ok_or_else(|| "tab_id is required".to_owned())
    }

    fn snapshot(&self, sessions: &HashMap<String, SessionRecord>) -> WorkspaceState {
        WorkspaceState {
            selector: self.selector.clone(),
            active_tab_id: self.active_tab_id.clone(),
            tabs: self
                .tabs
                .iter()
                .enumerate()
                .map(|(index, tab)| WorkspaceTabState {
                    id: tab.id.clone(),
                    label: tab
                        .custom_label
                        .clone()
                        .unwrap_or_else(|| (index + 1).to_string()),
                    custom_label: tab.custom_label.clone(),
                    pinned: self
                        .tab_metadata
                        .get(&tab.id)
                        .is_some_and(|metadata| metadata.pinned),
                    pinned_order: self
                        .tab_metadata
                        .get(&tab.id)
                        .and_then(|metadata| metadata.pinned.then_some(metadata.pinned_order))
                        .flatten(),
                    active_pane_id: tab.active_pane_id.clone(),
                    layout: tab.layout.clone(),
                    panes: tab
                        .panes
                        .iter()
                        .map(|pane| {
                            let session = sessions.get(&pane.session_id);
                            WorkspacePaneState {
                                id: pane.id.clone(),
                                session_id: pane.session_id.clone(),
                                status: session.map_or_else(
                                    || "stopped".to_owned(),
                                    |session| session.status.clone(),
                                ),
                                session_backend: session_backend_from_session(session),
                                herdr_output_sequence: None,
                                cols: session.map_or(pane.cols, |session| session.cols),
                                rows: session.map_or(pane.rows, |session| session.rows),
                            }
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    fn create_tab(
        &mut self,
        sessions: &mut HashMap<String, SessionRecord>,
        defaults: &WorkspaceTerminalDefaults,
        label: Option<&str>,
    ) -> SessionRecord {
        self.create_tab_with_metadata(sessions, defaults, HashMap::new(), label)
    }

    fn create_tab_with_metadata(
        &mut self,
        sessions: &mut HashMap<String, SessionRecord>,
        defaults: &WorkspaceTerminalDefaults,
        metadata: HashMap<String, String>,
        label: Option<&str>,
    ) -> SessionRecord {
        let tab_id = Self::next_tab_id();
        let pane = Self::new_pane(
            defaults.cols,
            defaults.rows,
            defaults.output_limit,
            defaults.auto_restart,
        );
        let record = session_record_with_metadata(
            &self.selector,
            &pane.session_id,
            defaults,
            "starting",
            metadata,
        );
        sessions.insert(pane.session_id.clone(), record.clone());
        let pane_id = pane.id.clone();
        let tab = WorkspaceTab {
            id: tab_id.clone(),
            custom_label: normalized_tab_label(label),
            active_pane_id: Some(pane_id.clone()),
            layout: Some(pane_layout_node(&pane_id)),
            panes: vec![pane],
        };
        self.tabs.push(tab);
        self.active_tab_id = Some(tab_id);
        record
    }

    fn close_tab(
        &mut self,
        tab_id: &str,
        sessions: &mut HashMap<String, SessionRecord>,
        closed_sessions: &mut Vec<String>,
    ) -> Result<(), String> {
        let (index, tab) = self
            .find_tab_index(tab_id)
            .ok_or_else(|| "tab not found".to_owned())?;
        for pane in &tab.panes {
            sessions.remove(&pane.session_id);
            closed_sessions.push(pane.session_id.clone());
        }
        self.tabs.remove(index);
        if self.active_tab_id.as_deref() == Some(tab_id) {
            self.active_tab_id = self
                .tabs
                .get(index)
                .or_else(|| index.checked_sub(1).and_then(|left| self.tabs.get(left)))
                .map(|tab| tab.id.clone());
        }
        Ok(())
    }

    fn rename_tab(&mut self, tab_id: &str, label: Option<&str>) -> Result<(), String> {
        let tab = self
            .find_tab_mut(tab_id)
            .ok_or_else(|| "tab not found".to_owned())?;
        tab.custom_label = normalized_tab_label(label);
        Ok(())
    }

    fn activate_tab(&mut self, tab_id: &str) -> Result<(), String> {
        if self.tabs.iter().any(|tab| tab.id == tab_id) {
            self.active_tab_id = Some(tab_id.to_owned());
            Ok(())
        } else {
            Err("tab not found".to_owned())
        }
    }

    fn split_pane(
        &mut self,
        tab_id: &str,
        pane_id: Option<&str>,
        direction: SplitDirection,
        sessions: &mut HashMap<String, SessionRecord>,
        defaults: &WorkspaceTerminalDefaults,
    ) -> Result<(), String> {
        let pane = Self::new_pane(
            defaults.cols,
            defaults.rows,
            defaults.output_limit,
            defaults.auto_restart,
        );
        sessions.insert(
            pane.session_id.clone(),
            session_record(&self.selector, &pane.session_id, "starting", defaults),
        );
        let tab = self
            .find_tab_mut(tab_id)
            .ok_or_else(|| "tab not found".to_owned())?;
        let reference_pane_id = pane_id.or(tab.active_pane_id.as_deref());
        let new_pane_id = pane.id.clone();
        tab.layout = Some(next_pane_layout(
            tab.layout.clone(),
            reference_pane_id,
            &new_pane_id,
            direction,
        ));
        tab.panes.push(pane);
        tab.active_pane_id = Some(new_pane_id);
        self.active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn close_pane(
        &mut self,
        tab_id: &str,
        pane_id: &str,
        sessions: &mut HashMap<String, SessionRecord>,
        closed_sessions: &mut Vec<String>,
    ) -> Result<(), String> {
        let tab_index = self
            .find_tab_index(tab_id)
            .map(|(index, _)| index)
            .ok_or_else(|| "tab not found".to_owned())?;
        if self.tabs[tab_index].panes.len() <= 1 {
            return self.close_tab(tab_id, sessions, closed_sessions);
        }
        let tab = &mut self.tabs[tab_index];
        let pane_index = tab
            .panes
            .iter()
            .position(|pane| pane.id == pane_id)
            .ok_or_else(|| "pane not found".to_owned())?;
        let removed = tab.panes.remove(pane_index);
        sessions.remove(&removed.session_id);
        closed_sessions.push(removed.session_id);
        tab.layout = remove_pane_from_layout(tab.layout.clone(), pane_id)
            .or_else(|| tab.panes.first().map(|pane| pane_layout_node(&pane.id)));
        if tab.active_pane_id.as_deref() == Some(pane_id) {
            tab.active_pane_id = tab
                .panes
                .get(pane_index)
                .or_else(|| {
                    pane_index
                        .checked_sub(1)
                        .and_then(|left| tab.panes.get(left))
                })
                .map(|pane| pane.id.clone());
        }
        self.active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn close_session_pane(
        &mut self,
        session_id: &str,
        sessions: &mut HashMap<String, SessionRecord>,
        closed_sessions: &mut Vec<String>,
    ) -> Result<(), String> {
        let Some((tab_id, pane_id)) = self.pane_for_session(session_id) else {
            return Err("session not found in workspace".to_owned());
        };
        self.close_pane(&tab_id, &pane_id, sessions, closed_sessions)
    }

    fn set_tab_pinned(
        &mut self,
        tab_id: &str,
        pinned: bool,
        requested_order: Option<u32>,
    ) -> Result<(), String> {
        let tab_id = tab_id.trim();
        if tab_id.is_empty() {
            return Err("tab_id is required".to_owned());
        }
        if pinned {
            let next_order = requested_order
                .or_else(|| {
                    self.tab_metadata
                        .get(tab_id)
                        .and_then(|metadata| metadata.pinned.then_some(metadata.pinned_order))
                        .flatten()
                })
                .unwrap_or_else(|| self.next_pinned_order());
            self.tab_metadata.insert(
                tab_id.to_owned(),
                WorkspaceTabMetadata {
                    pinned: true,
                    pinned_order: Some(next_order),
                },
            );
        } else {
            self.tab_metadata.remove(tab_id);
        }
        Ok(())
    }

    fn next_pinned_order(&self) -> u32 {
        self.tab_metadata
            .values()
            .filter(|metadata| metadata.pinned)
            .filter_map(|metadata| metadata.pinned_order)
            .max()
            .map_or(0, |order| order.saturating_add(1))
    }

    fn apply_tab_metadata(&self, workspace: &mut WorkspaceState) {
        for tab in &mut workspace.tabs {
            if let Some(metadata) = self.tab_metadata.get(&tab.id)
                && metadata.pinned
            {
                tab.pinned = true;
                tab.pinned_order = metadata.pinned_order;
                continue;
            }
            tab.pinned = false;
            tab.pinned_order = None;
        }
    }

    fn normalize_tab_metadata(&mut self, visible_tab_ids: Option<&[String]>) -> bool {
        let original = self.tab_metadata.clone();
        if let Some(ids) = visible_tab_ids {
            let visible = ids.iter().map(String::as_str).collect::<HashSet<_>>();
            self.tab_metadata
                .retain(|tab_id, _| visible.contains(tab_id.as_str()));
        }
        self.tab_metadata.retain(|_, metadata| metadata.pinned);
        let mut next_order = self.next_pinned_order();
        for metadata in self.tab_metadata.values_mut() {
            if metadata.pinned_order.is_none() {
                metadata.pinned_order = Some(next_order);
                next_order = next_order.saturating_add(1);
            }
        }
        self.tab_metadata != original
    }

    fn activate_pane(&mut self, tab_id: &str, pane_id: &str) -> Result<(), String> {
        let tab = self
            .find_tab_mut(tab_id)
            .ok_or_else(|| "tab not found".to_owned())?;
        if !tab.panes.iter().any(|pane| pane.id == pane_id) {
            return Err("pane not found".to_owned());
        }
        tab.active_pane_id = Some(pane_id.to_owned());
        self.active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn promote_pane_to_tab(&mut self, tab_id: &str, pane_id: &str) -> Result<(), String> {
        let source_index = self
            .find_tab_index(tab_id)
            .map(|(index, _)| index)
            .ok_or_else(|| "tab not found".to_owned())?;
        if self.tabs[source_index].panes.len() <= 1 {
            return Ok(());
        }
        let pane_index = self.tabs[source_index]
            .panes
            .iter()
            .position(|pane| pane.id == pane_id)
            .ok_or_else(|| "pane not found".to_owned())?;
        let pane = self.tabs[source_index].panes.remove(pane_index);
        let source_tab = &mut self.tabs[source_index];
        source_tab.layout =
            remove_pane_from_layout(source_tab.layout.clone(), pane_id).or_else(|| {
                source_tab
                    .panes
                    .first()
                    .map(|pane| pane_layout_node(&pane.id))
            });
        if source_tab.active_pane_id.as_deref() == Some(pane_id) {
            source_tab.active_pane_id = source_tab
                .panes
                .get(pane_index)
                .or_else(|| {
                    pane_index
                        .checked_sub(1)
                        .and_then(|left| source_tab.panes.get(left))
                })
                .map(|pane| pane.id.clone());
        }

        let tab_id = Self::next_tab_id();
        let pane_id = pane.id.clone();
        let promoted = WorkspaceTab {
            id: tab_id.clone(),
            custom_label: None,
            active_pane_id: Some(pane_id.clone()),
            layout: Some(pane_layout_node(&pane_id)),
            panes: vec![pane],
        };
        self.tabs.insert(source_index + 1, promoted);
        self.active_tab_id = Some(tab_id);
        Ok(())
    }

    fn update_layout(
        &mut self,
        tab_id: &str,
        layout: Option<WorkspaceLayoutNode>,
        active_pane_id: Option<&str>,
    ) -> Result<(), String> {
        let tab = self
            .find_tab_mut(tab_id)
            .ok_or_else(|| "tab not found".to_owned())?;
        if let Some(layout) = layout.as_ref() {
            let pane_ids = pane_ids_in_layout(layout);
            if pane_ids
                .iter()
                .any(|id| !tab.panes.iter().any(|pane| &pane.id == id))
            {
                return Err("layout references an unknown pane".to_owned());
            }
        }
        if let Some(active_pane_id) = active_pane_id {
            if !tab.panes.iter().any(|pane| pane.id == active_pane_id) {
                return Err("active pane not found".to_owned());
            }
            tab.active_pane_id = Some(active_pane_id.to_owned());
        }
        tab.layout = layout;
        self.active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn new_pane(cols: u16, rows: u16, _output_limit: usize, _auto_restart: bool) -> WorkspacePane {
        WorkspacePane {
            id: Self::next_pane_id(),
            session_id: Uuid::new_v4().to_string(),
            cols,
            rows,
        }
    }

    fn next_tab_id() -> String {
        Uuid::new_v4().to_string()
    }

    fn next_pane_id() -> String {
        Uuid::new_v4().to_string()
    }

    fn repair(&mut self) {
        let mut used_tab_ids = HashSet::new();
        let mut tab_id_map = HashMap::new();
        for tab in &mut self.tabs {
            normalize_uuid_id(&mut tab.id, &mut used_tab_ids, &mut tab_id_map);
        }
        if let Some(active_tab_id) = self.active_tab_id.as_mut()
            && let Some(next_id) = tab_id_map.get(active_tab_id)
        {
            *active_tab_id = next_id.clone();
        }
        self.tabs.retain(|tab| !tab.id.trim().is_empty());

        let mut used_pane_ids = HashSet::new();
        let mut used_session_ids = HashSet::new();
        for tab in &mut self.tabs {
            let mut pane_id_map = HashMap::new();
            tab.panes
                .retain(|pane| validate_size(pane.cols, pane.rows).is_ok());
            for pane in &mut tab.panes {
                normalize_uuid_id(&mut pane.id, &mut used_pane_ids, &mut pane_id_map);
                let mut session_id_map = HashMap::new();
                normalize_uuid_id(
                    &mut pane.session_id,
                    &mut used_session_ids,
                    &mut session_id_map,
                );
            }
            if let Some(active_pane_id) = tab.active_pane_id.as_mut()
                && let Some(next_id) = pane_id_map.get(active_pane_id)
            {
                *active_pane_id = next_id.clone();
            }
            if !pane_id_map.is_empty() {
                tab.layout = tab
                    .layout
                    .take()
                    .map(|layout| remap_layout_pane_ids(layout, &pane_id_map));
            }
            let pane_ids = tab
                .panes
                .iter()
                .map(|pane| pane.id.clone())
                .collect::<Vec<_>>();
            tab.layout = normalize_layout(tab.layout.clone(), &pane_ids)
                .or_else(|| pane_ids.first().map(|pane_id| pane_layout_node(pane_id)));
            if !tab
                .active_pane_id
                .as_deref()
                .is_some_and(|active| pane_ids.iter().any(|id| id == active))
            {
                tab.active_pane_id = pane_ids.first().cloned();
            }
        }
        self.tabs.retain(|tab| !tab.panes.is_empty());
        if !self
            .active_tab_id
            .as_deref()
            .is_some_and(|active| self.tabs.iter().any(|tab| tab.id == active))
        {
            self.active_tab_id = self.tabs.first().map(|tab| tab.id.clone());
        }
    }

    fn find_tab_mut(&mut self, tab_id: &str) -> Option<&mut WorkspaceTab> {
        self.tabs.iter_mut().find(|tab| tab.id == tab_id)
    }

    fn find_tab_index(&self, tab_id: &str) -> Option<(usize, WorkspaceTab)> {
        self.tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .map(|index| (index, self.tabs[index].clone()))
    }

    fn pane_for_session(&self, session_id: &str) -> Option<(String, String)> {
        self.tabs.iter().find_map(|tab| {
            tab.panes
                .iter()
                .find(|pane| pane.session_id == session_id)
                .map(|pane| (tab.id.clone(), pane.id.clone()))
        })
    }
}

fn normalized_tab_label(label: Option<&str>) -> Option<String> {
    let label = label.map(str::trim).unwrap_or_default();
    if label.is_empty() {
        None
    } else {
        Some(label.chars().take(128).collect())
    }
}

fn workspace_selector_for_session(
    workspaces: &HashMap<String, WorkspaceRecord>,
    session_id: &str,
) -> Option<String> {
    workspaces.iter().find_map(|(selector, workspace)| {
        workspace
            .pane_for_session(session_id)
            .is_some()
            .then_some(selector.clone())
    })
}

fn ensure_pane_session(
    sessions: &mut HashMap<String, SessionRecord>,
    selector: &str,
    pane: &WorkspacePane,
    status: &str,
    defaults: &WorkspaceTerminalDefaults,
) -> bool {
    if let Some(session) = sessions.get_mut(&pane.session_id) {
        return sync_session_login_user(session, &defaults.login_user);
    }
    sessions.insert(
        pane.session_id.clone(),
        session_record(selector, &pane.session_id, status, defaults),
    );
    true
}

fn session_record(
    selector: &str,
    session_id: &str,
    status: &str,
    defaults: &WorkspaceTerminalDefaults,
) -> SessionRecord {
    session_record_with_metadata(selector, session_id, defaults, status, HashMap::new())
}

fn session_backend_from_session(session: Option<&SessionRecord>) -> String {
    session
        .and_then(|session| session.metadata.get("sessionBackend"))
        .map(String::as_str)
        .filter(|backend| matches!(*backend, "webshell" | "herdr" | "zellij" | "ssh"))
        .unwrap_or("webshell")
        .to_owned()
}

fn session_record_with_metadata(
    selector: &str,
    session_id: &str,
    defaults: &WorkspaceTerminalDefaults,
    status: &str,
    extra_metadata: HashMap<String, String>,
) -> SessionRecord {
    let host = host_from_selector(selector);
    let mut metadata = extra_metadata;
    let login_user = defaults.login_user.trim();
    metadata.insert("host".to_owned(), host.clone());
    metadata.insert("restartable".to_owned(), defaults.auto_restart.to_string());
    if login_user.is_empty() {
        metadata.remove(METADATA_LOGIN_USER);
    } else {
        metadata.insert(METADATA_LOGIN_USER.to_owned(), login_user.to_owned());
    }
    metadata.insert(
        "sessionBackend".to_owned(),
        match defaults.session_backend {
            SessionBackend::Webshell => "webshell",
            SessionBackend::Herdr => "herdr",
            SessionBackend::Zellij => "zellij",
            SessionBackend::Ssh => "ssh",
        }
        .to_owned(),
    );
    metadata.insert(
        "outputBufferLimit".to_owned(),
        normalize_output_frame_limit(Some(defaults.output_limit)).to_string(),
    );
    if defaults.output_limit == DEFAULT_OUTPUT_FRAME_LIMIT {
        metadata.insert(
            "outputBufferLimit".to_owned(),
            output_frame_limit_from_metadata(&metadata).to_string(),
        );
    }
    SessionRecord {
        id: session_id.to_owned(),
        host,
        selector: selector.to_owned(),
        status: status.to_owned(),
        cols: defaults.cols,
        rows: defaults.rows,
        command: defaults.command.clone(),
        args: defaults.args.clone(),
        metadata,
    }
}

fn session_command_for_backend(
    state: &AppState,
    selector: &str,
    login_user: &str,
    backend: SessionBackend,
) -> Result<(String, Vec<String>), String> {
    match backend {
        SessionBackend::Webshell => Ok(default_session_command_for_user(selector, login_user)),
        SessionBackend::Herdr => Ok(session_command_for_backend_id(
            selector, login_user, "herdr",
        )),
        SessionBackend::Zellij => Ok(session_command_for_backend_id(
            selector, login_user, "zellij",
        )),
        SessionBackend::Ssh => {
            let profile =
                ssh_backend::load_enabled_profile(&state.database(), selector).map_err(|err| {
                    err.message
                        .unwrap_or_else(|| "SSH profile is unavailable".to_owned())
                })?;
            Ok(ssh_backend::terminal_command_for_profile(&profile))
        }
    }
}

fn next_pane_layout(
    layout: Option<WorkspaceLayoutNode>,
    reference_pane_id: Option<&str>,
    new_pane_id: &str,
    direction: SplitDirection,
) -> WorkspaceLayoutNode {
    let new_pane = pane_layout_node(new_pane_id);
    let Some(layout) = layout else {
        return new_pane;
    };
    let Some(reference_pane_id) = reference_pane_id else {
        return new_pane;
    };
    let axis = split_axis_for_direction(direction);
    let insert_before = matches!(direction, SplitDirection::Up | SplitDirection::Left);
    let (node, inserted) = insert_pane_into_layout(
        layout.clone(),
        reference_pane_id,
        &new_pane,
        axis,
        insert_before,
    );
    if inserted {
        return node;
    }
    WorkspaceLayoutNode::Split {
        axis,
        children: if insert_before {
            vec![new_pane, layout]
        } else {
            vec![layout, new_pane]
        },
    }
}

fn insert_pane_into_layout(
    node: WorkspaceLayoutNode,
    reference_pane_id: &str,
    new_pane: &WorkspaceLayoutNode,
    axis: SplitAxis,
    insert_before: bool,
) -> (WorkspaceLayoutNode, bool) {
    match node {
        WorkspaceLayoutNode::Pane { pane_id } => {
            if pane_id != reference_pane_id {
                return (WorkspaceLayoutNode::Pane { pane_id }, false);
            }
            let existing = WorkspaceLayoutNode::Pane { pane_id };
            (
                WorkspaceLayoutNode::Split {
                    axis,
                    children: if insert_before {
                        vec![new_pane.clone(), existing]
                    } else {
                        vec![existing, new_pane.clone()]
                    },
                },
                true,
            )
        }
        WorkspaceLayoutNode::Split {
            axis: existing_axis,
            children,
        } => {
            let mut inserted = false;
            let children = children
                .into_iter()
                .map(|child| {
                    if inserted {
                        return child;
                    }
                    let (child, child_inserted) = insert_pane_into_layout(
                        child,
                        reference_pane_id,
                        new_pane,
                        axis,
                        insert_before,
                    );
                    inserted = child_inserted;
                    child
                })
                .collect();
            (
                WorkspaceLayoutNode::Split {
                    axis: existing_axis,
                    children,
                },
                inserted,
            )
        }
    }
}

fn remove_pane_from_layout(
    node: Option<WorkspaceLayoutNode>,
    pane_id: &str,
) -> Option<WorkspaceLayoutNode> {
    match node? {
        WorkspaceLayoutNode::Pane { pane_id: current } => {
            if current == pane_id {
                None
            } else {
                Some(WorkspaceLayoutNode::Pane { pane_id: current })
            }
        }
        WorkspaceLayoutNode::Split { axis, children } => {
            let mut children = children
                .into_iter()
                .filter_map(|child| remove_pane_from_layout(Some(child), pane_id))
                .collect::<Vec<_>>();
            match children.len() {
                0 => None,
                1 => children.pop(),
                _ => Some(WorkspaceLayoutNode::Split { axis, children }),
            }
        }
    }
}

fn normalize_layout(
    node: Option<WorkspaceLayoutNode>,
    valid_pane_ids: &[String],
) -> Option<WorkspaceLayoutNode> {
    match node? {
        WorkspaceLayoutNode::Pane { pane_id } => valid_pane_ids
            .iter()
            .any(|id| id == &pane_id)
            .then_some(WorkspaceLayoutNode::Pane { pane_id }),
        WorkspaceLayoutNode::Split { axis, children } => {
            let mut children = children
                .into_iter()
                .filter_map(|child| normalize_layout(Some(child), valid_pane_ids))
                .collect::<Vec<_>>();
            match children.len() {
                0 => None,
                1 => children.pop(),
                _ => Some(WorkspaceLayoutNode::Split { axis, children }),
            }
        }
    }
}

fn pane_ids_in_layout(node: &WorkspaceLayoutNode) -> Vec<String> {
    match node {
        WorkspaceLayoutNode::Pane { pane_id } => vec![pane_id.clone()],
        WorkspaceLayoutNode::Split { children, .. } => {
            children.iter().flat_map(pane_ids_in_layout).collect()
        }
    }
}

fn pane_layout_node(pane_id: &str) -> WorkspaceLayoutNode {
    WorkspaceLayoutNode::Pane {
        pane_id: pane_id.to_owned(),
    }
}

fn split_axis_for_direction(direction: SplitDirection) -> SplitAxis {
    match direction {
        SplitDirection::Left | SplitDirection::Right => SplitAxis::Columns,
        SplitDirection::Up | SplitDirection::Down => SplitAxis::Rows,
    }
}

fn normalize_uuid_id(
    value: &mut String,
    used: &mut HashSet<String>,
    remapped: &mut HashMap<String, String>,
) {
    let original = value.trim().to_owned();
    let mut next = if Uuid::parse_str(&original).is_ok() {
        original.clone()
    } else {
        Uuid::new_v4().to_string()
    };
    while used.contains(&next) {
        next = Uuid::new_v4().to_string();
    }
    if !original.is_empty() && original != next {
        remapped.insert(original, next.clone());
    }
    value.clone_from(&next);
    used.insert(next);
}

fn remap_layout_pane_ids(
    node: WorkspaceLayoutNode,
    pane_id_map: &HashMap<String, String>,
) -> WorkspaceLayoutNode {
    match node {
        WorkspaceLayoutNode::Pane { pane_id } => WorkspaceLayoutNode::Pane {
            pane_id: pane_id_map.get(&pane_id).cloned().unwrap_or(pane_id),
        },
        WorkspaceLayoutNode::Split { axis, children } => WorkspaceLayoutNode::Split {
            axis,
            children: children
                .into_iter()
                .map(|child| remap_layout_pane_ids(child, pane_id_map))
                .collect(),
        },
    }
}

fn required_pane_id(request: &WorkspaceActionRequest) -> Result<&str, String> {
    request
        .pane_id
        .as_deref()
        .ok_or_else(|| "pane_id is required".to_owned())
}

fn request_size(cols: Option<u16>, rows: Option<u16>) -> Result<(u16, u16), (StatusCode, String)> {
    let cols = cols.unwrap_or(DEFAULT_COLS);
    let rows = rows.unwrap_or(DEFAULT_ROWS);
    if cols > MAX_COLS || rows > MAX_ROWS {
        return Err((
            StatusCode::BAD_REQUEST,
            "terminal size is too large".to_owned(),
        ));
    }
    validate_size(cols, rows)
        .map(|()| (cols, rows))
        .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))
}

async fn authorize_workspace_selector(
    state: &AppState,
    selector: &str,
    require_running: bool,
) -> Result<String, (StatusCode, String)> {
    if selector.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name is required".to_owned()));
    }
    validate_selector(selector).map_err(|err| {
        (
            StatusCode::BAD_REQUEST,
            err.message.unwrap_or_else(|| "invalid selector".to_owned()),
        )
    })?;
    if ssh_backend::is_ssh_selector(selector) {
        return ssh_backend::load_enabled_profile(&state.database(), selector)
            .map(|profile| profile.login_user())
            .map_err(|err| {
                (
                    StatusCode::FORBIDDEN,
                    err.message
                        .unwrap_or_else(|| "SSH profile is not available".to_owned()),
                )
            });
    }
    if !lightos_features_enabled() {
        return Err((
            StatusCode::NOT_FOUND,
            "LightOS integration is disabled".to_owned(),
        ));
    }
    lightos::login_user_for_selector(selector, require_running)
        .await
        .map_err(|err| {
            (
                StatusCode::FORBIDDEN,
                err.message
                    .unwrap_or_else(|| "workspace selector is not authorized".to_owned()),
            )
        })
}

pub fn default_workspace_store(database: Arc<AppDatabase>) -> WorkspaceStore {
    WorkspaceStore::new(database)
}

fn internal_error(message: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
}

fn bad_gateway(message: String) -> Response {
    (StatusCode::BAD_GATEWAY, message).into_response()
}

#[derive(Debug)]
enum WorkspaceActionError {
    BadRequest(String),
    Internal(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_split_and_rename_are_persisted() {
        let state = test_app_state();
        let mut sessions = HashMap::new();
        let mut workspace = WorkspaceRecord::new("demo@owner");
        let defaults = test_defaults(&state, "", SessionBackend::Webshell);
        assert!(workspace.ensure_ready(&mut sessions, &defaults));

        let active_tab = workspace.active_tab_id.clone().unwrap();
        let active_pane = workspace.tabs[0].active_pane_id.clone();
        assert!(Uuid::parse_str(&active_tab).is_ok());
        assert!(
            active_pane
                .as_deref()
                .is_some_and(|pane_id| Uuid::parse_str(pane_id).is_ok())
        );
        assert!(
            workspace.tabs[0]
                .panes
                .iter()
                .all(|pane| Uuid::parse_str(&pane.id).is_ok()
                    && Uuid::parse_str(&pane.session_id).is_ok())
        );
        let request = WorkspaceActionRequest {
            name: "demo@owner".to_owned(),
            action: WorkspaceAction::SplitPane,
            tab_id: Some(active_tab.clone()),
            pane_id: active_pane,
            direction: Some(SplitDirection::Right),
            label: None,
            layout: None,
            active_pane_id: None,
            cols: None,
            rows: None,
            output_limit: None,
            auto_restart: None,
            session_backend: None,
            pinned: None,
            pinned_order: None,
        };
        let defaults = test_defaults(&state, "admin", SessionBackend::Webshell);
        let mut closed_sessions = Vec::new();
        workspace
            .apply_action(&request, &mut sessions, &defaults, &mut closed_sessions)
            .unwrap();
        let request = WorkspaceActionRequest {
            action: WorkspaceAction::RenameTab,
            tab_id: Some(active_tab.clone()),
            label: Some("Build".to_owned()),
            ..request
        };
        workspace
            .apply_action(&request, &mut sessions, &defaults, &mut closed_sessions)
            .unwrap();

        assert_eq!(workspace.tabs[0].panes.len(), 2);
        assert!(
            workspace.tabs[0]
                .panes
                .iter()
                .all(|pane| Uuid::parse_str(&pane.id).is_ok()
                    && Uuid::parse_str(&pane.session_id).is_ok())
        );
        assert_eq!(workspace.tabs[0].custom_label.as_deref(), Some("Build"));
        assert_eq!(sessions.len(), 2);
        assert!(matches!(
            workspace.tabs[0].layout,
            Some(WorkspaceLayoutNode::Split {
                axis: SplitAxis::Columns,
                ..
            })
        ));
    }

    #[test]
    fn workspace_store_round_trips_state() {
        let database = test_database();
        let store = WorkspaceStore::new(Arc::clone(&database));
        let tab_id = Uuid::new_v4().to_string();
        let pane_id = Uuid::new_v4().to_string();
        let session_id = Uuid::new_v4().to_string();
        let workspaces = HashMap::from([(
            "demo@owner".to_owned(),
            WorkspaceRecord {
                selector: "demo@owner".to_owned(),
                active_tab_id: Some(tab_id.clone()),
                tab_metadata: HashMap::new(),
                tabs: vec![WorkspaceTab {
                    id: tab_id,
                    custom_label: Some("Build".to_owned()),
                    active_pane_id: Some(pane_id.clone()),
                    layout: Some(pane_layout_node(&pane_id)),
                    panes: vec![WorkspacePane {
                        id: pane_id,
                        session_id,
                        cols: DEFAULT_COLS,
                        rows: DEFAULT_ROWS,
                    }],
                }],
            },
        )]);

        store.save(&workspaces).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(
            loaded
                .get("demo@owner")
                .and_then(|workspace| workspace.tabs[0].custom_label.as_deref()),
            Some("Build")
        );
    }

    #[test]
    fn create_tab_action_on_empty_workspace_creates_one_tab() {
        let state = test_app_state();
        let defaults = test_defaults(&state, "", SessionBackend::Herdr);
        let request = WorkspaceActionRequest {
            name: "demo@owner".to_owned(),
            action: WorkspaceAction::CreateTab,
            tab_id: None,
            pane_id: None,
            direction: None,
            label: None,
            layout: None,
            active_pane_id: None,
            cols: None,
            rows: None,
            output_limit: None,
            auto_restart: None,
            session_backend: Some(SessionBackend::Herdr),
            pinned: None,
            pinned_order: None,
        };

        let (workspace, closed) =
            apply_workspace_action(&state, "demo@owner", &defaults, &request).unwrap();

        assert!(closed.is_empty());
        assert_eq!(workspace.tabs.len(), 1);
        assert_eq!(workspace.tabs[0].panes.len(), 1);
        assert_eq!(workspace.tabs[0].panes[0].session_backend, "herdr");
    }

    #[test]
    fn create_tab_action_applies_custom_label() {
        let state = test_app_state();
        let defaults = test_defaults(&state, "", SessionBackend::Webshell);
        let request = WorkspaceActionRequest {
            name: "demo@owner".to_owned(),
            action: WorkspaceAction::CreateTab,
            tab_id: None,
            pane_id: None,
            direction: None,
            label: Some("ssh DemoServerA".to_owned()),
            layout: None,
            active_pane_id: None,
            cols: None,
            rows: None,
            output_limit: None,
            auto_restart: None,
            session_backend: Some(SessionBackend::Webshell),
            pinned: None,
            pinned_order: None,
        };

        let (workspace, closed) =
            apply_workspace_action(&state, "demo@owner", &defaults, &request).unwrap();

        assert!(closed.is_empty());
        assert_eq!(workspace.tabs.len(), 1);
        assert_eq!(
            workspace.tabs[0].custom_label.as_deref(),
            Some("ssh DemoServerA")
        );
    }

    #[test]
    fn pinned_tab_order_is_not_reused_after_unpin() {
        let mut workspace = WorkspaceRecord::new("demo@owner");

        workspace.set_tab_pinned("tab-a", true, None).unwrap();
        workspace.set_tab_pinned("tab-b", true, None).unwrap();
        workspace.set_tab_pinned("tab-c", true, None).unwrap();
        workspace.set_tab_pinned("tab-b", false, None).unwrap();
        workspace.set_tab_pinned("tab-d", true, None).unwrap();

        assert_eq!(
            workspace
                .tab_metadata
                .get("tab-a")
                .and_then(|metadata| metadata.pinned_order),
            Some(0)
        );
        assert!(!workspace.tab_metadata.contains_key("tab-b"));
        assert_eq!(
            workspace
                .tab_metadata
                .get("tab-c")
                .and_then(|metadata| metadata.pinned_order),
            Some(2)
        );
        assert_eq!(
            workspace
                .tab_metadata
                .get("tab-d")
                .and_then(|metadata| metadata.pinned_order),
            Some(3)
        );
    }

    #[test]
    fn pinned_tab_order_can_swap_adjacent_tabs() {
        let mut workspace = WorkspaceRecord::new("demo@owner");

        workspace.set_tab_pinned("tab-a", true, None).unwrap();
        workspace.set_tab_pinned("tab-b", true, None).unwrap();
        let a_order = workspace
            .tab_metadata
            .get("tab-a")
            .and_then(|metadata| metadata.pinned_order)
            .unwrap();
        let b_order = workspace
            .tab_metadata
            .get("tab-b")
            .and_then(|metadata| metadata.pinned_order)
            .unwrap();

        workspace
            .set_tab_pinned("tab-b", true, Some(a_order))
            .unwrap();
        workspace
            .set_tab_pinned("tab-a", true, Some(b_order))
            .unwrap();

        assert_eq!(
            workspace
                .tab_metadata
                .get("tab-a")
                .and_then(|metadata| metadata.pinned_order),
            Some(b_order)
        );
        assert_eq!(
            workspace
                .tab_metadata
                .get("tab-b")
                .and_then(|metadata| metadata.pinned_order),
            Some(a_order)
        );
    }

    #[test]
    fn pinned_metadata_applies_to_agent_tabs_without_local_tab_records() {
        let state = test_app_state();
        {
            let mut workspaces = state.workspaces.write().unwrap();
            let workspace = workspaces
                .entry("demo@owner".to_owned())
                .or_insert_with(|| WorkspaceRecord::new("demo@owner"));
            workspace.set_tab_pinned("agent-tab", true, None).unwrap();
        }
        let mut workspace = WorkspaceState {
            selector: "demo@owner".to_owned(),
            active_tab_id: Some("agent-tab".to_owned()),
            tabs: vec![WorkspaceTabState {
                id: "agent-tab".to_owned(),
                label: "1".to_owned(),
                custom_label: None,
                pinned: false,
                pinned_order: None,
                active_pane_id: None,
                layout: None,
                panes: Vec::new(),
            }],
        };

        sync_workspace_tab_metadata(&state, &mut workspace);

        assert!(workspace.tabs[0].pinned);
        assert_eq!(workspace.tabs[0].pinned_order, Some(0));
    }

    #[test]
    fn merge_keeps_existing_herdr_tab_before_new_webshell_tab() {
        let state = test_app_state();
        let herdr_tab_id = {
            let mut sessions = state.sessions.write().unwrap();
            let mut workspaces = state.workspaces.write().unwrap();
            let defaults = test_defaults(&state, "", SessionBackend::Herdr);
            let workspace = workspaces
                .entry("demo@owner".to_owned())
                .or_insert_with(|| WorkspaceRecord::new("demo@owner"));
            workspace.create_tab(&mut sessions, &defaults, None);
            workspace.tabs[0].id.clone()
        };
        let agent_workspace = WorkspaceState {
            selector: "demo@owner".to_owned(),
            active_tab_id: Some("agent-tab".to_owned()),
            tabs: vec![WorkspaceTabState {
                id: "agent-tab".to_owned(),
                label: "2".to_owned(),
                custom_label: None,
                pinned: false,
                pinned_order: None,
                active_pane_id: Some("agent-pane".to_owned()),
                layout: Some(pane_layout_node("agent-pane")),
                panes: vec![WorkspacePaneState {
                    id: "agent-pane".to_owned(),
                    session_id: "agent-session".to_owned(),
                    status: "running".to_owned(),
                    session_backend: "webshell".to_owned(),
                    herdr_output_sequence: None,
                    cols: DEFAULT_COLS,
                    rows: DEFAULT_ROWS,
                }],
            }],
        };

        let merged = merge_optional_backend_tabs(&state, agent_workspace, false);
        let tab_ids = merged
            .tabs
            .iter()
            .map(|tab| tab.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(tab_ids, vec![herdr_tab_id.as_str(), "agent-tab"]);
    }

    #[test]
    fn workspace_session_api_creates_workspace_owned_session() {
        let state = test_app_state();
        let defaults = test_defaults_with_restart(&state, "admin", SessionBackend::Webshell, true);
        let created = create_workspace_session(
            &state,
            "demo@owner",
            &defaults,
            HashMap::from([("client".to_owned(), "connect".to_owned())]),
        )
        .unwrap();

        assert_eq!(created.session.status, "starting");
        assert_eq!(
            created.session.metadata.get("client").map(String::as_str),
            Some("connect")
        );
        assert_eq!(
            created
                .session
                .metadata
                .get("restartable")
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            created
                .session
                .metadata
                .get("loginUser")
                .map(String::as_str),
            Some("admin")
        );
        assert!(
            created
                .session
                .args
                .last()
                .is_some_and(|script| script.contains("setpriv --reuid \"$uid\""))
        );
        assert!(
            state
                .sessions
                .read()
                .unwrap()
                .get(&created.session.id)
                .is_some_and(|session| session.status == "starting")
        );
        assert!(
            state
                .workspaces
                .read()
                .unwrap()
                .get("demo@owner")
                .is_some_and(|workspace| workspace.tabs.len() == 1
                    && workspace.tabs[0].panes.len() == 1
                    && workspace.pane_for_session(&created.session.id).is_some())
        );
    }

    #[test]
    fn workspace_session_api_closes_owned_session_and_keeps_siblings() {
        let state = test_app_state();
        let defaults = test_defaults(&state, "", SessionBackend::Webshell);
        let first =
            create_workspace_session(&state, "demo@owner", &defaults, HashMap::new()).unwrap();
        let second =
            create_workspace_session(&state, "demo@owner", &defaults, HashMap::new()).unwrap();

        let closed = close_workspace_session(&state, &first.session.id).unwrap();

        assert_eq!(closed.status, "closed");
        assert_eq!(closed.closed_session_ids, vec![first.session.id.clone()]);
        let sessions = state.sessions.read().unwrap();
        assert!(!sessions.contains_key(&first.session.id));
        assert!(sessions.contains_key(&second.session.id));
        drop(sessions);
        let workspaces = state.workspaces.read().unwrap();
        let workspace = workspaces.get("demo@owner").unwrap();
        assert!(workspace.pane_for_session(&first.session.id).is_none());
        assert!(workspace.pane_for_session(&second.session.id).is_some());
    }

    #[test]
    fn workspace_session_api_closes_last_pane_as_last_tab() {
        let state = test_app_state();
        let defaults = test_defaults(&state, "", SessionBackend::Webshell);
        let created =
            create_workspace_session(&state, "demo@owner", &defaults, HashMap::new()).unwrap();

        close_workspace_session(&state, &created.session.id).unwrap();

        assert!(state.sessions.read().unwrap().is_empty());
        assert!(
            state
                .workspaces
                .read()
                .unwrap()
                .get("demo@owner")
                .is_some_and(
                    |workspace| workspace.tabs.is_empty() && workspace.active_tab_id.is_none()
                )
        );
    }

    fn test_app_state() -> AppState {
        let suffix = Uuid::new_v4();
        AppState::new_for_test(
            std::env::temp_dir().join(format!("lazycat-neko-webshell-workspace-test-{suffix}.db")),
        )
    }

    fn test_defaults(
        state: &AppState,
        login_user: &str,
        backend: SessionBackend,
    ) -> WorkspaceTerminalDefaults {
        test_defaults_with_restart(state, login_user, backend, false)
    }

    fn test_defaults_with_restart(
        state: &AppState,
        login_user: &str,
        backend: SessionBackend,
        restartable: bool,
    ) -> WorkspaceTerminalDefaults {
        WorkspaceTerminalDefaults::new(
            state,
            "demo@owner",
            DEFAULT_COLS,
            DEFAULT_ROWS,
            DEFAULT_OUTPUT_FRAME_LIMIT,
            restartable,
            login_user,
            backend,
        )
        .unwrap()
    }

    fn test_database() -> Arc<AppDatabase> {
        Arc::new(
            AppDatabase::open(std::env::temp_dir().join(format!(
                "lazycat-neko-webshell-workspace-store-{}.db",
                Uuid::new_v4()
            )))
            .unwrap(),
        )
    }
}
