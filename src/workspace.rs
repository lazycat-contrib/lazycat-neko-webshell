use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tracing::warn;
use uuid::Uuid;

use crate::config::{
    DEFAULT_COLS, DEFAULT_OUTPUT_FRAME_LIMIT, DEFAULT_ROWS, DEFAULT_WORKSPACE_STATE_FILE, MAX_COLS,
    MAX_ROWS,
};
use crate::lightos;
use crate::state::{
    AppState, SessionRecord, default_session_command, host_from_selector,
    output_frame_limit_from_metadata,
};
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceRecord {
    pub selector: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub tabs: Vec<WorkspaceTab>,
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
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceQuery {
    name: String,
    cols: Option<u16>,
    rows: Option<u16>,
    output_limit: Option<usize>,
    auto_restart: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceActionRequest {
    name: String,
    action: WorkspaceAction,
    tab_id: Option<String>,
    pane_id: Option<String>,
    direction: Option<SplitDirection>,
    label: Option<String>,
    layout: Option<WorkspaceLayoutNode>,
    active_pane_id: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    output_limit: Option<usize>,
    auto_restart: Option<bool>,
}

#[derive(Clone, Copy)]
struct WorkspaceTerminalDefaults {
    cols: u16,
    rows: u16,
    output_limit: usize,
    auto_restart: bool,
}

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
    path: PathBuf,
}

impl WorkspaceStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> io::Result<HashMap<String, WorkspaceRecord>> {
        match fs::read(&self.path) {
            Ok(bytes) => Self::decode(&bytes),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(err) => Err(err),
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
            return remove_workspace_file(&self.path);
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut workspaces = workspaces.values().cloned().collect::<Vec<_>>();
        workspaces.sort_by(|left, right| left.selector.cmp(&right.selector));
        let persisted = PersistedWorkspaceState {
            version: 1,
            workspaces,
        };
        let bytes = serde_json::to_vec_pretty(&persisted)
            .map_err(|err| io::Error::other(err.to_string()))?;
        let temp = temp_path_for(&self.path);
        fs::write(&temp, bytes)?;
        fs::rename(temp, &self.path)?;
        Ok(())
    }
}

pub async fn get_workspace(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    let selector = query.name.trim();
    if let Err(response) = authorize_workspace_selector(selector, true).await {
        return response.into_response();
    }
    let (cols, rows) = match request_size(query.cols, query.rows) {
        Ok(size) => size,
        Err(response) => return response.into_response(),
    };
    let output_limit = normalize_output_frame_limit(query.output_limit);
    let auto_restart = query.auto_restart.unwrap_or(false);

    match ensure_workspace_state(&state, selector, cols, rows, output_limit, auto_restart) {
        Ok(workspace) => Json(workspace).into_response(),
        Err(message) => internal_error(message),
    }
}

pub async fn put_workspace_action(
    State(state): State<Arc<AppState>>,
    Json(request): Json<WorkspaceActionRequest>,
) -> Response {
    let selector = request.name.trim().to_owned();
    if let Err(response) = authorize_workspace_selector(&selector, true).await {
        return response.into_response();
    }
    let (cols, rows) = match request_size(request.cols, request.rows) {
        Ok(size) => size,
        Err(response) => return response.into_response(),
    };
    let output_limit = normalize_output_frame_limit(request.output_limit);
    let auto_restart = request.auto_restart.unwrap_or(false);

    match apply_workspace_action(
        &state,
        &selector,
        cols,
        rows,
        output_limit,
        auto_restart,
        &request,
    ) {
        Ok((workspace, closed_sessions)) => {
            state
                .sessions
                .close_sessions(closed_sessions.iter().map(String::as_str));
            Json(workspace).into_response()
        }
        Err(WorkspaceActionError::BadRequest(message)) => {
            (StatusCode::BAD_REQUEST, message).into_response()
        }
        Err(WorkspaceActionError::Internal(message)) => internal_error(message),
    }
}

fn ensure_workspace_state(
    state: &AppState,
    selector: &str,
    cols: u16,
    rows: u16,
    output_limit: usize,
    auto_restart: bool,
) -> Result<WorkspaceState, String> {
    let mut persist_workspaces = None;
    let mut persist_sessions = None;
    let workspace = {
        let mut workspaces = state
            .workspaces
            .write()
            .map_err(|_| "workspace store lock poisoned".to_owned())?;
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| "session store lock poisoned".to_owned())?;
        let workspace = workspaces
            .entry(selector.to_owned())
            .or_insert_with(|| WorkspaceRecord::new(selector));
        let changed = workspace.ensure_ready(&mut sessions, cols, rows, output_limit, auto_restart);
        let snapshot = workspace.snapshot(&sessions);
        if changed {
            persist_workspaces = Some(workspaces.clone());
            persist_sessions = Some(sessions.clone());
        }
        snapshot
    };
    persist_snapshots(state, persist_workspaces, persist_sessions)?;
    Ok(workspace)
}

