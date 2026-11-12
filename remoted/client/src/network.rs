//! One bounded socket and Noise state per connection. No commands are retried.
use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use neko_remoted_protocol::{
    self as protocol, RelayAddress,
    code::DeviceCode,
    crypto::{Channel, Handshake, Identity, Mode},
    messages::{Operation, RelayFrame, Request, Response},
};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};

const DEADLINE: Duration = Duration::from_secs(10);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug)]
struct LinkClosed;
impl std::fmt::Display for LinkClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("连接已断开，终端会话仍保留")
    }
}
impl std::error::Error for LinkClosed {}
#[derive(Debug)]
struct HealthStatus(u16);
impl std::fmt::Display for HealthStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "中转服务未就绪（HTTP {}）", self.0)
    }
}
impl std::error::Error for HealthStatus {}
#[derive(Debug)]
struct RelayRejected(String);
impl std::fmt::Display for RelayRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "中转拒绝连接：{}", self.0)
    }
}
impl std::error::Error for RelayRejected {}
#[derive(Debug)]
pub(crate) struct AuthenticationRejected(pub String);
impl std::fmt::Display for AuthenticationRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for AuthenticationRejected {}

pub(crate) fn authentication_failure(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.is::<AuthenticationRejected>()
            || cause.downcast_ref::<HealthStatus>().is_some_and(|e| matches!(e.0, 401 | 403))
            || cause.downcast_ref::<tokio_tungstenite::tungstenite::Error>().is_some_and(|e| matches!(e, tokio_tungstenite::tungstenite::Error::Http(reply) if matches!(reply.status().as_u16(), 401 | 403)))
            || cause.downcast_ref::<RelayRejected>().is_some_and(|e| matches!(e.0.to_ascii_lowercase().as_str(), "revoked" | "disabled" | "unauthorized" | "authentication_failed" | "authorization_failed"))
    })
}
/// Only evidenced transport failures are retried; protocol, identity and storage errors are not.
pub(crate) fn retryable(error: &anyhow::Error) -> bool {
    if authentication_failure(error) {
        return false;
    }
    error.chain().any(|cause| {
        cause.is::<LinkClosed>() || cause.is::<tokio::time::error::Elapsed>()
            || cause.downcast_ref::<std::io::Error>().is_some_and(|e| matches!(e.kind(), std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::NotConnected | std::io::ErrorKind::TimedOut | std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::NetworkUnreachable | std::io::ErrorKind::HostUnreachable))
            || cause.downcast_ref::<reqwest::Error>().is_some_and(|e| e.is_timeout() || e.is_connect())
            || cause.downcast_ref::<HealthStatus>().is_some_and(|e| e.0 == 429 || e.0 >= 500)
            || cause.downcast_ref::<tokio_tungstenite::tungstenite::Error>().is_some_and(|e| matches!(e, tokio_tungstenite::tungstenite::Error::ConnectionClosed | tokio_tungstenite::tungstenite::Error::AlreadyClosed) || matches!(e, tokio_tungstenite::tungstenite::Error::Http(reply) if reply.status().is_server_error() || reply.status().as_u16() == 429))
    })
}

pub async fn check_relay(relay: &RelayAddress) -> Result<()> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DEADLINE)
        .build()?;
    let origin = relay.origin().replacen("wss:", "https:", 1);
    let reply = client
        .get(format!("{origin}/healthz"))
        .send()
        .await
        .context("检查 Relay /healthz 时连接失败")?;
    if !reply.status().is_success() {
        return Err(HealthStatus(reply.status().as_u16()).into());
    }
    let mut body = Vec::new();
    let mut reply = reply;
    while let Some(chunk) = reply.chunk().await? {
        ensure!(body.len() + chunk.len() <= 4096, "中转响应过大");
        body.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&body)?;
    ensure!(
        value["protocol"] == "neko.remoted.v1" && value["version"] == 1,
        "该地址不是兼容的小橘中转服务"
    );
    Ok(())
}

