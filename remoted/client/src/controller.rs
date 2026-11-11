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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pane {
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
    pub fingerprint: String,
    pub permission: Option<Permission>,
    pub resources: Vec<Resource>,
    pub panes: Vec<Pane>,
    pub herdr_grant: String,
    pub herdr_panes: Vec<(String, String)>,
    pub file_grant: String,
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
    pub transfer: Option<TransferView>,
    pub error: String,
    pub notice: String,
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
    Check(String),
    Pair {
        code: String,
        name: String,
    },
    Reconnect(Binding),
    Forget(Binding),
    Disconnect,
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
}

impl Client {
    #[cfg(test)]
    pub(crate) fn fixture(sender: mpsc::Sender<Command>) -> Self {
        Self { sender }
    }
    pub fn send(&self, command: Command) -> Result<()> {
        self.sender
            .try_send(command)
            .map_err(|error| anyhow::anyhow!("操作队列繁忙或连接已关闭，请稍后重试：{error}"))
    }
}

pub fn start() -> (Client, mpsc::Receiver<Update>) {
    let (sender, commands) = mpsc::channel(QUEUE);
    let (updates, receiver) = mpsc::channel(QUEUE);
    let failure = updates.clone();
    let launched = std::thread::Builder::new()
        .name("remoted-controller".into())
        .spawn(move || {
            match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime.block_on(Actor::new(updates).run(commands)),
                Err(error) => {
                    let _ = failure.blocking_send(Update::Model(Box::new(Model {
                        error: error.to_string(),
                        ..Model::default()
                    })));
                }
            }
        });
    if let Err(error) = launched {
        let _ = sender.try_send(Command::Disconnect);
        eprintln!("启动远程控制器失败：{error}");
    }
    (Client { sender }, receiver)
}

enum Pending {
    Ordinary,
    Attach,
    Detach(String),
    Herdr(String),
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
    cancel: Arc<AtomicBool>,
    grant: String,
    path: String,
}
enum PreparedResult {
    Prepared(Result<Option<Prepared>>),
    Finished { result: Result<()>, size: u64 },
}

struct Actor {
    model: Model,
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
    completed: Option<String>,
    handshake_deadline: Option<Instant>,
    last_received: Instant,
}

impl Actor {
    fn new(updates: mpsc::Sender<Update>) -> Self {
        let (prepare_tx, prepare_rx) = mpsc::channel(1);
        Self {
            model: Model::default(),
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
            completed: None,
            handshake_deadline: None,
            last_received: Instant::now(),
        }
    }

