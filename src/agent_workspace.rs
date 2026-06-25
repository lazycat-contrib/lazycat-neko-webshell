use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::thread;

use anyhow::{anyhow, bail};
use buffa::MessageField;
use uuid::Uuid;

use crate::agent_history::{AgentHistory, AgentHistoryFrame};
use crate::agent_pty::{AgentPty, AgentPtyEvent, AgentPtyExit};
use crate::config::{DEFAULT_COLS, DEFAULT_ROWS};
use crate::proto::lazycat::webshell::v1::{
    AgentLayoutNode, AgentLayoutNodeType, AgentPaneState, AgentSplitAxis, AgentSplitDirection,
    AgentTabState, AgentWorkspaceAction, AgentWorkspaceActionType, AgentWorkspaceState,
};
use crate::validation::{normalize_output_frame_limit, validate_size};

#[derive(Clone, Debug)]
pub enum AgentPaneEvent {
    Output(AgentHistoryFrame),
    Exit(AgentPtyExit),
    Error(String),
}

pub struct AgentPane {
    id: String,
    session_id: String,
    selector: String,
    cols: Mutex<u16>,
    rows: Mutex<u16>,
    status: Mutex<String>,
    pty: AgentPty,
    history: Mutex<AgentHistory>,
    history_recording: AtomicBool,
    subscribers: Mutex<Vec<mpsc::Sender<AgentPaneEvent>>>,
}

pub struct AgentWorkspace {
    inner: Mutex<AgentWorkspaceInner>,
}

struct AgentWorkspaceInner {
    selector: String,
    username: String,
    tabs: Vec<AgentTab>,
    panes: HashMap<String, Arc<AgentPane>>,
    active_tab_id: Option<String>,
    next_tab_id: u64,
    next_pane_id: u64,
}

#[derive(Clone, Debug)]
struct AgentTab {
    id: String,
    custom_label: Option<String>,
    active_pane_id: Option<String>,
    layout: Option<AgentLayoutNode>,
    pane_ids: Vec<String>,
}

