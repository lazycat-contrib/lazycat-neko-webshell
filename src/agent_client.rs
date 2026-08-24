use std::collections::HashMap;
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use buffa::Message;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{sleep, timeout};
use tracing::warn;

use crate::agent_protocol::{
    AGENT_PROTOCOL_VERSION, AGENT_VERSION, MIN_SUPPORTED_AGENT_VERSION, action_request,
    close_session_request, ping_request, read_agent_response, state_request,
};
use crate::config::LIGHTOSCTL;
use crate::proto::lazycat::webshell::v1::{
    AgentResponse, AgentWorkspaceAction, AgentWorkspaceState,
};
use crate::validation::{normalize_output_frame_limit, validate_selector};

const AGENT_INSTALL_PATH: &str = "/usr/local/bin/lazycat-neko-webshell-agent";
const AGENT_PAYLOAD_ROOT: &str = "/usr/local/lib/lazycat-neko-webshell/agents";
const LEGACY_V0_5_35_PAYLOAD_VERSION: &str = "0.5.35";
const LEGACY_V0_5_35_AGENT_VERSION: u64 = 1;
const AGENT_READY_MARKER: &str = "lazycat-neko-webshell-agent-ready";
const AGENT_LOCK_READY_MARKER: &str = "lazycat-neko-webshell-agent-lock-ready";
const AGENT_LOG_TAIL_LINES: usize = 80;
const AGENT_READY_CACHE_TTL: Duration = Duration::from_secs(5);
const AGENT_ENSURE_FAILURE_TTL: Duration = Duration::from_secs(15);

static AGENT_ENSURE_LOCKS: OnceLock<StdMutex<HashMap<String, Weak<AsyncMutex<()>>>>> =
    OnceLock::new();
static AGENT_READY_CACHE: OnceLock<StdMutex<HashMap<String, AgentReadyCacheEntry>>> =
    OnceLock::new();
static AGENT_ENSURE_FAILURES: OnceLock<StdMutex<HashMap<String, AgentEnsureFailureEntry>>> =
    OnceLock::new();

#[derive(Clone, Copy, Debug)]
struct AgentReadyCacheEntry {
    verified_at: Instant,
    minimum_version: u64,
}

#[derive(Clone, Debug)]
struct AgentEnsureFailureEntry {
    failed_at: Instant,
    minimum_version: u64,
    message: String,
}

#[cfg(not(debug_assertions))]
include!(concat!(env!("OUT_DIR"), "/embedded_agent.rs"));

#[derive(Clone, Debug)]
pub struct AgentClient {
    selector: String,
    username: String,
    socket_path: String,
}

#[derive(Clone, Debug)]
struct AgentPayloadIdentity {
    manifest: String,
    install_path: String,
    agent_version: u64,
}

