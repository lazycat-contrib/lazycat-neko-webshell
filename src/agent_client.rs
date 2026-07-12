#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use buffa::Message;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{sleep, timeout};
use tracing::warn;

use crate::agent_protocol::{
    AGENT_PROTOCOL_VERSION, action_request, close_session_request, ping_request,
    read_agent_response, state_request,
};
use crate::config::LIGHTOSCTL;
use crate::proto::lazycat::webshell::v1::{
    AgentResponse, AgentWorkspaceAction, AgentWorkspaceState,
};
use crate::validation::{normalize_output_frame_limit, validate_selector};

const AGENT_INSTALL_PATH: &str = "/usr/local/bin/lazycat-neko-webshell-agent";
const AGENT_MANIFEST_PATH: &str = "/usr/local/lib/lazycat-neko-webshell/agent.sha256";
const AGENT_READY_MARKER: &str = "lazycat-neko-webshell-agent-ready";
const AGENT_LOG_TAIL_LINES: usize = 80;

#[cfg(not(debug_assertions))]
include!(concat!(env!("OUT_DIR"), "/embedded_agent.rs"));

#[derive(Clone, Debug)]
pub struct AgentClient {
    selector: String,
    username: String,
    socket_path: String,
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
}

pub async fn ensure_agent(selector: &str, username: &str) -> anyhow::Result<AgentClient> {
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

    match ping_agent(&client).await {
        Ok(response) if agent_protocol_version_is_current(response.version.as_deref()) => {
            return Ok(client);
        }
        Ok(response) if agent_protocol_version_is_stale(response.version.as_deref()) => {
            warn!(
                selector = %selector,
                running_protocol = response.version.as_deref().unwrap_or(""),
                expected_protocol = AGENT_PROTOCOL_VERSION,
                "webshell agent protocol is stale; restarting agent"
            );
            ensure_agent_binary_installed(selector).await?;
            restart_agent(&client).await?;
            wait_for_agent(&client).await?;
            return Ok(client);
        }
        Ok(response) => {
            bail!(
                "unsupported newer webshell agent protocol: running {}, provider expects {}",
                response.version.unwrap_or_default(),
                AGENT_PROTOCOL_VERSION
            );
        }
        Err(_) => {}
    }
    if try_recover_installed_agent(&client).await? {
        return Ok(client);
    }
    ensure_agent_binary_installed(selector).await?;
    match ping_agent(&client).await {
        Ok(response) if agent_protocol_version_is_current(response.version.as_deref()) => {
            return Ok(client);
        }
        Ok(response) if agent_protocol_version_is_stale(response.version.as_deref()) => {
            restart_agent(&client).await?;
            wait_for_agent(&client).await?;
            return Ok(client);
        }
        Ok(response) => {
            bail!(
                "unsupported newer webshell agent protocol: running {}, provider expects {}",
                response.version.unwrap_or_default(),
                AGENT_PROTOCOL_VERSION
            );
        }
        Err(_) => {}
    }
    start_agent(&client).await?;
    wait_for_agent(&client).await?;
    Ok(client)
}