pub fn create_workspace_session(
    state: &AppState,
    selector: &str,
    cols: u16,
    rows: u16,
    output_limit: usize,
    auto_restart: bool,
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
        let session = workspace.create_tab_with_metadata(
            &mut sessions,
            cols,
            rows,
            output_limit,
            auto_restart,
            metadata,
        );
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
    cols: u16,
    rows: u16,
    output_limit: usize,
    auto_restart: bool,
    request: &WorkspaceActionRequest,
) -> Result<(WorkspaceState, Vec<String>), WorkspaceActionError> {
    let defaults = WorkspaceTerminalDefaults {
        cols,
        rows,
        output_limit,
        auto_restart,
    };
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
        workspace.ensure_ready(&mut sessions, cols, rows, output_limit, auto_restart);
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
        }
    }

    fn ensure_ready(
        &mut self,
        sessions: &mut HashMap<String, SessionRecord>,
        cols: u16,
        rows: u16,
        output_limit: usize,
        auto_restart: bool,
    ) -> bool {
        self.repair();
        let mut changed = false;
        if self.tabs.is_empty() {
            self.create_tab(sessions, cols, rows, output_limit, auto_restart);
            changed = true;
        }
        for tab in &mut self.tabs {
            for pane in &mut tab.panes {
                changed |= ensure_pane_session(
                    sessions,
                    &self.selector,
                    pane,
                    "stopped",
                    output_limit,
                    auto_restart,
                );
            }
        }
        changed
    }

    fn apply_action(
        &mut self,
        request: &WorkspaceActionRequest,
        sessions: &mut HashMap<String, SessionRecord>,
        defaults: WorkspaceTerminalDefaults,
        closed_sessions: &mut Vec<String>,
    ) -> Result<(), String> {
        match request.action {
            WorkspaceAction::CreateTab => {
                self.create_tab(
                    sessions,
                    defaults.cols,
                    defaults.rows,
                    defaults.output_limit,
                    defaults.auto_restart,
                );
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
        cols: u16,
        rows: u16,
        output_limit: usize,
        auto_restart: bool,
    ) -> SessionRecord {
        self.create_tab_with_metadata(
            sessions,
            cols,
            rows,
            output_limit,
            auto_restart,
            HashMap::new(),
        )
    }

    fn create_tab_with_metadata(
        &mut self,
        sessions: &mut HashMap<String, SessionRecord>,
        cols: u16,
        rows: u16,
        output_limit: usize,
        auto_restart: bool,
        metadata: HashMap<String, String>,
    ) -> SessionRecord {
        let tab_id = Self::next_tab_id();
        let pane = Self::new_pane(cols, rows, output_limit, auto_restart);
        let record = session_record_with_metadata(
            &self.selector,
            &pane.session_id,
            WorkspaceTerminalDefaults {
                cols: pane.cols,
                rows: pane.rows,
                output_limit,
                auto_restart,
            },
            "starting",
            metadata,
        );
        sessions.insert(pane.session_id.clone(), record.clone());
        let pane_id = pane.id.clone();
        let tab = WorkspaceTab {
            id: tab_id.clone(),
            custom_label: None,
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
        let label = label.map(str::trim).unwrap_or_default();
        tab.custom_label = if label.is_empty() {
            None
        } else {
            Some(label.chars().take(128).collect())
        };
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
        defaults: WorkspaceTerminalDefaults,
    ) -> Result<(), String> {
        let pane = Self::new_pane(
            defaults.cols,
            defaults.rows,
            defaults.output_limit,
            defaults.auto_restart,
        );
        sessions.insert(
            pane.session_id.clone(),
            session_record(
                &self.selector,
                &pane.session_id,
                pane.cols,
                pane.rows,
                "starting",
                defaults.output_limit,
                defaults.auto_restart,
            ),
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
    output_limit: usize,
    auto_restart: bool,
) -> bool {
    if sessions.contains_key(&pane.session_id) {
        return false;
    }
    sessions.insert(
        pane.session_id.clone(),
        session_record(
            selector,
            &pane.session_id,
            pane.cols,
            pane.rows,
            status,
            output_limit,
            auto_restart,
        ),
    );
    true
}

fn session_record(
    selector: &str,
    session_id: &str,
    cols: u16,
    rows: u16,
    status: &str,
    output_limit: usize,
    auto_restart: bool,
) -> SessionRecord {
    session_record_with_metadata(
        selector,
        session_id,
        WorkspaceTerminalDefaults {
            cols,
            rows,
            output_limit,
            auto_restart,
        },
        status,
        HashMap::new(),
    )
}

fn session_record_with_metadata(
    selector: &str,
    session_id: &str,
    defaults: WorkspaceTerminalDefaults,
    status: &str,
    extra_metadata: HashMap<String, String>,
) -> SessionRecord {
    let host = host_from_selector(selector);
    let (command, args) = default_session_command(selector);
    let mut metadata = extra_metadata;
    metadata.insert("host".to_owned(), host.clone());
    metadata.insert("restartable".to_owned(), defaults.auto_restart.to_string());
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
        command,
        args,
        control: None,
        metadata,
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
    selector: &str,
    require_running: bool,
) -> Result<(), (StatusCode, String)> {
    if selector.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name is required".to_owned()));
    }
    validate_selector(selector).map_err(|err| {
        (
            StatusCode::BAD_REQUEST,
            err.message.unwrap_or_else(|| "invalid selector".to_owned()),
        )
    })?;
    lightos::authorize_selector(selector, require_running)
        .await
        .map_err(|err| {
            (
                StatusCode::FORBIDDEN,
                err.message
                    .unwrap_or_else(|| "workspace selector is not authorized".to_owned()),
            )
        })
}

fn workspace_state_path() -> PathBuf {
    std::env::var_os("PURE_TERMINAL_WORKSPACE_STATE_FILE").map_or_else(
        || PathBuf::from(DEFAULT_WORKSPACE_STATE_FILE),
        PathBuf::from,
    )
}

pub fn default_workspace_store() -> WorkspaceStore {
    WorkspaceStore::new(workspace_state_path())
}

fn remove_workspace_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn temp_path_for(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspaces.json");
    path.with_file_name(format!("{filename}.tmp"))
}

fn internal_error(message: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
}

enum WorkspaceActionError {
    BadRequest(String),
    Internal(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_split_and_rename_are_persisted() {
        let mut sessions = HashMap::new();
        let mut workspace = WorkspaceRecord::new("demo@owner");
        assert!(workspace.ensure_ready(
            &mut sessions,
            DEFAULT_COLS,
            DEFAULT_ROWS,
            DEFAULT_OUTPUT_FRAME_LIMIT,
            false,
        ));

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
        };
        let defaults = WorkspaceTerminalDefaults {
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            output_limit: DEFAULT_OUTPUT_FRAME_LIMIT,
            auto_restart: false,
        };
        let mut closed_sessions = Vec::new();
        workspace
            .apply_action(&request, &mut sessions, defaults, &mut closed_sessions)
            .unwrap();
        let request = WorkspaceActionRequest {
            action: WorkspaceAction::RenameTab,
            tab_id: Some(active_tab.clone()),
            label: Some("Build".to_owned()),
            ..request
        };
        workspace
            .apply_action(&request, &mut sessions, defaults, &mut closed_sessions)
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
        let path = std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-workspaces-{}.json",
            Uuid::new_v4()
        ));
        let store = WorkspaceStore::new(path.clone());
        let tab_id = Uuid::new_v4().to_string();
        let pane_id = Uuid::new_v4().to_string();
        let session_id = Uuid::new_v4().to_string();
        let workspaces = HashMap::from([(
            "demo@owner".to_owned(),
            WorkspaceRecord {
                selector: "demo@owner".to_owned(),
                active_tab_id: Some(tab_id.clone()),
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

        let _ = fs::remove_file(path);
    }

    #[test]
    fn workspace_session_api_creates_workspace_owned_session() {
        let state = test_app_state();
        let created = create_workspace_session(
            &state,
            "demo@owner",
            DEFAULT_COLS,
            DEFAULT_ROWS,
            DEFAULT_OUTPUT_FRAME_LIMIT,
            true,
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
        let first = create_workspace_session(
            &state,
            "demo@owner",
            DEFAULT_COLS,
            DEFAULT_ROWS,
            DEFAULT_OUTPUT_FRAME_LIMIT,
            false,
            HashMap::new(),
        )
        .unwrap();
        let second = create_workspace_session(
            &state,
            "demo@owner",
            DEFAULT_COLS,
            DEFAULT_ROWS,
            DEFAULT_OUTPUT_FRAME_LIMIT,
            false,
            HashMap::new(),
        )
        .unwrap();

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
        let created = create_workspace_session(
            &state,
            "demo@owner",
            DEFAULT_COLS,
            DEFAULT_ROWS,
            DEFAULT_OUTPUT_FRAME_LIMIT,
            false,
            HashMap::new(),
        )
        .unwrap();

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
            std::env::temp_dir().join(format!("lazycat-neko-webshell-session-test-{suffix}.json")),
            std::env::temp_dir().join(format!(
                "lazycat-neko-webshell-workspace-test-{suffix}.json"
            )),
            std::env::temp_dir().join(format!("lazycat-neko-webshell-output-test-{suffix}")),
        )
    }
}
