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

use crate::agent_protocol::{
    AGENT_PROTOCOL_VERSION, action_request, ping_request, read_agent_response, state_request,
};
use crate::config::LIGHTOSCTL;
use crate::proto::lazycat::webshell::v1::{
    AgentResponse, AgentWorkspaceAction, AgentWorkspaceState,
};
use crate::validation::{normalize_output_frame_limit, validate_selector};

const AGENT_INSTALL_PATH: &str = "/usr/local/bin/lazycat-neko-webshell-agent";
const AGENT_MANIFEST_PATH: &str = "/usr/local/lib/lazycat-neko-webshell/agent.sha256";
const AGENT_READY_MARKER: &str = "lazycat-neko-webshell-agent-ready";

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

    if ping_agent(&client).await.is_ok() {
        return Ok(client);
    }
    ensure_agent_binary_installed(selector).await?;
    if ping_agent(&client).await.is_ok() {
        return Ok(client);
    }
    start_agent(&client).await?;
    wait_for_agent(&client).await?;
    Ok(client)
}

async fn ping_agent(client: &AgentClient) -> anyhow::Result<()> {
    let request = ping_request(client.selector.clone(), client.username.clone());
    let response = run_agent_request(client, &request).await?;
    response_ok(response)
}

async fn wait_for_agent(client: &AgentClient) -> anyhow::Result<()> {
    let mut last_error = None;
    for _ in 0..25 {
        match ping_agent(client).await {
            Ok(()) => return Ok(()),
            Err(err) => last_error = Some(err),
        }
        sleep(Duration::from_millis(120)).await;
    }
    Err(last_error.unwrap_or_else(|| anyhow!("agent did not become ready")))
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
    let payload = tokio::fs::read(current_exe()?)
        .await
        .context("failed to read current executable")?;
    let manifest = binary_manifest(&payload);
    if installed_manifest_matches(selector, &manifest).await? {
        return Ok(());
    }
    install_agent_binary(selector, &manifest, &payload).await
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
    let log_path = scoped_log_path(&client.selector);
    let script = format!(
        r#"set -eu
agent={}
socket={}
log={}
selector={}
username={}
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
        shell_quote(AGENT_READY_MARKER),
    );
    let output = run_target_shell(&client.selector, &script, None, Duration::from_secs(10)).await?;
    if String::from_utf8_lossy(&output.stdout).trim() != AGENT_READY_MARKER {
        bail!(
            "agent start did not complete: {}",
            command_output_detail(&output)
        );
    }
    Ok(())
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
    let output = timeout(duration, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("target command timed out"))?
        .map_err(|err| anyhow!("target command failed: {err}"))?;
    if !output.status.success() {
        bail!("target command failed: {}", command_output_detail(&output));
    }
    Ok(output)
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

fn current_exe() -> anyhow::Result<PathBuf> {
    std::env::current_exe().context("failed to resolve current executable")
}

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
    fn quote_handles_single_quotes() {
        assert_eq!(shell_quote("dev'user"), "'dev'\"'\"'user'");
    }
}
