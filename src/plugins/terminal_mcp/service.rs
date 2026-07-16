use std::collections::HashSet;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::broadcast;
use tokio::time::{Instant, timeout};
use tracing::warn;

use crate::agent_client::ensure_agent;
use crate::agent_protocol::{
    detach_frame, input_frame, read_agent_frame_async, resize_frame, write_agent_frame_async,
};
use crate::config::{
    DEFAULT_OUTPUT_FRAME_LIMIT, MCP_TERMINAL_MAX_KEYS, MCP_TERMINAL_MAX_READ_BYTES,
    MCP_TERMINAL_MAX_WAIT_MS, PTY_INPUT_MESSAGE_BYTES,
};
use crate::lightos;
use crate::proto::lazycat::webshell::v1::{
    AgentControlType, AgentFrameType, AgentPaneState, AgentWorkspaceAction,
    AgentWorkspaceActionType, AgentWorkspaceState,
};
use crate::pty_io::PtyInputError;
use crate::ssh_backend;
use crate::state::{AppState, SessionRecord};
use crate::terminal_manager::{ManagedTerminal, TerminalEvent};
use crate::tty_init::lightos_features_enabled;
use crate::validation::{validate_selector, validate_size};
use crate::workspace::{
    SessionBackend, WorkspaceSessionError, WorkspaceTerminalDefaults, close_workspace_session,
    create_workspace_session,
};

use super::herdr_adapter::HerdrTerminalAdapter;
use super::principal::McpPrincipal;
use super::types::{
    ControlAccess, ControlGrant, ControlTarget, TerminalBackend, TerminalCapability,
    TerminalMcpError, TerminalMcpPolicy, TerminalOutputFrame, TerminalReadResult,
    TerminalSessionSummary,
};

const AGENT_ATTACH_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct TerminalControlService {
    state: Arc<AppState>,
    herdr: HerdrTerminalAdapter,
}

#[derive(Clone, Debug)]
struct AgentPaneTarget {
    selector: String,
    login_user: String,
    session_id: String,
    pane_id: String,
    title: String,
    status: String,
    cols: u16,
    rows: u16,
}

enum ResolvedTarget {
    Native(SessionRecord),
    Agent(AgentPaneTarget),
    Herdr(SessionRecord, String),
}

impl TerminalControlService {
    pub fn new(state: Arc<AppState>) -> Self {
        Self {
            herdr: HerdrTerminalAdapter::new(Arc::clone(&state)),
            state,
        }
    }

    pub async fn list_sessions(
        &self,
        principal: &McpPrincipal,
        backend_filter: Option<TerminalBackend>,
        status_filter: Option<&str>,
        selector_filter: Option<&str>,
    ) -> Result<Vec<TerminalSessionSummary>, TerminalMcpError> {
        self.policy()?;
        let records = self
            .state
            .sessions
            .read()
            .map_err(|_| internal_error())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut sessions = Vec::new();
        let mut seen = HashSet::new();
        for record in records {
            if selector_filter.is_some_and(|selector| selector != record.selector) {
                continue;
            }
            let backend = backend_for_record(&record)?;
            if backend_filter.is_some_and(|filter| filter != backend) {
                continue;
            }
            if status_filter.is_some_and(|status| status != record.status) {
                continue;
            }
            if backend == TerminalBackend::Herdr {
                match self.herdr.list_panes(&record.id).await {
                    Ok(panes) if !panes.is_empty() => {
                        for pane in panes {
                            sessions.push(TerminalSessionSummary {
                                session_id: record.id.clone(),
                                backend,
                                title: pane.title,
                                selector: record.selector.clone(),
                                status: record.status.clone(),
                                cols: record.cols,
                                rows: record.rows,
                                busy: true,
                                control_granted: self
                                    .state
                                    .terminal_mcp
                                    .has_grant(principal, &record.id),
                                workspace_id: pane.workspace_id,
                                tab_id: pane.tab_id,
                                pane_id: Some(pane.pane_id),
                            });
                        }
                    }
                    Ok(_) | Err(_) => {
                        sessions.push(self.native_summary(principal, &record, backend))
                    }
                }
            } else {
                sessions.push(self.native_summary(principal, &record, backend));
            }
            seen.insert(record.id);
        }

        if backend_filter.is_none_or(|backend| backend == TerminalBackend::Webshell) {
            for target in self.agent_sessions(selector_filter).await {
                if seen.contains(&target.session_id)
                    || status_filter.is_some_and(|status| status != target.status)
                {
                    continue;
                }
                sessions.push(self.agent_summary(principal, &target));
            }
        }
        sessions.sort_by(|left, right| {
            left.selector
                .cmp(&right.selector)
                .then_with(|| left.title.cmp(&right.title))
                .then_with(|| left.session_id.cmp(&right.session_id))
                .then_with(|| left.pane_id.cmp(&right.pane_id))
        });
        Ok(sessions)
    }