#[derive(Clone, Debug)]
struct InstalledAgentIdentity {
    protocol_version: String,
    payload: Option<AgentPayloadIdentity>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentProtocolCompatibility {
    Current,
    Stale,
    Newer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentRollbackAction {
    PreserveRunning,
    ReactivateRollback,
    RestoreRollback,
    RejectNewer,
}

struct RemoteAgentLock {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl RemoteAgentLock {
    async fn acquire(selector: &str) -> anyhow::Result<Self> {
        let script = remote_agent_lock_script(selector);
        let mut command = Command::new(LIGHTOSCTL);
        command.args(["exec", "-i", selector, "/bin/sh", "-lc", &script]);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|err| anyhow!("failed to acquire target agent lock: {err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("failed to open target agent lock stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("failed to open target agent lock stdout"))?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let marker = timeout(Duration::from_secs(65), reader.read_line(&mut line)).await;
        if !matches!(marker, Ok(Ok(_))) || line.trim() != AGENT_LOCK_READY_MARKER {
            let _ = child.kill().await;
            let _ = child.wait().await;
            bail!("timed out acquiring the target webshell agent upgrade lock");
        }
        Ok(Self {
            child,
            stdin: Some(stdin),
        })
    }

    async fn release(mut self) -> anyhow::Result<()> {
        if let Some(mut stdin) = self.stdin.take() {
            stdin
                .write_all(b"release\n")
                .await
                .context("failed to release target agent lock")?;
            stdin
                .shutdown()
                .await
                .context("failed to close target agent lock")?;
        }
        if let Ok(status) = timeout(Duration::from_secs(5), self.child.wait()).await {
            let status = status.context("failed to wait for target agent lock")?;
            if !status.success() {
                bail!("target agent lock exited with {status}");
            }
        } else {
            self.child
                .kill()
                .await
                .context("failed to stop target agent lock")?;
            let _ = self.child.wait().await;
        }
        Ok(())
    }
}

fn selector_ensure_lock(selector: &str) -> Arc<AsyncMutex<()>> {
    let locks = AGENT_ENSURE_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(selector).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(selector.to_owned(), Arc::downgrade(&lock));
    lock
}

fn agent_was_recently_ensured(selector: &str, minimum_version: u64, now: Instant) -> bool {
    let ready = AGENT_READY_CACHE.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut ready = ready
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    ready.retain(|_, entry| agent_ready_cache_entry_is_fresh(entry.verified_at, now));
    ready
        .get(selector)
        .is_some_and(|entry| entry.minimum_version >= minimum_version)
}

fn mark_agent_ensured(selector: &str, minimum_version: u64) {
    let ready = AGENT_READY_CACHE.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut ready = ready
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = Instant::now();
    ready.retain(|_, entry| agent_ready_cache_entry_is_fresh(entry.verified_at, now));
    let minimum_version = ready.get(selector).map_or(minimum_version, |entry| {
        entry.minimum_version.max(minimum_version)
    });
    ready.insert(
        selector.to_owned(),
        AgentReadyCacheEntry {
            verified_at: now,
            minimum_version,
        },
    );
}

fn invalidate_agent_ensured(selector: &str) {
    let ready = AGENT_READY_CACHE.get_or_init(|| StdMutex::new(HashMap::new()));
    ready
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(selector);
}

fn recent_agent_ensure_failure(
    selector: &str,
    minimum_version: u64,
    now: Instant,
) -> Option<String> {
    let failures = AGENT_ENSURE_FAILURES.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut failures = failures
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    failures.retain(|_, entry| {
        now.saturating_duration_since(entry.failed_at) < AGENT_ENSURE_FAILURE_TTL
    });
    failures
        .get(selector)
        .filter(|entry| minimum_version >= entry.minimum_version)
        .map(|entry| entry.message.clone())
}

fn mark_agent_ensure_failure(selector: &str, minimum_version: u64, message: String) {
    let failures = AGENT_ENSURE_FAILURES.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut failures = failures
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let minimum_version = failures.get(selector).map_or(minimum_version, |entry| {
        entry.minimum_version.min(minimum_version)
    });
    failures.insert(
        selector.to_owned(),
        AgentEnsureFailureEntry {
            failed_at: Instant::now(),
            minimum_version,
            message,
        },
    );
}

fn clear_agent_ensure_failure(selector: &str, satisfied_version: u64) {
    let failures = AGENT_ENSURE_FAILURES.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut failures = failures
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if failures
        .get(selector)
        .is_some_and(|entry| entry.minimum_version <= satisfied_version)
    {
        failures.remove(selector);
    }
}

fn agent_ready_cache_entry_is_fresh(verified_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(verified_at) < AGENT_READY_CACHE_TTL
}

fn remote_agent_lock_script(selector: &str) -> String {
    format!(
        r#"set -eu
lock_file={}
lock_dir="${{lock_file}}.d"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$lock_file"
  flock 9
else
  attempts=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    owner="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$lock_dir"
      continue
    fi
    attempts=$((attempts + 1))
    [ "$attempts" -lt 300 ] || exit 1
    sleep 0.2
  done
  printf '%s' "$$" > "$lock_dir/pid"
  trap 'rm -rf "$lock_dir"' EXIT HUP INT TERM
fi
printf '%s\n' {}
IFS= read -r _release || true
"#,
        shell_quote(&scoped_upgrade_lock_path(selector)),
        shell_quote(AGENT_LOCK_READY_MARKER),
    )
}

impl AgentClient {
    pub async fn state(
        &self,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<AgentWorkspaceState> {
        let request = state_request(
            self.selector.clone(),
            self.username.clone(),
            cols,
            rows,
            output_limit,
        );
        response_state(run_agent_request(self, &request).await?)
    }

    pub async fn action(
        &self,
        cols: u16,
        rows: u16,
        output_limit: usize,
        action: AgentWorkspaceAction,
    ) -> anyhow::Result<AgentWorkspaceState> {
        let request = action_request(
            self.selector.clone(),
            self.username.clone(),
            cols,
            rows,
            output_limit,
            action,
        );
        response_state(run_agent_request(self, &request).await?)
    }

    pub async fn close_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        output_limit: usize,
    ) -> anyhow::Result<AgentWorkspaceState> {
        let request = close_session_request(
            self.selector.clone(),
            self.username.clone(),
            session_id.to_owned(),
            cols,
            rows,
            output_limit,
        );
        response_state(run_agent_request(self, &request).await?)
    }

    pub fn attach_command(
        &self,
        pane_id: &str,
        cols: u16,
        rows: u16,
        output_limit: usize,
        replay_after: u64,
    ) -> Command {
        let mut command = Command::new(LIGHTOSCTL);
        command
            .args([
                "exec",
                "-i",
                self.selector.as_str(),
                AGENT_INSTALL_PATH,
                "agent",
                "attach",
                "--socket",
                self.socket_path.as_str(),
                "--selector",
                self.selector.as_str(),
                "--username",
                self.username.as_str(),
                "--pane",
                pane_id,
                "--cols",
            ])
            .arg(cols.to_string())
            .arg("--rows")
            .arg(rows.to_string())
            .arg("--output-limit")
            .arg(normalize_output_frame_limit(Some(output_limit)).to_string())
            .arg("--replay-after")
            .arg(replay_after.to_string());
        command
    }

    pub fn interactive_command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(LIGHTOSCTL);
        command.args([
            "exec",
            "-i",
            self.selector.as_str(),
            AGENT_INSTALL_PATH,
            "agent",
        ]);
        command.args(args);
        command
    }
}

pub async fn ensure_agent(selector: &str, username: &str) -> anyhow::Result<AgentClient> {
    ensure_agent_at_least(selector, username, MIN_SUPPORTED_AGENT_VERSION).await
}

pub(crate) async fn ensure_agent_at_least(
    selector: &str,
    username: &str,
    minimum_version: u64,
) -> anyhow::Result<AgentClient> {
    if minimum_version > AGENT_VERSION {
        bail!(
            "requested agent version {minimum_version} exceeds embedded agent version {AGENT_VERSION}"
        );
    }
    let selector = selector.trim();
    validate_selector(selector).map_err(|err| {
        anyhow!(
            "{}",
            err.message
                .unwrap_or_else(|| "invalid LightOS selector".to_owned())
        )
    })?;
    let username = username.trim().to_owned();
    let client = AgentClient {
        selector: selector.to_owned(),
        username,
        socket_path: scoped_socket_path(selector),
    };
    if let Some(message) = recent_agent_ensure_failure(selector, minimum_version, Instant::now()) {
        bail!("webshell agent preparation is cooling down after a recent failure: {message}");
    }
    if agent_was_recently_ensured(selector, minimum_version, Instant::now()) {
        return Ok(client);
    }
    let ensure_lock = selector_ensure_lock(selector);
    let _ensure_guard = ensure_lock.lock().await;
    if agent_was_recently_ensured(selector, minimum_version, Instant::now()) {
        return Ok(client);
    }
    if let Some(message) = recent_agent_ensure_failure(selector, minimum_version, Instant::now()) {
        bail!("webshell agent preparation is cooling down after a recent failure: {message}");
    }
    let expected = agent_payload_identity().await?;

    let running_rollback_payload = match ping_agent(&client).await {
        Ok(response) => {
            if running_agent_is_acceptable_at_least(&response, minimum_version) {
                mark_agent_ensured(selector, minimum_version);
                return Ok(client);
            }
            reject_unsupported_newer_agent(&response)?;
            reusable_running_agent_rollback_payload(&response, &expected)
        }
        Err(_) => None,
    };

    // A stronger feature requirement is about to mutate the shared target
    // agent. Prevent weaker callers from trusting a pre-upgrade cache entry.
    invalidate_agent_ensured(selector);
    let remote_lock = RemoteAgentLock::acquire(selector).await.map_err(|err| {
        mark_agent_ensure_failure(selector, minimum_version, err.to_string());
        err
    })?;
    let rollback_payload = match probe_installed_agent_payload(selector).await {
        Ok(installed) => {
            reusable_agent_rollback_payload(installed, &expected).or(running_rollback_payload)
        }
        Err(err) => {
            warn!(selector = %selector, error = %err, "failed to capture webshell agent rollback payload");
            running_rollback_payload
        }
    };
    let mut result = ensure_agent_locked(&client, &expected, minimum_version).await;
    if result.is_err()
        && let Some(rollback_payload) = rollback_payload
    {
        match restore_agent_after_failed_upgrade(&client, &rollback_payload).await {
            Ok(()) => warn!(
                selector = %selector,
                restored_agent_version = rollback_payload.agent_version,
                restored_manifest = %rollback_payload.manifest,
                "restored compatible webshell agent after failed upgrade"
            ),
            Err(rollback_error) => {
                let upgrade_error = result.expect_err("failed agent ensure must contain an error");
                result = Err(upgrade_error.context(format!(
                    "failed to restore previous compatible webshell agent: {rollback_error}"
                )));
            }
        }
    }
    if let Err(err) = remote_lock.release().await {
        warn!(selector = %selector, error = %err, "failed to release webshell agent upgrade lock");
    }
    if result.is_ok() {
        mark_agent_ensured(selector, minimum_version);
        clear_agent_ensure_failure(selector, minimum_version);
    } else if let Err(err) = &result {
        mark_agent_ensure_failure(selector, minimum_version, err.to_string());
    }
    result
}

fn reusable_agent_rollback_payload(
    installed: Option<InstalledAgentIdentity>,
    expected: &AgentPayloadIdentity,
) -> Option<AgentPayloadIdentity> {
    let installed = installed?;
    if agent_protocol_compatibility(Some(&installed.protocol_version))
        != AgentProtocolCompatibility::Current
    {
        return None;
    }
    installed.payload.filter(|payload| {
        payload.agent_version >= MIN_SUPPORTED_AGENT_VERSION
            && payload.install_path != expected.install_path
    })
}

fn reusable_running_agent_rollback_payload(
    response: &AgentResponse,
    expected: &AgentPayloadIdentity,
) -> Option<AgentPayloadIdentity> {
    if agent_protocol_compatibility(response.version.as_deref())
        != AgentProtocolCompatibility::Current
    {
        return None;
    }
    let agent_version = running_agent_version(response)?;
    if agent_version < MIN_SUPPORTED_AGENT_VERSION {
        return None;
    }
    let manifest = response.payload_manifest.as_deref()?;
    let install_path = agent_payload_install_path(manifest).ok()?;
    (install_path != expected.install_path).then(|| AgentPayloadIdentity {
        manifest: manifest.to_owned(),
        install_path,
        agent_version,
    })
}

async fn restore_agent_after_failed_upgrade(
    client: &AgentClient,
    rollback_payload: &AgentPayloadIdentity,
) -> anyhow::Result<()> {
    if let Ok(response) = ping_agent(client).await {
        match agent_rollback_action(&response, &rollback_payload.manifest) {
            AgentRollbackAction::PreserveRunning => return Ok(()),
            AgentRollbackAction::ReactivateRollback => {
                activate_agent_payload(&client.selector, &rollback_payload.install_path).await?;
                return Ok(());
            }
            AgentRollbackAction::RejectNewer => {
                return reject_unsupported_newer_agent(&response);
            }
            AgentRollbackAction::RestoreRollback => {}
        }
    }
    activate_agent_payload(&client.selector, &rollback_payload.install_path).await?;
    restart_agent(client, rollback_payload).await?;
    wait_for_agent(client, rollback_payload, MIN_SUPPORTED_AGENT_VERSION).await
}

fn agent_rollback_action(response: &AgentResponse, rollback_manifest: &str) -> AgentRollbackAction {
    if agent_protocol_compatibility(response.version.as_deref())
        == AgentProtocolCompatibility::Newer
    {
        AgentRollbackAction::RejectNewer
    } else if running_agent_is_acceptable_at_least(response, MIN_SUPPORTED_AGENT_VERSION) {
        if response.payload_manifest.as_deref() == Some(rollback_manifest) {
            AgentRollbackAction::ReactivateRollback
        } else {
            AgentRollbackAction::PreserveRunning
        }
    } else {
        AgentRollbackAction::RestoreRollback
    }
}

async fn ensure_agent_locked(
    client: &AgentClient,
    expected: &AgentPayloadIdentity,
    minimum_version: u64,
) -> anyhow::Result<AgentClient> {
    match ping_agent(client).await {
        Ok(response) if running_agent_is_acceptable_at_least(&response, minimum_version) => {
            return Ok(client.clone());
        }
        Ok(response)
            if agent_protocol_compatibility(response.version.as_deref())
                == AgentProtocolCompatibility::Newer =>
        {
            reject_unsupported_newer_agent(&response)?;
        }
        Ok(response)
            if agent_protocol_compatibility(response.version.as_deref())
                == AgentProtocolCompatibility::Stale =>
        {
            warn!(
                selector = %client.selector,
                running_protocol = response.version.as_deref().unwrap_or(""),
                expected_protocol = AGENT_PROTOCOL_VERSION,
                "webshell agent protocol is stale; restarting agent"
            );
            ensure_agent_binary_installed(&client.selector, expected).await?;
            restart_agent(client, expected).await?;
            wait_for_agent(client, expected, minimum_version).await?;
            prune_stale_agent_payloads(&client.selector, expected).await;
            return Ok(client.clone());
        }
        Ok(response) => {
            warn!(
                selector = %client.selector,
                running_manifest = response.payload_manifest.as_deref().unwrap_or(""),
                running_agent_version = running_agent_version(&response).unwrap_or_default(),
                expected_manifest = %expected.manifest,
                embedded_agent_version = expected.agent_version,
                minimum_supported_agent_version = minimum_version,
                "webshell agent version is below the compatibility floor; restarting agent"
            );
            ensure_agent_binary_installed(&client.selector, expected).await?;
            restart_agent(client, expected).await?;
            wait_for_agent(client, expected, minimum_version).await?;
            prune_stale_agent_payloads(&client.selector, expected).await;
            return Ok(client.clone());
        }
        Err(_) => {}
    }
    if try_recover_installed_agent(client, expected, minimum_version).await? {
        return Ok(client.clone());
    }
    ensure_agent_binary_installed(&client.selector, expected).await?;
    match ping_agent(client).await {
        Ok(response) if running_agent_is_acceptable_at_least(&response, minimum_version) => {
            return Ok(client.clone());
        }
        Ok(response)
            if agent_protocol_compatibility(response.version.as_deref())
                != AgentProtocolCompatibility::Newer =>
        {
            restart_agent(client, expected).await?;
            wait_for_agent(client, expected, minimum_version).await?;
            prune_stale_agent_payloads(&client.selector, expected).await;
            return Ok(client.clone());
        }
        Ok(response) => {
            reject_unsupported_newer_agent(&response)?;
        }
        Err(_) => {}
    }
    start_agent(client, expected).await?;
    wait_for_agent(client, expected, minimum_version).await?;
    prune_stale_agent_payloads(&client.selector, expected).await;
    Ok(client.clone())
}

async fn try_recover_installed_agent(
    client: &AgentClient,
    expected: &AgentPayloadIdentity,
    minimum_version: u64,
) -> anyhow::Result<bool> {
    let installed = probe_installed_agent_payload(&client.selector).await?;
    let reusable_installed = if let Some(installed) = installed {
        match agent_protocol_compatibility(Some(&installed.protocol_version)) {
            AgentProtocolCompatibility::Newer => {
                return reject_unsupported_newer_agent_protocol(&installed.protocol_version)
                    .map(|()| false);
            }
            AgentProtocolCompatibility::Current
                if installed
                    .payload
                    .as_ref()
                    .is_some_and(|payload| payload.agent_version >= minimum_version) =>
            {
                installed.payload
            }
            AgentProtocolCompatibility::Current | AgentProtocolCompatibility::Stale => None,
        }
    } else {
        None
    };
    let restart_payload = if let Some(installed) = reusable_installed {
        installed
    } else if installed_agent_binary_exists(&client.selector, &expected.install_path)
        .await
        .unwrap_or(false)
    {
        expected.clone()
    } else {
        return Ok(false);
    };
    activate_agent_payload(&client.selector, &restart_payload.install_path).await?;
    if let Err(err) = restart_agent(client, &restart_payload).await {
        warn!(
            selector = %client.selector,
            error = %err,
            "failed to restart installed webshell agent; reinstalling agent"
        );
        return Ok(false);
    }
    match wait_for_agent_response(client).await {
        Ok(response) if running_agent_is_acceptable_at_least(&response, minimum_version) => {
            Ok(true)
        }
        Ok(response)
            if agent_protocol_compatibility(response.version.as_deref())
                == AgentProtocolCompatibility::Current =>
        {
            warn!(
                selector = %client.selector,
                running_manifest = response.payload_manifest.as_deref().unwrap_or(""),
                running_agent_version = running_agent_version(&response).unwrap_or_default(),
                minimum_supported_agent_version = minimum_version,
                expected_manifest = %expected.manifest,
                "installed webshell agent version is below the compatibility floor; upgrading agent"
            );
            Ok(false)
        }
        Ok(response)
            if agent_protocol_compatibility(response.version.as_deref())
                == AgentProtocolCompatibility::Stale =>
        {
            warn!(
                selector = %client.selector,
                running_protocol = response.version.as_deref().unwrap_or(""),
                expected_protocol = AGENT_PROTOCOL_VERSION,
                "installed webshell agent protocol is stale; upgrading agent"
            );
            Ok(false)
        }
        Ok(response) => reject_unsupported_newer_agent(&response).map(|()| false),
        Err(err) => {
            warn!(
                selector = %client.selector,
                error = %err,
                "installed webshell agent did not restart; reinstalling agent"
            );
            Ok(false)
        }
    }
}

async fn ping_agent(client: &AgentClient) -> anyhow::Result<AgentResponse> {
    let request = ping_request(client.selector.clone(), client.username.clone());
    let response = run_agent_request(client, &request).await?;
    if response.ok != Some(true) {
        bail!(
            "{}",
            response
                .error
                .clone()
                .unwrap_or_else(|| "agent ping failed".to_owned())
        );
    }
    Ok(response)
}

async fn wait_for_agent(
    client: &AgentClient,
    expected: &AgentPayloadIdentity,
    minimum_version: u64,
) -> anyhow::Result<()> {
    let mut last_error = None;
    for _ in 0..25 {
        match ping_agent(client).await {
            Ok(response) if running_agent_is_acceptable_at_least(&response, minimum_version) => {
                return Ok(());
            }
            Ok(response)
                if agent_protocol_compatibility(response.version.as_deref())
                    == AgentProtocolCompatibility::Current =>
            {
                last_error = Some(anyhow!(
                    "agent version mismatch: running {} version {}, expected minimum version {} from embedded version {} ({})",
                    response.payload_manifest.as_deref().unwrap_or_default(),
                    running_agent_version(&response).unwrap_or_default(),
                    minimum_version,
                    expected.agent_version,
                    expected.manifest,
                ));
            }
            Ok(response) => {
                last_error = Some(anyhow!(
                    "agent protocol mismatch: running {}, expected {}",
                    response.version.unwrap_or_default(),
                    AGENT_PROTOCOL_VERSION
                ));
            }
            Err(err) => last_error = Some(err),
        }
        sleep(Duration::from_millis(120)).await;
    }
    let log_tail = read_agent_log_tail(client, AGENT_LOG_TAIL_LINES).await;
    Err(agent_startup_timeout_error(
        client,
        last_error.as_ref(),
        &log_tail,
    ))
}

async fn wait_for_agent_response(client: &AgentClient) -> anyhow::Result<AgentResponse> {
    let mut last_error = None;
    for _ in 0..25 {
        match ping_agent(client).await {
            Ok(response) => return Ok(response),
            Err(err) => last_error = Some(err),
        }
        sleep(Duration::from_millis(120)).await;
    }
    let log_tail = read_agent_log_tail(client, AGENT_LOG_TAIL_LINES).await;
    Err(agent_startup_timeout_error(
        client,
        last_error.as_ref(),
        &log_tail,
    ))
}

async fn installed_agent_binary_exists(selector: &str, agent_path: &str) -> anyhow::Result<bool> {
    let output = run_target_shell(
        selector,
        &installed_agent_probe_script(agent_path),
        None,
        Duration::from_secs(8),
    )
    .await?;
    Ok(String::from_utf8_lossy(&output.stdout).trim() == AGENT_READY_MARKER)
}

fn installed_agent_probe_script(agent_path: &str) -> String {
    format!(
        r#"agent={}
if [ -x "$agent" ]; then
  printf '%s\n' {}
fi
"#,
        shell_quote(agent_path),
        shell_quote(AGENT_READY_MARKER),
    )
}

async fn probe_installed_agent_payload(
    selector: &str,
) -> anyhow::Result<Option<InstalledAgentIdentity>> {
    let output = run_target_shell(
        selector,
        &installed_agent_identity_probe_script(),
        None,
        Duration::from_secs(8),
    )
    .await?;
    Ok(parse_installed_agent_identity(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn installed_agent_identity_probe_script() -> String {
    format!(
        r#"set -eu
agent={}
if [ -L "$agent" ] && [ -x "$agent" ]; then
  target="$(readlink "$agent" 2>/dev/null || true)"
  protocol="$("$agent" version 2>/dev/null || true)"
  agent_version="$("$agent" agent-version 2>/dev/null || true)"
  printf '%s\t%s\t%s\t%s\n' {} "$protocol" "$agent_version" "$target"
fi
"#,
        shell_quote(AGENT_INSTALL_PATH),
        shell_quote(AGENT_READY_MARKER),
    )
}

fn parse_installed_agent_identity(output: &str) -> Option<InstalledAgentIdentity> {
    let line = output.lines().find(|line| !line.trim().is_empty())?;
    let mut fields = line.split('\t');
    if fields.next() != Some(AGENT_READY_MARKER) {
        return None;
    }
    let protocol_version = fields.next().unwrap_or_default().to_owned();
    let agent_version = match fields.next().filter(|value| !value.is_empty()) {
        Some(value) => value
            .parse()
            .ok()
            .filter(|version| *version > 0)
            .unwrap_or_default(),
        None if agent_protocol_compatibility(Some(&protocol_version))
            == AgentProtocolCompatibility::Current =>
        {
            LEGACY_V0_5_35_AGENT_VERSION
        }
        None => 0,
    };
    let install_path = fields.next().unwrap_or_default().to_owned();
    if fields.next().is_some() {
        return None;
    }
    let payload = agent_payload_manifest_from_install_path(&install_path).map(|manifest| {
        AgentPayloadIdentity {
            manifest,
            install_path,
            agent_version,
        }
    });
    Some(InstalledAgentIdentity {
        protocol_version,
        payload,
    })
}

async fn run_agent_request(
    client: &AgentClient,
    request: &crate::proto::lazycat::webshell::v1::AgentRequest,
) -> anyhow::Result<AgentResponse> {
    let encoded = BASE64_STANDARD.encode(request.encode_to_vec());
    let mut command = Command::new(LIGHTOSCTL);
    command.args([
        "exec",
        "-i",
        client.selector.as_str(),
        AGENT_INSTALL_PATH,
        "agent",
        "request",
        "--socket",
        client.socket_path.as_str(),
        "--request",
        encoded.as_str(),
    ]);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let output = run_command_with_input_timeout(command, None, Duration::from_secs(8))
        .await
        .map_err(|err| {
            if err.to_string().contains("timed out") {
                anyhow!("agent request timed out")
            } else {
                anyhow!("failed to run agent request: {err}")
            }
        })?;
    if !output.status.success() {
        bail!("agent request failed: {}", command_output_detail(&output));
    }
    read_agent_response(output.stdout.as_slice())
        .map_err(|err| anyhow!("invalid agent response: {err}"))
}

async fn ensure_agent_binary_installed(
    selector: &str,
    expected: &AgentPayloadIdentity,
) -> anyhow::Result<()> {
    if installed_agent_binary_exists(selector, &expected.install_path).await? {
        activate_agent_payload(selector, &expected.install_path).await?;
        return Ok(());
    }
    let payload = load_agent_payload().await?;
    install_agent_binary(selector, &expected.install_path, &payload).await
}

async fn load_agent_payload() -> anyhow::Result<Vec<u8>> {
    #[cfg(not(debug_assertions))]
    {
        if EMBEDDED_AGENT_BINARY.is_empty() {
            bail!("embedded webshell agent payload is empty");
        }
        Ok(EMBEDDED_AGENT_BINARY.to_vec())
    }

    #[cfg(debug_assertions)]
    {
        let provider = std::env::current_exe().context("failed to resolve current executable")?;
        let path = sibling_agent_path(&provider);
        tokio::fs::read(&path)
            .await
            .with_context(|| format!("failed to read lightweight agent at {}", path.display()))
    }
}

async fn agent_payload_identity() -> anyhow::Result<AgentPayloadIdentity> {
    let manifest = agent_payload_manifest().await?;
    let install_path = agent_payload_install_path(&manifest)?;
    Ok(AgentPayloadIdentity {
        manifest,
        install_path,
        agent_version: AGENT_VERSION,
    })
}

async fn agent_payload_manifest() -> anyhow::Result<String> {
    #[cfg(not(debug_assertions))]
    {
        if EMBEDDED_AGENT_BINARY.is_empty() || EMBEDDED_AGENT_SHA256.is_empty() {
            bail!("embedded webshell agent payload or manifest is empty");
        }
        Ok(EMBEDDED_AGENT_SHA256.to_owned())
    }

    #[cfg(debug_assertions)]
    {
        let provider = std::env::current_exe().context("failed to resolve current executable")?;
        let path = sibling_agent_path(&provider);
        let payload = tokio::fs::read(&path)
            .await
            .with_context(|| format!("failed to read lightweight agent at {}", path.display()))?;
        Ok(binary_manifest(&payload))
    }
}

#[cfg(debug_assertions)]
fn sibling_agent_path(provider: &std::path::Path) -> PathBuf {
    provider.with_file_name("lazycat-neko-webshell-agent")
}

fn agent_payload_install_path(manifest: &str) -> anyhow::Result<String> {
    let digest = manifest
        .strip_prefix("sha256:")
        .filter(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
        .ok_or_else(|| anyhow!("invalid embedded webshell agent manifest"))?;
    Ok(format!(
        "{AGENT_PAYLOAD_ROOT}/sha256-{digest}/lazycat-neko-webshell-agent"
    ))
}

fn agent_payload_manifest_from_install_path(path: &str) -> Option<String> {
    let path = std::path::Path::new(path);
    if path.file_name()?.to_str()? != "lazycat-neko-webshell-agent" {
        return None;
    }
    let payload_dir = path.parent()?;
    if payload_dir.parent()? != std::path::Path::new(AGENT_PAYLOAD_ROOT) {
        return None;
    }
    let digest = payload_dir.file_name()?.to_str()?.strip_prefix("sha256-")?;
    let manifest = format!("sha256:{digest}");
    agent_payload_install_path(&manifest).ok().map(|_| manifest)
}

async fn activate_agent_payload(selector: &str, agent_path: &str) -> anyhow::Result<()> {
    let script = activate_agent_payload_script(agent_path);
    let output = run_target_shell(selector, &script, None, Duration::from_secs(8)).await?;
    if String::from_utf8_lossy(&output.stdout).trim() != AGENT_READY_MARKER {
        bail!(
            "agent activation did not complete: {}",
            command_output_detail(&output)
        );
    }
    Ok(())
}

fn activate_agent_payload_script(agent_path: &str) -> String {
    let script = format!(
        r#"set -eu
agent={}
link={}
tmp_link="${{link}}.tmp-$$"
[ -x "$agent" ]
rm -f "$tmp_link"
ln -s "$agent" "$tmp_link"
mv -f "$tmp_link" "$link"
printf '%s\n' {}
"#,
        shell_quote(agent_path),
        shell_quote(AGENT_INSTALL_PATH),
        shell_quote(AGENT_READY_MARKER),
    );
    script
}

async fn install_agent_binary(
    selector: &str,
    agent_path: &str,
    payload: &[u8],
) -> anyhow::Result<()> {
    let install_dir = std::path::Path::new(agent_path)
        .parent()
        .and_then(std::path::Path::to_str)
        .ok_or_else(|| anyhow!("invalid webshell agent install path"))?;
    let tmp_path = format!("{agent_path}.tmp-{}", std::process::id());
    let script = format!(
        r#"set -eu
install_dir={}
agent={}
tmp={}
link={}
tmp_link="${{link}}.tmp-$$"
mkdir -p "$install_dir"
cat > "$tmp"
chmod 755 "$tmp"
mv "$tmp" "$agent"
rm -f "$tmp_link"
ln -s "$agent" "$tmp_link"
mv -f "$tmp_link" "$link"
printf '%s\n' {}
"#,
        shell_quote(install_dir),
        shell_quote(agent_path),
        shell_quote(&tmp_path),
        shell_quote(AGENT_INSTALL_PATH),
        shell_quote(AGENT_READY_MARKER),
    );
    let output =
        run_target_shell(selector, &script, Some(payload), Duration::from_secs(30)).await?;
    if String::from_utf8_lossy(&output.stdout).trim() != AGENT_READY_MARKER {
        bail!(
            "agent install did not complete: {}",
            command_output_detail(&output)
        );
    }
    Ok(())
}

async fn prune_stale_agent_payloads(selector: &str, expected: &AgentPayloadIdentity) {
    let Some(active_dir) = std::path::Path::new(&expected.install_path)
        .parent()
        .and_then(std::path::Path::to_str)
    else {
        return;
    };
    let script = format!(
        r#"set -eu
root={}
active={}
backup_kept=0
for directory in $(ls -1dt "$root"/sha256-* 2>/dev/null || true); do
  [ -d "$directory" ] || continue
  [ "$directory" = "$active" ] && continue
  if [ "$backup_kept" -eq 0 ]; then
    backup_kept=1
    continue
  fi
  rm -rf "$directory"
done
"#,
        shell_quote(AGENT_PAYLOAD_ROOT),
        shell_quote(active_dir),
    );
    if let Err(err) = run_target_shell(selector, &script, None, Duration::from_secs(8)).await {
        warn!(selector = %selector, error = %err, "failed to prune stale webshell agent payloads");
    }
}

async fn start_agent(client: &AgentClient, expected: &AgentPayloadIdentity) -> anyhow::Result<()> {
    start_agent_with_reset(client, expected, false).await
}

async fn restart_agent(
    client: &AgentClient,
    expected: &AgentPayloadIdentity,
) -> anyhow::Result<()> {
    start_agent_with_reset(client, expected, true).await
}

async fn start_agent_with_reset(
    client: &AgentClient,
    expected: &AgentPayloadIdentity,
    stop_existing: bool,
) -> anyhow::Result<()> {
    let script = agent_start_script(client, &expected.install_path, stop_existing);
    let output = run_target_shell(&client.selector, &script, None, Duration::from_secs(10))
        .await
        .with_context(|| {
            format!(
                "agent start command failed: {}",
                agent_runtime_context(client)
            )
        })?;
    if String::from_utf8_lossy(&output.stdout).trim() != AGENT_READY_MARKER {
        bail!(
            "{}",
            agent_start_failure_message(client, &command_output_detail(&output))
        );
    }
    Ok(())
}

fn agent_start_script(client: &AgentClient, agent_path: &str, stop_existing: bool) -> String {
    let log_path = scoped_log_path(&client.selector);
    let stop_script = if stop_existing {
        r#"
if [ -S "$socket" ]; then
  old_pids="$(fuser "$socket" 2>/dev/null || true)"
  if [ -n "$old_pids" ]; then kill $old_pids 2>/dev/null || true; fi
fi
"#
        .to_string()
    } else {
        String::new()
    };
    format!(
        r#"set -eu
agent={}
socket={}
log={}
selector={}
username={}
{}
rm -f "$socket"
if command -v setsid >/dev/null 2>&1; then
  setsid "$agent" agent daemon --socket "$socket" --selector "$selector" --username "$username" </dev/null >>"$log" 2>&1 &
else
  nohup "$agent" agent daemon --socket "$socket" --selector "$selector" --username "$username" </dev/null >>"$log" 2>&1 &
fi
printf '%s\n' {}
"#,
        shell_quote(agent_path),
        shell_quote(&client.socket_path),
        shell_quote(&log_path),
        shell_quote(&client.selector),
        shell_quote(&client.username),
        stop_script,
        shell_quote(AGENT_READY_MARKER),
    )
}

async fn read_agent_log_tail(client: &AgentClient, lines: usize) -> String {
    let lines = lines.max(1);
    let script = format!(
        "tail -n {} {} 2>/dev/null || true",
        lines,
        shell_quote(&scoped_log_path(&client.selector)),
    );
    match run_target_shell(&client.selector, &script, None, Duration::from_secs(5)).await {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        Err(_) => String::new(),
    }
}

fn agent_startup_timeout_error(
    client: &AgentClient,
    last_error: Option<&anyhow::Error>,
    log_tail: &str,
) -> anyhow::Error {
    anyhow!(agent_startup_timeout_message(client, last_error, log_tail))
}

fn agent_startup_timeout_message(
    client: &AgentClient,
    last_error: Option<&anyhow::Error>,
    log_tail: &str,
) -> String {
    use std::fmt::Write as _;

    let mut message = format!(
        "agent did not become ready: {}",
        agent_runtime_context(client)
    );
    if let Some(error) = last_error {
        let _ = write!(message, "\nlast ping error: {error}");
    }
    let log_tail = log_tail.trim();
    if !log_tail.is_empty() {
        let _ = write!(message, "\nagent log tail:\n{log_tail}");
    }
    message
}

fn agent_start_failure_message(client: &AgentClient, output_detail: &str) -> String {
    let context = agent_runtime_context(client);
    let output_detail = output_detail.trim();
    if output_detail.is_empty() {
        return format!("agent start did not complete: {context}");
    }
    format!("agent start did not complete: {context}; output={output_detail:?}")
}

fn agent_runtime_context(client: &AgentClient) -> String {
    format!(
        "selector={} username={} socket={} log={}",
        client.selector,
        client.username,
        client.socket_path,
        scoped_log_path(&client.selector),
    )
}

async fn run_target_shell(
    selector: &str,
    script: &str,
    stdin_payload: Option<&[u8]>,
    duration: Duration,
) -> anyhow::Result<std::process::Output> {
    let mut command = Command::new(LIGHTOSCTL);
    if stdin_payload.is_some() {
        command.args(["exec", "-i", selector, "/bin/sh", "-lc", script]);
        command.stdin(Stdio::piped());
    } else {
        command.args(["exec", selector, "/bin/sh", "-lc", script]);
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let output = run_command_with_input_timeout(command, stdin_payload, duration).await?;
    if !output.status.success() {
        bail!("target command failed: {}", command_output_detail(&output));
    }
    Ok(output)
}

async fn run_command_with_input_timeout(
    mut command: Command,
    stdin_payload: Option<&[u8]>,
    duration: Duration,
) -> anyhow::Result<std::process::Output> {
    command.kill_on_drop(true);
    timeout(duration, async move {
        let mut child = command
            .spawn()
            .map_err(|err| anyhow!("failed to enter target instance: {err}"))?;
        if let Some(payload) = stdin_payload {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| anyhow!("failed to open target command stdin"))?;
            stdin
                .write_all(payload)
                .await
                .map_err(|err| anyhow!("failed to write target command stdin: {err}"))?;
            drop(stdin);
        }
        child
            .wait_with_output()
            .await
            .map_err(|err| anyhow!("target command failed: {err}"))
    })
    .await
    .map_err(|_| anyhow!("target command timed out"))?
}

fn response_state(response: AgentResponse) -> anyhow::Result<AgentWorkspaceState> {
    response_ok(response.clone())?;
    response
        .state
        .into_option()
        .ok_or_else(|| anyhow!("agent response did not include workspace state"))
}

fn response_ok(response: AgentResponse) -> anyhow::Result<()> {
    if response.version.as_deref() != Some(AGENT_PROTOCOL_VERSION) {
        bail!(
            "unsupported agent protocol: {}",
            response.version.unwrap_or_default()
        );
    }
    if response.ok == Some(true) {
        return Ok(());
    }
    bail!(
        "{}",
        response
            .error
            .unwrap_or_else(|| "agent request failed".to_owned())
    )
}

fn agent_protocol_version_is_current(version: Option<&str>) -> bool {
    agent_protocol_compatibility(version) == AgentProtocolCompatibility::Current
}

#[cfg(test)]
fn running_agent_is_acceptable(response: &AgentResponse) -> bool {
    running_agent_is_acceptable_at_least(response, MIN_SUPPORTED_AGENT_VERSION)
}

fn running_agent_is_acceptable_at_least(response: &AgentResponse, minimum_version: u64) -> bool {
    if !agent_protocol_version_is_current(response.version.as_deref()) {
        return false;
    }
    let Some(_running_manifest) = response
        .payload_manifest
        .as_deref()
        .filter(|manifest| agent_payload_install_path(manifest).is_ok())
    else {
        return false;
    };
    running_agent_version(response).is_some_and(|version| version >= minimum_version)
}

fn running_agent_version(response: &AgentResponse) -> Option<u64> {
    if let Some(version) = response.agent_version.filter(|version| *version > 0) {
        return Some(version);
    }
    (response.payload_version.as_deref() == Some(LEGACY_V0_5_35_PAYLOAD_VERSION)
        && response.payload_generation.is_some())
    .then_some(LEGACY_V0_5_35_AGENT_VERSION)
}

fn reject_unsupported_newer_agent(response: &AgentResponse) -> anyhow::Result<()> {
    reject_unsupported_newer_agent_protocol(response.version.as_deref().unwrap_or_default())
}

fn reject_unsupported_newer_agent_protocol(version: &str) -> anyhow::Result<()> {
    if agent_protocol_compatibility(Some(version)) != AgentProtocolCompatibility::Newer {
        return Ok(());
    }
    bail!(
        "unsupported newer webshell agent protocol: running {version}, provider expects {AGENT_PROTOCOL_VERSION}"
    )
}

fn agent_protocol_compatibility(version: Option<&str>) -> AgentProtocolCompatibility {
    let Some(version) = version else {
        return AgentProtocolCompatibility::Stale;
    };
    match (
        agent_protocol_generation(version),
        agent_protocol_generation(AGENT_PROTOCOL_VERSION),
    ) {
        (Some(running), Some(current)) if running == current => AgentProtocolCompatibility::Current,
        (Some(running), Some(current)) if running > current => AgentProtocolCompatibility::Newer,
        _ => AgentProtocolCompatibility::Stale,
    }
}

fn agent_protocol_generation(version: &str) -> Option<u32> {
    version
        .trim()
        .strip_prefix("lazycat-neko-webshell-agent-v")?
        .parse()
        .ok()
}

#[cfg(any(debug_assertions, test))]
fn binary_manifest(payload: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload);
    format!("sha256:{}", hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn scoped_socket_path(selector: &str) -> String {
    format!(
        "/tmp/lazycat-neko-webshell-agent-{}.sock",
        scope_hash(selector)
    )
}

fn scoped_log_path(selector: &str) -> String {
    format!(
        "/tmp/lazycat-neko-webshell-agent-{}.log",
        scope_hash(selector)
    )
}

fn scoped_upgrade_lock_path(selector: &str) -> String {
    format!(
        "/tmp/lazycat-neko-webshell-agent-{}.upgrade.lock",
        scope_hash(selector)
    )
}

fn scope_hash(selector: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(selector.trim().as_bytes());
    let digest = hasher.finalize();
    hex_lower(&digest[..12])
}

fn command_output_detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if stderr.is_empty() { stdout } else { stderr }
}

fn shell_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\"'\"'");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_paths_are_stable_and_safe() {
        assert_eq!(scope_hash("demo@owner"), scope_hash(" demo@owner "));
        let socket = scoped_socket_path("demo@owner");
        assert!(socket.starts_with("/tmp/lazycat-neko-webshell-agent-"));
        assert!(
            std::path::Path::new(&socket)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("sock"))
        );
        assert!(
            socket
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '-'))
        );
        assert!(scoped_upgrade_lock_path("demo@owner").ends_with(".upgrade.lock"));
    }

    #[test]
    fn manifest_uses_sha256_hex() {
        assert_eq!(
            binary_manifest(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_agent_payload_uses_a_dedicated_sibling_binary() {
        let provider = PathBuf::from("/lzcapp/pkg/content/lazycat-neko-webshell");

        assert_eq!(
            sibling_agent_path(&provider),
            PathBuf::from("/lzcapp/pkg/content/lazycat-neko-webshell-agent")
        );
        assert_ne!(sibling_agent_path(&provider), provider);
    }

    #[tokio::test]
    async fn command_timeout_covers_stdin_backpressure() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 5"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let payload = vec![0_u8; 8 * 1024 * 1024];
        let started = std::time::Instant::now();

        let error = run_command_with_input_timeout(
            command,
            Some(payload.as_slice()),
            Duration::from_millis(50),
        )
        .await
        .expect_err("blocked stdin write must time out");

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn command_timeout_kills_the_spawned_process() {
        let pid_path = std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-timeout-pid-{}",
            std::process::id()
        ));
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                &format!(
                    "printf '%s' \"$$\" > {}; exec sleep 5",
                    shell_quote(&pid_path.display().to_string())
                ),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let error = run_command_with_input_timeout(command, None, Duration::from_millis(100))
            .await
            .expect_err("command must time out");
        assert!(error.to_string().contains("timed out"));

        let pid = tokio::fs::read_to_string(&pid_path)
            .await
            .expect("timed command pid")
            .trim()
            .to_owned();
        let process_path = std::path::PathBuf::from(format!("/proc/{pid}"));
        for _ in 0..20 {
            if !process_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let _ = tokio::fs::remove_file(pid_path).await;

        assert!(
            !process_path.exists(),
            "timed out process {pid} is still alive"
        );
    }

    #[test]
    fn installed_agent_probe_checks_the_content_addressed_binary() {
        let agent_path = "/usr/local/lib/lazycat-neko-webshell/agents/sha256-abc/agent";
        let script = installed_agent_probe_script(agent_path);
        assert!(script.contains("[ -x \"$agent\" ]"));
        assert!(script.contains(agent_path));
        assert!(script.contains(AGENT_READY_MARKER));
    }

    #[test]
    fn agent_ready_cache_has_a_short_burst_window() {
        let verified_at = Instant::now();
        let just_before_expiration = (verified_at + AGENT_READY_CACHE_TTL)
            .checked_sub(Duration::from_millis(1))
            .expect("ready-cache TTL should exceed one millisecond");
        assert!(agent_ready_cache_entry_is_fresh(
            verified_at,
            just_before_expiration,
        ));
        assert!(!agent_ready_cache_entry_is_fresh(
            verified_at,
            verified_at + AGENT_READY_CACHE_TTL
        ));
    }

    #[test]
    fn agent_ready_cache_preserves_feature_version_requirements() {
        let selector = format!("cache-test-{}", std::process::id());
        let weaker_version = MIN_SUPPORTED_AGENT_VERSION.saturating_sub(1);
        mark_agent_ensured(&selector, weaker_version);
        assert!(agent_was_recently_ensured(
            &selector,
            weaker_version,
            Instant::now(),
        ));
        assert!(!agent_was_recently_ensured(
            &selector,
            MIN_SUPPORTED_AGENT_VERSION,
            Instant::now(),
        ));

        mark_agent_ensured(&selector, MIN_SUPPORTED_AGENT_VERSION);
        assert!(agent_was_recently_ensured(
            &selector,
            MIN_SUPPORTED_AGENT_VERSION,
            Instant::now(),
        ));

        invalidate_agent_ensured(&selector);
        assert!(!agent_was_recently_ensured(
            &selector,
            MIN_SUPPORTED_AGENT_VERSION,
            Instant::now(),
        ));
    }

    #[test]
    fn stronger_agent_failure_cooldown_does_not_block_weaker_features() {
        let selector = format!("failure-cache-test-{}", std::process::id());
        let stronger_version = MIN_SUPPORTED_AGENT_VERSION.saturating_add(1);
        mark_agent_ensure_failure(
            &selector,
            stronger_version,
            "stronger feature failed".to_owned(),
        );

        assert!(
            recent_agent_ensure_failure(&selector, MIN_SUPPORTED_AGENT_VERSION, Instant::now())
                .is_none()
        );
        assert_eq!(
            recent_agent_ensure_failure(&selector, stronger_version, Instant::now()).as_deref(),
            Some("stronger feature failed")
        );

        clear_agent_ensure_failure(&selector, MIN_SUPPORTED_AGENT_VERSION);
        assert!(recent_agent_ensure_failure(&selector, stronger_version, Instant::now()).is_some());
        clear_agent_ensure_failure(&selector, stronger_version);
        assert!(recent_agent_ensure_failure(&selector, stronger_version, Instant::now()).is_none());
    }

    #[test]
    fn failed_upgrade_can_restore_only_an_older_compatible_payload() {
        let expected = AgentPayloadIdentity {
            manifest: "sha256:expected".to_owned(),
            install_path: "/agents/expected".to_owned(),
            agent_version: AGENT_VERSION,
        };
        let previous = AgentPayloadIdentity {
            manifest: "sha256:previous".to_owned(),
            install_path: "/agents/previous".to_owned(),
            agent_version: MIN_SUPPORTED_AGENT_VERSION,
        };
        let installed = InstalledAgentIdentity {
            protocol_version: AGENT_PROTOCOL_VERSION.to_owned(),
            payload: Some(previous.clone()),
        };

        let rollback = reusable_agent_rollback_payload(Some(installed), &expected)
            .expect("compatible previous payload");
        assert_eq!(rollback.install_path, previous.install_path);

        let stale = InstalledAgentIdentity {
            protocol_version: "lazycat-neko-webshell-agent-v3".to_owned(),
            payload: Some(previous),
        };
        assert!(reusable_agent_rollback_payload(Some(stale), &expected).is_none());
    }

    #[test]
    fn failed_upgrade_can_restore_the_observed_running_payload_when_probe_fails() {
        let expected = AgentPayloadIdentity {
            manifest: "sha256:49ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a"
                .to_owned(),
            install_path: agent_payload_install_path(
                "sha256:49ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a",
            )
            .unwrap(),
            agent_version: AGENT_VERSION,
        };
        let running_manifest =
            "sha256:39ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a";
        let running = AgentResponse {
            ok: Some(true),
            version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
            payload_manifest: Some(running_manifest.to_owned()),
            agent_version: Some(MIN_SUPPORTED_AGENT_VERSION),
            ..Default::default()
        };

        let rollback = reusable_running_agent_rollback_payload(&running, &expected)
            .expect("running compatible payload should remain recoverable");
        assert_eq!(rollback.manifest, running_manifest);
        assert_eq!(
            rollback.install_path,
            agent_payload_install_path(running_manifest).unwrap(),
        );
        assert_eq!(rollback.agent_version, MIN_SUPPORTED_AGENT_VERSION);
    }

    #[test]
    fn installed_agent_identity_reuses_the_stable_symlink_target() {
        let digest = "29ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a";
        let path = format!("{AGENT_PAYLOAD_ROOT}/sha256-{digest}/lazycat-neko-webshell-agent");
        let output = format!("{AGENT_READY_MARKER}\t{AGENT_PROTOCOL_VERSION}\t1\t{path}\n");

        let identity = parse_installed_agent_identity(&output).expect("installed agent identity");
        let payload = identity.payload.expect("installed agent payload");

        assert_eq!(identity.protocol_version, AGENT_PROTOCOL_VERSION);
        assert_eq!(payload.manifest, format!("sha256:{digest}"));
        assert_eq!(payload.install_path, path);
        assert_eq!(payload.agent_version, 1);
    }

    #[test]
    fn installed_v0_5_35_symlink_maps_to_the_first_agent_version() {
        let digest = "29ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a";
        let path = format!("{AGENT_PAYLOAD_ROOT}/sha256-{digest}/lazycat-neko-webshell-agent");
        let output = format!("{AGENT_READY_MARKER}\t{AGENT_PROTOCOL_VERSION}\t\t{path}\n");

        let identity =
            parse_installed_agent_identity(&output).expect("legacy installed agent identity");
        let payload = identity.payload.expect("legacy installed agent payload");

        assert_eq!(identity.protocol_version, AGENT_PROTOCOL_VERSION);
        assert_eq!(payload.agent_version, LEGACY_V0_5_35_AGENT_VERSION);
    }

    #[test]
    fn installed_newer_protocol_remains_visible_when_payload_identity_changes() {
        let protocol = "lazycat-neko-webshell-agent-v999";
        let output = format!("{AGENT_READY_MARKER}\t{protocol}\tfuture\t/opt/future-agent\n");

        let identity = parse_installed_agent_identity(&output).expect("newer installed agent");

        assert_eq!(identity.protocol_version, protocol);
        assert!(identity.payload.is_none());
        assert_eq!(
            agent_protocol_compatibility(Some(&identity.protocol_version)),
            AgentProtocolCompatibility::Newer
        );
    }

    #[test]
    fn payload_install_path_accepts_only_a_sha256_manifest() {
        let digest = "29ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a";
        assert_eq!(
            agent_payload_install_path(&format!("sha256:{digest}")).unwrap(),
            format!("{AGENT_PAYLOAD_ROOT}/sha256-{digest}/lazycat-neko-webshell-agent")
        );
        assert!(agent_payload_install_path("sha256:expected").is_err());
        assert!(agent_payload_install_path("md5:29ec22").is_err());
    }

    #[test]
    fn agent_start_executes_the_content_addressed_payload() {
        let client = AgentClient {
            selector: "demo@owner".to_owned(),
            username: "alice".to_owned(),
            socket_path: scoped_socket_path("demo@owner"),
        };
        let agent_path = "/usr/local/lib/lazycat-neko-webshell/agents/sha256-abc/agent";

        let script = agent_start_script(&client, agent_path, true);

        assert!(script.contains(agent_path));
        assert!(!script.contains("--payload-manifest"));
    }

    #[test]
    fn quote_handles_single_quotes() {
        assert_eq!(shell_quote("dev'user"), "'dev'\"'\"'user'");
    }

    #[test]
    fn startup_timeout_message_reports_runtime_context() {
        let selector = "demo@owner";
        let client = AgentClient {
            selector: selector.to_owned(),
            username: "alice".to_owned(),
            socket_path: scoped_socket_path(selector),
        };
        let last_error = anyhow!("agent request timed out");

        let message = agent_startup_timeout_message(
            &client,
            Some(&last_error),
            "listen tcp: too many open files",
        );

        assert!(message.contains("agent did not become ready"));
        assert!(message.contains("selector=demo@owner"));
        assert!(message.contains("username=alice"));
        assert!(message.contains("socket=/tmp/lazycat-neko-webshell-agent-"));
        assert!(message.contains("log=/tmp/lazycat-neko-webshell-agent-"));
        assert!(message.contains("last ping error: agent request timed out"));
        assert!(message.contains("agent log tail:\nlisten tcp: too many open files"));
    }

    #[test]
    fn start_failure_message_reports_context_and_output() {
        let selector = "demo@owner";
        let client = AgentClient {
            selector: selector.to_owned(),
            username: "alice".to_owned(),
            socket_path: scoped_socket_path(selector),
        };

        let message = agent_start_failure_message(&client, "unexpected output");
        assert!(message.contains("agent start did not complete"));
        assert!(message.contains("selector=demo@owner"));
        assert!(message.contains("socket=/tmp/lazycat-neko-webshell-agent-"));
        assert!(message.contains("output=\"unexpected output\""));
    }

    #[test]
    fn classifies_agent_protocol_versions() {
        assert_eq!(
            agent_protocol_compatibility(Some(AGENT_PROTOCOL_VERSION)),
            AgentProtocolCompatibility::Current
        );
        assert_eq!(
            agent_protocol_compatibility(None),
            AgentProtocolCompatibility::Stale
        );
        assert_eq!(
            agent_protocol_compatibility(Some("lazycat-neko-webshell-agent-v1")),
            AgentProtocolCompatibility::Stale
        );
        assert_eq!(
            agent_protocol_compatibility(Some("lazycat-neko-webshell-agent-v999")),
            AgentProtocolCompatibility::Newer
        );
    }

    #[test]
    fn protocol_match_then_minimum_agent_version_controls_reuse() {
        let current_manifest =
            "sha256:29ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a";
        let current = AgentResponse {
            ok: Some(true),
            version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
            payload_manifest: Some(current_manifest.to_owned()),
            agent_version: Some(MIN_SUPPORTED_AGENT_VERSION),
            ..Default::default()
        };
        let stale = AgentResponse {
            ok: Some(true),
            version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
            payload_manifest: Some(
                "sha256:19ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a"
                    .to_owned(),
            ),
            agent_version: Some(MIN_SUPPORTED_AGENT_VERSION.saturating_sub(1)),
            ..Default::default()
        };
        let unidentified = AgentResponse {
            ok: Some(true),
            version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
            ..Default::default()
        };

        assert!(running_agent_is_acceptable(&current));
        assert!(!running_agent_is_acceptable(&stale));
        assert!(!running_agent_is_acceptable(&unidentified));
    }

    #[test]
    fn older_provider_reuses_a_newer_compatible_agent_payload() {
        let newer = AgentResponse {
            ok: Some(true),
            version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
            payload_manifest: Some(
                "sha256:39ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a"
                    .to_owned(),
            ),
            agent_version: Some(MIN_SUPPORTED_AGENT_VERSION + 1),
            ..Default::default()
        };

        assert!(running_agent_is_acceptable(&newer));
    }

    #[test]
    fn minimum_agent_version_rejects_the_legacy_agent_version() {
        let installed = AgentResponse {
            ok: Some(true),
            version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
            payload_manifest: Some(
                "sha256:39ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a"
                    .to_owned(),
            ),
            payload_version: Some("0.5.35".to_owned()),
            payload_generation: Some(123),
            ..Default::default()
        };

        assert_eq!(running_agent_version(&installed), Some(1));
        assert!(!running_agent_is_acceptable(&installed));
    }

    #[test]
    fn v0_5_34_agent_without_payload_identity_upgrades_once() {
        let installed = AgentResponse {
            ok: Some(true),
            version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
            ..Default::default()
        };

        assert_eq!(running_agent_version(&installed), None);
        assert!(!running_agent_is_acceptable(&installed));
    }

    #[test]
    fn protocol_mismatch_wins_over_a_high_agent_version() {
        let stale_protocol = AgentResponse {
            ok: Some(true),
            version: Some("lazycat-neko-webshell-agent-v1".to_owned()),
            payload_manifest: Some(
                "sha256:39ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a"
                    .to_owned(),
            ),
            agent_version: Some(u64::MAX),
            ..Default::default()
        };

        assert!(!running_agent_is_acceptable(&stale_protocol));
    }

    #[test]
    fn failed_upgrade_rollback_rejects_a_newer_running_protocol() {
        let newer_protocol = AgentResponse {
            ok: Some(true),
            version: Some("lazycat-neko-webshell-agent-v999".to_owned()),
            payload_manifest: Some(
                "sha256:49ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a"
                    .to_owned(),
            ),
            agent_version: Some(u64::MAX),
            ..Default::default()
        };

        assert_eq!(
            agent_rollback_action(
                &newer_protocol,
                "sha256:39ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a",
            ),
            AgentRollbackAction::RejectNewer,
        );
    }
}