async fn try_recover_installed_agent(client: &AgentClient) -> anyhow::Result<bool> {
    let binary_exists = installed_agent_binary_exists(&client.selector)
        .await
        .unwrap_or(false);
    if !binary_exists {
        return Ok(false);
    }
    let expected_manifest = agent_payload_manifest().await?;
    let manifest_matches = installed_manifest_matches(&client.selector, &expected_manifest).await?;
    if !should_restart_installed_agent(binary_exists, manifest_matches) {
        warn!(
            selector = %client.selector,
            "installed webshell agent payload is stale; installing embedded lightweight agent"
        );
        return Ok(false);
    }
    if let Err(err) = restart_agent(client).await {
        warn!(
            selector = %client.selector,
            error = %err,
            "failed to restart installed webshell agent; reinstalling agent"
        );
        return Ok(false);
    }
    match wait_for_agent_response(client).await {
        Ok(response) if agent_protocol_version_is_current(response.version.as_deref()) => Ok(true),
        Ok(response) if agent_protocol_version_is_stale(response.version.as_deref()) => {
            warn!(
                selector = %client.selector,
                running_protocol = response.version.as_deref().unwrap_or(""),
                expected_protocol = AGENT_PROTOCOL_VERSION,
                "installed webshell agent protocol is stale; upgrading agent"
            );
            Ok(false)
        }
        Ok(response) => bail!(
            "unsupported newer webshell agent protocol: running {}, provider expects {}",
            response.version.unwrap_or_default(),
            AGENT_PROTOCOL_VERSION
        ),
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

async fn wait_for_agent(client: &AgentClient) -> anyhow::Result<()> {
    let mut last_error = None;
    for _ in 0..25 {
        match ping_agent(client).await {
            Ok(response) if agent_protocol_version_is_current(response.version.as_deref()) => {
                return Ok(());
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

async fn installed_agent_binary_exists(selector: &str) -> anyhow::Result<bool> {
    let output = run_target_shell(
        selector,
        &installed_agent_probe_script(),
        None,
        Duration::from_secs(8),
    )
    .await?;
    Ok(String::from_utf8_lossy(&output.stdout).trim() == AGENT_READY_MARKER)
}

fn installed_agent_probe_script() -> String {
    format!(
        r#"agent={}
if [ -x "$agent" ]; then
  printf '%s\n' {}
fi
"#,
        shell_quote(AGENT_INSTALL_PATH),
        shell_quote(AGENT_READY_MARKER),
    )
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
    let output = timeout(Duration::from_secs(8), command.output())
        .await
        .map_err(|_| anyhow!("agent request timed out"))?
        .map_err(|err| anyhow!("failed to run agent request: {err}"))?;
    if !output.status.success() {
        bail!("agent request failed: {}", command_output_detail(&output));
    }
    read_agent_response(output.stdout.as_slice())
        .map_err(|err| anyhow!("invalid agent response: {err}"))
}

async fn ensure_agent_binary_installed(selector: &str) -> anyhow::Result<()> {
    let payload = load_agent_payload().await?;
    let manifest = binary_manifest(&payload);
    if installed_manifest_matches(selector, &manifest).await? {
        return Ok(());
    }
    install_agent_binary(selector, &manifest, &payload).await
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

async fn agent_payload_manifest() -> anyhow::Result<String> {
    #[cfg(not(debug_assertions))]
    {
        if EMBEDDED_AGENT_BINARY.is_empty() {
            bail!("embedded webshell agent payload is empty");
        }
        Ok(binary_manifest(EMBEDDED_AGENT_BINARY))
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

async fn installed_manifest_matches(selector: &str, manifest: &str) -> anyhow::Result<bool> {
    let script = format!(
        r#"set -eu
agent={}
manifest_path={}
expected={}
if [ -x "$agent" ] && [ "$(cat "$manifest_path" 2>/dev/null || true)" = "$expected" ]; then
  printf '%s\n' {}
fi
"#,
        shell_quote(AGENT_INSTALL_PATH),
        shell_quote(AGENT_MANIFEST_PATH),
        shell_quote(manifest),
        shell_quote(AGENT_READY_MARKER),
    );
    let output = run_target_shell(selector, &script, None, Duration::from_secs(8)).await?;
    Ok(String::from_utf8_lossy(&output.stdout).trim() == AGENT_READY_MARKER)
}

async fn install_agent_binary(
    selector: &str,
    manifest: &str,
    payload: &[u8],
) -> anyhow::Result<()> {
    let install_dir = "/usr/local/bin";
    let manifest_dir = "/usr/local/lib/lazycat-neko-webshell";
    let tmp_path = format!("{AGENT_INSTALL_PATH}.tmp-{}", std::process::id());
    let script = format!(
        r#"set -eu
install_dir={}
manifest_dir={}
agent={}
tmp={}
manifest_path={}
expected={}
mkdir -p "$install_dir" "$manifest_dir"
cat > "$tmp"
chmod 755 "$tmp"
mv "$tmp" "$agent"
printf '%s' "$expected" > "$manifest_path"
printf '%s\n' {}
"#,
        shell_quote(install_dir),
        shell_quote(manifest_dir),
        shell_quote(AGENT_INSTALL_PATH),
        shell_quote(&tmp_path),
        shell_quote(AGENT_MANIFEST_PATH),
        shell_quote(manifest),
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

async fn start_agent(client: &AgentClient) -> anyhow::Result<()> {
    start_agent_with_reset(client, false).await
}

async fn restart_agent(client: &AgentClient) -> anyhow::Result<()> {
    start_agent_with_reset(client, true).await
}

async fn start_agent_with_reset(client: &AgentClient, stop_existing: bool) -> anyhow::Result<()> {
    let log_path = scoped_log_path(&client.selector);
    let stop_script = if stop_existing {
        format!(
            r#"
if [ -S "$socket" ]; then
  old_pids="$(fuser "$socket" 2>/dev/null || true)"
  if [ -n "$old_pids" ]; then kill $old_pids 2>/dev/null || true; fi
fi
"#
        )
    } else {
        String::new()
    };
    let script = format!(
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
        shell_quote(AGENT_INSTALL_PATH),
        shell_quote(&client.socket_path),
        shell_quote(&log_path),
        shell_quote(&client.selector),
        shell_quote(&client.username),
        stop_script,
        shell_quote(AGENT_READY_MARKER),
    );
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
    version.is_some_and(|version| version.trim() == AGENT_PROTOCOL_VERSION)
}

fn agent_protocol_version_is_stale(version: Option<&str>) -> bool {
    let Some(version) = version else {
        return true;
    };
    match (
        agent_protocol_generation(version),
        agent_protocol_generation(AGENT_PROTOCOL_VERSION),
    ) {
        (Some(running), Some(current)) => running < current,
        _ => true,
    }
}

fn agent_protocol_generation(version: &str) -> Option<u32> {
    version
        .trim()
        .strip_prefix("lazycat-neko-webshell-agent-v")?
        .parse()
        .ok()
}

fn binary_manifest(payload: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload);
    format!("sha256:{}", hex_lower(&hasher.finalize()))
}

fn should_restart_installed_agent(binary_exists: bool, manifest_matches: bool) -> bool {
    binary_exists && manifest_matches
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
        assert!(socket.ends_with(".sock"));
        assert!(
            socket
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '-'))
        );
    }

    #[test]
    fn manifest_uses_sha256_hex() {
        assert_eq!(
            binary_manifest(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

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

    #[test]
    fn installed_agent_probe_checks_the_existing_binary_without_matching_provider_hash() {
        let script = installed_agent_probe_script();
        assert!(script.contains("[ -x \"$agent\" ]"));
        assert!(script.contains(AGENT_READY_MARKER));
        assert!(!script.contains(AGENT_MANIFEST_PATH));
    }

    #[test]
    fn recovery_restarts_only_the_embedded_agent_payload() {
        assert!(should_restart_installed_agent(true, true));
        assert!(!should_restart_installed_agent(true, false));
        assert!(!should_restart_installed_agent(false, true));
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
        assert!(agent_protocol_version_is_current(Some(
            AGENT_PROTOCOL_VERSION
        )));
        assert!(agent_protocol_version_is_stale(None));
        assert!(agent_protocol_version_is_stale(Some(
            "lazycat-neko-webshell-agent-v1"
        )));
        assert!(!agent_protocol_version_is_stale(Some(
            "lazycat-neko-webshell-agent-v999"
        )));
    }
}