    pub async fn read(
        &self,
        principal: &McpPrincipal,
        session_id: &str,
        pane_id: Option<&str>,
        after_sequence: u64,
        wait_ms: u64,
        max_bytes: usize,
    ) -> Result<TerminalReadResult, TerminalMcpError> {
        self.policy()?;
        let _read_permit = self
            .state
            .terminal_mcp
            .begin_read(principal, session_id, pane_id)?;
        let wait_ms = wait_ms.min(MCP_TERMINAL_MAX_WAIT_MS);
        let max_bytes = max_bytes.clamp(1, MCP_TERMINAL_MAX_READ_BYTES);
        let target = self.resolve_target(session_id, pane_id).await?;
        match target {
            ResolvedTarget::Native(session) => {
                self.read_native(&session, after_sequence, wait_ms, max_bytes)
                    .await
            }
            ResolvedTarget::Agent(target) => {
                self.read_agent(&target, after_sequence, wait_ms, max_bytes)
                    .await
            }
            ResolvedTarget::Herdr(_, pane_id) => {
                self.herdr
                    .read(session_id, &pane_id, after_sequence, wait_ms, max_bytes)
                    .await
            }
        }
        .map(|mut read| {
            read.session_id = session_id.to_owned();
            let _ = principal;
            read
        })
    }

    pub async fn request_control(
        &self,
        principal: &McpPrincipal,
        session_id: &str,
        pane_id: Option<&str>,
        capability: TerminalCapability,
        reason: &str,
    ) -> Result<ControlAccess, TerminalMcpError> {
        let policy = self.policy()?;
        let target = self.resolve_target(session_id, pane_id).await?;
        let control_target = control_target(&target);
        self.state
            .terminal_mcp
            .authorize(&policy, principal, control_target, capability, reason)
    }

    pub async fn send_text(
        &self,
        principal: &McpPrincipal,
        session_id: &str,
        pane_id: Option<&str>,
        text: &str,
        append_enter: bool,
        reason: &str,
    ) -> Result<(), TerminalMcpError> {
        let mut data = text.as_bytes().to_vec();
        if append_enter {
            data.push(b'\r');
        }
        validate_input_size(&data)?;
        let target = self.resolve_target(session_id, pane_id).await?;
        self.authorize_target(principal, &target, TerminalCapability::Interact, reason)?;
        match target {
            ResolvedTarget::Native(session) => self.write_native(&session, data).await,
            ResolvedTarget::Agent(target) => self.write_agent_input(&target, data).await,
            ResolvedTarget::Herdr(session, pane_id) => {
                self.herdr
                    .send_text(&session.id, &pane_id, text.to_owned())
                    .await?;
                if append_enter {
                    self.herdr
                        .send_keys(&session.id, &pane_id, vec!["Enter".to_owned()])
                        .await?;
                }
                Ok(())
            }
        }
    }

    pub async fn send_keys(
        &self,
        principal: &McpPrincipal,
        session_id: &str,
        pane_id: Option<&str>,
        keys: &[String],
        reason: &str,
    ) -> Result<(), TerminalMcpError> {
        let (names, data) = normalize_keys(keys)?;
        let target = self.resolve_target(session_id, pane_id).await?;
        self.authorize_target(principal, &target, TerminalCapability::Interact, reason)?;
        match target {
            ResolvedTarget::Native(session) => self.write_native(&session, data).await,
            ResolvedTarget::Agent(target) => self.write_agent_input(&target, data).await,
            ResolvedTarget::Herdr(session, pane_id) => {
                self.herdr.send_keys(&session.id, &pane_id, names).await
            }
        }
    }

    pub async fn send_input(
        &self,
        principal: &McpPrincipal,
        session_id: &str,
        pane_id: Option<&str>,
        data: Vec<u8>,
        reason: &str,
    ) -> Result<(), TerminalMcpError> {
        validate_input_size(&data)?;
        let target = self.resolve_target(session_id, pane_id).await?;
        self.authorize_target(principal, &target, TerminalCapability::Interact, reason)?;
        match target {
            ResolvedTarget::Native(session) => self.write_native(&session, data).await,
            ResolvedTarget::Agent(target) => self.write_agent_input(&target, data).await,
            ResolvedTarget::Herdr(session, pane_id) => {
                self.herdr.send_input(&session.id, &pane_id, &data).await
            }
        }
    }

    pub async fn resize(
        &self,
        principal: &McpPrincipal,
        session_id: &str,
        pane_id: Option<&str>,
        cols: u16,
        rows: u16,
        reason: &str,
    ) -> Result<(), TerminalMcpError> {
        validate_size(cols, rows)
            .map_err(|err| TerminalMcpError::invalid_input(err.to_string()))?;
        let target = self.resolve_target(session_id, pane_id).await?;
        self.authorize_target(principal, &target, TerminalCapability::Interact, reason)?;
        match target {
            ResolvedTarget::Native(session) => {
                let terminal = self.ensure_native_terminal(&session)?;
                terminal.resize(cols, rows).map_err(map_terminal_error)?;
                self.state
                    .sessions
                    .persist_resize(&session.id, cols, rows)
                    .map_err(|_| internal_error())
            }
            ResolvedTarget::Agent(target) => self.resize_agent(&target, cols, rows).await,
            ResolvedTarget::Herdr(session, pane_id) => {
                self.herdr.resize(&session.id, &pane_id, cols, rows).await
            }
        }
    }