    async fn publish(&self) {
        let _ = self
            .updates
            .send(Update::Model(Box::new(self.model.clone())))
            .await;
    }

    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        match storage::last_relay().await {
            Ok(relay) => self.model.relay = relay,
            Err(error) => self.model.error = format!("无法恢复 Relay 设置：{error:#}"),
        }
        match storage::bindings().await {
            Ok(bindings) => self.model.bindings = bindings,
            Err(error) => self.model.error = format!("无法读取安全设备存储：{error:#}"),
        }
        self.publish().await;
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
                Incoming::Prepared(PreparedResult::Prepared(prepared)) => {
                    self.prepared(prepared).await
                }
                Incoming::Prepared(PreparedResult::Finished { result, size }) => {
                    self.finalizing = false;
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
                Incoming::Tick => {
                    if self
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
                        Err(anyhow::anyhow!(
                            "请求超时，操作结果可能未知；未自动重试。请重连后核对。"
                        ))
                    } else {
                        continue;
                    }
                }
            };
            if let Err(error) = result {
                self.model.error = format!("{error:#}");
            }
            self.publish().await;
        }
        self.disconnected().await;
    }

    async fn disconnected(&mut self) {
        self.session = None;
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
        self.model.herdr_grant.clear();
        self.model.entries.clear();
        self.model.file_grant.clear();
        self.model.path.clear();
        if let Some(preparation) = &self.preparation {
            preparation.cancel.store(true, Ordering::Release);
        }
        self.cleanup_transfer().await;
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
        let result = self
            .session
            .as_mut()
            .context("尚未连接主机")?
            .request(operation)
            .await;
        let id = match result {
            Ok(id) => id,
            Err(error) => {
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
        self.model.error.clear();
        match command {
            Command::Disconnect => {
                self.disconnected().await;
                self.model.notice = "已断开；主机终端仍保留".into();
            }
            Command::Forget(binding) => {
                ensure!(self.session.is_none(), "请先断开设备，再忘记本机配对");
                self.model.bindings = storage::forget(&binding).await?;
                self.model.notice =
                    "已忘记本机配对；主机授权未撤销，如需撤销请在小橘管理此设备。".into();
            }
            Command::Check(address) => {
                ensure!(
                    self.session.is_none() && self.preparation.is_none(),
                    "请先断开当前设备"
                );
                let relay = RelayAddress::parse(&address)?;
                self.model.phase = Phase::Checking;
                self.publish().await;
                if let Err(error) = network::check_relay(&relay).await {
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
                self.model.phase = Phase::Connecting;
                self.publish().await;
                let result = async {
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
                }
                .await;
                if result.is_err() {
                    self.session = None;
                    self.model.phase = Phase::RelayReady;
                }
                result?;
            }
            Command::Reconnect(binding) => {
                ensure!(
                    self.model.phase == Phase::RelayReady
                        && self.model.relay.as_ref() == Some(&binding.relay),
                    "请先检查该设备的 Relay"
                );
                self.model.phase = Phase::Connecting;
                self.publish().await;
                let result = async {
                    self.identity = Some(storage::identity().await?);
                    let key = protocol::decode32(&binding.host_key)?;
                    let session = Session::connect(
                        &binding.relay,
                        &binding.route,
                        self.identity.as_ref().context("设备身份缺失")?,
                        &key,
                    )
                    .await?;
                    self.model.fingerprint = protocol::fingerprint(&key);
                    self.binding = Some(binding);
                    self.session = Some(session);
                    self.model.panes.clear();
                    self.model.phase = Phase::AwaitingReady;
                    self.handshake_deadline = Some(Instant::now() + Duration::from_secs(30));
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                if result.is_err() {
                    self.session = None;
                    self.model.phase = Phase::RelayReady;
                }
                result?;
            }
            Command::Request(operation) => {
                self.validate(&operation)?;
                let kind = match &operation {
                    Operation::TerminalAttach { .. } => Pending::Attach,
                    Operation::Herdr { grant, .. } => Pending::Herdr(grant.clone()),
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
                    "terminal" => resource.terminal,
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
        let name = name.to_owned();
        tokio::spawn(async move {
            let result = transfers::prepare(upload, &name, cancel).await;
            if let Err(undelivered) = sender.send(PreparedResult::Prepared(result)).await
                && let PreparedResult::Prepared(Ok(Some(prepared))) = undelivered.0
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
                self.handshake_deadline = None;
                self.model.permission = Some(permission);
                self.model.resources = resources;
                self.model.notice.clear();
            }
            Event::Resources { resources } => {
                ensure!(self.model.ready(), "主机尚未就绪");
                self.model.resources = resources;
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
                    self.output.remove(&stream);
                    changed = true;
                }
            }
            Event::TerminalAttached {
                stream,
                name,
                read_only,
            } => {
                ensure!(
                    matches!(pending, Some(Pending::Attach)) && self.model.panes.len() < 8,
                    "未请求的终端附着"
                );
                self.output.insert(
                    stream.clone(),
                    OutputState {
                        decoder: Decoder::default(),
                        sequence: None,
                    },
                );
                self.model.panes.push(Pane {
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
                let Some(Pending::Herdr(grant)) = pending else {
                    bail!("未请求的 Herdr 回复");
                };
                self.model.herdr_grant = grant;
                self.model.herdr_panes = crate::ui::herdr::panes(&data);
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
                    let sender = self.prepare_tx.clone();
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
                        let _ = sender.send(PreparedResult::Finished { result, size }).await;
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
                if matches!(
                    code.as_str(),
                    "REQUEST_FAILED" | "QUEUE_FULL" | "DEVICE_BUSY"
                ) && self.model.ready()
                    && pending.is_some()
                {
                    match pending {
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
                if matches!(code.as_str(), "revoked" | "disabled" | "unauthorized") {
                    self.disconnected().await;
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
}