impl AgentPane {
    fn spawn(
        id: String,
        selector: String,
        username: &str,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<Arc<Self>> {
        let (event_tx, event_rx) = mpsc::channel::<AgentPtyEvent>();
        let pty = AgentPty::spawn(&id, username, cols, rows, event_tx)?;
        let pane = Arc::new(Self {
            id,
            session_id: Uuid::new_v4().to_string(),
            selector,
            cols: Mutex::new(cols),
            rows: Mutex::new(rows),
            status: Mutex::new("running".to_owned()),
            pty,
            history: Mutex::new(AgentHistory::new(output_limit)),
            history_recording: AtomicBool::new(true),
            subscribers: Mutex::new(Vec::new()),
        });
        spawn_pane_event_dispatcher(Arc::downgrade(&pane), event_rx);
        Ok(pane)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn selector(&self) -> &str {
        &self.selector
    }

    pub fn write_input(&self, data: Vec<u8>) -> anyhow::Result<()> {
        self.pty.write_input(data)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        validate_size(cols, rows)?;
        self.pty.resize(cols, rows)?;
        if let Ok(mut current_cols) = self.cols.lock() {
            *current_cols = cols;
        }
        if let Ok(mut current_rows) = self.rows.lock() {
            *current_rows = rows;
        }
        Ok(())
    }

    pub fn set_output_limit(&self, output_limit: usize) {
        if let Ok(mut history) = self.history.lock() {
            history.set_limit(output_limit);
        }
    }

    pub fn set_history_recording(&self, enabled: bool) {
        self.history_recording.store(enabled, Ordering::Relaxed);
    }

    pub fn snapshot_after(&self, sequence: u64) -> (Vec<AgentHistoryFrame>, u64) {
        self.history
            .lock()
            .expect("agent pane history lock poisoned")
            .snapshot_after(sequence)
    }

    pub fn subscribe(&self) -> mpsc::Receiver<AgentPaneEvent> {
        let (tx, rx) = mpsc::channel();
        self.subscribers
            .lock()
            .expect("agent pane subscriber lock poisoned")
            .push(tx);
        rx
    }

    pub fn state(&self) -> AgentPaneState {
        AgentPaneState {
            id: Some(self.id.clone()),
            session_id: Some(self.session_id.clone()),
            status: Some(self.status()),
            session_backend: Some("webshell".to_owned()),
            cols: Some(i32::from(self.cols())),
            rows: Some(i32::from(self.rows())),
            ..Default::default()
        }
    }

    fn status(&self) -> String {
        self.status
            .lock()
            .map_or_else(|_| "stopped".to_owned(), |status| status.clone())
    }

    fn cols(&self) -> u16 {
        self.cols.lock().map_or(DEFAULT_COLS, |cols| *cols)
    }

    fn rows(&self) -> u16 {
        self.rows.lock().map_or(DEFAULT_ROWS, |rows| *rows)
    }

    fn close(&self) {
        self.pty.close();
        if let Ok(mut status) = self.status.lock() {
            *status = "closed".to_owned();
        }
    }

    fn push_output(&self, data: Vec<u8>) {
        let record = self.history_recording.load(Ordering::Relaxed);
        let frame = self
            .history
            .lock()
            .expect("agent pane history lock poisoned")
            .push_recorded(data, record);
        self.broadcast(AgentPaneEvent::Output(frame));
    }

    fn mark_exit(&self, exit: AgentPtyExit) {
        if let Ok(mut status) = self.status.lock() {
            *status = "exited".to_owned();
        }
        self.broadcast(AgentPaneEvent::Exit(exit));
    }

    fn broadcast(&self, event: AgentPaneEvent) {
        let mut subscribers = self
            .subscribers
            .lock()
            .expect("agent pane subscriber lock poisoned");
        subscribers.retain(|subscriber| subscriber.send(event.clone()).is_ok());
    }
}

impl AgentWorkspace {
    pub fn new(selector: impl Into<String>, username: impl Into<String>) -> Self {
        Self {
            inner: Mutex::new(AgentWorkspaceInner {
                selector: selector.into(),
                username: username.into(),
                tabs: Vec::new(),
                panes: HashMap::new(),
                active_tab_id: None,
                next_tab_id: 1,
                next_pane_id: 1,
            }),
        }
    }

    pub fn ensure_state(
        &self,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<AgentWorkspaceState> {
        let mut inner = self.lock_inner()?;
        inner.ensure_ready(cols, rows, output_limit)?;
        Ok(inner.snapshot())
    }

    pub fn snapshot_state(
        &self,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<AgentWorkspaceState> {
        let mut inner = self.lock_inner()?;
        inner.update_existing_panes(cols, rows, output_limit)?;
        Ok(inner.snapshot())
    }

    pub fn apply_action(
        &self,
        action: &AgentWorkspaceAction,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<AgentWorkspaceState> {
        let mut inner = self.lock_inner()?;
        let action_kind = action_kind(action)?;
        if matches!(
            action_kind,
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CREATE_TAB
        ) {
            inner.update_existing_panes(cols, rows, output_limit)?;
        } else {
            inner.ensure_ready(cols, rows, output_limit)?;
        }
        inner.apply_action(action, cols, rows, output_limit)?;
        Ok(inner.snapshot())
    }

    pub fn close_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<AgentWorkspaceState> {
        let mut inner = self.lock_inner()?;
        inner.update_existing_panes(cols, rows, output_limit)?;
        inner.close_session(session_id)?;
        inner.repair();
        Ok(inner.snapshot())
    }

    pub fn pane(&self, pane_id: &str) -> anyhow::Result<Arc<AgentPane>> {
        let inner = self.lock_inner()?;
        inner
            .panes
            .get(pane_id)
            .cloned()
            .ok_or_else(|| anyhow!("pane not found"))
    }

    pub fn active_pane(&self) -> anyhow::Result<Arc<AgentPane>> {
        let inner = self.lock_inner()?;
        let active_tab_id = inner
            .active_tab_id
            .as_deref()
            .ok_or_else(|| anyhow!("workspace has no active tab"))?;
        let tab = inner
            .tabs
            .iter()
            .find(|tab| tab.id == active_tab_id)
            .ok_or_else(|| anyhow!("active tab not found"))?;
        let pane_id = tab
            .active_pane_id
            .as_deref()
            .or_else(|| tab.pane_ids.first().map(String::as_str))
            .ok_or_else(|| anyhow!("active tab has no pane"))?;
        inner
            .panes
            .get(pane_id)
            .cloned()
            .ok_or_else(|| anyhow!("active pane not found"))
    }

    fn lock_inner(&self) -> anyhow::Result<std::sync::MutexGuard<'_, AgentWorkspaceInner>> {
        self.inner
            .lock()
            .map_err(|_| anyhow!("agent workspace lock poisoned"))
    }
}

impl AgentWorkspaceInner {
    fn ensure_ready(&mut self, cols: u16, rows: u16, output_limit: usize) -> anyhow::Result<()> {
        self.update_existing_panes(cols, rows, output_limit)?;
        if self.tabs.is_empty() {
            self.create_tab(cols, rows, output_limit)?;
        }
        Ok(())
    }

    fn update_existing_panes(
        &mut self,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<()> {
        validate_size(cols, rows)?;
        let output_limit = normalize_output_frame_limit(Some(output_limit));
        for pane in self.panes.values() {
            pane.set_output_limit(output_limit);
        }
        Ok(())
    }

    fn apply_action(
        &mut self,
        action: &AgentWorkspaceAction,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<()> {
        match action_kind(action)? {
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CREATE_TAB => {
                self.create_tab(cols, rows, output_limit)?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CLOSE_TAB => {
                let tab_id = self.request_tab_id(action)?;
                self.close_tab(&tab_id)?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_RENAME_TAB => {
                let tab_id = required_string(action.tab_id.as_deref(), "tab_id")?;
                self.rename_tab(tab_id, action.label.as_deref())?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_ACTIVATE_TAB => {
                let tab_id = required_string(action.tab_id.as_deref(), "tab_id")?;
                self.activate_tab(tab_id)?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_SPLIT_PANE => {
                let tab_id = self.request_tab_id(action)?;
                let direction = action
                    .direction
                    .as_ref()
                    .and_then(|direction| direction.as_known())
                    .unwrap_or(AgentSplitDirection::AGENT_SPLIT_DIRECTION_DOWN);
                self.split_pane(
                    &tab_id,
                    action.pane_id.as_deref(),
                    direction,
                    cols,
                    rows,
                    output_limit,
                )?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CLOSE_PANE => {
                let tab_id = self.request_tab_id(action)?;
                let pane_id = required_string(action.pane_id.as_deref(), "pane_id")?;
                self.close_pane(&tab_id, pane_id)?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_ACTIVATE_PANE => {
                let tab_id = self.request_tab_id(action)?;
                let pane_id = required_string(action.pane_id.as_deref(), "pane_id")?;
                self.activate_pane(&tab_id, pane_id)?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_PROMOTE_PANE_TO_TAB => {
                let tab_id = self.request_tab_id(action)?;
                let pane_id = required_string(action.pane_id.as_deref(), "pane_id")?;
                self.promote_pane_to_tab(&tab_id, pane_id)?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_UPDATE_LAYOUT => {
                let tab_id = self.request_tab_id(action)?;
                let layout = action.layout.as_option().cloned();
                self.update_layout(&tab_id, layout, action.active_pane_id.as_deref())?;
            }
            AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_UNSPECIFIED => {
                bail!("workspace action is required");
            }
        }
        self.repair();
        Ok(())
    }

    fn snapshot(&self) -> AgentWorkspaceState {
        AgentWorkspaceState {
            selector: Some(self.selector.clone()),
            active_tab_id: self.active_tab_id.clone(),
            tabs: self
                .tabs
                .iter()
                .enumerate()
                .map(|(index, tab)| AgentTabState {
                    id: Some(tab.id.clone()),
                    label: Some(
                        tab.custom_label
                            .clone()
                            .unwrap_or_else(|| (index + 1).to_string()),
                    ),
                    custom_label: tab.custom_label.clone(),
                    active_pane_id: tab.active_pane_id.clone(),
                    layout: tab
                        .layout
                        .clone()
                        .map_or_else(MessageField::none, MessageField::some),
                    panes: tab
                        .pane_ids
                        .iter()
                        .filter_map(|pane_id| self.panes.get(pane_id))
                        .map(|pane| pane.state())
                        .collect(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    fn create_tab(&mut self, cols: u16, rows: u16, output_limit: usize) -> anyhow::Result<()> {
        let tab_id = self.next_tab_id();
        let pane = self.create_pane(cols, rows, output_limit)?;
        let pane_id = pane.id().to_owned();
        let tab = AgentTab {
            id: tab_id.clone(),
            custom_label: None,
            active_pane_id: Some(pane_id.clone()),
            layout: Some(pane_layout_node(&pane_id)),
            pane_ids: vec![pane_id],
        };
        self.tabs.push(tab);
        self.active_tab_id = Some(tab_id);
        Ok(())
    }

    fn create_pane(
        &mut self,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<Arc<AgentPane>> {
        let pane_id = self.next_pane_id();
        let pane = AgentPane::spawn(
            pane_id.clone(),
            self.selector.clone(),
            &self.username,
            cols,
            rows,
            output_limit,
        )?;
        self.panes.insert(pane_id, Arc::clone(&pane));
        Ok(pane)
    }

    fn close_tab(&mut self, tab_id: &str) -> anyhow::Result<()> {
        let index = self
            .tab_index(tab_id)
            .ok_or_else(|| anyhow!("tab not found"))?;
        let tab = self.tabs.remove(index);
        for pane_id in tab.pane_ids {
            if let Some(pane) = self.panes.remove(&pane_id) {
                pane.close();
            }
        }
        if self.active_tab_id.as_deref() == Some(tab_id) {
            self.active_tab_id = self
                .tabs
                .get(index)
                .or_else(|| index.checked_sub(1).and_then(|left| self.tabs.get(left)))
                .map(|tab| tab.id.clone());
        }
        Ok(())
    }

    fn rename_tab(&mut self, tab_id: &str, label: Option<&str>) -> anyhow::Result<()> {
        let tab = self
            .tab_mut(tab_id)
            .ok_or_else(|| anyhow!("tab not found"))?;
        let label = label.map(str::trim).unwrap_or_default();
        tab.custom_label = if label.is_empty() {
            None
        } else {
            Some(label.chars().take(128).collect())
        };
        Ok(())
    }

    fn activate_tab(&mut self, tab_id: &str) -> anyhow::Result<()> {
        if self.tabs.iter().any(|tab| tab.id == tab_id) {
            self.active_tab_id = Some(tab_id.to_owned());
            Ok(())
        } else {
            bail!("tab not found")
        }
    }

    fn split_pane(
        &mut self,
        tab_id: &str,
        pane_id: Option<&str>,
        direction: AgentSplitDirection,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<()> {
        let pane = self.create_pane(cols, rows, output_limit)?;
        let new_pane_id = pane.id().to_owned();
        let tab = self
            .tab_mut(tab_id)
            .ok_or_else(|| anyhow!("tab not found"))?;
        let reference_pane_id = pane_id.or(tab.active_pane_id.as_deref());
        tab.layout = Some(next_pane_layout(
            tab.layout.clone(),
            reference_pane_id,
            &new_pane_id,
            direction,
        ));
        tab.pane_ids.push(new_pane_id.clone());
        tab.active_pane_id = Some(new_pane_id);
        self.active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn close_pane(&mut self, tab_id: &str, pane_id: &str) -> anyhow::Result<()> {
        let tab_index = self
            .tab_index(tab_id)
            .ok_or_else(|| anyhow!("tab not found"))?;
        if self.tabs[tab_index].pane_ids.len() <= 1 {
            return self.close_tab(tab_id);
        }

        let tab = &mut self.tabs[tab_index];
        let pane_index = tab
            .pane_ids
            .iter()
            .position(|id| id == pane_id)
            .ok_or_else(|| anyhow!("pane not found"))?;
        tab.pane_ids.remove(pane_index);
        if let Some(pane) = self.panes.remove(pane_id) {
            pane.close();
        }
        tab.layout = remove_pane_from_layout(tab.layout.clone(), pane_id)
            .or_else(|| tab.pane_ids.first().map(|id| pane_layout_node(id)));
        if tab.active_pane_id.as_deref() == Some(pane_id) {
            tab.active_pane_id = tab
                .pane_ids
                .get(pane_index)
                .or_else(|| {
                    pane_index
                        .checked_sub(1)
                        .and_then(|left| tab.pane_ids.get(left))
                })
                .cloned();
        }
        self.active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn close_session(&mut self, session_id: &str) -> anyhow::Result<()> {
        let session_id = required_string(Some(session_id), "session_id")?;
        let Some((tab_id, pane_id)) = self.pane_for_session(session_id) else {
            bail!("session not found")
        };
        self.close_pane(&tab_id, &pane_id)
    }

    fn activate_pane(&mut self, tab_id: &str, pane_id: &str) -> anyhow::Result<()> {
        let tab = self
            .tab_mut(tab_id)
            .ok_or_else(|| anyhow!("tab not found"))?;
        if !tab.pane_ids.iter().any(|id| id == pane_id) {
            bail!("pane not found");
        }
        tab.active_pane_id = Some(pane_id.to_owned());
        self.active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn promote_pane_to_tab(&mut self, tab_id: &str, pane_id: &str) -> anyhow::Result<()> {
        let source_index = self
            .tab_index(tab_id)
            .ok_or_else(|| anyhow!("tab not found"))?;
        if self.tabs[source_index].pane_ids.len() <= 1 {
            return Ok(());
        }
        let pane_index = self.tabs[source_index]
            .pane_ids
            .iter()
            .position(|id| id == pane_id)
            .ok_or_else(|| anyhow!("pane not found"))?;
        self.tabs[source_index].pane_ids.remove(pane_index);
        {
            let source = &mut self.tabs[source_index];
            source.layout = remove_pane_from_layout(source.layout.clone(), pane_id)
                .or_else(|| source.pane_ids.first().map(|id| pane_layout_node(id)));
            if source.active_pane_id.as_deref() == Some(pane_id) {
                source.active_pane_id = source
                    .pane_ids
                    .get(pane_index)
                    .or_else(|| {
                        pane_index
                            .checked_sub(1)
                            .and_then(|left| source.pane_ids.get(left))
                    })
                    .cloned();
            }
        }

        let tab_id = self.next_tab_id();
        self.tabs.insert(
            source_index + 1,
            AgentTab {
                id: tab_id.clone(),
                custom_label: None,
                active_pane_id: Some(pane_id.to_owned()),
                layout: Some(pane_layout_node(pane_id)),
                pane_ids: vec![pane_id.to_owned()],
            },
        );
        self.active_tab_id = Some(tab_id);
        Ok(())
    }

    fn update_layout(
        &mut self,
        tab_id: &str,
        layout: Option<AgentLayoutNode>,
        active_pane_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let tab = self
            .tab_mut(tab_id)
            .ok_or_else(|| anyhow!("tab not found"))?;
        if let Some(layout) = layout.as_ref() {
            let pane_ids = pane_ids_in_layout(layout);
            if pane_ids
                .iter()
                .any(|id| !tab.pane_ids.iter().any(|pane_id| pane_id == id))
            {
                bail!("layout references an unknown pane");
            }
        }
        if let Some(active_pane_id) = active_pane_id {
            if !tab.pane_ids.iter().any(|id| id == active_pane_id) {
                bail!("active pane not found");
            }
            tab.active_pane_id = Some(active_pane_id.to_owned());
        }
        tab.layout = layout;
        self.active_tab_id = Some(tab_id.to_owned());
        Ok(())
    }

    fn repair(&mut self) {
        for tab in &mut self.tabs {
            tab.pane_ids
                .retain(|pane_id| self.panes.contains_key(pane_id));
            tab.layout = normalize_layout(tab.layout.clone(), &tab.pane_ids).or_else(|| {
                tab.pane_ids
                    .first()
                    .map(|pane_id| pane_layout_node(pane_id))
            });
            if !tab
                .active_pane_id
                .as_deref()
                .is_some_and(|active| tab.pane_ids.iter().any(|pane_id| pane_id == active))
            {
                tab.active_pane_id = tab.pane_ids.first().cloned();
            }
        }
        self.tabs.retain(|tab| !tab.pane_ids.is_empty());
        let referenced_pane_ids = self
            .tabs
            .iter()
            .flat_map(|tab| tab.pane_ids.iter().cloned())
            .collect::<std::collections::HashSet<_>>();
        self.panes.retain(|pane_id, pane| {
            let keep = referenced_pane_ids.contains(pane_id);
            if !keep {
                pane.close();
            }
            keep
        });
        if !self
            .active_tab_id
            .as_deref()
            .is_some_and(|active| self.tabs.iter().any(|tab| tab.id == active))
        {
            self.active_tab_id = self.tabs.first().map(|tab| tab.id.clone());
        }
    }

    fn request_tab_id(&self, action: &AgentWorkspaceAction) -> anyhow::Result<String> {
        action
            .tab_id
            .as_deref()
            .map(ToOwned::to_owned)
            .or_else(|| self.active_tab_id.clone())
            .ok_or_else(|| anyhow!("tab_id is required"))
    }

    fn tab_index(&self, tab_id: &str) -> Option<usize> {
        self.tabs.iter().position(|tab| tab.id == tab_id)
    }

    fn tab_mut(&mut self, tab_id: &str) -> Option<&mut AgentTab> {
        self.tabs.iter_mut().find(|tab| tab.id == tab_id)
    }

    fn pane_for_session(&self, session_id: &str) -> Option<(String, String)> {
        self.tabs.iter().find_map(|tab| {
            tab.pane_ids.iter().find_map(|pane_id| {
                self.panes.get(pane_id).and_then(|pane| {
                    (pane.session_id() == session_id).then(|| (tab.id.clone(), pane_id.clone()))
                })
            })
        })
    }

    fn next_tab_id(&mut self) -> String {
        let id = format!("tab-{}", self.next_tab_id);
        self.next_tab_id = self.next_tab_id.saturating_add(1);
        id
    }

    fn next_pane_id(&mut self) -> String {
        let id = format!("pane-{}", self.next_pane_id);
        self.next_pane_id = self.next_pane_id.saturating_add(1);
        id
    }
}

fn spawn_pane_event_dispatcher(pane: Weak<AgentPane>, event_rx: mpsc::Receiver<AgentPtyEvent>) {
    thread::spawn(move || {
        for event in event_rx {
            let Some(pane) = pane.upgrade() else {
                break;
            };
            match event {
                AgentPtyEvent::Output(data) => pane.push_output(data),
                AgentPtyEvent::Exit(exit) => pane.mark_exit(exit),
                AgentPtyEvent::Error(message) => pane.broadcast(AgentPaneEvent::Error(message)),
            }
        }
    });
}

fn action_kind(action: &AgentWorkspaceAction) -> anyhow::Result<AgentWorkspaceActionType> {
    action
        .action
        .as_ref()
        .and_then(|kind| kind.as_known())
        .ok_or_else(|| anyhow!("workspace action is required"))
}

fn required_string<'a>(value: Option<&'a str>, name: &str) -> anyhow::Result<&'a str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("{name} is required"))
}

fn pane_layout_node(pane_id: &str) -> AgentLayoutNode {
    AgentLayoutNode {
        r#type: Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE.into()),
        pane_id: Some(pane_id.to_owned()),
        ..Default::default()
    }
}

fn split_axis_for_direction(direction: AgentSplitDirection) -> AgentSplitAxis {
    match direction {
        AgentSplitDirection::AGENT_SPLIT_DIRECTION_UP
        | AgentSplitDirection::AGENT_SPLIT_DIRECTION_DOWN => AgentSplitAxis::AGENT_SPLIT_AXIS_ROWS,
        AgentSplitDirection::AGENT_SPLIT_DIRECTION_LEFT
        | AgentSplitDirection::AGENT_SPLIT_DIRECTION_RIGHT => {
            AgentSplitAxis::AGENT_SPLIT_AXIS_COLUMNS
        }
        AgentSplitDirection::AGENT_SPLIT_DIRECTION_UNSPECIFIED => {
            AgentSplitAxis::AGENT_SPLIT_AXIS_ROWS
        }
    }
}

fn next_pane_layout(
    layout: Option<AgentLayoutNode>,
    reference_pane_id: Option<&str>,
    new_pane_id: &str,
    direction: AgentSplitDirection,
) -> AgentLayoutNode {
    let new_pane = pane_layout_node(new_pane_id);
    let Some(layout) = layout else {
        return new_pane;
    };
    let Some(reference_pane_id) = reference_pane_id else {
        return new_pane;
    };
    let axis = split_axis_for_direction(direction);
    let insert_before = matches!(
        direction,
        AgentSplitDirection::AGENT_SPLIT_DIRECTION_UP
            | AgentSplitDirection::AGENT_SPLIT_DIRECTION_LEFT
    );
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
    split_layout_node(
        axis,
        if insert_before {
            vec![new_pane, layout]
        } else {
            vec![layout, new_pane]
        },
    )
}

fn insert_pane_into_layout(
    node: AgentLayoutNode,
    reference_pane_id: &str,
    new_pane: &AgentLayoutNode,
    axis: AgentSplitAxis,
    insert_before: bool,
) -> (AgentLayoutNode, bool) {
    match node_kind(&node) {
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE) => {
            if node.pane_id.as_deref() != Some(reference_pane_id) {
                return (node, false);
            }
            let existing = pane_layout_node(reference_pane_id);
            (
                split_layout_node(
                    axis,
                    if insert_before {
                        vec![new_pane.clone(), existing]
                    } else {
                        vec![existing, new_pane.clone()]
                    },
                ),
                true,
            )
        }
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT) => {
            let same_axis = node.axis.as_ref().and_then(|axis| axis.as_known()) == Some(axis);
            let mut changed = false;
            let mut children = Vec::with_capacity(node.children.len() + 1);
            for child in node.children {
                if changed {
                    children.push(child);
                    continue;
                }
                let (next_child, inserted) = insert_pane_into_layout(
                    child,
                    reference_pane_id,
                    new_pane,
                    axis,
                    insert_before,
                );
                if inserted && same_axis {
                    match node_kind(&next_child) {
                        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT)
                            if next_child.axis.as_ref().and_then(|axis| axis.as_known())
                                == Some(axis) =>
                        {
                            children.extend(next_child.children);
                        }
                        _ => children.push(next_child),
                    }
                } else {
                    children.push(next_child);
                }
                changed = inserted;
            }
            (
                split_layout_node(
                    node.axis
                        .as_ref()
                        .and_then(|axis| axis.as_known())
                        .unwrap_or(AgentSplitAxis::AGENT_SPLIT_AXIS_ROWS),
                    children,
                ),
                changed,
            )
        }
        _ => (node, false),
    }
}

fn remove_pane_from_layout(
    layout: Option<AgentLayoutNode>,
    pane_id: &str,
) -> Option<AgentLayoutNode> {
    let node = layout?;
    match node_kind(&node) {
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE) => {
            (node.pane_id.as_deref() != Some(pane_id)).then_some(node)
        }
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT) => {
            let mut children = node
                .children
                .into_iter()
                .filter_map(|child| remove_pane_from_layout(Some(child), pane_id))
                .collect::<Vec<_>>();
            match children.len() {
                0 => None,
                1 => children.pop(),
                _ => Some(split_layout_node(
                    node.axis
                        .as_ref()
                        .and_then(|axis| axis.as_known())
                        .unwrap_or(AgentSplitAxis::AGENT_SPLIT_AXIS_ROWS),
                    children,
                )),
            }
        }
        _ => None,
    }
}

fn normalize_layout(
    layout: Option<AgentLayoutNode>,
    valid_pane_ids: &[String],
) -> Option<AgentLayoutNode> {
    let node = layout?;
    match node_kind(&node) {
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE) => node
            .pane_id
            .as_deref()
            .filter(|pane_id| valid_pane_ids.iter().any(|valid| valid == *pane_id))
            .map(pane_layout_node),
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT) => {
            let mut children = node
                .children
                .into_iter()
                .filter_map(|child| normalize_layout(Some(child), valid_pane_ids))
                .collect::<Vec<_>>();
            match children.len() {
                0 => None,
                1 => children.pop(),
                _ => Some(split_layout_node(
                    node.axis
                        .as_ref()
                        .and_then(|axis| axis.as_known())
                        .unwrap_or(AgentSplitAxis::AGENT_SPLIT_AXIS_ROWS),
                    children,
                )),
            }
        }
        _ => None,
    }
}

fn pane_ids_in_layout(node: &AgentLayoutNode) -> Vec<String> {
    match node_kind(node) {
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE) => {
            node.pane_id.iter().cloned().collect()
        }
        Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT) => {
            node.children.iter().flat_map(pane_ids_in_layout).collect()
        }
        _ => Vec::new(),
    }
}

fn split_layout_node(axis: AgentSplitAxis, children: Vec<AgentLayoutNode>) -> AgentLayoutNode {
    AgentLayoutNode {
        r#type: Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT.into()),
        axis: Some(axis.into()),
        children,
        ..Default::default()
    }
}

fn node_kind(node: &AgentLayoutNode) -> Option<AgentLayoutNodeType> {
    node.r#type.as_ref().and_then(|kind| kind.as_known())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserts_split_layout_next_to_reference_pane() {
        let layout = next_pane_layout(
            Some(pane_layout_node("pane-1")),
            Some("pane-1"),
            "pane-2",
            AgentSplitDirection::AGENT_SPLIT_DIRECTION_RIGHT,
        );

        assert_eq!(
            node_kind(&layout),
            Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_SPLIT)
        );
        assert_eq!(
            layout.axis.and_then(|axis| axis.as_known()),
            Some(AgentSplitAxis::AGENT_SPLIT_AXIS_COLUMNS)
        );
        assert_eq!(
            layout
                .children
                .iter()
                .filter_map(|child| child.pane_id.clone())
                .collect::<Vec<_>>(),
            vec!["pane-1", "pane-2"]
        );
    }

    #[test]
    fn removes_pane_and_collapses_single_child_split() {
        let layout = split_layout_node(
            AgentSplitAxis::AGENT_SPLIT_AXIS_COLUMNS,
            vec![pane_layout_node("pane-1"), pane_layout_node("pane-2")],
        );

        let layout = remove_pane_from_layout(Some(layout), "pane-2").unwrap();

        assert_eq!(
            node_kind(&layout),
            Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE)
        );
        assert_eq!(layout.pane_id.as_deref(), Some("pane-1"));
    }

    #[test]
    fn normalizes_layout_to_known_panes() {
        let layout = split_layout_node(
            AgentSplitAxis::AGENT_SPLIT_AXIS_ROWS,
            vec![pane_layout_node("pane-1"), pane_layout_node("stale")],
        );

        let layout = normalize_layout(Some(layout), &["pane-1".to_owned()]).unwrap();

        assert_eq!(
            node_kind(&layout),
            Some(AgentLayoutNodeType::AGENT_LAYOUT_NODE_TYPE_PANE)
        );
        assert_eq!(layout.pane_id.as_deref(), Some("pane-1"));
    }

    #[test]
    fn create_tab_after_closing_last_tab_creates_one_tab() {
        let workspace = AgentWorkspace::new("demo@owner", "");
        let initial = workspace
            .ensure_state(DEFAULT_COLS, DEFAULT_ROWS, 32)
            .unwrap();
        let tab_id = initial.tabs[0].id.clone().unwrap();

        let closed = workspace
            .apply_action(
                &AgentWorkspaceAction {
                    action: Some(
                        AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CLOSE_TAB.into(),
                    ),
                    tab_id: Some(tab_id),
                    ..Default::default()
                },
                DEFAULT_COLS,
                DEFAULT_ROWS,
                32,
            )
            .unwrap();
        assert_eq!(closed.tabs.len(), 0);

        let created = workspace
            .apply_action(
                &AgentWorkspaceAction {
                    action: Some(
                        AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CREATE_TAB.into(),
                    ),
                    ..Default::default()
                },
                DEFAULT_COLS,
                DEFAULT_ROWS,
                32,
            )
            .unwrap();

        assert_eq!(created.tabs.len(), 1);
    }

    #[test]
    fn close_session_removes_the_matching_single_pane_tab() {
        let workspace = AgentWorkspace::new("demo@owner", "");
        let initial = workspace
            .ensure_state(DEFAULT_COLS, DEFAULT_ROWS, 32)
            .unwrap();
        let session_id = initial.tabs[0].panes[0].session_id.clone().unwrap();

        let closed = workspace
            .close_session(&session_id, DEFAULT_COLS, DEFAULT_ROWS, 32)
            .unwrap();

        assert_eq!(closed.tabs.len(), 0);
        assert!(workspace.pane("pane-1").is_err());
    }

    #[test]
    fn close_session_removes_only_the_matching_pane_from_a_split_tab() {
        let workspace = AgentWorkspace::new("demo@owner", "");
        let initial = workspace
            .ensure_state(DEFAULT_COLS, DEFAULT_ROWS, 32)
            .unwrap();
        let tab_id = initial.tabs[0].id.clone().unwrap();
        let split = workspace
            .apply_action(
                &AgentWorkspaceAction {
                    action: Some(
                        AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_SPLIT_PANE.into(),
                    ),
                    tab_id: Some(tab_id.clone()),
                    pane_id: Some("pane-1".to_owned()),
                    direction: Some(AgentSplitDirection::AGENT_SPLIT_DIRECTION_RIGHT.into()),
                    ..Default::default()
                },
                DEFAULT_COLS,
                DEFAULT_ROWS,
                32,
            )
            .unwrap();
        let session_id = split.tabs[0].panes[0].session_id.clone().unwrap();

        let closed = workspace
            .close_session(&session_id, DEFAULT_COLS, DEFAULT_ROWS, 32)
            .unwrap();

        assert_eq!(closed.tabs.len(), 1);
        assert_eq!(closed.tabs[0].id.as_deref(), Some(tab_id.as_str()));
        assert_eq!(closed.tabs[0].panes.len(), 1);
        assert_ne!(
            closed.tabs[0].panes[0].session_id.as_deref(),
            Some(session_id.as_str())
        );
    }

    #[test]
    fn repair_closes_unreferenced_orphan_panes() {
        let workspace = AgentWorkspace::new("demo@owner", "");
        workspace
            .ensure_state(DEFAULT_COLS, DEFAULT_ROWS, 32)
            .unwrap();

        let orphan_id = {
            let mut inner = workspace.inner.lock().unwrap();
            let orphan = inner.create_pane(DEFAULT_COLS, DEFAULT_ROWS, 32).unwrap();
            let orphan_id = orphan.id().to_owned();
            assert!(inner.panes.contains_key(&orphan_id));

            inner.repair();

            assert!(!inner.panes.contains_key(&orphan_id));
            orphan_id
        };

        assert!(workspace.pane(&orphan_id).is_err());
    }
}
