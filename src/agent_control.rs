use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use buffa::Message as _;
use tokio::io::AsyncWriteExt as _;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;
use tokio::time::timeout;

use crate::agent_protocol::{
    AGENT_PROTOCOL_VERSION, read_agent_message_async, write_agent_message_async,
};
use crate::proto::lazycat::webshell::v1::{AgentRequest, AgentResponse};

const MAX_CONTROL_REQUEST_BYTES: usize = 64 * 1024;
const CONTROL_QUEUE_CAPACITY: usize = 4;
const RECONNECT_COOLDOWN: Duration = Duration::from_secs(5);

type Reply = anyhow::Result<Option<AgentResponse>>;

struct Job {
    request: AgentRequest,
    reply: oneshot::Sender<Reply>,
}

struct Entry {
    sender: mpsc::Sender<Job>,
    abort: AbortHandle,
    started: Instant,
}

#[derive(Default)]
struct PoolState {
    entries: HashMap<(String, String), Entry>,
    closed: bool,
}

#[derive(Clone, Copy)]
struct Limits {
    capacity: usize,
    request_timeout: Duration,
    connect_timeout: Duration,
    idle_timeout: Duration,
}

pub(crate) struct AgentControlPool {
    limits: Limits,
    state: Mutex<PoolState>,
}

impl Default for AgentControlPool {
    fn default() -> Self {
        Self {
            limits: Limits {
                capacity: 8,
                request_timeout: Duration::from_secs(8),
                connect_timeout: Duration::from_secs(3),
                idle_timeout: Duration::from_secs(30),
            },
            state: Mutex::default(),
        }
    }
}

impl AgentControlPool {
    pub async fn request(
        &self,
        selector: &str,
        username: &str,
        command: Command,
        request: &AgentRequest,
    ) -> Reply {
        if request.encode_to_vec().len() > MAX_CONTROL_REQUEST_BYTES {
            return Ok(None);
        }
        let Some(sender) = self.sender(selector, username, command) else {
            return Ok(None);
        };
        let (reply, response) = oneshot::channel();
        timeout(self.limits.request_timeout, async {
            if sender
                .send(Job {
                    request: request.clone(),
                    reply,
                })
                .await
                .is_err()
            {
                return Ok(None);
            }
            response.await.map_err(|_| {
                anyhow::anyhow!(
                    "agent control bridge ended; request result is unknown and was not retried"
                )
            })?
        })
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "agent control request timed out; request result may be unknown and was not retried"
            )
        })?
    }

    fn sender(
        &self,
        selector: &str,
        username: &str,
        command: Command,
    ) -> Option<mpsc::Sender<Job>> {
        let key = (selector.to_owned(), username.to_owned());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed {
            return None;
        }
        state.entries.retain(|_, entry| {
            !entry.sender.is_closed() || entry.started.elapsed() < RECONNECT_COOLDOWN
        });
        if let Some(entry) = state.entries.get(&key) {
            return (!entry.sender.is_closed()).then(|| entry.sender.clone());
        }
        if state.entries.len() >= self.limits.capacity {
            return None;
        }
        let (sender, receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
        let task = tokio::spawn(run_bridge(command, receiver, self.limits));
        state.entries.insert(
            key,
            Entry {
                sender: sender.clone(),
                abort: task.abort_handle(),
                started: Instant::now(),
            },
        );
        Some(sender)
    }

    pub fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.closed = true;
        for (_, entry) in state.entries.drain() {
            entry.abort.abort();
        }
    }
}

impl Drop for AgentControlPool {
    fn drop(&mut self) {
        self.close();
    }
}

struct BridgeProcess {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
}