/// Encrypted client session. A single transport task owns the socket and its
/// delivery credits. Receiving may be cancelled; requests must be awaited once.
pub struct Session {
    transport: Transport,
    channel: Channel,
    remote_key: [u8; 32],
    next: u64,
}
impl Session {
    pub async fn pair(
        relay: &RelayAddress,
        code: &DeviceCode,
        identity: &Identity,
    ) -> Result<Self> {
        Self::open(
            relay,
            code.route(),
            identity,
            Mode::Pair,
            Some(code.psk()),
            None,
        )
        .await
    }
    pub async fn connect(
        relay: &RelayAddress,
        route: &str,
        identity: &Identity,
        host: &[u8; 32],
    ) -> Result<Self> {
        Self::open(relay, route, identity, Mode::Connect, None, Some(host)).await
    }
    async fn open(
        relay: &RelayAddress,
        route: &str,
        identity: &Identity,
        mode: Mode,
        psk: Option<&[u8; 32]>,
        host: Option<&[u8; 32]>,
    ) -> Result<Self> {
        let mut request = relay.socket("client", route)?.into_client_request()?;
        request
            .headers_mut()
            .insert("sec-websocket-protocol", "neko.remoted.v1".parse()?);
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(protocol::MAX_RELAY_MESSAGE))
            .max_frame_size(Some(protocol::MAX_RELAY_MESSAGE));
        let (mut socket, response) = timeout(
            DEADLINE,
            tokio_tungstenite::connect_async_with_config(request, Some(config), false),
        )
        .await
        .context("连接中转超时")?
        .context("建立 Relay WebSocket/TLS 连接失败")?;
        ensure!(
            response
                .headers()
                .get("sec-websocket-protocol")
                .is_some_and(|v| v == "neko.remoted.v1"),
            "中转未接受协议版本"
        );
        let peer = match timeout(DEADLINE, next(&mut socket))
            .await
            .context("等待 Relay 分配连接超时")?
            .context("等待 Relay 分配连接失败")?
        {
            RelayFrame::Connected { peer } => peer,
            _ => bail!("中转握手顺序错误"),
        };
        send(
            &mut socket,
            &RelayFrame::Hello {
                peer: peer.clone(),
                mode,
            },
        )
        .await
        .context("发送主机连接请求失败")?;
        let mut transport = Transport::start(socket, peer);
        let mut handshake = Handshake::new(identity, relay, route, mode, true, psk, host)?;
        transport
            .send(handshake.write()?)
            .await
            .context("发送设备加密握手失败")?;
        let reply = timeout(DEADLINE, transport.receive())
            .await
            .context("设备加密握手超时")?
            .context("等待目标主机加密握手失败")?;
        handshake.read(&reply)?;
        if !handshake.finished() {
            transport
                .send(handshake.write()?)
                .await
                .context("发送设备加密握手失败")?;
        }
        let (channel, remote_key) = handshake.into_channel()?;
        Ok(Self {
            transport,
            channel,
            remote_key,
            next: 1,
        })
    }
    pub fn host_key(&self) -> &[u8; 32] {
        &self.remote_key
    }
    pub async fn request(&mut self, operation: Operation) -> Result<u64> {
        let id = self.next;
        self.next = self
            .next
            .checked_add(1)
            .context("request sequence exhausted")?;
        let plain = protocol::pack(&Request { id, operation })?;
        let encrypted = self.channel.encrypt(&plain)?;
        if let Err(error) = self.transport.send(encrypted).await {
            self.channel.close();
            return Err(error);
        }
        Ok(id)
    }
    /// Cancellation safe: authentication and decoding happen without yielding
    /// after the complete ciphertext has been removed from the bounded queue.
    pub async fn receive(&mut self) -> Result<Response> {
        let result = async {
            let cipher = self.transport.receive().await?;
            let plain = self.channel.decrypt(&cipher)?;
            Ok(protocol::unpack(&plain)?)
        }
        .await;
        if result.is_err() {
            self.channel.close();
            self.transport.failed = true;
            self.transport.task.abort();
        }
        result
    }
    pub async fn close(mut self) {
        self.channel.close();
        if let Some(shutdown) = self.transport.shutdown.take() {
            let _ = shutdown.send(());
        }
        if timeout(Duration::from_millis(250), &mut self.transport.task)
            .await
            .is_err()
        {
            self.transport.task.abort();
            let _ = (&mut self.transport.task).await;
        }
    }
}
struct Write {
    data: Vec<u8>,
    completed: tokio::sync::oneshot::Sender<Result<()>>,
}
struct Transport {
    outgoing: tokio::sync::mpsc::Sender<Write>,
    incoming: tokio::sync::mpsc::Receiver<Result<Vec<u8>>>,
    task: tokio::task::JoinHandle<()>,
    failed: bool,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Transport {
    fn start(socket: Socket, peer: String) -> Self {
        let (outgoing, writes) = tokio::sync::mpsc::channel(8);
        let (events, incoming) = tokio::sync::mpsc::channel(8);
        let (shutdown, stopping) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            if let Err(error) = pump(socket, peer, writes, &events, stopping).await {
                let _ = events.try_send(Err(error));
            }
        });
        Self {
            outgoing,
            incoming,
            task,
            failed: false,
            shutdown: Some(shutdown),
        }
    }
    async fn send(&mut self, data: Vec<u8>) -> Result<()> {
        ensure!(!self.failed, "连接已关闭");
        // Dropping this future also closes the socket and discards unsent writes.
        // A request which has already reached the socket still has unknown outcome.
        let mut guard = AbortOnDrop(Some(self.task.abort_handle()));
        let result = self.send_inner(data).await;
        if result.is_ok() {
            guard.0 = None;
        } else {
            self.failed = true;
        }
        result
    }
    async fn send_inner(&self, data: Vec<u8>) -> Result<()> {
        ensure!(data.len() <= protocol::MAX_CIPHERTEXT, "消息过大");
        let (completed, ack) = tokio::sync::oneshot::channel();
        timeout(DEADLINE, self.outgoing.send(Write { data, completed }))
            .await
            .context("发送队列超时")?
            .map_err(|_| anyhow::Error::new(LinkClosed))?;
        timeout(DEADLINE, ack)
            .await
            .context("发送确认超时，操作结果未知，请勿自动重试")?
            .map_err(|_| anyhow::Error::new(LinkClosed))?
    }
    async fn receive(&mut self) -> Result<Vec<u8>> {
        ensure!(!self.failed, "连接已关闭");
        self.incoming
            .recv()
            .await
            .ok_or_else(|| anyhow::Error::new(LinkClosed))?
    }
}
struct AbortOnDrop(Option<tokio::task::AbortHandle>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}
async fn pump(
    mut socket: Socket,
    peer: String,
    mut writes: tokio::sync::mpsc::Receiver<Write>,
    events: &tokio::sync::mpsc::Sender<Result<Vec<u8>>>,
    mut stopping: tokio::sync::oneshot::Receiver<()>,
) -> Result<()> {
    let mut outstanding = 0u8;
    let mut received_sequence = 0u64;
    loop {
        tokio::select! {
            _ = &mut stopping => { socket.close(None).await?; return Ok(()); }
            frame = next(&mut socket) => match frame? {
                RelayFrame::Data {peer: source, data, sequence: Some(sequence)} if source == peer => {
                    ensure!(sequence == received_sequence.checked_add(1).context("接收序号耗尽")?, "中转消息序号错误");
                    let bytes = protocol::decode(&data, protocol::MAX_CIPHERTEXT)?;
                    // Never let a slow UI cause unbounded buffering or acknowledge
                    // a frame which has not entered the bounded receive queue.
                    events.try_send(Ok(bytes)).map_err(|_| anyhow::anyhow!("接收缓冲已满，连接已关闭"))?;
                    received_sequence = sequence;
                    send(&mut socket, &RelayFrame::Acknowledge {peer: peer.clone(), sequence}).await?;
                }
                RelayFrame::Delivered {peer: source, count} if source == peer => {
                    ensure!(count > 0 && count <= outstanding, "中转发送确认无效");
                    outstanding -= count;
                }
                RelayFrame::Pong {..} => {},
                RelayFrame::Closed {..} => return Err(LinkClosed.into()),
                RelayFrame::Error {code} => return Err(RelayRejected(code).into()),
                _ => bail!("中转消息顺序或连接身份错误"),
            },
            write = writes.recv(), if outstanding < 8 => {
                let Some(write) = write else { return Ok(()); };
                let frame = RelayFrame::Data {peer: peer.clone(), data: protocol::encode(&write.data), sequence: None};
                match send(&mut socket, &frame).await {
                    Ok(()) => { outstanding += 1; let _ = write.completed.send(Ok(())); }
                    Err(error) => { let _ = write.completed.send(Err(error.context("发送失败，操作结果未知"))); return Err(LinkClosed.into()); }
                }
            }
        }
    }
}
async fn send(socket: &mut Socket, frame: &RelayFrame) -> Result<()> {
    let text = serde_json::to_string(frame)?;
    ensure!(
        text.len() <= protocol::MAX_RELAY_MESSAGE,
        "relay message exceeds limit"
    );
    timeout(DEADLINE, socket.send(Message::Text(text.into())))
        .await
        .context("中转发送超时")??;
    Ok(())
}
async fn next(socket: &mut Socket) -> Result<RelayFrame> {
    loop {
        match socket.next().await.ok_or(LinkClosed)?? {
            Message::Text(text) => {
                ensure!(text.len() <= protocol::MAX_RELAY_MESSAGE, "中转消息过大");
                return Ok(serde_json::from_str(&text)?);
            }
            Message::Ping(bytes) => {
                timeout(DEADLINE, socket.send(Message::Pong(bytes))).await??;
            }
            Message::Pong(_) => {}
            Message::Close(_) => return Err(LinkClosed.into()),
            _ => bail!("中转协议格式错误"),
        }
    }
}

