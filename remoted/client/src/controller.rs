use crate::{
    network::{self, Session},
    storage::{self, Binding},
    ui::transfers::{self, Prepared, Transfer},
};
use anyhow::{Context, Result, bail, ensure};
use neko_remoted_protocol::{
    self as protocol, RelayAddress,
    code::DeviceCode,
    crypto::Identity,
    messages::{Event, FileEntry, Operation, Permission, Resource, Response},
    utf8::Decoder,
};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

mod connection_scope;
mod retry;
use connection_scope::ConnectionScope;
use retry::Retry;

const QUEUE: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Offline,
    Checking,
    RelayReady,
    Connecting,
    AwaitingApproval,
    Persisting,
    AwaitingReady,
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneKind {
    Terminal,
    Herdr,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pane {
    pub kind: PaneKind,
    pub stream: String,
    pub name: String,
    pub controller: bool,
    pub read_only: bool,
    pub exit: Option<i32>,
    pub gap: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Model {
    pub phase: Phase,
    pub relay: Option<RelayAddress>,
    pub bindings: Vec<Binding>,
    /// Selected saved host, retained while offline so the UI can retry it.
    pub active_binding: Option<Binding>,
    /// Workspace actions must carry this value through Client::send_for.
    pub generation: u64,
    /// True only while a session navigation request is awaiting its reply.
    pub opening: bool,
    pub reconnect_attempt: usize,
    pub reconnect_in_seconds: Option<u64>,
    pub fingerprint: String,
    pub permission: Option<Permission>,
    pub resources: Vec<Resource>,
    pub panes: Vec<Pane>,
    pub herdr_grant: String,
    pub herdr_panes: Vec<(String, String)>,
    pub herdr_response: Option<HerdrResponse>,
    pub file_grant: String,
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
    pub transfer: Option<TransferView>,
    pub error: String,
    pub notice: String,
}

#[derive(Clone, Debug)]
#[allow(
    dead_code,
    reason = "Typed RPC result exposed for the independently owned Herdr UI"
)]
pub struct HerdrResponse {
    pub grant: String,
    pub method: String,
    pub data: serde_json::Value,
}

#[derive(Clone, Debug)]
pub struct TransferView {
    pub name: String,
    pub offset: u64,
    pub total: u64,
    pub status: String,
    pub cancellable: bool,
}

impl Model {
    pub fn ready(&self) -> bool {
        self.phase == Phase::Ready
    }
    pub fn writable(&self) -> bool {
        self.ready() && self.permission == Some(Permission::Operate)
    }
    pub fn status(&self) -> &'static str {
        if self.reconnect_in_seconds.is_some() {
            return "连接中断，等待自动重连…";
        }
        match self.phase {
            Phase::Offline => "未连接",
            Phase::Checking => "正在检查 Relay…",
            Phase::RelayReady => "Relay 已验证，请配对或重连",
            Phase::Connecting => "正在连接设备…",
            Phase::AwaitingApproval => "等待主机用户明确批准，请在小橘核对设备指纹",
            Phase::Persisting => "主机已批准，正在安全保存绑定…",
            Phase::AwaitingReady => "绑定已保存，等待主机就绪…",
            Phase::Ready => {
                if self.writable() {
                    "已连接 · 可操作授权"
                } else {
                    "已连接 · 只读授权"
                }
            }
        }
    }
}

#[derive(Debug)]
pub enum Command {
    #[doc(hidden)]
    Scoped {
        generation: u64,
        command: Box<Command>,
    },
    Check(String),
    Pair {
        code: String,
        name: String,
    },
    Reconnect(Binding),
    Forget(Binding),
    Disconnect,
    /// Lifecycle detach: stop this process without disabling saved auto-connect.
    Suspend,
    Request(Operation),
    Upload {
        grant: String,
        directory: String,
    },
    Download {
        grant: String,
        path: String,
        name: String,
    },
    CancelTransfer,
}

pub enum Update {
    Model(Box<Model>),
    Output {
        stream: String,
        text: String,
        reset: bool,
    },
}

#[derive(Clone)]
pub struct Client {
    sender: mpsc::Sender<Command>,
    scope: Option<Arc<ConnectionScope>>,
}

impl Client {
    #[cfg(test)]
    pub(crate) fn fixture(sender: mpsc::Sender<Command>) -> Self {
        Self {
            sender,
            scope: None,
        }
    }
    pub fn send(&self, command: Command) -> Result<()> {
        let permit = self
            .sender
            .try_reserve()
            .map_err(|_| anyhow::anyhow!("操作队列繁忙或连接已关闭，请稍后重试"))?;
        if let Some(scope) = &self.scope {
            let generation = if command.changes_connection()
                || matches!(&command, Command::Forget(binding) if scope.is_selected(binding))
            {
                scope.advance()?
            } else {
                scope.current()
            };
            permit.send(Command::Scoped {
                generation,
                command: Box::new(command),
            });
        } else {
            permit.send(command);
        }
        Ok(())
    }

    /// Sends a workspace action only to the connection shown by the originating UI.
    pub fn send_for(&self, generation: u64, command: Command) -> Result<()> {
        if command.changes_connection() && !matches!(command, Command::Disconnect) {
            return self.send(command);
        }
        let permit = self
            .sender
            .try_reserve()
            .map_err(|_| anyhow::anyhow!("操作队列繁忙或连接已关闭，请稍后重试"))?;
        if let Some(scope) = &self.scope {
            ensure!(
                scope.current() == generation,
                "工作区已切换，旧页面操作已丢弃"
            );
            let generation = if matches!(command, Command::Disconnect)
                || matches!(&command, Command::Forget(binding) if scope.is_selected(binding))
            {
                scope
                    .advance_if_current(generation)
                    .context("工作区已切换，旧页面操作已丢弃")?
            } else {
                generation
            };
            permit.send(Command::Scoped {
                generation,
                command: Box::new(command),
            });
        } else {
            permit.send(command);
        }
        Ok(())
    }
}

impl Command {
    fn changes_connection(&self) -> bool {
        matches!(
            self,
            Self::Check(_)
                | Self::Pair { .. }
                | Self::Reconnect(_)
                | Self::Disconnect
                | Self::Suspend
        )
    }
}