impl BridgeProcess {
    async fn start(mut command: Command) -> anyhow::Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("missing control input"))?;
        let mut output = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("missing control output"))?;
        let ready: AgentResponse = read_agent_message_async(&mut output).await?;
        if ready.ok != Some(true)
            || ready.version.as_deref() != Some(AGENT_PROTOCOL_VERSION)
            || ready.agent_version.unwrap_or(0) < 20
        {
            anyhow::bail!("control stream is unsupported by this helper");
        }
        Ok(Self {
            child,
            input,
            output,
        })
    }

    async fn exchange(&mut self, request: &AgentRequest) -> anyhow::Result<AgentResponse> {
        write_agent_message_async(&mut self.input, request).await?;
        Ok(read_agent_message_async(&mut self.output).await?)
    }

    async fn stop(mut self) {
        let _ = self.input.shutdown().await;
        if timeout(Duration::from_secs(1), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

fn drain_unsent(receiver: &mut mpsc::Receiver<Job>) {
    receiver.close();
    while let Ok(job) = receiver.try_recv() {
        let _ = job.reply.send(Ok(None));
    }
}

async fn run_bridge(command: Command, mut receiver: mpsc::Receiver<Job>, limits: Limits) {
    let Ok(Ok(mut process)) = timeout(limits.connect_timeout, BridgeProcess::start(command)).await
    else {
        drain_unsent(&mut receiver);
        return;
    };
    while let Ok(Some(job)) = timeout(limits.idle_timeout, receiver.recv()).await {
        if job.reply.is_closed() {
            continue;
        }
        let result = timeout(limits.request_timeout, process.exchange(&job.request)).await;
        if let Ok(Ok(response)) = result {
            let _ = job.reply.send(Ok(Some(response)));
        } else {
            let _ = job.reply.send(Err(anyhow::anyhow!(
                "agent control request failed; result is unknown and was not retried"
            )));
            break;
        }
    }
    drain_unsent(&mut receiver);
    process.stop().await;
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::sync::Arc;
    use std::time::Duration;

    use buffa::Message as _;
    use tokio::process::Command;

    use super::AgentControlPool;

    const ECHO: &str = r"
import sys,struct,time,os
reader=sys.stdin.buffer
writer=sys.stdout.buffer
ready=bytes.fromhex(sys.argv[1])
mode=sys.argv[2] if len(sys.argv)>2 else ''
if mode=='handshake-stall': time.sleep(10)
if len(sys.argv)>3:
    with open(sys.argv[3],'a') as marker: marker.write(str(os.getpid())+'\n')
writer.write(struct.pack('>I',len(ready))+ready)
writer.flush()
while True:
    header=reader.read(4)
    if not header: break
    length=struct.unpack('>I',header)[0]
    payload=reader.read(length)
    if mode=='delay' and len(sys.argv)>3:
        with open(sys.argv[3],'a') as marker: marker.write('request\n')
    if mode=='fail': sys.exit(3)
    if mode=='delay': time.sleep(0.1)
    if mode=='stall': time.sleep(10)
    writer.write(struct.pack('>I',len(payload))+payload)
    writer.flush()
";

    fn command(fail: bool) -> Command {
        command_mode(if fail { "fail" } else { "" })
    }

    fn command_mode(mode: &str) -> Command {
        let mut ready = crate::agent_protocol::ok_response();
        ready.agent_version = Some(20);
        let mut encoded = String::new();
        for byte in ready.encode_to_vec() {
            write!(&mut encoded, "{byte:02x}").unwrap();
        }
        let mut command = Command::new("python3");
        command.args(["-u", "-c", ECHO, &encoded]);
        command.arg(mode);
        command
    }

    #[tokio::test]
    async fn concurrent_requests_share_one_helper_and_keep_responses_correlated() {
        let marker = std::env::temp_dir().join(format!("neko-control-{}", uuid::Uuid::new_v4()));
        let pool = Arc::new(AgentControlPool::default());
        let mut tasks = Vec::new();
        for index in 0..12 {
            let pool = Arc::clone(&pool);
            let mut command = command(false);
            command.arg(&marker);
            tasks.push(tokio::spawn(async move {
                let selector = format!("request-{index}");
                let response = pool
                    .request(
                        "target",
                        "user",
                        command,
                        &crate::agent_protocol::ping_request(&selector, "user"),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(response.version.as_deref(), Some(selector.as_str()));
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(), 1);
        std::fs::remove_file(marker).unwrap();
    }

    #[tokio::test]
    async fn pool_isolates_user_and_target_and_bounds_capacity() {
        let mut pool = AgentControlPool::default();
        pool.limits.capacity = 3;
        let request = crate::agent_protocol::ping_request("first", "user");
        for (selector, username) in [
            ("target", "first"),
            ("target", "second"),
            ("other", "first"),
        ] {
            assert!(
                pool.request(selector, username, command(false), &request)
                    .await
                    .unwrap()
                    .is_some()
            );
        }
        assert_eq!(pool.state.lock().unwrap().entries.len(), 3);
        assert!(
            pool.request("full", "user", command(false), &request)
                .await
                .unwrap()
                .is_none()
        );
        pool.close();
        assert!(
            pool.request("target", "first", command(false), &request)
                .await
                .unwrap()
                .is_none()
        );
        assert!(pool.state.lock().unwrap().entries.is_empty());
    }

    #[tokio::test]
    async fn cancelling_sent_request_does_not_shift_the_next_response() {
        let marker = std::env::temp_dir().join(format!("neko-control-{}", uuid::Uuid::new_v4()));
        let mut delayed = command_mode("delay");
        delayed.arg(&marker);
        let pool = Arc::new(AgentControlPool::default());
        let pending_pool = Arc::clone(&pool);
        let pending = tokio::spawn(async move {
            pending_pool
                .request(
                    "target",
                    "user",
                    delayed,
                    &crate::agent_protocol::ping_request("cancelled", "user"),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while std::fs::read_to_string(&marker)
                .unwrap_or_default()
                .lines()
                .count()
                < 2
            {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("request must be sent before cancellation");
        pending.abort();
        let _ = pending.await;
        let response = pool
            .request(
                "target",
                "user",
                command(false),
                &crate::agent_protocol::ping_request("next", "user"),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.version.as_deref(), Some("next"));
        assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(), 3);
        std::fs::remove_file(marker).unwrap();
    }

    #[tokio::test]
    async fn handshake_stall_can_fall_back_but_sent_request_stall_cannot() {
        let mut pool = AgentControlPool::default();
        pool.limits.connect_timeout = Duration::from_millis(100);
        pool.limits.request_timeout = Duration::from_millis(300);
        let request = crate::agent_protocol::ping_request("first", "user");
        assert!(
            pool.request("unready", "user", command_mode("handshake-stall"), &request)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            pool.request("sent", "user", command_mode("stall"), &request)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn idle_bridge_closes_and_reaps_helper() {
        let marker = std::env::temp_dir().join(format!("neko-control-{}", uuid::Uuid::new_v4()));
        let mut pool = AgentControlPool::default();
        pool.limits.idle_timeout = Duration::from_millis(50);
        let mut command = command(false);
        command.arg(&marker);
        pool.request(
            "target",
            "user",
            command,
            &crate::agent_protocol::ping_request("first", "user"),
        )
        .await
        .unwrap()
        .unwrap();
        let pid = std::fs::read_to_string(&marker).unwrap().trim().to_owned();
        std::fs::remove_file(marker).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while std::path::Path::new(&format!("/proc/{pid}")).exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("idle helper must be reaped");
        assert!(
            pool.state
                .lock()
                .unwrap()
                .entries
                .values()
                .all(|entry| entry.sender.is_closed())
        );
    }

    #[tokio::test]
    async fn shutdown_reaps_active_helper_and_oversized_requests_do_not_spawn() {
        let marker = std::env::temp_dir().join(format!("neko-control-{}", uuid::Uuid::new_v4()));
        let pool = AgentControlPool::default();
        let oversized = crate::agent_protocol::ping_request(
            "x".repeat(super::MAX_CONTROL_REQUEST_BYTES),
            "user",
        );
        assert!(
            pool.request("target", "user", command(false), &oversized)
                .await
                .unwrap()
                .is_none()
        );
        assert!(pool.state.lock().unwrap().entries.is_empty());
        let mut helper = command(false);
        helper.arg(&marker);
        pool.request(
            "target",
            "user",
            helper,
            &crate::agent_protocol::ping_request("first", "user"),
        )
        .await
        .unwrap()
        .unwrap();
        let pid = std::fs::read_to_string(&marker).unwrap().trim().to_owned();
        std::fs::remove_file(marker).unwrap();
        pool.close();
        tokio::time::timeout(Duration::from_secs(2), async {
            while std::path::Path::new(&format!("/proc/{pid}")).exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("shutdown must reap active helper");
    }

    #[tokio::test]
    async fn control_bridge_returns_correlated_responses() {
        let pool = AgentControlPool::default();
        for selector in ["first", "second", "third"] {
            let request = crate::agent_protocol::ping_request(selector, "user");
            let response = pool
                .request("target@scope", "user", command(false), &request)
                .await
                .unwrap()
                .expect("stream helper must be used");
            assert_eq!(response.version.as_deref(), Some(selector));
        }
    }

    #[tokio::test]
    async fn failure_after_sending_request_is_not_eligible_for_replay() {
        let pool = AgentControlPool::default();
        let result = pool
            .request(
                "target@scope",
                "user",
                command(true),
                &crate::agent_protocol::ping_request("first", "user"),
            )
            .await;
        assert!(
            result.is_err(),
            "a possibly executed request must not fall back to one-shot"
        );
    }

    #[tokio::test]
    async fn legacy_helper_falls_back_before_request_is_written() {
        let pool = AgentControlPool::default();
        let mut legacy = Command::new("sh");
        legacy.args(["-c", "exit 1"]);
        let response = pool
            .request(
                "target@scope",
                "user",
                legacy,
                &crate::agent_protocol::ping_request("first", "user"),
            )
            .await
            .unwrap();
        assert!(response.is_none());
    }
}