    pub async fn create_session(
        &self,
        principal: &McpPrincipal,
        backend: TerminalBackend,
        selector: &str,
        cols: u16,
        rows: u16,
        title: Option<&str>,
        reason: &str,
    ) -> Result<TerminalSessionSummary, TerminalMcpError> {
        if backend == TerminalBackend::Herdr {
            return Err(TerminalMcpError::backend_not_supported());
        }
        validate_size(cols, rows)
            .map_err(|err| TerminalMcpError::invalid_input(err.to_string()))?;
        let selector = selector.trim();
        if selector.is_empty() {
            return Err(TerminalMcpError::invalid_input("selector is required"));
        }
        let create_target = ControlTarget {
            session_id: format!("new:{}:{selector}", backend_name(backend)),
            backend: backend_name(backend).to_owned(),
            label: title
                .unwrap_or("New terminal")
                .trim()
                .chars()
                .take(128)
                .collect(),
        };
        let policy = self.policy()?;
        require_grant(self.state.terminal_mcp.authorize(
            &policy,
            principal,
            create_target,
            TerminalCapability::Create,
            reason,
        )?)?;

        let summary = match backend {
            TerminalBackend::Webshell => {
                validate_selector(selector)
                    .map_err(|err| TerminalMcpError::invalid_input(err.to_string()))?;
                let login_user = lightos::login_user_for_selector(selector, true)
                    .await
                    .map_err(|_| TerminalMcpError::caller_not_authorized())?;
                let agent = ensure_agent(selector, &login_user).await.map_err(|_| {
                    TerminalMcpError::new(
                        "BACKEND_OPERATION_FAILED",
                        "WebShell agent is unavailable",
                    )
                })?;
                let state = agent
                    .action(
                        cols,
                        rows,
                        DEFAULT_OUTPUT_FRAME_LIMIT,
                        AgentWorkspaceAction {
                            action: Some(
                                AgentWorkspaceActionType::AGENT_WORKSPACE_ACTION_TYPE_CREATE_TAB
                                    .into(),
                            ),
                            label: title.map(ToOwned::to_owned),
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(|_| {
                        TerminalMcpError::new(
                            "BACKEND_OPERATION_FAILED",
                            "Failed to create WebShell session",
                        )
                    })?;
                let target = active_agent_target(state, login_user)
                    .ok_or_else(TerminalMcpError::session_not_found)?;
                self.agent_summary(principal, &target)
            }
            TerminalBackend::Ssh => {
                let profile = ssh_backend::load_enabled_profile(&self.state.database(), selector)
                    .map_err(|_| TerminalMcpError::caller_not_authorized())?;
                drop(profile);
                let defaults = WorkspaceTerminalDefaults::new(
                    &self.state,
                    selector,
                    cols,
                    rows,
                    DEFAULT_OUTPUT_FRAME_LIMIT,
                    false,
                    "",
                    SessionBackend::Ssh,
                )
                .map_err(TerminalMcpError::invalid_input)?;
                let mut metadata = std::collections::HashMap::new();
                if let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) {
                    metadata.insert("title".to_owned(), title.chars().take(128).collect());
                }
                metadata.insert("creatorSource".to_owned(), principal.caller_app_id.clone());
                let created = create_workspace_session(&self.state, selector, &defaults, metadata)
                    .map_err(map_workspace_error)?;
                let terminal = self.ensure_native_terminal(&created.session)?;
                self.state
                    .sessions
                    .mark_status(&created.session.id, "running");
                let mut summary = self.native_summary(principal, &created.session, backend);
                summary.busy = terminal.is_busy();
                summary
            }
            TerminalBackend::Herdr => unreachable!(),
        };
        self.state
            .terminal_mcp
            .record_created_session(principal, &summary.session_id);
        Ok(summary)
    }

    pub async fn close_session(
        &self,
        principal: &McpPrincipal,
        session_id: &str,
        pane_id: Option<&str>,
        reason: &str,
    ) -> Result<(), TerminalMcpError> {
        let target = self.resolve_target(session_id, pane_id).await?;
        if matches!(target, ResolvedTarget::Herdr(_, _)) {
            return Err(TerminalMcpError::backend_not_supported());
        }
        if !self
            .state
            .terminal_mcp
            .caller_created_session(principal, session_id)
        {
            self.authorize_target(principal, &target, TerminalCapability::Terminate, reason)?;
        }
        match target {
            ResolvedTarget::Agent(target) => {
                let agent = ensure_agent(&target.selector, &target.login_user)
                    .await
                    .map_err(|_| {
                        TerminalMcpError::new(
                            "BACKEND_OPERATION_FAILED",
                            "WebShell agent is unavailable",
                        )
                    })?;
                agent
                    .close_session(
                        &target.session_id,
                        target.cols,
                        target.rows,
                        DEFAULT_OUTPUT_FRAME_LIMIT,
                    )
                    .await
                    .map_err(|_| {
                        TerminalMcpError::new(
                            "BACKEND_OPERATION_FAILED",
                            "Failed to close WebShell session",
                        )
                    })?;
            }
            ResolvedTarget::Native(_) => {
                let closed = close_workspace_session(&self.state, session_id)
                    .map_err(map_workspace_error)?;
                self.state
                    .sessions
                    .close_sessions(closed.closed_session_ids.iter().map(String::as_str));
                for closed_id in &closed.closed_session_ids {
                    self.state.terminal_mcp.revoke_session(closed_id);
                }
            }
            ResolvedTarget::Herdr(_, _) => unreachable!(),
        }
        self.state.terminal_mcp.revoke_session(session_id);
        Ok(())
    }

    pub fn revoke_control(&self, principal: &McpPrincipal, grant_id: &str) -> bool {
        self.state
            .terminal_mcp
            .revoke_grant_for(principal, grant_id)
    }

    fn policy(&self) -> Result<TerminalMcpPolicy, TerminalMcpError> {
        let plugins = self.state.plugins.read().map_err(|_| internal_error())?;
        let plugin = plugins
            .get(super::PLUGIN_ID)
            .ok_or_else(TerminalMcpError::disabled)?;
        if !plugin.enabled {
            return Err(TerminalMcpError::disabled());
        }
        Ok(TerminalMcpPolicy::from_plugin(plugin))
    }

    fn authorize_target(
        &self,
        principal: &McpPrincipal,
        target: &ResolvedTarget,
        capability: TerminalCapability,
        reason: &str,
    ) -> Result<ControlGrant, TerminalMcpError> {
        let policy = self.policy()?;
        require_grant(self.state.terminal_mcp.authorize(
            &policy,
            principal,
            control_target(target),
            capability,
            reason,
        )?)
    }

    async fn resolve_target(
        &self,
        session_id: &str,
        pane_id: Option<&str>,
    ) -> Result<ResolvedTarget, TerminalMcpError> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err(TerminalMcpError::invalid_input("sessionId is required"));
        }
        let record = self
            .state
            .sessions
            .read()
            .map_err(|_| internal_error())?
            .get(session_id)
            .cloned();
        if let Some(record) = record {
            return match backend_for_record(&record)? {
                TerminalBackend::Herdr => {
                    let pane_id = pane_id
                        .map(str::trim)
                        .filter(|pane_id| !pane_id.is_empty())
                        .ok_or_else(TerminalMcpError::pane_not_found)?;
                    Ok(ResolvedTarget::Herdr(record, pane_id.to_owned()))
                }
                TerminalBackend::Webshell | TerminalBackend::Ssh => {
                    Ok(ResolvedTarget::Native(record))
                }
            };
        }
        let target = self
            .agent_sessions(None)
            .await
            .into_iter()
            .find(|target| {
                target.session_id == session_id
                    && pane_id.is_none_or(|pane_id| pane_id == target.pane_id)
            })
            .ok_or_else(TerminalMcpError::session_not_found)?;
        Ok(ResolvedTarget::Agent(target))
    }

    async fn read_native(
        &self,
        session: &SessionRecord,
        after_sequence: u64,
        wait_ms: u64,
        max_bytes: usize,
    ) -> Result<TerminalReadResult, TerminalMcpError> {
        let terminal = self
            .state
            .sessions
            .terminal(&session.id)
            .map_err(|_| internal_error())?;
        let mut events = terminal.as_ref().map(|terminal| terminal.subscribe());
        let output = self
            .state
            .output_buffer(&session.id, session.output_frame_limit());
        let mut snapshot = output.snapshot_after_bounded(after_sequence, max_bytes, 1024);
        let mut timed_out = false;
        if snapshot.frames.is_empty() && wait_ms > 0 {
            if let Some(events) = events.as_mut() {
                let wait = timeout(Duration::from_millis(wait_ms), async {
                    loop {
                        match events.recv().await {
                            Ok(TerminalEvent::Output(frame)) if frame.sequence > after_sequence => {
                                break;
                            }
                            Ok(TerminalEvent::Exit(_) | TerminalEvent::Error(_)) => break,
                            Ok(TerminalEvent::Output(_))
                            | Err(broadcast::error::RecvError::Lagged(_)) => {}
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                })
                .await;
                timed_out = wait.is_err();
                snapshot = output.snapshot_after_bounded(after_sequence, max_bytes, 1024);
            } else {
                timed_out = true;
            }
        }
        let frames = snapshot
            .frames
            .iter()
            .map(|frame| TerminalOutputFrame {
                sequence: frame.sequence,
                data_base64: BASE64_STANDARD.encode(&frame.data),
            })
            .collect::<Vec<_>>();
        let next_sequence = frames.last().map_or(after_sequence, |frame| frame.sequence);
        Ok(TerminalReadResult {
            session_id: session.id.clone(),
            pane_id: None,
            frames,
            next_sequence,
            last_sequence: snapshot.last_sequence,
            oldest_sequence: snapshot.oldest_sequence,
            timed_out,
            truncated: snapshot.truncated,
            replay_gap: snapshot.replay_gap,
            exited: terminal
                .as_ref()
                .is_some_and(|terminal| terminal.exit_info().is_some())
                || matches!(session.status.as_str(), "closed" | "exited"),
        })
    }

    async fn read_agent(
        &self,
        target: &AgentPaneTarget,
        after_sequence: u64,
        wait_ms: u64,
        max_bytes: usize,
    ) -> Result<TerminalReadResult, TerminalMcpError> {
        let mut attach = AgentAttach::spawn(target, after_sequence).await?;
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        let mut frames = Vec::new();
        let mut total_bytes = 0usize;
        let mut replay_complete = false;
        let mut last_sequence = after_sequence;
        let mut truncated = false;
        let mut exited = false;
        let mut timed_out = false;
        loop {
            let frame = if replay_complete && wait_ms == 0 && frames.is_empty() {
                break;
            } else if replay_complete && frames.is_empty() {
                match timeout(
                    deadline.saturating_duration_since(Instant::now()),
                    read_agent_frame_async(&mut attach.stdout),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => {
                        timed_out = true;
                        break;
                    }
                }
            } else {
                read_agent_frame_async(&mut attach.stdout).await
            };
            let frame = match frame {
                Ok(frame) => frame,
                Err(_) => break,
            };
            match frame.r#type.as_ref().and_then(|kind| kind.as_known()) {
                Some(AgentFrameType::AGENT_FRAME_TYPE_BINARY) => {
                    let Some(sequence) = frame.sequence.and_then(|value| u64::try_from(value).ok())
                    else {
                        continue;
                    };
                    last_sequence = last_sequence.max(sequence);
                    if sequence <= after_sequence {
                        continue;
                    }
                    let data = frame.payload.unwrap_or_default();
                    if !frames.is_empty() && total_bytes.saturating_add(data.len()) > max_bytes {
                        truncated = true;
                        break;
                    }
                    total_bytes = total_bytes.saturating_add(data.len());
                    frames.push(TerminalOutputFrame {
                        sequence,
                        data_base64: BASE64_STANDARD.encode(data),
                    });
                    if total_bytes >= max_bytes || replay_complete {
                        truncated = total_bytes >= max_bytes;
                        break;
                    }
                }
                Some(AgentFrameType::AGENT_FRAME_TYPE_TEXT) if frame.control.is_set() => {
                    let Some(control) = frame.control.into_option() else {
                        continue;
                    };
                    match control.r#type.as_ref().and_then(|kind| kind.as_known()) {
                        Some(AgentControlType::AGENT_CONTROL_TYPE_REPLAY_COMPLETE) => {
                            replay_complete = true;
                            last_sequence = control
                                .last_sequence
                                .and_then(|value| u64::try_from(value).ok())
                                .unwrap_or(last_sequence);
                            if !frames.is_empty() || wait_ms == 0 {
                                break;
                            }
                        }
                        Some(AgentControlType::AGENT_CONTROL_TYPE_PROCESS_EXIT) => {
                            exited = true;
                            break;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        attach.shutdown().await;
        let next_sequence = frames.last().map_or(after_sequence, |frame| frame.sequence);
        let oldest_sequence = frames.first().map(|frame| frame.sequence);
        Ok(TerminalReadResult {
            session_id: target.session_id.clone(),
            pane_id: Some(target.pane_id.clone()),
            replay_gap: oldest_sequence
                .is_some_and(|sequence| sequence > after_sequence.saturating_add(1)),
            frames,
            next_sequence,
            last_sequence,
            oldest_sequence,
            timed_out,
            truncated,
            exited,
        })
    }

    async fn write_native(
        &self,
        session: &SessionRecord,
        data: Vec<u8>,
    ) -> Result<(), TerminalMcpError> {
        self.ensure_native_terminal(session)?
            .write_input(data)
            .map_err(map_terminal_error)
    }

    fn ensure_native_terminal(
        &self,
        session: &SessionRecord,
    ) -> Result<Arc<ManagedTerminal>, TerminalMcpError> {
        if let Some(terminal) = self
            .state
            .sessions
            .terminal(&session.id)
            .map_err(|_| internal_error())?
        {
            return Ok(terminal);
        }
        let terminal = self
            .state
            .sessions
            .open_terminal(
                session.terminal_spec(session.cols, session.rows),
                true,
                false,
            )
            .map_err(map_terminal_error)?;
        self.state.sessions.mark_status(&session.id, "running");
        Ok(terminal)
    }

    async fn write_agent_input(
        &self,
        target: &AgentPaneTarget,
        data: Vec<u8>,
    ) -> Result<(), TerminalMcpError> {
        let mut attach = AgentAttach::spawn(target, i64::MAX as u64).await?;
        attach.wait_for_replay_complete().await?;
        write_agent_frame_async(&mut attach.stdin, &input_frame(data))
            .await
            .map_err(|_| {
                TerminalMcpError::new("BACKEND_OPERATION_FAILED", "Failed to write WebShell input")
            })?;
        attach.shutdown().await;
        Ok(())
    }

    async fn resize_agent(
        &self,
        target: &AgentPaneTarget,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalMcpError> {
        let mut attach = AgentAttach::spawn(target, i64::MAX as u64).await?;
        attach.wait_for_replay_complete().await?;
        write_agent_frame_async(&mut attach.stdin, &resize_frame(cols, rows))
            .await
            .map_err(|_| {
                TerminalMcpError::new("BACKEND_OPERATION_FAILED", "Failed to resize WebShell pane")
            })?;
        attach.shutdown().await;
        Ok(())
    }

    async fn agent_sessions(&self, selector_filter: Option<&str>) -> Vec<AgentPaneTarget> {
        if !lightos_features_enabled() {
            return Vec::new();
        }
        let selectors = match selector_filter {
            Some(selector) => vec![selector.to_owned()],
            None => match lightos::authorized_selectors().await {
                Ok(selectors) => selectors.into_iter().collect(),
                Err(_) => return Vec::new(),
            },
        };
        let mut targets = Vec::new();
        for selector in selectors {
            if ssh_backend::is_ssh_selector(&selector) {
                continue;
            }
            let login_user = match lightos::login_user_for_selector(&selector, true).await {
                Ok(user) => user,
                Err(_) => continue,
            };
            let agent = match ensure_agent(&selector, &login_user).await {
                Ok(agent) => agent,
                Err(err) => {
                    warn!(selector = %selector, error = %err, "failed to discover WebShell agent sessions for MCP");
                    continue;
                }
            };
            let state = match agent.state(120, 32, DEFAULT_OUTPUT_FRAME_LIMIT).await {
                Ok(state) => state,
                Err(_) => continue,
            };
            targets.extend(agent_targets(state, &login_user));
        }
        targets
    }

    fn native_summary(
        &self,
        principal: &McpPrincipal,
        session: &SessionRecord,
        backend: TerminalBackend,
    ) -> TerminalSessionSummary {
        let terminal = self.state.sessions.terminal(&session.id).ok().flatten();
        let (workspace_id, tab_id, pane_id) = workspace_location(&self.state, session);
        TerminalSessionSummary {
            session_id: session.id.clone(),
            backend,
            title: session
                .metadata
                .get("title")
                .map(String::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or(&session.host)
                .to_owned(),
            selector: session.selector.clone(),
            status: session.status.clone(),
            cols: session.cols,
            rows: session.rows,
            busy: terminal.as_ref().is_some_and(|terminal| terminal.is_busy()),
            control_granted: self.state.terminal_mcp.has_grant(principal, &session.id),
            workspace_id,
            tab_id,
            pane_id,
        }
    }

    fn agent_summary(
        &self,
        principal: &McpPrincipal,
        target: &AgentPaneTarget,
    ) -> TerminalSessionSummary {
        TerminalSessionSummary {
            session_id: target.session_id.clone(),
            backend: TerminalBackend::Webshell,
            title: target.title.clone(),
            selector: target.selector.clone(),
            status: target.status.clone(),
            cols: target.cols,
            rows: target.rows,
            busy: false,
            control_granted: self
                .state
                .terminal_mcp
                .has_grant(principal, &target.session_id),
            workspace_id: Some(target.selector.clone()),
            tab_id: None,
            pane_id: Some(target.pane_id.clone()),
        }
    }
}

struct AgentAttach {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl AgentAttach {
    async fn spawn(target: &AgentPaneTarget, replay_after: u64) -> Result<Self, TerminalMcpError> {
        let agent = ensure_agent(&target.selector, &target.login_user)
            .await
            .map_err(|_| {
                TerminalMcpError::new("BACKEND_OPERATION_FAILED", "WebShell agent is unavailable")
            })?;
        let mut command = agent.attach_command(
            &target.pane_id,
            target.cols,
            target.rows,
            DEFAULT_OUTPUT_FRAME_LIMIT,
            replay_after,
        );
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|_| {
            TerminalMcpError::new("BACKEND_OPERATION_FAILED", "Failed to attach WebShell pane")
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            TerminalMcpError::new(
                "BACKEND_OPERATION_FAILED",
                "WebShell attach input is unavailable",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            TerminalMcpError::new(
                "BACKEND_OPERATION_FAILED",
                "WebShell attach output is unavailable",
            )
        })?;
        Ok(Self {
            child,
            stdin,
            stdout,
        })
    }

    async fn wait_for_replay_complete(&mut self) -> Result<(), TerminalMcpError> {
        loop {
            let frame = timeout(
                Duration::from_secs(10),
                read_agent_frame_async(&mut self.stdout),
            )
            .await
            .map_err(|_| TerminalMcpError::operation_timeout())?
            .map_err(|_| {
                TerminalMcpError::new("BACKEND_OPERATION_FAILED", "WebShell attach ended")
            })?;
            if !matches!(
                frame.r#type.as_ref().and_then(|kind| kind.as_known()),
                Some(AgentFrameType::AGENT_FRAME_TYPE_TEXT)
            ) || !frame.control.is_set()
            {
                continue;
            }
            let Some(control) = frame.control.into_option() else {
                continue;
            };
            if matches!(
                control.r#type.as_ref().and_then(|kind| kind.as_known()),
                Some(AgentControlType::AGENT_CONTROL_TYPE_REPLAY_COMPLETE)
            ) {
                return Ok(());
            }
        }
    }

    async fn shutdown(mut self) {
        let _ = write_agent_frame_async(&mut self.stdin, &detach_frame()).await;
        drop(self.stdin);
        if timeout(AGENT_ATTACH_SHUTDOWN_TIMEOUT, self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

fn require_grant(access: ControlAccess) -> Result<ControlGrant, TerminalMcpError> {
    match access {
        ControlAccess::Granted(grant) => Ok(grant),
        ControlAccess::ApprovalRequired(request) => {
            Err(TerminalMcpError::approval_required(request.id))
        }
    }
}

fn control_target(target: &ResolvedTarget) -> ControlTarget {
    match target {
        ResolvedTarget::Native(session) => ControlTarget {
            session_id: session.id.clone(),
            backend: backend_for_record(session)
                .map(backend_name)
                .unwrap_or("webshell")
                .to_owned(),
            label: session
                .metadata
                .get("title")
                .cloned()
                .unwrap_or_else(|| session.host.clone()),
        },
        ResolvedTarget::Agent(target) => ControlTarget {
            session_id: target.session_id.clone(),
            backend: "webshell".to_owned(),
            label: target.title.clone(),
        },
        ResolvedTarget::Herdr(session, pane_id) => ControlTarget {
            session_id: session.id.clone(),
            backend: "herdr".to_owned(),
            label: format!("Herdr pane {pane_id}"),
        },
    }
}

fn backend_for_record(session: &SessionRecord) -> Result<TerminalBackend, TerminalMcpError> {
    match session
        .metadata
        .get("sessionBackend")
        .map(String::as_str)
        .unwrap_or("webshell")
    {
        "webshell" => Ok(TerminalBackend::Webshell),
        "ssh" => Ok(TerminalBackend::Ssh),
        "herdr" => Ok(TerminalBackend::Herdr),
        _ => Err(TerminalMcpError::backend_not_supported()),
    }
}

fn backend_name(backend: TerminalBackend) -> &'static str {
    match backend {
        TerminalBackend::Webshell => "webshell",
        TerminalBackend::Ssh => "ssh",
        TerminalBackend::Herdr => "herdr",
    }
}

fn validate_input_size(data: &[u8]) -> Result<(), TerminalMcpError> {
    if data.is_empty() {
        return Err(TerminalMcpError::invalid_input("terminal input is empty"));
    }
    if data.len() > PTY_INPUT_MESSAGE_BYTES {
        return Err(TerminalMcpError::invalid_input(format!(
            "terminal input exceeds {PTY_INPUT_MESSAGE_BYTES} bytes"
        )));
    }
    Ok(())
}

fn normalize_keys(keys: &[String]) -> Result<(Vec<String>, Vec<u8>), TerminalMcpError> {
    if keys.is_empty() || keys.len() > MCP_TERMINAL_MAX_KEYS {
        return Err(TerminalMcpError::invalid_input(format!(
            "keys must contain 1..={MCP_TERMINAL_MAX_KEYS} entries"
        )));
    }
    let mut names = Vec::with_capacity(keys.len());
    let mut data = Vec::new();
    for key in keys {
        let (name, bytes): (&str, &[u8]) = match key.trim().to_ascii_lowercase().as_str() {
            "enter" | "return" => ("Enter", b"\r"),
            "escape" | "esc" => ("Escape", b"\x1b"),
            "tab" => ("Tab", b"\t"),
            "backspace" => ("Backspace", b"\x7f"),
            "arrowup" | "up" => ("ArrowUp", b"\x1b[A"),
            "arrowdown" | "down" => ("ArrowDown", b"\x1b[B"),
            "arrowright" | "right" => ("ArrowRight", b"\x1b[C"),
            "arrowleft" | "left" => ("ArrowLeft", b"\x1b[D"),
            "ctrl-c" | "control-c" => ("Ctrl-C", b"\x03"),
            "ctrl-d" | "control-d" => ("Ctrl-D", b"\x04"),
            "ctrl-l" | "control-l" => ("Ctrl-L", b"\x0c"),
            _ => return Err(TerminalMcpError::invalid_input("unsupported terminal key")),
        };
        names.push(name.to_owned());
        data.extend_from_slice(bytes);
    }
    Ok((names, data))
}

fn map_terminal_error(error: anyhow::Error) -> TerminalMcpError {
    if matches!(
        error.downcast_ref::<PtyInputError>(),
        Some(PtyInputError::Backpressure)
    ) {
        TerminalMcpError::input_backpressure()
    } else if matches!(
        error.downcast_ref::<PtyInputError>(),
        Some(PtyInputError::Closed)
    ) {
        TerminalMcpError::terminal_exited()
    } else {
        TerminalMcpError::new("BACKEND_OPERATION_FAILED", "Terminal operation failed")
    }
}

fn map_workspace_error(error: WorkspaceSessionError) -> TerminalMcpError {
    match error {
        WorkspaceSessionError::NotFound(_) => TerminalMcpError::session_not_found(),
        WorkspaceSessionError::Internal(_) => internal_error(),
    }
}

fn internal_error() -> TerminalMcpError {
    TerminalMcpError::new("INTERNAL_ERROR", "Terminal MCP state is unavailable")
}

fn workspace_location(
    state: &AppState,
    session: &SessionRecord,
) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(workspaces) = state.workspaces.read() else {
        return (None, None, None);
    };
    let Some(workspace) = workspaces.get(&session.selector) else {
        return (None, None, None);
    };
    for tab in &workspace.tabs {
        if let Some(pane) = tab.panes.iter().find(|pane| pane.session_id == session.id) {
            return (
                Some(workspace.selector.clone()),
                Some(tab.id.clone()),
                Some(pane.id.clone()),
            );
        }
    }
    (None, None, None)
}

fn agent_targets(state: AgentWorkspaceState, login_user: &str) -> Vec<AgentPaneTarget> {
    let selector = state.selector.unwrap_or_default();
    state
        .tabs
        .into_iter()
        .flat_map(|tab| {
            let title = tab
                .custom_label
                .as_deref()
                .or(tab.label.as_deref())
                .unwrap_or("WebShell")
                .to_owned();
            let selector = selector.clone();
            let login_user = login_user.to_owned();
            tab.panes.into_iter().filter_map(move |pane| {
                agent_target_from_pane(&selector, &login_user, &title, pane)
            })
        })
        .collect()
}

fn active_agent_target(state: AgentWorkspaceState, login_user: String) -> Option<AgentPaneTarget> {
    let selector = state.selector.clone().unwrap_or_default();
    let active_tab_id = state.active_tab_id.as_deref();
    let tab = state
        .tabs
        .iter()
        .find(|tab| active_tab_id.is_some_and(|active| tab.id.as_deref() == Some(active)))
        .or_else(|| state.tabs.last())?;
    let title = tab
        .custom_label
        .as_deref()
        .or(tab.label.as_deref())
        .unwrap_or("WebShell");
    let active_pane_id = tab.active_pane_id.as_deref();
    let pane = tab
        .panes
        .iter()
        .find(|pane| active_pane_id.is_some_and(|active| pane.id.as_deref() == Some(active)))
        .or_else(|| tab.panes.first())?
        .clone();
    agent_target_from_pane(&selector, &login_user, title, pane)
}

fn agent_target_from_pane(
    selector: &str,
    login_user: &str,
    title: &str,
    pane: AgentPaneState,
) -> Option<AgentPaneTarget> {
    let session_id = pane.session_id?.trim().to_owned();
    let pane_id = pane.id?.trim().to_owned();
    if session_id.is_empty() || pane_id.is_empty() {
        return None;
    }
    Some(AgentPaneTarget {
        selector: selector.to_owned(),
        login_user: login_user.to_owned(),
        session_id,
        pane_id,
        title: title.to_owned(),
        status: pane.status.unwrap_or_else(|| "running".to_owned()),
        cols: pane
            .cols
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(120),
        rows: pane
            .rows
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(32),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use uuid::Uuid;

    use super::*;
    use crate::state::PluginRecord;

    fn principal() -> McpPrincipal {
        McpPrincipal {
            user_id: "lazycat".to_owned(),
            caller_app_id: "cloud.lazycat.app.agent".to_owned(),
            caller_name: "Agent".to_owned(),
        }
    }

    fn test_service() -> (Arc<AppState>, TerminalControlService) {
        let state = Arc::new(AppState::new_for_test(
            std::env::temp_dir().join(format!("terminal-mcp-service-{}.db", Uuid::new_v4())),
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
                enabled: true,
                metadata: HashMap::from([
                    ("defaultPolicy".to_owned(), "confirm".to_owned()),
                    ("trustedCallers".to_owned(), "[]".to_owned()),
                    ("deniedCallers".to_owned(), "[]".to_owned()),
                ]),
            },
        );
        let service = TerminalControlService::new(Arc::clone(&state));
        (state, service)
    }

    fn native_session() -> SessionRecord {
        SessionRecord {
            id: "session-one".to_owned(),
            host: "remote.example".to_owned(),
            selector: "device@owner".to_owned(),
            status: "running".to_owned(),
            cols: 120,
            rows: 32,
            command: "/bin/sh".to_owned(),
            args: Vec::new(),
            metadata: HashMap::from([
                ("sessionBackend".to_owned(), "webshell".to_owned()),
                ("privateKey".to_owned(), "must-not-leak".to_owned()),
            ]),
        }
    }

    #[test]
    fn maps_allowlisted_terminal_keys() {
        let (names, data) = normalize_keys(&[
            "Enter".to_owned(),
            "Ctrl-C".to_owned(),
            "ArrowUp".to_owned(),
        ])
        .unwrap();

        assert_eq!(names, vec!["Enter", "Ctrl-C", "ArrowUp"]);
        assert_eq!(data, b"\r\x03\x1b[A");
    }

    #[test]
    fn rejects_unknown_or_excessive_keys() {
        assert_eq!(
            normalize_keys(&["F13".to_owned()]).unwrap_err().code,
            "INVALID_INPUT"
        );
        assert_eq!(
            normalize_keys(&vec!["Enter".to_owned(); MCP_TERMINAL_MAX_KEYS + 1])
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );
    }

    #[tokio::test]
    async fn lists_sanitized_sessions_and_reads_bounded_native_output() {
        let (state, service) = test_service();
        state
            .sessions
            .write()
            .unwrap()
            .insert("session-one".to_owned(), native_session());
        for (sequence, data) in [(1, b"abc".to_vec()), (2, b"def".to_vec())] {
            state
                .database()
                .append_output_frame(
                    "session-one",
                    &crate::terminal_manager::OutputFrame { sequence, data },
                    1,
                    crate::agent_protocol::AGENT_PROTOCOL_VERSION,
                )
                .unwrap();
        }

        let sessions = service
            .list_sessions(&principal(), Some(TerminalBackend::Webshell), None, None)
            .await
            .unwrap();
        let serialized = serde_json::to_string(&sessions).unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(!serialized.contains("privateKey"));
        assert!(!serialized.contains("must-not-leak"));

        let read = service
            .read(&principal(), "session-one", None, 0, 0, 3)
            .await
            .unwrap();
        assert_eq!(read.frames.len(), 1);
        assert_eq!(read.frames[0].data_base64, BASE64_STANDARD.encode("abc"));
        assert!(read.truncated);
    }

    #[tokio::test]
    async fn write_control_requires_terminal_side_approval() {
        let (state, service) = test_service();
        state
            .sessions
            .write()
            .unwrap()
            .insert("session-one".to_owned(), native_session());

        let error = service
            .send_text(
                &principal(),
                "session-one",
                None,
                "uptime",
                true,
                "maintain server",
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, "CONTROL_APPROVAL_REQUIRED");
        assert_eq!(state.terminal_mcp.pending_requests().len(), 1);
    }
}