pub fn start() -> (Client, mpsc::Receiver<Update>) {
    let (sender, commands) = mpsc::channel(QUEUE);
    let (updates, receiver) = mpsc::channel(QUEUE);
    let failure = updates.clone();
    let scope = Arc::new(ConnectionScope::default());
    let actor_scope = scope.clone();
    let launched = std::thread::Builder::new()
        .name("remoted-controller".into())
        .spawn(move || {
            match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => {
                    runtime.block_on(Actor::with_scope(updates, actor_scope).run(commands))
                }
                Err(error) => {
                    let _ = failure.blocking_send(Update::Model(Box::new(Model {
                        error: error.to_string(),
                        ..Model::default()
                    })));
                }
            }
        });
    if let Err(error) = launched {
        let _ = sender.try_send(Command::Suspend);
        eprintln!("启动远程控制器失败：{error}");
    }
    (
        Client {
            sender,
            scope: Some(scope),
        },
        receiver,
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Attachment {
    grant: String,
    pane: Option<String>,
}

#[derive(Clone)]
struct Restoration {
    attachment: Attachment,
    backend: String,
}

#[derive(Clone, Copy)]
enum ReconnectMode {
    Selected,
    Retry,
}

enum Pending {
    Ordinary,
    Attach(Attachment),
    Restore {
        previous: String,
        attachment: Attachment,
    },
    Detach(String),
    Herdr {
        grant: String,
        method: String,
    },
    Files(String),
    TransferStart,
    Transfer(String),
    Cancel(String),
    Identify,
}
struct Outstanding {
    kind: Pending,
    expires: Instant,
}
struct OutputState {
    decoder: Decoder,
    sequence: Option<u64>,
}
struct Preparation {
    generation: u64,
    cancel: Arc<AtomicBool>,
    grant: String,
    path: String,
}
enum PreparedResult {
    Prepared {
        generation: u64,
        result: Result<Option<Prepared>>,
    },
    Finished {
        generation: u64,
        result: Result<()>,
        size: u64,
    },
}

struct Actor {
    model: Model,
    scope: Arc<ConnectionScope>,
    retry: Retry,
    unknown_outcome: bool,
    attachments: HashMap<String, Attachment>,
    restoring: HashMap<String, Restoration>,
    session: Option<Session>,
    binding: Option<Binding>,
    identity: Option<Identity>,
    output: HashMap<String, OutputState>,
    outstanding: HashMap<u64, Outstanding>,
    updates: mpsc::Sender<Update>,
    prepare_tx: mpsc::Sender<PreparedResult>,
    prepare_rx: mpsc::Receiver<PreparedResult>,
    preparation: Option<Preparation>,
    prepared: Option<Prepared>,
    transfer: Option<Transfer>,
    cancelling: bool,
    finalizing: bool,
    finalizing_generation: Option<u64>,
    completed: Option<String>,
    handshake_deadline: Option<Instant>,
    last_received: Instant,
}

impl Actor {
    #[cfg(test)]
    fn new(updates: mpsc::Sender<Update>) -> Self {
        Self::with_scope(updates, Arc::new(ConnectionScope::default()))
    }

    fn with_scope(updates: mpsc::Sender<Update>, scope: Arc<ConnectionScope>) -> Self {
        let (prepare_tx, prepare_rx) = mpsc::channel(1);
        Self {
            model: Model::default(),
            scope,
            retry: Retry::default(),
            unknown_outcome: false,
            attachments: HashMap::new(),
            restoring: HashMap::new(),
            session: None,
            binding: None,
            identity: None,
            output: HashMap::new(),
            outstanding: HashMap::new(),
            updates,
            prepare_tx,
            prepare_rx,
            preparation: None,
            prepared: None,
            transfer: None,
            cancelling: false,
            finalizing: false,
            finalizing_generation: None,
            completed: None,
            handshake_deadline: None,
            last_received: Instant::now(),
        }
    }

    fn restore_preferences(&mut self, preferences: storage::Preferences) -> Option<Binding> {
        self.model.bindings = preferences.bindings;
        self.model.active_binding = preferences.selected.clone();
        preferences
            .auto_connect
            .then_some(preferences.selected)
            .flatten()
    }

    async fn publish(&self) {
        self.scope.select(self.model.active_binding.clone());
        let mut model = self.model.clone();
        model.opening = self.outstanding.values().any(|request| {
            matches!(&request.kind, Pending::Attach(_) | Pending::Restore { .. })
                || matches!(&request.kind, Pending::Herdr { method, .. } if method == "session.snapshot")
        });
        let _ = self.updates.send(Update::Model(Box::new(model))).await;
    }

    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        match storage::last_relay().await {
            Ok(relay) => self.model.relay = relay,
            Err(error) => self.model.error = format!("无法恢复 Relay 设置：{error:#}"),
        }
        let mut automatic = None;
        match storage::preferences().await {
            Ok(preferences) => automatic = self.restore_preferences(preferences),
            Err(error) => self.model.error = format!("无法读取安全设备和自动连接偏好：{error:#}"),
        }
        self.publish().await;
        if let Some(binding) = automatic
            && let Some(generation) = self.scope.advance_if_current(0)
        {
            self.model.generation = generation;
            self.retry.arm();
            let result = self.connect_binding(binding, ReconnectMode::Selected).await;
            self.connection_result(result).await;
            if self.model.generation == self.scope.current() {
                self.publish().await;
            }
        }
        let mut deadline = tokio::time::interval(Duration::from_secs(1));
        loop {
            enum Incoming {
                Command(Option<Command>),
                Response(Result<Response>),
                Prepared(PreparedResult),
                Tick,
            }
            let incoming = tokio::select! {
                command = commands.recv() => Incoming::Command(command),
                response = async { match self.session.as_mut() { Some(session) => session.receive().await, None => std::future::pending().await } } => Incoming::Response(response),
                Some(prepared) = self.prepare_rx.recv() => Incoming::Prepared(prepared),
                _ = deadline.tick() => Incoming::Tick,
                _ = self.updates.closed() => break,
            };
            let result = match incoming {
                Incoming::Command(None) => break,
                Incoming::Command(Some(command)) => self.command(command).await,
                Incoming::Response(Ok(response)) => match self.response(response).await {
                    Ok(false) => continue,
                    Ok(true) => Ok(()),
                    Err(error) => {
                        self.disconnected().await;
                        Err(error)
                    }
                },
                Incoming::Response(Err(error)) => {
                    self.disconnected().await;
                    Err(error)
                }
                Incoming::Prepared(prepared) => self.preparation_result(prepared).await,
                Incoming::Tick => {
                    if let Some(at) = self.retry.at {
                        if at > Instant::now() {
                            self.model.reconnect_in_seconds = Some(
                                at.saturating_duration_since(Instant::now())
                                    .as_millis()
                                    .div_ceil(1000) as u64,
                            );
                            self.publish().await;
                            continue;
                        }
                        self.retry.at = None;
                        self.model.reconnect_in_seconds = None;
                        if let Some(binding) = self.retry_target() {
                            self.connect_binding(binding, ReconnectMode::Retry).await
                        } else {
                            continue;
                        }
                    } else if self
                        .outstanding
                        .values()
                        .any(|request| request.expires < Instant::now())
                        || self
                            .handshake_deadline
                            .is_some_and(|deadline| deadline < Instant::now())
                        || (self.model.ready()
                            && self.last_received.elapsed() > Duration::from_secs(35))
                    {
                        self.disconnected().await;
                        Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "连接或请求超时，操作结果可能未知；只重连，不重放操作",
                        )
                        .into())
                    } else {
                        continue;
                    }
                }
            };
            if self.model.generation != self.scope.current() {
                continue;
            }
            self.connection_result(result).await;
            self.publish().await;
        }
        self.disconnected().await;
    }

    async fn disconnected(&mut self) {
        if self.retry.enabled {
            self.capture_restoration();
        }
        self.unknown_outcome |=
            !self.outstanding.is_empty() || self.transfer.is_some() || self.finalizing;
        if let Some(session) = self.session.take() {
            session.close().await;
        }
        self.binding = None;
        self.outstanding.clear();
        self.handshake_deadline = None;
        self.output.clear();
        self.model.phase = Phase::Offline;
        self.model.permission = None;
        self.model.resources.clear();
        for pane in &mut self.model.panes {
            pane.controller = false;
            pane.read_only = true;
        }
        self.model.herdr_panes.clear();
        self.model.herdr_response = None;
        self.model.herdr_grant.clear();
        self.model.entries.clear();
        self.model.file_grant.clear();
        self.model.path.clear();
        if let Some(preparation) = self.preparation.take() {
            preparation.cancel.store(true, Ordering::Release);
        }
        self.cleanup_transfer().await;
        self.finalizing = false;
        self.finalizing_generation = None;
        self.completed = None;
        if self.unknown_outcome {
            self.model.notice = self.outcome_notice();
        }
    }

    async fn detach_with_preference(
        &mut self,
        command: Command,
        persist_manual_stop: impl std::future::Future<Output = Result<()>>,
    ) -> Result<()> {
        self.stop_retry();
        self.disconnected().await;
        if matches!(command, Command::Disconnect) {
            self.model.notice = format!(
                "已断开，自动连接已停止；主机终端仍保留。{}",
                self.outcome_notice()
            );
            persist_manual_stop
                .await
                .context("已断开，但停止自动连接偏好未能安全保存")?;
        }
        Ok(())
    }

    fn capture_restoration(&mut self) {
        for pane in self.model.panes.iter().filter(|pane| pane.exit.is_none()) {
            if let Some(attachment) = self.attachments.get(&pane.stream)
                && let Some(resource) = self
                    .model
                    .resources
                    .iter()
                    .find(|r| r.id == attachment.grant)
            {
                self.restoring.insert(
                    pane.stream.clone(),
                    Restoration {
                        attachment: attachment.clone(),
                        backend: resource.backend.clone(),
                    },
                );
            }
        }
    }

    fn restoration_requests(&mut self) -> Vec<(String, Attachment)> {
        let before = self.restoring.len();
        self.restoring.retain(|_, saved| {
            self.model.resources.iter().any(|r| {
                r.id == saved.attachment.grant
                    && r.backend == saved.backend
                    && if saved.attachment.pane.is_some() {
                        r.herdr
                    } else {
                        r.terminal && r.backend != "herdr"
                    }
            })
        });
        if self.restoring.len() < before {
            self.model
                .notice
                .push_str("部分会话授权已变化，未自动恢复；请重新选择会话。");
        }
        self.restoring
            .iter()
            .map(|(stream, saved)| (stream.clone(), saved.attachment.clone()))
            .collect()
    }

    fn clear_workspace(&mut self) {
        self.output.clear();
        self.outstanding.clear();
        self.attachments.clear();
        self.restoring.clear();
        self.identity = None;
        self.model.panes.clear();
        self.model.permission = None;
        self.model.resources.clear();
        self.model.fingerprint.clear();
        self.model.herdr_grant.clear();
        self.model.herdr_panes.clear();
        self.model.herdr_response = None;
        self.model.file_grant.clear();
        self.model.path.clear();
        self.model.entries.clear();
        self.model.truncated = false;
        self.model.transfer = None;
        self.model.notice = self.outcome_notice();
    }

    fn outcome_notice(&self) -> String {
        if self.unknown_outcome {
            "上次连接的部分操作结果未知，未自动重放；请核对后再操作。".into()
        } else {
            String::new()
        }
    }

    async fn connection_result(&mut self, result: Result<()>) {
        let Err(error) = result else {
            return;
        };
        self.connection_failure(&error);
    }

    fn connection_failure(&mut self, error: &anyhow::Error) {
        self.model.error = format!("{error:#}");
        if self.session.is_some() || !self.retry.enabled {
            return;
        }
        if network::authentication_failure(error) {
            self.stop_retry();
            self.model.notice = format!(
                "认证或授权已失效，已停止自动重连；请在主机确认授权。{}",
                self.outcome_notice()
            );
        } else if network::retryable(error) && self.model.active_binding.is_some() {
            if let Some(delay) = self.retry.schedule(Instant::now()) {
                self.model.reconnect_attempt = self.retry.attempts;
                self.model.reconnect_in_seconds = Some(delay.as_secs());
                self.model.notice = self.outcome_notice();
            } else {
                self.stop_retry();
                self.model.notice = format!(
                    "自动重连已达到 5 次上限，请点击设备重试。{}",
                    self.outcome_notice()
                );
            }
        }
    }

    fn stop_retry(&mut self) {
        self.retry.stop();
        self.restoring.clear();
        self.model.reconnect_in_seconds = None;
        self.model.reconnect_attempt = 0;
    }

    fn retry_target(&mut self) -> Option<Binding> {
        let generation = self.scope.advance_if_current(self.model.generation)?;
        self.model.generation = generation;
        self.model.active_binding.clone()
    }

    async fn connect_binding(&mut self, binding: Binding, mode: ReconnectMode) -> Result<()> {
        let target = binding.clone();
        let relay = binding.relay.clone();
        self.reconnect_with(binding, mode, network::check_relay(&relay), async move {
            let identity = storage::identity().await?;
            let key = protocol::decode32(&target.host_key)?;
            let session = Session::connect(&target.relay, &target.route, &identity, &key).await?;
            Ok((identity, session))
        })
        .await
    }

    async fn reconnect_with(
        &mut self,
        binding: Binding,
        mode: ReconnectMode,
        check: impl std::future::Future<Output = Result<()>>,
        connect: impl std::future::Future<Output = Result<(Identity, Session)>>,
    ) -> Result<()> {
        storage::validate(&binding)?;
        ensure!(
            self.model.bindings.contains(&binding),
            "该配对已不存在或身份已变化，请从设备列表重新选择"
        );
        self.disconnected().await;
        let restoring = if matches!(mode, ReconnectMode::Retry)
            && self.model.active_binding.as_ref() == Some(&binding)
        {
            std::mem::take(&mut self.restoring)
        } else {
            HashMap::new()
        };
        self.clear_workspace();
        self.restoring = restoring;
        self.model.active_binding = Some(binding.clone());
        self.model.relay = Some(binding.relay.clone());
        self.model.fingerprint = protocol::fingerprint(&protocol::decode32(&binding.host_key)?);
        self.model.phase = Phase::Checking;
        self.publish().await;
        let scope = self.scope.clone();
        let generation = self.model.generation;
        let result: Result<()> = async {
            scope
                .during(generation, check)
                .await
                .context("目标设备的 Relay 检查失败")?;
            self.model.phase = Phase::Connecting;
            self.publish().await;
            let (identity, session) = scope
                .during(generation, connect)
                .await
                .context("目标主机连接失败")?;
            self.identity = Some(identity);
            self.binding = Some(binding);
            self.session = Some(session);
            self.model.phase = Phase::AwaitingReady;
            self.handshake_deadline = Some(Instant::now() + Duration::from_secs(30));
            self.last_received = Instant::now();
            Ok(())
        }
        .await;
        if let Err(error) = result {
            self.disconnected().await;
            return Err(error.context("设备连接未完成，配对已保留，可点击该设备重试"));
        }
        Ok(())
    }

    async fn preparation_result(&mut self, prepared: PreparedResult) -> Result<()> {
        let generation = match &prepared {
            PreparedResult::Prepared { generation, .. }
            | PreparedResult::Finished { generation, .. } => *generation,
        };
        if generation != self.model.generation || generation != self.scope.current() {
            if self
                .preparation
                .as_ref()
                .is_some_and(|p| p.generation == generation)
            {
                self.preparation
                    .take()
                    .expect("preparation checked")
                    .cancel
                    .store(true, Ordering::Release);
            }
            if self.finalizing_generation == Some(generation) {
                self.finalizing = false;
                self.finalizing_generation = None;
            }
            if let PreparedResult::Prepared {
                result: Ok(Some(prepared)),
                ..
            } = prepared
                && let Err(error) = transfers::cleanup(&prepared.handle, prepared.upload).await
            {
                eprintln!("旧连接文件句柄清理未确认：{error:#}");
            }
            return Ok(());
        }
        match prepared {
            PreparedResult::Prepared { result, .. } => self.prepared(result).await,
            PreparedResult::Finished { result, size, .. } => {
                self.finalizing = false;
                self.finalizing_generation = None;
                if let Some(view) = &mut self.model.transfer {
                    view.status = if result.is_ok() {
                        "传输完成 · SHA-256 已校验"
                    } else {
                        "文件提交失败；未确认保存"
                    }
                    .into();
                    view.offset = size;
                }
                result
            }
        }
    }

    async fn cleanup_transfer(&mut self) {
        let prepared = self
            .transfer
            .take()
            .map(|transfer| transfer.prepared)
            .or_else(|| self.prepared.take());
        if let Some(prepared) = prepared
            && let Err(error) = transfers::cleanup(&prepared.handle, prepared.upload).await
        {
            self.model.error = format!("文件清理未确认：{error:#}");
        }
        if let Some(view) = &mut self.model.transfer {
            view.cancellable = false;
            view.status = "已中断；未确认完成".into();
        }
        self.cancelling = false;
    }

    async fn request(&mut self, operation: Operation, kind: Pending) -> Result<()> {
        ensure!(self.outstanding.len() < 64, "待确认请求过多");
        let approval = matches!(kind, Pending::Identify);
        let scope = self.scope.clone();
        let result = scope
            .during(
                self.model.generation,
                self.session
                    .as_mut()
                    .context("尚未连接主机")?
                    .request(operation),
            )
            .await;
        let id = match result {
            Ok(id) => id,
            Err(error) => {
                self.unknown_outcome = true;
                self.disconnected().await;
                return Err(error.context("发送失败，操作结果可能未知；未自动重试"));
            }
        };
        self.outstanding.insert(
            id,
            Outstanding {
                kind,
                expires: Instant::now() + Duration::from_secs(if approval { 150 } else { 30 }),
            },
        );
        Ok(())
    }

    async fn command(&mut self, command: Command) -> Result<()> {
        let (generation, command) = match command {
            Command::Scoped {
                generation,
                command,
            } => (generation, *command),
            command => {
                let generation = if command.changes_connection()
                    || matches!(&command, Command::Forget(binding) if self.model.active_binding.as_ref() == Some(binding))
                {
                    self.scope.advance()?
                } else {
                    self.scope.current()
                };
                (generation, command)
            }
        };
        ensure!(
            generation == self.scope.current(),
            "工作区已切换，旧页面操作已丢弃"
        );
        if command.changes_connection()
            || matches!(&command, Command::Forget(binding) if self.model.active_binding.as_ref() == Some(binding))
        {
            self.model.generation = generation;
        }
        ensure!(
            generation == self.model.generation,
            "工作区已切换，旧页面操作已丢弃"
        );
        self.model.error.clear();
        match command {
            Command::Scoped { .. } => bail!("不接受嵌套工作区命令"),
            command @ (Command::Disconnect | Command::Suspend) => {
                self.detach_with_preference(command, storage::stop_auto_connect())
                    .await?;
            }
            Command::Forget(binding) => {
                if self.model.active_binding.as_ref() == Some(&binding) {
                    self.stop_retry();
                    self.disconnected().await;
                }
                self.model.bindings = storage::forget(&binding).await?;
                if self.model.active_binding.as_ref() == Some(&binding) {
                    self.model.active_binding = None;
                    self.clear_workspace();
                }
                self.model.notice =
                    "已忘记本机配对；主机授权未撤销，如需撤销请在小橘管理此设备。".into();
            }
            Command::Check(address) => {
                ensure!(
                    self.session.is_none() && self.preparation.is_none(),
                    "请先断开当前设备"
                );
                let relay = RelayAddress::parse(&address)?;
                self.stop_retry();
                self.clear_workspace();
                self.model.active_binding = None;
                self.model.phase = Phase::Checking;
                self.publish().await;
                if let Err(error) = self
                    .scope
                    .during(generation, network::check_relay(&relay))
                    .await
                {
                    self.model.phase = Phase::Offline;
                    return Err(error);
                }
                if let Err(error) = storage::remember_relay(&relay).await {
                    self.model.phase = Phase::Offline;
                    return Err(error.context("Relay 验证成功，但地址未能安全保存"));
                }
                self.model.relay = Some(relay);
                self.model.phase = Phase::RelayReady;
            }
            Command::Pair { code, name } => {
                ensure!(self.model.phase == Phase::RelayReady, "请先检查 Relay");
                ensure!(
                    !name.trim().is_empty() && name.len() <= 128,
                    "请输入 1–128 字节的设备名称"
                );
                let relay = self.model.relay.clone().context("尚未选择 Relay")?;
                let code = DeviceCode::parse(&code, &relay)?;
                self.stop_retry();
                self.clear_workspace();
                self.model.active_binding = None;
                self.model.phase = Phase::Connecting;
                self.publish().await;
                let scope = self.scope.clone();
                let result = scope
                    .during(generation, async {
                        self.identity = Some(storage::identity().await?);
                        let session = Session::pair(
                            &relay,
                            &code,
                            self.identity.as_ref().context("设备身份缺失")?,
                        )
                        .await?;
                        self.model.fingerprint = protocol::fingerprint(session.host_key());
                        self.binding = Some(Binding {
                            relay,
                            route: code.route().into(),
                            host_key: protocol::encode(session.host_key()),
                            device_id: String::new(),
                        });
                        self.session = Some(session);
                        self.model.panes.clear();
                        self.model.phase = Phase::AwaitingApproval;
                        self.handshake_deadline = Some(Instant::now() + Duration::from_secs(150));
                        self.request(
                            Operation::Identify {
                                name: name.trim().into(),
                            },
                            Pending::Identify,
                        )
                        .await
                    })
                    .await;
                if result.is_err() {
                    self.disconnected().await;
                    self.model.phase = Phase::RelayReady;
                }
                result?;
            }
            Command::Reconnect(binding) => {
                storage::validate(&binding)?;
                ensure!(
                    self.model.bindings.contains(&binding),
                    "设备配对已变化，请重新选择"
                );
                self.stop_retry();
                storage::select_binding(&binding)
                    .await
                    .context("所选设备偏好未能安全保存，未开始连接")?;
                ensure!(self.scope.current() == generation, "设备选择已变化");
                self.retry.arm();
                self.model.reconnect_attempt = 0;
                self.connect_binding(binding, ReconnectMode::Selected)
                    .await?;
            }
            Command::Request(operation) => {
                self.validate(&operation)?;
                let kind = match &operation {
                    Operation::TerminalAttach { grant, pane } => {
                        ensure!(
                            self.model.panes.len()
                                + self
                                    .outstanding
                                    .values()
                                    .filter(|request| matches!(
                                        request.kind,
                                        Pending::Attach(_) | Pending::Restore { .. }
                                    ))
                                    .count()
                                < 8,
                            "最多打开 8 个终端"
                        );
                        let attachment = Attachment {
                            grant: grant.clone(),
                            pane: pane.clone(),
                        };
                        ensure!(!self.outstanding.values().any(|request| matches!(&request.kind, Pending::Attach(active) | Pending::Restore { attachment: active, .. } if active == &attachment)), "此终端正在打开，请等待");
                        ensure!(
                            pane.is_none()
                                || !self
                                    .attachments
                                    .values()
                                    .any(|active| active == &attachment),
                            "此 Herdr 终端已打开"
                        );
                        Pending::Attach(attachment)
                    }
                    Operation::Herdr { grant, method, .. } => Pending::Herdr {
                        grant: grant.clone(),
                        method: method.clone(),
                    },
                    Operation::FileList { grant, .. } => Pending::Files(grant.clone()),
                    Operation::TerminalDetach { stream } => Pending::Detach(stream.clone()),
                    _ => Pending::Ordinary,
                };
                self.request(operation, kind).await?;
            }
            Command::Upload { grant, directory } => {
                self.resource(&grant, "files")?;
                ensure!(self.model.writable(), "只读设备不能上传");
                self.prepare(true, grant, directory, "文件").await?;
            }
            Command::Download { grant, path, name } => {
                self.resource(&grant, "files")?;
                self.prepare(false, grant, path, &name).await?;
            }
            Command::CancelTransfer => {
                ensure!(!self.finalizing, "文件正在提交，已不能取消");
                if let Some(preparation) = &self.preparation {
                    preparation.cancel.store(true, Ordering::Release);
                }
                self.cancelling = true;
                if let Some(view) = &mut self.model.transfer {
                    view.status = "正在取消，等待确认…".into();
                    view.cancellable = false;
                }
                if let Some(transfer) = &self.transfer {
                    self.request(
                        Operation::Cancel {
                            transfer: transfer.id.clone(),
                        },
                        Pending::Cancel(transfer.id.clone()),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    fn resource(&self, id: &str, capability: &str) -> Result<()> {
        ensure!(self.model.ready(), "主机尚未就绪");
        ensure!(
            self.model.resources.iter().any(|resource| resource.id == id
                && match capability {
                    "terminal" => resource.terminal && resource.backend != "herdr",
                    "herdr" => resource.herdr,
                    "files" => resource.files,
                    _ => false,
                }),
            "资源未授权或能力不可用"
        );
        Ok(())
    }

    fn validate(&self, operation: &Operation) -> Result<()> {
        ensure!(self.model.ready(), "主机尚未就绪");
        match operation {
            Operation::Resources {} => Ok(()),
            Operation::TerminalAttach { grant, pane } => {
                self.resource(grant, if pane.is_some() { "herdr" } else { "terminal" })
            }
            Operation::FileList { grant, .. } => self.resource(grant, "files"),
            Operation::Herdr { grant, method, .. } => {
                self.resource(grant, "herdr")?;
                ensure!(
                    protocol::messages::herdr_allowed(
                        self.model.permission.context("授权缺失")?,
                        method
                    ),
                    "Herdr 方法未授权"
                );
                Ok(())
            }
            Operation::TerminalDetach { stream } => {
                ensure!(
                    self.model.panes.iter().any(|pane| &pane.stream == stream),
                    "终端已关闭"
                );
                Ok(())
            }
            Operation::TerminalControl { stream, take } => {
                ensure!(!take || self.model.writable(), "设备只有只读授权");
                ensure!(
                    self.model
                        .panes
                        .iter()
                        .any(|pane| &pane.stream == stream && pane.exit.is_none()),
                    "终端已退出"
                );
                Ok(())
            }
            Operation::TerminalInput { stream, .. } | Operation::TerminalResize { stream, .. } => {
                ensure!(
                    self.model.writable()
                        && self.model.panes.iter().any(|pane| &pane.stream == stream
                            && pane.controller
                            && !pane.read_only
                            && pane.exit.is_none()),
                    "终端为只读，请先取得控制权"
                );
                Ok(())
            }
            _ => bail!("不能从 UI 直接发送该操作"),
        }
    }

    async fn prepare(
        &mut self,
        upload: bool,
        grant: String,
        path: String,
        name: &str,
    ) -> Result<()> {
        ensure!(
            self.preparation.is_none()
                && self.prepared.is_none()
                && self.transfer.is_none()
                && !self.finalizing,
            "请先完成或取消当前传输"
        );
        let cancel = Arc::new(AtomicBool::new(false));
        self.preparation = Some(Preparation {
            generation: self.model.generation,
            cancel: cancel.clone(),
            grant,
            path,
        });
        self.cancelling = false;
        self.model.transfer = Some(TransferView {
            name: name.into(),
            offset: 0,
            total: 0,
            status: if upload {
                "选择文件并流式计算 SHA-256…"
            } else {
                "选择保存位置…"
            }
            .into(),
            cancellable: true,
        });
        let sender = self.prepare_tx.clone();
        let generation = self.model.generation;
        let name = name.to_owned();
        tokio::spawn(async move {
            let result = transfers::prepare(upload, &name, cancel).await;
            if let Err(undelivered) = sender
                .send(PreparedResult::Prepared { generation, result })
                .await
                && let PreparedResult::Prepared {
                    result: Ok(Some(prepared)),
                    ..
                } = undelivered.0
            {
                let _ = transfers::cleanup(&prepared.handle, prepared.upload).await;
            }
        });
        Ok(())
    }

    async fn prepared(&mut self, result: Result<Option<Prepared>>) -> Result<()> {
        let preparation = self.preparation.take().context("传输准备状态缺失")?;
        let prepared = match result {
            Ok(Some(prepared)) => prepared,
            other => {
                self.model.transfer = None;
                self.cancelling = false;
                return other.map(|_| ());
            }
        };
        if preparation.cancel.load(Ordering::Acquire) || !self.model.ready() {
            transfers::cleanup(&prepared.handle, prepared.upload).await?;
            self.model.transfer = None;
            self.cancelling = false;
            return Ok(());
        }
        if let Some(view) = &mut self.model.transfer {
            view.name = prepared.name.clone();
            view.total = prepared.size;
            view.status = "等待主机开始传输…".into();
        }
        self.prepared = Some(prepared);
        let result = async {
            self.resource(&preparation.grant, "files")?;
            let prepared = self.prepared.as_ref().context("传输文件缺失")?;
            let operation = if prepared.upload {
                ensure!(self.model.writable(), "上传授权已失效");
                let path = transfers::remote_path(&preparation.path, &prepared.name)?;
                Operation::FileUpload {
                    grant: preparation.grant,
                    path,
                    size: prepared.size,
                    sha256: prepared.digest.clone(),
                    overwrite: false,
                }
            } else {
                Operation::FileDownload {
                    grant: preparation.grant,
                    path: preparation.path,
                }
            };
            self.request(operation, Pending::TransferStart).await
        }
        .await;
        if result.is_err() {
            self.cleanup_transfer().await;
        }
        result
    }

    async fn response(&mut self, response: Response) -> Result<bool> {
        self.last_received = Instant::now();
        let mut changed = true;
        let pending = self
            .outstanding
            .remove(&response.id)
            .map(|request| request.kind);
        match response.event {
            Event::Pending { fingerprint } => {
                ensure!(
                    self.model.phase == Phase::AwaitingApproval,
                    "非配对阶段收到批准等待"
                );
                self.model.notice = format!("本设备指纹：{fingerprint}");
            }
            Event::Approved {
                host_key,
                device_id,
                permission: _,
            } => {
                ensure!(
                    self.model.phase == Phase::AwaitingApproval,
                    "非配对阶段收到批准"
                );
                let mut binding = self.binding.clone().context("配对上下文缺失")?;
                ensure!(
                    binding.host_key == host_key
                        && protocol::decode32(&host_key)?
                            == *self.session.as_ref().context("连接已关闭")?.host_key(),
                    "主机公钥与加密握手不一致"
                );
                binding.device_id = device_id;
                self.model.phase = Phase::Persisting;
                self.publish().await;
                self.model.bindings = match storage::remember(binding.clone()).await {
                    Ok(bindings) => bindings,
                    Err(error) => {
                        self.disconnected().await;
                        return Err(error.context("安全保存失败，未发送配对确认"));
                    }
                };
                self.model.active_binding = Some(binding.clone());
                self.retry.arm();
                self.binding = Some(binding);
                self.request(Operation::AcknowledgePairing {}, Pending::Ordinary)
                    .await?;
                self.model.phase = Phase::AwaitingReady;
                self.handshake_deadline = Some(Instant::now() + Duration::from_secs(30));
            }
            Event::Ready {
                device_id,
                permission,
                resources,
            } => {
                ensure!(
                    self.model.phase == Phase::AwaitingReady
                        && self
                            .binding
                            .as_ref()
                            .is_some_and(|binding| binding.device_id == device_id),
                    "主机就绪身份不匹配"
                );
                self.outstanding.clear();
                self.model.phase = Phase::Ready;
                self.model.error.clear();
                self.handshake_deadline = None;
                self.model.permission = Some(permission);
                self.model.resources = ordinary_terminal_capabilities(resources);
                self.retry.at = None;
                self.retry.connected_at = Some(Instant::now());
                self.model.reconnect_in_seconds = None;
                self.model.notice = self.outcome_notice();
                let requests = self.restoration_requests();
                for (previous, attachment) in requests {
                    self.request(
                        Operation::TerminalAttach {
                            grant: attachment.grant.clone(),
                            pane: attachment.pane.clone(),
                        },
                        Pending::Restore {
                            previous,
                            attachment,
                        },
                    )
                    .await?;
                }
            }
            Event::Resources { resources } => {
                ensure!(self.model.ready(), "主机尚未就绪");
                self.model.resources = ordinary_terminal_capabilities(resources);
            }
            Event::Ping { nonce } => {
                self.session
                    .as_mut()
                    .context("连接已关闭")?
                    .request(Operation::Pong { nonce })
                    .await?;
                changed = false;
            }
            Event::Pong { .. } => {
                changed = false;
            }
            Event::Ok => {
                changed = false;
                if let Some(Pending::Detach(stream)) = pending {
                    self.model.panes.retain(|pane| pane.stream != stream);
                    self.attachments.remove(&stream);
                    self.output.remove(&stream);
                    changed = true;
                }
            }
            Event::TerminalAttached {
                stream,
                name,
                read_only,
            } => {
                let attachment = match pending {
                    Some(Pending::Attach(attachment)) => attachment,
                    Some(Pending::Restore {
                        previous,
                        attachment,
                    }) => {
                        self.restoring.remove(&previous);
                        attachment
                    }
                    _ => bail!("未请求的终端附着"),
                };
                ensure!(
                    self.model.panes.len() < 8 && !self.output.contains_key(&stream),
                    "终端重复或数量超限"
                );
                let kind = if attachment.pane.is_some() {
                    PaneKind::Herdr
                } else {
                    PaneKind::Terminal
                };
                self.attachments.insert(stream.clone(), attachment);
                self.output.insert(
                    stream.clone(),
                    OutputState {
                        decoder: Decoder::default(),
                        sequence: None,
                    },
                );
                self.model.panes.push(Pane {
                    kind,
                    stream,
                    name,
                    controller: false,
                    read_only,
                    exit: None,
                    gap: false,
                });
            }
            Event::TerminalControl { stream, controller } => {
                let pane = self
                    .model
                    .panes
                    .iter_mut()
                    .find(|pane| pane.stream == stream)
                    .context("未知终端控制事件")?;
                pane.controller = controller;
            }
            Event::TerminalOutput {
                stream,
                sequence,
                data,
                reset,
                gap,
                ..
            } => {
                let output = self.output.get_mut(&stream).context("未知终端输出")?;
                if output.sequence.is_some_and(|last| sequence <= last) {
                    return Ok(false);
                }
                let missing = output
                    .sequence
                    .is_some_and(|last| sequence > last.saturating_add(1));
                if reset {
                    output.decoder = Decoder::default();
                }
                let bytes = protocol::decode(&data, protocol::MAX_PLAINTEXT)?;
                let text = output.decoder.push(&bytes);
                output.sequence = Some(sequence);
                changed = false;
                if let Some(pane) = self
                    .model
                    .panes
                    .iter_mut()
                    .find(|pane| pane.stream == stream)
                {
                    changed = !pane.gap && (gap || missing);
                    pane.gap |= gap || missing;
                }
                self.updates
                    .send(Update::Output {
                        stream,
                        text,
                        reset,
                    })
                    .await
                    .context("界面已关闭")?;
            }
            Event::TerminalExit { stream, code } => {
                self.attachments.remove(&stream);
                self.restoring.remove(&stream);
                if let Some(output) = self.output.get_mut(&stream) {
                    self.updates
                        .send(Update::Output {
                            stream: stream.clone(),
                            text: output.decoder.finish(),
                            reset: false,
                        })
                        .await
                        .context("界面已关闭")?;
                }
                if let Some(pane) = self
                    .model
                    .panes
                    .iter_mut()
                    .find(|pane| pane.stream == stream)
                {
                    pane.exit = Some(code);
                    pane.controller = false;
                }
            }
            Event::Herdr { data } => {
                let Some(Pending::Herdr { grant, method }) = pending else {
                    bail!("未请求的 Herdr 回复");
                };
                if matches!(method.as_str(), "session.snapshot" | "pane.list") {
                    self.model.herdr_grant = grant.clone();
                    self.model.herdr_panes = crate::ui::herdr::panes(&data);
                }
                self.model.herdr_response = Some(HerdrResponse {
                    grant,
                    method,
                    data,
                });
            }
            Event::FileList {
                path,
                entries,
                truncated,
            } => {
                let Some(Pending::Files(grant)) = pending else {
                    bail!("未请求的文件列表");
                };
                self.model.file_grant = grant;
                self.model.path = path;
                self.model.entries = entries;
                self.model.truncated = truncated;
            }
            Event::TransferStarted { transfer, size } => {
                ensure!(
                    matches!(pending, Some(Pending::TransferStart)),
                    "未请求的文件传输"
                );
                ensure!(
                    size <= transfers::MAX_FILE_SIZE
                        && self
                            .prepared
                            .as_ref()
                            .is_some_and(|prepared| !prepared.upload || prepared.size == size),
                    "传输大小不匹配或超过上限"
                );
                let prepared = self.prepared.take().context("传输文件缺失")?;
                self.transfer = Some(Transfer::new(prepared, transfer.clone(), size)?);
                if let Some(view) = &mut self.model.transfer {
                    view.total = size;
                    view.status = "传输中…".into();
                }
                let operation = if self.cancelling {
                    Operation::Cancel { transfer }
                } else if self
                    .transfer
                    .as_ref()
                    .is_some_and(|transfer| transfer.prepared.upload)
                {
                    self.transfer
                        .as_mut()
                        .context("传输缺失")?
                        .next_upload()
                        .await?
                } else {
                    Operation::TransferAcknowledge {
                        transfer,
                        offset: 0,
                    }
                };
                let id = self.transfer.as_ref().context("传输缺失")?.id.clone();
                self.request(
                    operation,
                    if self.cancelling {
                        Pending::Cancel(id)
                    } else {
                        Pending::Transfer(id)
                    },
                )
                .await?;
            }
            Event::TransferProgress { transfer, offset } => {
                let active = self.transfer.as_mut().context("传输缺失")?;
                ensure!(active.id == transfer, "传输身份不匹配");
                active.progress(offset)?;
                if let Some(view) = &mut self.model.transfer {
                    view.offset = offset;
                }
                if !self.cancelling {
                    let operation = active.next_upload().await?;
                    self.request(operation, Pending::Transfer(transfer)).await?;
                }
            }
            Event::FileChunk {
                transfer,
                offset,
                data,
            } => {
                let active = self.transfer.as_mut().context("传输缺失")?;
                ensure!(active.id == transfer, "传输身份不匹配");
                if !self.cancelling {
                    let operation = active.download(offset, &data).await?;
                    if let Some(view) = &mut self.model.transfer {
                        view.offset = active.offset;
                    }
                    self.request(operation, Pending::Transfer(transfer)).await?;
                }
            }
            Event::TransferComplete {
                transfer,
                size,
                sha256,
            } => {
                let active = self.transfer.as_ref().context("传输缺失")?;
                ensure!(active.id == transfer, "传输身份不匹配");
                active.verify(size, &sha256)?;
                self.completed = Some(transfer);
                if self.cancelling && !active.prepared.upload {
                    self.cleanup_transfer().await;
                } else {
                    if let Some(view) = &mut self.model.transfer {
                        view.status = "校验通过，正在提交文件…".into();
                        view.cancellable = false;
                    }
                    self.publish().await;
                    if self.cancelling {
                        self.model.notice = "主机已完成上传，取消请求未能阻止提交。".into();
                    }
                    let active = self.transfer.take().context("传输缺失")?;
                    self.finalizing = true;
                    self.finalizing_generation = Some(self.model.generation);
                    let sender = self.prepare_tx.clone();
                    let generation = self.model.generation;
                    tokio::spawn(async move {
                        let result = active.complete().await;
                        let result = if let Err(error) = result {
                            match transfers::cleanup(
                                &active.prepared.handle,
                                active.prepared.upload,
                            )
                            .await
                            {
                                Ok(()) => Err(error),
                                Err(cleanup) => {
                                    Err(error.context(format!("清理也未确认：{cleanup:#}")))
                                }
                            }
                        } else {
                            result
                        };
                        let _ = sender
                            .send(PreparedResult::Finished {
                                generation,
                                result,
                                size,
                            })
                            .await;
                    });
                }
            }
            Event::Cancelled { transfer } => {
                if self.completed.as_ref() == Some(&transfer) {
                    return Ok(false);
                }
                ensure!(
                    self.transfer
                        .as_ref()
                        .is_some_and(|active| active.id == transfer),
                    "取消回复的传输身份不匹配"
                );
                self.cleanup_transfer().await;
                if let Some(view) = &mut self.model.transfer {
                    view.status = "主机已确认取消".into();
                }
            }
            Event::Error {
                code,
                message,
                outcome_unknown,
            } => {
                self.unknown_outcome |= outcome_unknown;
                if matches!(
                    code.as_str(),
                    "REQUEST_FAILED" | "QUEUE_FULL" | "DEVICE_BUSY"
                ) && self.model.ready()
                    && pending.is_some()
                {
                    match pending {
                        Some(Pending::Restore { previous, .. }) => {
                            self.restoring.remove(&previous);
                        }
                        Some(Pending::TransferStart) => self.cleanup_transfer().await,
                        Some(Pending::Cancel(id))
                            if self
                                .transfer
                                .as_ref()
                                .is_some_and(|transfer| transfer.id == id) =>
                        {
                            self.cleanup_transfer().await
                        }
                        Some(Pending::Transfer(id))
                            if self
                                .transfer
                                .as_ref()
                                .is_some_and(|transfer| transfer.id == id) =>
                        {
                            self.cancelling = true;
                            if let Some(view) = &mut self.model.transfer {
                                view.status = "传输失败，正在请求主机取消…".into();
                                view.cancellable = false;
                            }
                            self.request(
                                Operation::Cancel {
                                    transfer: id.clone(),
                                },
                                Pending::Cancel(id),
                            )
                            .await?;
                        }
                        _ => {}
                    }
                    self.model.error = format!(
                        "{code}：{message}{}",
                        if outcome_unknown {
                            "（结果未知；请核对后再操作）"
                        } else {
                            ""
                        }
                    );
                    return Ok(true);
                }
                if self.transfer.is_some() || self.prepared.is_some() {
                    self.cleanup_transfer().await;
                }
                if matches!(
                    code.to_ascii_lowercase().as_str(),
                    "revoked"
                        | "disabled"
                        | "unauthorized"
                        | "authentication_failed"
                        | "authorization_failed"
                ) {
                    return Err(
                        network::AuthenticationRejected(format!("{code}：{message}")).into(),
                    );
                }
                bail!(
                    "{code}：{message}{}",
                    if outcome_unknown {
                        "（结果未知；请核对后再操作）"
                    } else {
                        ""
                    }
                );
            }
        }
        Ok(changed)
    }
}

fn ordinary_terminal_capabilities(mut resources: Vec<Resource>) -> Vec<Resource> {
    for resource in &mut resources {
        if resource.backend == "herdr" {
            resource.terminal = false;
        }
    }
    resources
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor() -> Actor {
        Actor::new(mpsc::channel(32).0)
    }

    #[test]
    fn approval_is_not_ready_and_permission_is_not_control() {
        let mut actor = actor();
        actor.model.phase = Phase::AwaitingReady;
        actor.model.permission = Some(Permission::Operate);
        assert!(!actor.model.writable());
        actor.model.phase = Phase::Ready;
        actor.model.panes.push(Pane {
            kind: PaneKind::Terminal,
            stream: "s".into(),
            name: "shell".into(),
            controller: false,
            read_only: false,
            exit: None,
            gap: false,
        });
        let input = Operation::TerminalInput {
            stream: "s".into(),
            data: protocol::encode(b"rm"),
        };
        assert!(actor.validate(&input).is_err());
        actor.model.panes[0].controller = true;
        assert!(actor.validate(&input).is_ok());
        actor.model.permission = Some(Permission::ReadOnly);
        assert!(actor.validate(&input).is_err());
    }

    #[test]
    fn resources_are_exact_capability_grants() {
        let mut actor = actor();
        actor.model.phase = Phase::Ready;
        actor.model.resources.push(Resource {
            id: "grant".into(),
            name: "host".into(),
            backend: "ssh".into(),
            terminal: true,
            herdr: false,
            files: false,
        });
        assert!(actor.resource("grant", "terminal").is_ok());
        assert!(actor.resource("other", "terminal").is_err());
        assert!(actor.resource("grant", "files").is_err());
        assert!(actor.resource("grant", "herdr").is_err());
    }

    #[tokio::test]
    async fn output_decodes_split_utf8_resets_pending_bytes_and_flags_missing_sequences() {
        let (sender, mut receiver) = mpsc::channel(32);
        let mut actor = Actor::new(sender);
        actor.model.phase = Phase::Ready;
        actor.model.panes.push(Pane {
            kind: PaneKind::Terminal,
            stream: "stream".into(),
            name: "terminal".into(),
            controller: false,
            read_only: true,
            exit: None,
            gap: false,
        });
        actor.output.insert(
            "stream".into(),
            OutputState {
                decoder: Decoder::default(),
                sequence: None,
            },
        );
        let character = "猫".as_bytes();
        for (sequence, bytes, reset) in [
            (1, &character[..2], false),
            (2, &character[2..], false),
            (3, &[0xf0][..], false),
            (4, &b"prompt"[..], true),
            (4, &b"stale"[..], true),
            (7, &b"tail"[..], false),
        ] {
            actor
                .response(Response {
                    id: 0,
                    event: Event::TerminalOutput {
                        stream: "stream".into(),
                        sequence,
                        data: protocol::encode(bytes),
                        replay: reset,
                        reset,
                        gap: false,
                    },
                })
                .await
                .unwrap();
        }
        let mut emitted = Vec::new();
        while let Ok(Update::Output { text, reset, .. }) = receiver.try_recv() {
            emitted.push((text, reset));
        }
        assert_eq!(
            emitted,
            vec![
                ("".into(), false),
                ("猫".into(), false),
                ("".into(), false),
                ("prompt".into(), true),
                ("tail".into(), false)
            ]
        );
        assert!(actor.model.panes[0].gap);
        actor
            .response(Response {
                id: 0,
                event: Event::TerminalExit {
                    stream: "stream".into(),
                    code: 17,
                },
            })
            .await
            .unwrap();
        assert_eq!(actor.model.panes[0].exit, Some(17));
        assert!(!actor.model.panes[0].controller);
    }

    #[tokio::test]
    async fn ready_requires_saved_device_identity_and_correct_phase() {
        let mut actor = actor();
        actor.binding = Some(Binding {
            relay: RelayAddress::parse("https://relay.example.com").unwrap(),
            route: protocol::encode(&[1; 32]),
            host_key: protocol::encode(&[2; 32]),
            device_id: "expected".into(),
        });
        actor.model.phase = Phase::AwaitingApproval;
        assert!(
            actor
                .response(Response {
                    id: 0,
                    event: Event::Ready {
                        device_id: "expected".into(),
                        permission: Permission::Operate,
                        resources: Vec::new()
                    }
                })
                .await
                .is_err()
        );
        actor.model.phase = Phase::AwaitingReady;
        assert!(
            actor
                .response(Response {
                    id: 0,
                    event: Event::Ready {
                        device_id: "wrong".into(),
                        permission: Permission::Operate,
                        resources: Vec::new()
                    }
                })
                .await
                .is_err()
        );
        actor
            .response(Response {
                id: 0,
                event: Event::Ready {
                    device_id: "expected".into(),
                    permission: Permission::ReadOnly,
                    resources: Vec::new(),
                },
            })
            .await
            .unwrap();
        assert!(actor.model.ready());
        assert!(!actor.model.writable());
    }

    #[test]
    fn ui_command_backpressure_is_explicit_and_bounded() {
        let (sender, _receiver) = mpsc::channel(1);
        let client = Client::fixture(sender);
        client.send(Command::Disconnect).unwrap();
        assert!(client.send(Command::Disconnect).is_err());
    }

    #[tokio::test]
    async fn failed_upload_request_preserves_attached_terminal_and_workspace() {
        let mut actor = actor();
        actor.model.phase = Phase::Ready;
        actor.model.permission = Some(Permission::Operate);
        actor.model.panes.push(Pane {
            kind: PaneKind::Terminal,
            stream: "stream".into(),
            name: "shell".into(),
            controller: true,
            read_only: false,
            exit: None,
            gap: false,
        });
        actor.output.insert(
            "stream".into(),
            OutputState {
                decoder: Decoder::default(),
                sequence: None,
            },
        );
        actor.outstanding.insert(
            4,
            Outstanding {
                kind: Pending::TransferStart,
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
        assert!(
            actor
                .response(Response {
                    id: 4,
                    event: Event::Error {
                        code: "REQUEST_FAILED".into(),
                        message: "destination exists; overwrite disabled".into(),
                        outcome_unknown: false
                    }
                })
                .await
                .unwrap()
        );
        assert!(actor.model.ready());
        assert!(actor.model.writable());
        assert!(actor.model.panes[0].controller);
        assert!(actor.output.contains_key("stream"));
        assert!(actor.model.error.contains("overwrite disabled"));
        assert!(actor.outstanding.is_empty());
    }

    #[tokio::test]
    async fn failed_directory_list_does_not_cancel_an_unrelated_transfer() {
        let mut actor = actor();
        actor.model.phase = Phase::Ready;
        actor.transfer = Some(
            Transfer::new(
                Prepared {
                    handle: "unrelated".into(),
                    name: "file".into(),
                    size: 3,
                    digest: String::new(),
                    upload: true,
                },
                "transfer".into(),
                3,
            )
            .unwrap(),
        );
        actor.outstanding.insert(
            8,
            Outstanding {
                kind: Pending::Files("grant".into()),
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
        actor
            .response(Response {
                id: 8,
                event: Event::Error {
                    code: "REQUEST_FAILED".into(),
                    message: "file not found".into(),
                    outcome_unknown: false,
                },
            })
            .await
            .unwrap();
        assert!(actor.model.ready());
        assert_eq!(actor.transfer.as_ref().unwrap().id, "transfer");
    }

    #[tokio::test]
    async fn failed_late_cancel_cannot_cleanup_a_new_transfer() {
        let mut actor = actor();
        actor.model.phase = Phase::Ready;
        actor.transfer = Some(
            Transfer::new(
                Prepared {
                    handle: "new-handle".into(),
                    name: "new-file".into(),
                    size: 3,
                    digest: String::new(),
                    upload: true,
                },
                "new-transfer".into(),
                3,
            )
            .unwrap(),
        );
        actor.outstanding.insert(
            9,
            Outstanding {
                kind: Pending::Cancel("old-transfer".into()),
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
        actor
            .response(Response {
                id: 9,
                event: Event::Error {
                    code: "REQUEST_FAILED".into(),
                    message: "old cancel failed".into(),
                    outcome_unknown: true,
                },
            })
            .await
            .unwrap();
        assert_eq!(actor.transfer.as_ref().unwrap().id, "new-transfer");
        assert!(actor.model.ready());
        assert!(actor.model.error.contains("结果未知"));
    }

    #[tokio::test]
    async fn authorization_and_unsolicited_errors_remain_fatal() {
        for (id, code) in [(3, "AUTHORIZATION_FAILED"), (0, "REQUEST_FAILED")] {
            let mut actor = actor();
            actor.model.phase = Phase::Ready;
            actor.outstanding.insert(
                3,
                Outstanding {
                    kind: Pending::Files("grant".into()),
                    expires: Instant::now() + Duration::from_secs(30),
                },
            );
            assert!(
                actor
                    .response(Response {
                        id,
                        event: Event::Error {
                            code: code.into(),
                            message: "denied".into(),
                            outcome_unknown: false
                        }
                    })
                    .await
                    .is_err()
            );
        }
    }
    fn saved_binding(index: u8) -> Binding {
        Binding {
            relay: RelayAddress::parse("https://relay.example.com").unwrap(),
            route: protocol::encode(&[index; 32]),
            host_key: protocol::encode(&[index + 1; 32]),
            device_id: format!("device-{index}"),
        }
    }

    #[tokio::test]
    async fn reconnect_from_ready_or_offline_checks_target_and_clears_the_old_workspace() {
        for phase in [Phase::Ready, Phase::Offline] {
            let (sender, mut updates) = mpsc::channel(32);
            let mut actor = Actor::new(sender);
            let old = saved_binding(1);
            let target = saved_binding(3);
            actor.model.phase = phase;
            actor.model.bindings = vec![old.clone(), target.clone()];
            actor.model.active_binding = Some(old);
            actor.model.resources.push(Resource {
                id: "shared-grant".into(),
                name: "old".into(),
                backend: "ssh".into(),
                terminal: true,
                herdr: false,
                files: true,
            });
            actor.model.panes.push(Pane {
                kind: PaneKind::Terminal,
                stream: "old-stream".into(),
                name: "old".into(),
                controller: true,
                read_only: false,
                exit: None,
                gap: false,
            });
            actor
                .model
                .herdr_panes
                .push(("old-pane".into(), "old".into()));
            actor.model.path = "old/path".into();
            actor.outstanding.insert(
                7,
                Outstanding {
                    kind: Pending::Ordinary,
                    expires: Instant::now() + Duration::from_secs(30),
                },
            );
            let result = actor
                .reconnect_with(
                    target.clone(),
                    ReconnectMode::Selected,
                    async { Err(anyhow::anyhow!("health fixture failed")) },
                    async { panic!("connect must not run after failed relay validation") },
                )
                .await;
            assert!(result.is_err());
            assert_eq!(actor.model.active_binding, Some(target));
            assert_eq!(actor.model.bindings.len(), 2);
            assert_eq!(actor.model.phase, Phase::Offline);
            assert!(
                actor.model.panes.is_empty()
                    && actor.model.resources.is_empty()
                    && actor.model.herdr_panes.is_empty()
                    && actor.model.path.is_empty()
                    && actor.outstanding.is_empty()
            );
            let Some(Update::Model(model)) = updates.recv().await else {
                panic!("missing startup state")
            };
            assert_eq!(model.phase, Phase::Checking);
            assert!(model.active_binding.is_some());
        }
    }

    #[tokio::test]
    async fn queued_commands_and_old_ui_events_cannot_enter_the_next_host() {
        let mut actor = actor();
        let (sender, mut commands) = mpsc::channel(8);
        let client = Client {
            sender,
            scope: Some(actor.scope.clone()),
        };
        client
            .send_for(0, Command::Request(Operation::Resources {}))
            .unwrap();
        client.send(Command::Reconnect(saved_binding(1))).unwrap();
        assert!(
            client
                .send_for(0, Command::Request(Operation::Resources {}))
                .is_err()
        );
        assert!(client.send_for(0, Command::Disconnect).is_err());
        let error = actor
            .command(commands.recv().await.unwrap())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("工作区已切换"));
        assert!(actor.outstanding.is_empty());
    }

    #[tokio::test]
    async fn newer_device_selection_cancels_an_inflight_relay_check() {
        let mut actor = actor();
        let target = saved_binding(1);
        actor.model.bindings.push(target.clone());
        let scope = actor.scope.clone();
        let (result, _) = tokio::join!(
            actor.reconnect_with(
                target,
                ReconnectMode::Selected,
                std::future::pending(),
                async { panic!("superseded check must never connect") }
            ),
            async move {
                tokio::task::yield_now().await;
                scope.advance().unwrap();
            }
        );
        assert!(format!("{:#}", result.unwrap_err()).contains("取消"));
        assert!(actor.session.is_none());
    }

    #[tokio::test]
    async fn old_file_preparation_and_finalization_results_do_not_touch_new_transfer() {
        let mut actor = actor();
        actor.model.generation = actor.scope.advance().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        actor.preparation = Some(Preparation {
            generation: 1,
            cancel: cancel.clone(),
            grant: "new-grant".into(),
            path: "new".into(),
        });
        actor.finalizing = true;
        actor.finalizing_generation = Some(1);
        actor.model.transfer = Some(TransferView {
            name: "new-file".into(),
            offset: 9,
            total: 10,
            status: "new-transfer".into(),
            cancellable: false,
        });
        actor
            .preparation_result(PreparedResult::Prepared {
                generation: 0,
                result: Err(anyhow::anyhow!("old picker failed")),
            })
            .await
            .unwrap();
        actor
            .preparation_result(PreparedResult::Finished {
                generation: 0,
                result: Ok(()),
                size: 100,
            })
            .await
            .unwrap();
        assert!(actor.preparation.is_some() && actor.finalizing && !cancel.load(Ordering::Acquire));
        assert_eq!(actor.model.transfer.as_ref().unwrap().offset, 9);
        assert_eq!(
            actor.model.transfer.as_ref().unwrap().status,
            "new-transfer"
        );
    }

    #[tokio::test]
    async fn attach_kind_uses_the_request_and_non_listing_herdr_reply_preserves_panes() {
        let mut actor = actor();
        actor.model.phase = Phase::Ready;
        for (id, pane, kind) in [
            (1, None, PaneKind::Terminal),
            (2, Some("herdr-pane".into()), PaneKind::Herdr),
        ] {
            actor.outstanding.insert(
                id,
                Outstanding {
                    kind: Pending::Attach(Attachment {
                        grant: "grant".into(),
                        pane,
                    }),
                    expires: Instant::now() + Duration::from_secs(30),
                },
            );
            actor
                .response(Response {
                    id,
                    event: Event::TerminalAttached {
                        stream: format!("s{id}"),
                        name: "shell".into(),
                        read_only: true,
                    },
                })
                .await
                .unwrap();
            assert_eq!(actor.model.panes.last().unwrap().kind, kind);
        }
        actor.model.herdr_grant = "grant".into();
        actor.model.herdr_panes = vec![("keep".into(), "Shell".into())];
        actor.outstanding.insert(
            3,
            Outstanding {
                kind: Pending::Herdr {
                    grant: "grant".into(),
                    method: "agent.read".into(),
                },
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
        actor
            .response(Response {
                id: 3,
                event: Event::Herdr {
                    data: serde_json::json!({"text":"agent status"}),
                },
            })
            .await
            .unwrap();
        assert_eq!(actor.model.herdr_panes, [("keep".into(), "Shell".into())]);
        assert_eq!(
            actor.model.herdr_response.as_ref().unwrap().method,
            "agent.read"
        );
        let resources = ordinary_terminal_capabilities(vec![Resource {
            id: "herdr".into(),
            name: "Herdr".into(),
            backend: "herdr".into(),
            terminal: true,
            herdr: true,
            files: false,
        }]);
        assert!(!resources[0].terminal && resources[0].herdr);
        actor.model.resources = resources;
        assert!(
            actor
                .validate(&Operation::TerminalAttach {
                    grant: "herdr".into(),
                    pane: None
                })
                .is_err()
        );
        assert!(
            actor
                .validate(&Operation::TerminalAttach {
                    grant: "herdr".into(),
                    pane: Some("p".into())
                })
                .is_ok()
        );
    }

    #[test]
    fn startup_restores_selection_but_manual_stop_is_not_auto_connected() {
        let mut actor = actor();
        let binding = saved_binding(1);
        let automatic = actor.restore_preferences(storage::Preferences {
            bindings: vec![binding.clone()],
            selected: Some(binding.clone()),
            auto_connect: true,
        });
        assert_eq!(automatic, Some(binding.clone()));
        assert_eq!(actor.model.active_binding, Some(binding.clone()));
        assert!(
            actor
                .restore_preferences(storage::Preferences {
                    bindings: vec![binding.clone()],
                    selected: Some(binding),
                    auto_connect: false
                })
                .is_none()
        );
    }

    #[tokio::test]
    async fn transient_retry_never_keeps_pending_requests_or_transfer_for_replay() {
        let mut actor = actor();
        let binding = saved_binding(1);
        actor.model.active_binding = Some(binding.clone());
        actor.model.bindings.push(binding);
        actor.retry.arm();
        actor.outstanding.insert(
            1,
            Outstanding {
                kind: Pending::Ordinary,
                expires: Instant::now(),
            },
        );
        actor.disconnected().await;
        actor
            .connection_result(Err(std::io::Error::from(
                std::io::ErrorKind::ConnectionAborted,
            )
            .into()))
            .await;
        assert!(actor.retry.at.is_some());
        assert_eq!(actor.model.reconnect_attempt, 1);
        assert!(
            actor.session.is_none() && actor.outstanding.is_empty() && actor.transfer.is_none()
        );
        assert!(actor.model.notice.contains("结果未知"));
        actor.stop_retry();
        assert!(actor.retry.at.is_none() && !actor.retry.enabled);
    }
    #[test]
    fn authorization_failure_clears_pending_retry_until_explicit_reconnect() {
        let mut actor = actor();
        actor.retry.arm();
        actor.model.active_binding = Some(saved_binding(1));
        actor.retry.schedule(Instant::now()).unwrap();
        actor.connection_failure(&network::AuthenticationRejected("revoked".into()).into());
        assert!(!actor.retry.enabled && actor.retry.at.is_none());
        assert!(actor.model.notice.contains("停止自动重连"));
    }
    #[test]
    fn background_retry_cannot_supersede_a_queued_explicit_device_selection() {
        let mut actor = actor();
        actor.model.active_binding = Some(saved_binding(1));
        actor.retry.arm();
        let (sender, mut commands) = mpsc::channel(8);
        let client = Client {
            sender,
            scope: Some(actor.scope.clone()),
        };
        client.send(Command::Reconnect(saved_binding(2))).unwrap();
        assert!(actor.retry_target().is_none());
        assert_eq!(actor.scope.current(), 1);
        assert!(matches!(
            commands.try_recv().unwrap(),
            Command::Scoped { generation: 1, .. }
        ));
    }
    #[test]
    fn forgetting_selected_host_invalidates_retry_before_controller_receives_it() {
        let mut actor = actor();
        let binding = saved_binding(1);
        actor.model.active_binding = Some(binding.clone());
        actor.scope.select(Some(binding.clone()));
        actor.retry.arm();
        let (sender, mut commands) = mpsc::channel(8);
        let client = Client {
            sender,
            scope: Some(actor.scope.clone()),
        };
        client.send_for(0, Command::Forget(binding)).unwrap();
        assert!(actor.retry_target().is_none());
        assert!(matches!(
            commands.try_recv().unwrap(),
            Command::Scoped { generation: 1, .. }
        ));
    }
    fn opened_actor() -> Actor {
        let mut actor = actor();
        let binding = saved_binding(1);
        actor.model.active_binding = Some(binding.clone());
        actor.model.bindings.push(binding);
        actor.model.phase = Phase::Ready;
        actor.model.permission = Some(Permission::Operate);
        actor.retry.arm();
        for (stream, grant, pane, exit) in [
            ("shell", "terminal", None, None),
            ("herdr", "herdr", Some("pane-1"), None),
            ("exited", "terminal", None, Some(0)),
        ] {
            actor.model.panes.push(Pane {
                kind: if pane.is_some() {
                    PaneKind::Herdr
                } else {
                    PaneKind::Terminal
                },
                stream: stream.into(),
                name: stream.into(),
                controller: true,
                read_only: false,
                exit,
                gap: false,
            });
            actor.attachments.insert(
                stream.into(),
                Attachment {
                    grant: grant.into(),
                    pane: pane.map(str::to_owned),
                },
            );
        }
        actor.model.resources = vec![
            Resource {
                id: "terminal".into(),
                name: "shell".into(),
                backend: "ssh".into(),
                terminal: true,
                herdr: false,
                files: false,
            },
            Resource {
                id: "herdr".into(),
                name: "Herdr".into(),
                backend: "herdr".into(),
                terminal: false,
                herdr: true,
                files: false,
            },
        ];
        actor
    }

    #[tokio::test]
    async fn lifecycle_suspend_preserves_auto_preference_but_manual_disconnect_disables_it() {
        for command in [Command::Suspend, Command::Disconnect] {
            let manual = matches!(command, Command::Disconnect);
            let mut actor = opened_actor();
            let auto = AtomicBool::new(true);
            let (session, mut requests) = Session::observed();
            actor.session = Some(session);
            actor.capture_restoration();
            let cancel = Arc::new(AtomicBool::new(false));
            actor.preparation = Some(Preparation {
                generation: 0,
                cancel: cancel.clone(),
                grant: "g".into(),
                path: "p".into(),
            });
            actor.outstanding.insert(
                1,
                Outstanding {
                    kind: Pending::Ordinary,
                    expires: Instant::now(),
                },
            );
            actor
                .detach_with_preference(command, async {
                    auto.store(false, Ordering::Release);
                    Ok(())
                })
                .await
                .unwrap();
            assert_eq!(auto.load(Ordering::Acquire), !manual);
            assert!(actor.session.is_none() && !actor.retry.enabled && actor.retry.at.is_none());
            assert!(actor.outstanding.is_empty() && actor.restoring.is_empty());
            assert!(cancel.load(Ordering::Acquire));
            assert!(
                actor
                    .model
                    .panes
                    .iter()
                    .all(|p| !p.controller && p.read_only)
            );
            assert!(actor.model.active_binding.is_some());
            assert!(
                requests.recv().await.is_none(),
                "detach must not send control/input/close-PTY operations"
            );
            let preferences = storage::Preferences {
                bindings: actor.model.bindings.clone(),
                selected: actor.model.active_binding.clone(),
                auto_connect: auto.load(Ordering::Acquire),
            };
            assert_eq!(actor.restore_preferences(preferences).is_some(), !manual);
        }
    }

    #[tokio::test]
    async fn lifecycle_suspend_is_global_even_when_ui_generation_lags_retry() {
        let mut actor = opened_actor();
        actor.model.generation = actor.scope.advance().unwrap();
        let (sender, mut commands) = mpsc::channel(8);
        let client = Client {
            sender,
            scope: Some(actor.scope.clone()),
        };
        client.send_for(0, Command::Suspend).unwrap();
        assert!(actor.retry_target().is_none());
        actor.command(commands.recv().await.unwrap()).await.unwrap();
        assert!(!actor.retry.enabled && actor.session.is_none());
        assert_eq!(actor.model.generation, 2);
    }

    #[tokio::test]
    async fn automatic_retry_restores_only_confirmed_live_sessions_without_control_or_input() {
        let mut actor = opened_actor();
        let resources = actor.model.resources.clone();
        let target = actor.model.active_binding.clone().unwrap();
        actor.disconnected().await;
        assert_eq!(actor.restoring.len(), 2);
        for _ in 0..2 {
            let failed = actor
                .reconnect_with(
                    target.clone(),
                    ReconnectMode::Retry,
                    async {
                        Err(std::io::Error::from(std::io::ErrorKind::ConnectionAborted).into())
                    },
                    async { panic!("failed check must not connect") },
                )
                .await;
            assert!(failed.is_err());
            assert_eq!(
                actor.restoring.len(),
                2,
                "failed attempts must retain restore descriptors"
            );
        }
        let (session, mut requests) = Session::observed();
        actor.session = Some(session);
        actor.binding = Some(target.clone());
        actor.model.phase = Phase::AwaitingReady;
        actor
            .response(Response {
                id: 0,
                event: Event::Ready {
                    device_id: target.device_id,
                    permission: Permission::Operate,
                    resources,
                },
            })
            .await
            .unwrap();
        assert_eq!(actor.outstanding.len(), 2);
        for _ in 0..2 {
            let request = requests.recv().await.unwrap();
            assert!(
                matches!(request.operation, Operation::TerminalAttach { .. }),
                "only attach may be replayed"
            );
            actor
                .response(Response {
                    id: request.id,
                    event: Event::TerminalAttached {
                        stream: format!("new-{}", request.id),
                        name: "resumed".into(),
                        read_only: false,
                    },
                })
                .await
                .unwrap();
        }
        assert!(requests.try_recv().is_err());
        assert!(actor.restoring.is_empty());
        assert_eq!(actor.model.panes.len(), 2);
        assert!(
            actor
                .model
                .panes
                .iter()
                .all(|p| !p.controller && p.exit.is_none())
        );
        assert!(
            actor
                .validate(&Operation::TerminalInput {
                    stream: actor.model.panes[0].stream.clone(),
                    data: "unsafe".into()
                })
                .is_err()
        );
        actor.disconnected().await;
        assert!(requests.recv().await.is_none());
    }

    #[tokio::test]
    async fn fresh_grants_and_explicit_selection_bound_session_restoration() {
        let mut actor = opened_actor();
        actor.capture_restoration();
        actor.model.resources[0].backend = "different-target-backend".into();
        let requests = actor.restoration_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].1.pane.as_deref(), Some("pane-1"));
        assert!(actor.model.notice.contains("授权已变化"));
        for same_host in [true, false] {
            let mut actor = opened_actor();
            let target = if same_host {
                saved_binding(1)
            } else {
                saved_binding(3)
            };
            if !same_host {
                actor.model.bindings.push(target.clone());
            }
            let failed = actor
                .reconnect_with(
                    target,
                    ReconnectMode::Selected,
                    async { Err(anyhow::anyhow!("fixture offline")) },
                    async { panic!("check failed") },
                )
                .await;
            assert!(failed.is_err());
            assert!(
                actor.restoring.is_empty()
                    && actor.attachments.is_empty()
                    && actor.model.panes.is_empty()
            );
        }
    }

    #[tokio::test]
    async fn opening_tracks_navigation_and_clears_after_success_failure_or_disconnect() {
        let (sender, mut updates) = mpsc::channel(8);
        let mut actor = Actor::new(sender);
        actor.model.phase = Phase::Ready;
        for (kind, opening) in [
            (Pending::Ordinary, false),
            (
                Pending::Herdr {
                    grant: "g".into(),
                    method: "agent.read".into(),
                },
                false,
            ),
            (
                Pending::Herdr {
                    grant: "g".into(),
                    method: "session.snapshot".into(),
                },
                true,
            ),
            (
                Pending::Attach(Attachment {
                    grant: "g".into(),
                    pane: None,
                }),
                true,
            ),
        ] {
            actor.outstanding.insert(
                1,
                Outstanding {
                    kind,
                    expires: Instant::now(),
                },
            );
            actor.publish().await;
            let Some(Update::Model(model)) = updates.recv().await else {
                panic!("missing model")
            };
            assert_eq!(model.opening, opening);
        }
        actor
            .response(Response {
                id: 1,
                event: Event::Error {
                    code: "REQUEST_FAILED".into(),
                    message: "fixture failed".into(),
                    outcome_unknown: false,
                },
            })
            .await
            .unwrap();
        actor.publish().await;
        let Some(Update::Model(model)) = updates.recv().await else {
            panic!("missing model")
        };
        assert!(!model.opening);
        actor.outstanding.insert(
            2,
            Outstanding {
                kind: Pending::Attach(Attachment {
                    grant: "g".into(),
                    pane: None,
                }),
                expires: Instant::now(),
            },
        );
        actor
            .response(Response {
                id: 2,
                event: Event::TerminalAttached {
                    stream: "s".into(),
                    name: "shell".into(),
                    read_only: true,
                },
            })
            .await
            .unwrap();
        actor.publish().await;
        let Some(Update::Model(model)) = updates.recv().await else {
            panic!("missing model")
        };
        assert!(!model.opening);
        actor.outstanding.insert(
            3,
            Outstanding {
                kind: Pending::Herdr {
                    grant: "g".into(),
                    method: "session.snapshot".into(),
                },
                expires: Instant::now(),
            },
        );
        actor.disconnected().await;
        actor.publish().await;
        let Some(Update::Model(model)) = updates.recv().await else {
            panic!("missing model")
        };
        assert!(!model.opening);
    }
}
