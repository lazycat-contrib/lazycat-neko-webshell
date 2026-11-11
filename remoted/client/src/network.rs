//! One bounded socket and Noise state per connection. No commands are retried.
use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use neko_remoted_protocol::{self as protocol, RelayAddress, code::DeviceCode, crypto::{Channel, Handshake, Identity, Mode}, messages::{Operation, RelayFrame, Request, Response}};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::{Message, client::IntoClientRequest}};

const DEADLINE: Duration = Duration::from_secs(10);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn check_relay(relay: &RelayAddress) -> Result<()> {
    let client=reqwest::Client::builder().https_only(true).no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(DEADLINE).build()?;
    let origin=relay.origin().replacen("wss:","https:",1);
    let reply=client.get(format!("{origin}/healthz")).send().await?;
    ensure!(reply.status().is_success(),"中转服务未就绪（HTTP {}）",reply.status());
    let mut body=Vec::new();let mut reply=reply;
    while let Some(chunk)=reply.chunk().await? {ensure!(body.len()+chunk.len()<=4096,"中转响应过大");body.extend_from_slice(&chunk);}
    let value:serde_json::Value=serde_json::from_slice(&body)?;
    ensure!(value["protocol"]=="neko.remoted.v1" && value["version"]==1,"该地址不是兼容的小橘中转服务");
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
    pub async fn pair(relay: &RelayAddress, code: &DeviceCode, identity: &Identity) -> Result<Self> {
        Self::open(relay, code.route(), identity, Mode::Pair, Some(code.psk()), None).await
    }
    pub async fn connect(relay: &RelayAddress, route: &str, identity: &Identity, host: &[u8; 32]) -> Result<Self> {
        Self::open(relay, route, identity, Mode::Connect, None, Some(host)).await
    }
    async fn open(relay: &RelayAddress, route: &str, identity: &Identity, mode: Mode, psk: Option<&[u8;32]>, host: Option<&[u8;32]>) -> Result<Self> {
        let mut request = relay.socket("client", route)?.into_client_request()?;
        request.headers_mut().insert("sec-websocket-protocol", "neko.remoted.v1".parse()?);
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(protocol::MAX_RELAY_MESSAGE))
            .max_frame_size(Some(protocol::MAX_RELAY_MESSAGE));
        let (mut socket, response) = timeout(DEADLINE, tokio_tungstenite::connect_async_with_config(request, Some(config), false)).await.context("连接中转超时")??;
        ensure!(response.headers().get("sec-websocket-protocol").is_some_and(|v| v == "neko.remoted.v1"), "中转未接受协议版本");
        let peer = match timeout(DEADLINE, next(&mut socket)).await?? {
            RelayFrame::Connected {peer} => peer,
            _ => bail!("中转握手顺序错误"),
        };
        send(&mut socket, &RelayFrame::Hello {peer: peer.clone(), mode}).await?;
        let mut transport = Transport::start(socket, peer);
        let mut handshake = Handshake::new(identity, relay, route, mode, true, psk, host)?;
        transport.send(handshake.write()?).await?;
        let reply = timeout(DEADLINE, transport.receive()).await.context("设备加密握手超时")??;
        handshake.read(&reply)?;
        if !handshake.finished() { transport.send(handshake.write()?).await?; }
        let (channel, remote_key) = handshake.into_channel()?;
        Ok(Self {transport, channel, remote_key, next: 1})
    }
    pub fn host_key(&self) -> &[u8;32] { &self.remote_key }
    pub async fn request(&mut self, operation: Operation) -> Result<u64> {
        let id = self.next;
        self.next = self.next.checked_add(1).context("request sequence exhausted")?;
        let plain = protocol::pack(&Request {id, operation})?;
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
        }.await;
        if result.is_err() {
            self.channel.close();
            self.transport.failed = true;
            self.transport.task.abort();
        }
        result
    }
    pub async fn close(self) { drop(self); }
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
}
impl Drop for Transport {
    fn drop(&mut self) { self.task.abort(); }
}
impl Transport {
    fn start(socket: Socket, peer: String) -> Self {
        let (outgoing, writes) = tokio::sync::mpsc::channel(8);
        let (events, incoming) = tokio::sync::mpsc::channel(8);
        let task = tokio::spawn(async move {
            if let Err(error) = pump(socket, peer, writes, &events).await {
                let _ = events.try_send(Err(error));
            }
        });
        Self {outgoing, incoming, task, failed: false}
    }
    async fn send(&mut self, data: Vec<u8>) -> Result<()> {
        ensure!(!self.failed, "连接已关闭");
        // Dropping this future also closes the socket and discards unsent writes.
        // A request which has already reached the socket still has unknown outcome.
        let mut guard = AbortOnDrop(Some(self.task.abort_handle()));
        let result = self.send_inner(data).await;
        if result.is_ok() { guard.0 = None; } else { self.failed = true; }
        result
    }
    async fn send_inner(&self, data: Vec<u8>) -> Result<()> {
        ensure!(data.len() <= protocol::MAX_CIPHERTEXT, "消息过大");
        let (completed, ack) = tokio::sync::oneshot::channel();
        timeout(DEADLINE, self.outgoing.send(Write {data, completed})).await.context("发送队列超时")?.map_err(|_| anyhow::anyhow!("连接已断开"))?;
        timeout(DEADLINE, ack).await.context("发送确认超时，操作结果未知，请勿自动重试")??
    }
    async fn receive(&mut self) -> Result<Vec<u8>> {
        ensure!(!self.failed, "连接已关闭");
        self.incoming.recv().await.context("连接已断开，终端会话仍保留")?
    }
}
struct AbortOnDrop(Option<tokio::task::AbortHandle>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) { if let Some(task) = &self.0 { task.abort(); } }
}
async fn pump(mut socket: Socket, peer: String, mut writes: tokio::sync::mpsc::Receiver<Write>, events: &tokio::sync::mpsc::Sender<Result<Vec<u8>>>) -> Result<()> {
    let mut outstanding = 0u8;
    let mut received_sequence = 0u64;
    loop {
        tokio::select! {
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
                RelayFrame::Closed {..} => bail!("主机已断开连接"),
                RelayFrame::Error {code} => bail!("中转拒绝连接：{code}"),
                _ => bail!("中转消息顺序或连接身份错误"),
            },
            write = writes.recv(), if outstanding < 8 => {
                let Some(write) = write else { return Ok(()); };
                let frame = RelayFrame::Data {peer: peer.clone(), data: protocol::encode(&write.data), sequence: None};
                match send(&mut socket, &frame).await {
                    Ok(()) => { outstanding += 1; let _ = write.completed.send(Ok(())); }
                    Err(error) => { let _ = write.completed.send(Err(anyhow::anyhow!("发送失败，操作结果未知"))); return Err(error); }
                }
            }
        }
    }
}
async fn send(socket: &mut Socket, frame: &RelayFrame) -> Result<()> {
    let text = serde_json::to_string(frame)?;
    ensure!(text.len() <= protocol::MAX_RELAY_MESSAGE, "relay message exceeds limit");
    timeout(DEADLINE, socket.send(Message::Text(text.into()))).await.context("中转发送超时")??;
    Ok(())
}
async fn next(socket: &mut Socket) -> Result<RelayFrame> {
    loop {
        match socket.next().await.context("中转已断开")?? {
            Message::Text(text) => {
                ensure!(text.len() <= protocol::MAX_RELAY_MESSAGE, "中转消息过大");
                return Ok(serde_json::from_str(&text)?);
            }
            Message::Ping(bytes) => { timeout(DEADLINE, socket.send(Message::Pong(bytes))).await??; }
            Message::Pong(_) => {},
            Message::Close(_) => bail!("中转已断开，终端会话仍保留"),
            _ => bail!("中转协议格式错误"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::messages::Event;
    use tokio::net::TcpListener;

    fn channels() -> (Channel, Channel, [u8; 32]) {
        let host = Identity::generate().unwrap();
        let client = Identity::generate().unwrap();
        let relay = RelayAddress::parse("https://relay.example").unwrap();
        let route = protocol::route(&protocol::random32().unwrap());
        let mut a = Handshake::new(&client, &relay, &route, Mode::Connect, true, None, Some(host.public())).unwrap();
        let mut b = Handshake::new(&host, &relay, &route, Mode::Connect, false, None, None).unwrap();
        b.read(&a.write().unwrap()).unwrap();
        a.read(&b.write().unwrap()).unwrap();
        (a.into_channel().unwrap().0, b.into_channel().unwrap().0, *host.public())
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_write_is_discarded_before_credits_return() {
        let (outgoing, mut writes) = tokio::sync::mpsc::channel::<Write>(8);
        let (_events, incoming) = tokio::sync::mpsc::channel(8);
        let (resume, blocked) = tokio::sync::oneshot::channel::<()>();
        let (observed, mut transmitted) = tokio::sync::mpsc::channel(1);
        let task = tokio::spawn(async move {
            let _ = blocked.await;
            if let Some(write) = writes.recv().await { let _ = observed.send(write.data).await; }
        });
        let mut transport = Transport {outgoing, incoming, task, failed: false};
        assert!(transport.send(b"must not execute later".to_vec()).await.is_err());
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
            assert!(writes.recv().await.is_none(), "cancelled command escaped the queue");
        });
        let mut transport = Transport {outgoing, incoming, task, failed: false};
        assert!(timeout(Duration::from_millis(1), transport.send(vec![1])).await.is_err());
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
                let Message::Text(text) = socket.next().await.unwrap().unwrap() else { panic!("expected application frame") };
                match serde_json::from_str::<RelayFrame>(&text).unwrap() {
                    RelayFrame::Data {data, ..} => {
                        sequence += 1;
                        let plain = host_channel.decrypt(&protocol::decode(&data, protocol::MAX_CIPHERTEXT).unwrap()).unwrap();
                        let request: Request = protocol::unpack(&plain).unwrap();
                        assert_eq!(request.id, sequence);
                        let delivered = RelayFrame::Delivered {peer: "fixture".into(), count: 1};
                        socket.send(Message::Text(serde_json::to_string(&delivered).unwrap().into())).await.unwrap();
                        let response = Response {id: request.id, event: Event::Pong {nonce: request.id.to_string()}};
                        let data = protocol::encode(&host_channel.encrypt(&protocol::pack(&response).unwrap()).unwrap());
                        let response = RelayFrame::Data {peer: "fixture".into(), data, sequence: Some(sequence)};
                        socket.send(Message::Text(serde_json::to_string(&response).unwrap().into())).await.unwrap();
                        replies += 1;
                    }
                    RelayFrame::Acknowledge {sequence: acknowledged, ..} => assert!(acknowledged <= sequence),
                    _ => panic!("unexpected relay frame"),
                }
            }
            // Drain the final ACK so the transport has completed its last write.
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                if matches!(serde_json::from_str::<RelayFrame>(&text).unwrap(), RelayFrame::Acknowledge {sequence: 32, ..}) { break; }
            }
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
        let mut session = Session {transport: Transport::start(socket, "fixture".into()), channel: client_channel, remote_key, next: 1};
        assert!(timeout(Duration::from_millis(1), session.receive()).await.is_err());
        resume.send(()).unwrap();
        for expected in 1..=32 {
            assert_eq!(session.request(Operation::Resources {}).await.unwrap(), expected);
            let response = timeout(DEADLINE, session.receive()).await.unwrap().unwrap();
            assert_eq!(response.id, expected);
            assert!(matches!(response.event, Event::Pong {nonce} if nonce == expected.to_string()));
        }
        fixture.await.unwrap();
    }
}