/// Observe the actual encrypted Session request path without a remote service.
#[cfg(test)]
impl Session {
    pub(crate) fn observed() -> (Self, tokio::sync::mpsc::Receiver<Request>) {
        let (channel, mut host, remote_key) = tests::channels();
        let (outgoing, mut writes) = tokio::sync::mpsc::channel::<Write>(8);
        let (events, incoming) = tokio::sync::mpsc::channel(8);
        let (requests, observed) = tokio::sync::mpsc::channel(16);
        let (shutdown, mut stopping) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _events = events;
            loop {
                tokio::select! {
                    _ = &mut stopping => return,
                    write = writes.recv() => {
                        let Some(write) = write else { return; };
                        let request = protocol::unpack(&host.decrypt(&write.data).unwrap()).unwrap();
                        requests.send(request).await.unwrap();
                        let _ = write.completed.send(Ok(()));
                    }
                }
            }
        });
        (
            Self {
                channel,
                remote_key,
                next: 1,
                transport: Transport {
                    outgoing,
                    incoming,
                    task,
                    failed: false,
                    shutdown: Some(shutdown),
                },
            },
            observed,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::messages::Event;
    use tokio::net::TcpListener;

    pub(super) fn channels() -> (Channel, Channel, [u8; 32]) {
        let host = Identity::generate().unwrap();
        let client = Identity::generate().unwrap();
        let relay = RelayAddress::parse("https://relay.example").unwrap();
        let route = protocol::route(&protocol::random32().unwrap());
        let mut a = Handshake::new(
            &client,
            &relay,
            &route,
            Mode::Connect,
            true,
            None,
            Some(host.public()),
        )
        .unwrap();
        let mut b =
            Handshake::new(&host, &relay, &route, Mode::Connect, false, None, None).unwrap();
        b.read(&a.write().unwrap()).unwrap();
        a.read(&b.write().unwrap()).unwrap();
        (
            a.into_channel().unwrap().0,
            b.into_channel().unwrap().0,
            *host.public(),
        )
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_write_is_discarded_before_credits_return() {
        let (outgoing, mut writes) = tokio::sync::mpsc::channel::<Write>(8);
        let (_events, incoming) = tokio::sync::mpsc::channel(8);
        let (resume, blocked) = tokio::sync::oneshot::channel::<()>();
        let (observed, mut transmitted) = tokio::sync::mpsc::channel(1);
        let task = tokio::spawn(async move {
            let _ = blocked.await;
            if let Some(write) = writes.recv().await {
                let _ = observed.send(write.data).await;
            }
        });
        let mut transport = Transport {
            outgoing,
            incoming,
            task,
            failed: false,
            shutdown: None,
        };
        assert!(
            transport
                .send(b"must not execute later".to_vec())
                .await
                .is_err()
        );
        tokio::task::yield_now().await;
        assert!(transport.failed);
        assert!(resume.send(()).is_err());
        assert!(transmitted.recv().await.is_none());
        assert!(transport.send(b"cannot reuse".to_vec()).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_write_aborts_the_socket_owner() {
        let (outgoing, mut writes) = tokio::sync::mpsc::channel::<Write>(8);
        let (_events, incoming) = tokio::sync::mpsc::channel(8);
        let (resume, blocked) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let _ = blocked.await;
            assert!(
                writes.recv().await.is_none(),
                "cancelled command escaped the queue"
            );
        });
        let mut transport = Transport {
            outgoing,
            incoming,
            task,
            failed: false,
            shutdown: None,
        };
        assert!(
            timeout(Duration::from_millis(1), transport.send(vec![1]))
                .await
                .is_err()
        );
        tokio::task::yield_now().await;
        assert!(resume.send(()).is_err());
    }

    #[tokio::test]
    async fn encrypted_responses_survive_delivery_credits_and_cancelled_receive() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (client_channel, mut host_channel, remote_key) = channels();
        let (resume, paused) = tokio::sync::oneshot::channel();
        let fixture = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            paused.await.unwrap();
            let mut sequence = 0u64;
            let mut replies = 0;
            while replies < 32 {
                let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
                    panic!("expected application frame")
                };
                match serde_json::from_str::<RelayFrame>(&text).unwrap() {
                    RelayFrame::Data { data, .. } => {
                        sequence += 1;
                        let plain = host_channel
                            .decrypt(&protocol::decode(&data, protocol::MAX_CIPHERTEXT).unwrap())
                            .unwrap();
                        let request: Request = protocol::unpack(&plain).unwrap();
                        assert_eq!(request.id, sequence);
                        let delivered = RelayFrame::Delivered {
                            peer: "fixture".into(),
                            count: 1,
                        };
                        socket
                            .send(Message::Text(
                                serde_json::to_string(&delivered).unwrap().into(),
                            ))
                            .await
                            .unwrap();
                        let response = Response {
                            id: request.id,
                            event: Event::Pong {
                                nonce: request.id.to_string(),
                            },
                        };
                        let data = protocol::encode(
                            &host_channel
                                .encrypt(&protocol::pack(&response).unwrap())
                                .unwrap(),
                        );
                        let response = RelayFrame::Data {
                            peer: "fixture".into(),
                            data,
                            sequence: Some(sequence),
                        };
                        socket
                            .send(Message::Text(
                                serde_json::to_string(&response).unwrap().into(),
                            ))
                            .await
                            .unwrap();
                        replies += 1;
                    }
                    RelayFrame::Acknowledge {
                        sequence: acknowledged,
                        ..
                    } => assert!(acknowledged <= sequence),
                    _ => panic!("unexpected relay frame"),
                }
            }
            // Drain the final ACK so the transport has completed its last write.
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                if matches!(
                    serde_json::from_str::<RelayFrame>(&text).unwrap(),
                    RelayFrame::Acknowledge { sequence: 32, .. }
                ) {
                    break;
                }
            }
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let mut session = Session {
            transport: Transport::start(socket, "fixture".into()),
            channel: client_channel,
            remote_key,
            next: 1,
        };
        assert!(
            timeout(Duration::from_millis(1), session.receive())
                .await
                .is_err()
        );
        resume.send(()).unwrap();
        for expected in 1..=32 {
            assert_eq!(
                session.request(Operation::Resources {}).await.unwrap(),
                expected
            );
            let response = timeout(DEADLINE, session.receive()).await.unwrap().unwrap();
            assert_eq!(response.id, expected);
            assert!(matches!(response.event, Event::Pong {nonce} if nonce == expected.to_string()));
        }
        fixture.await.unwrap();
    }
    #[test]
    fn retry_policy_distinguishes_aborted_transport_from_auth_and_protocol_errors() {
        assert!(retryable(
            &anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::ConnectionAborted))
                .context("WebSocket TLS connect")
        ));
        assert!(retryable(&HealthStatus(503).into()));
        assert!(!retryable(&HealthStatus(403).into()));
        assert!(authentication_failure(
            &AuthenticationRejected("revoked".into()).into()
        ));
        assert!(!retryable(&AuthenticationRejected("revoked".into()).into()));
        assert!(!retryable(&anyhow::anyhow!("Noise host identity mismatch")));
    }
    #[tokio::test]
    async fn closing_a_session_detaches_its_real_websocket_without_sending_operations() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let fixture = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            assert!(matches!(
                socket.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let (channel, _, remote_key) = channels();
        Session {
            transport: Transport::start(socket, "fixture".into()),
            channel,
            remote_key,
            next: 1,
        }
        .close()
        .await;
        timeout(Duration::from_secs(1), fixture)
            .await
            .unwrap()
            .unwrap();
    }
}
