use std::collections::HashSet;
use std::path::{Component, Path};
use std::time::Duration;

use connectrpc::ConnectError;
use serde::Deserialize;
use serde::Serialize;
use std::process::Stdio;
use tokio::io::AsyncWriteExt as _;
use tokio::time::timeout;

use crate::config::LIGHTOSCTL;
use crate::validation::validate_selector;

const TARGET_SSH_CONFIG_READ_TIMEOUT: Duration = Duration::from_secs(5);
const TARGET_SSH_CONFIG_WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const TARGET_SSH_CONFIG_MAX_BYTES: usize = 512 * 1024;
const TARGET_SSH_KEY_MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
struct LightOsInstance {
    #[serde(default)]
    selector: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    owner_deploy_id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    username: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminInfo {
    #[serde(default)]
    pub deploy_id: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub base_url: String,
}

pub async fn authorized_selectors() -> Result<HashSet<String>, ConnectError> {
    Ok(load_lightos_instances()
        .await?
        .iter()
        .filter_map(selector_for_instance)
        .collect())
}

pub async fn authorize_selector(selector: &str, require_running: bool) -> Result<(), ConnectError> {
    authorized_instance(selector, require_running)
        .await
        .map(|_| ())
}

pub async fn login_user_for_selector(
    selector: &str,
    require_running: bool,
) -> Result<String, ConnectError> {
    let instance = authorized_instance(selector, require_running).await?;
    Ok(instance.username.trim().to_owned())
}

pub async fn target_command_available(
    selector: &str,
    command_name: &str,
) -> Result<bool, ConnectError> {
    validate_selector(selector)?;
    if !command_name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        return Err(ConnectError::invalid_argument("invalid command name"));
    }
    let instance = authorized_instance(selector, true).await?;
    let script = target_command_probe_bootstrap_script(command_name, instance.username.trim());
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command.args(["exec", "-i", selector, "/bin/sh", "-lc", script.as_str()]);
    let output = timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("lightosctl exec timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;
    Ok(output.status.success())
}

pub async fn read_target_ssh_config(selector: &str) -> Result<Option<String>, ConnectError> {
    validate_selector(selector)?;
    let instance = authorized_instance(selector, true).await?;
    let script = target_ssh_config_read_bootstrap_script(instance.username.trim());
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command.args(["exec", "-i", selector, "/bin/sh", "-lc", script.as_str()]);
    let output = timeout(TARGET_SSH_CONFIG_READ_TIMEOUT, command.output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("lightosctl exec timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;

    if output.status.code() == Some(3) {
        return Ok(None);
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "failed to read target OpenSSH config: {detail}"
        )));
    }
    if output.stdout.len() > TARGET_SSH_CONFIG_MAX_BYTES {
        return Err(ConnectError::failed_precondition(
            "target OpenSSH config is too large to inspect",
        ));
    }
    String::from_utf8(output.stdout).map(Some).map_err(|err| {
        ConnectError::failed_precondition(format!("target OpenSSH config is not UTF-8: {err}"))
    })
}

pub async fn write_target_ssh_config(
    selector: &str,
    content: &str,
    backup_limit: usize,
) -> Result<Option<String>, ConnectError> {
    validate_selector(selector)?;
    if content.len() > TARGET_SSH_CONFIG_MAX_BYTES {
        return Err(ConnectError::failed_precondition(
            "target OpenSSH config is too large to save",
        ));
    }
    let instance = authorized_instance(selector, true).await?;
    let script = target_ssh_config_write_bootstrap_script(instance.username.trim(), backup_limit);
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command
        .args(["exec", "-i", selector, "/bin/sh", "-lc", script.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let input = content.as_bytes().to_vec();
        tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
        });
    }
    let output = timeout(TARGET_SSH_CONFIG_WRITE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("lightosctl exec timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "failed to write target OpenSSH config: {detail}"
        )));
    }
    let backup = String::from_utf8(output.stdout)
        .map_err(|err| {
            ConnectError::failed_precondition(format!("target output is not UTF-8: {err}"))
        })?
        .trim()
        .to_owned();
    Ok((!backup.is_empty()).then_some(backup))
}

pub async fn read_target_ssh_key_file(
    selector: &str,
    path: &str,
) -> Result<Option<String>, ConnectError> {
    validate_selector(selector)?;
    validate_target_ssh_file_path(path)?;
    let instance = authorized_instance(selector, true).await?;
    let script = target_ssh_file_read_bootstrap_script(instance.username.trim(), path);
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command.args(["exec", "-i", selector, "/bin/sh", "-lc", script.as_str()]);
    let output = timeout(TARGET_SSH_CONFIG_READ_TIMEOUT, command.output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("lightosctl exec timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;

    if output.status.code() == Some(3) {
        return Ok(None);
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "failed to read target SSH key file: {detail}"
        )));
    }
    if output.stdout.len() > TARGET_SSH_KEY_MAX_BYTES {
        return Err(ConnectError::failed_precondition(
            "target SSH key file is too large to inspect",
        ));
    }
    String::from_utf8(output.stdout).map(Some).map_err(|err| {
        ConnectError::failed_precondition(format!("target SSH key file is not UTF-8: {err}"))
    })
}

pub async fn write_target_ssh_key_file(
    selector: &str,
    path: &str,
    content: &str,
    backup_limit: usize,
) -> Result<Option<String>, ConnectError> {
    validate_selector(selector)?;
    validate_target_ssh_file_path(path)?;
    if content.len() > TARGET_SSH_KEY_MAX_BYTES {
        return Err(ConnectError::failed_precondition(
            "target SSH key file is too large to save",
        ));
    }
    let instance = authorized_instance(selector, true).await?;
    let script =
        target_ssh_file_write_bootstrap_script(instance.username.trim(), path, backup_limit);
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command
        .args(["exec", "-i", selector, "/bin/sh", "-lc", script.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let input = content.as_bytes().to_vec();
        tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
        });
    }
    let output = timeout(TARGET_SSH_CONFIG_WRITE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("lightosctl exec timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "failed to write target SSH key file: {detail}"
        )));
    }
    let backup = String::from_utf8(output.stdout)
        .map_err(|err| {
            ConnectError::failed_precondition(format!("target output is not UTF-8: {err}"))
        })?
        .trim()
        .to_owned();
    Ok((!backup.is_empty()).then_some(backup))
}

fn target_command_probe_script(command_name: &str) -> String {
    let version_check = match command_name {
        "zellij" => "\n[ -n \"$target_command\" ] && \"$target_command\" --version >/dev/null 2>&1",
        _ => "\n[ -n \"$target_command\" ]",
    };
    format!(
        r#"if [ -n "${{HOME:-}}" ]; then
  PATH="$HOME/.local/bin:$HOME/bin:$PATH"
fi
export PATH
target_command="$(command -v {command_name} 2>/dev/null || true)"
if [ -z "$target_command" ] && [ -n "${{HOME:-}}" ] && [ -x "$HOME/.local/bin/{command_name}" ]; then
  target_command="$HOME/.local/bin/{command_name}"
fi{version_check}"#
    )
}

fn target_command_probe_bootstrap_script(command_name: &str, login_user: &str) -> String {
    let probe_script = target_command_probe_script(command_name);
    target_login_user_bootstrap_script(&probe_script, login_user)
}

fn target_ssh_config_read_bootstrap_script(login_user: &str) -> String {
    let script = format!(
        r#"config="${{HOME:-}}/.ssh/config"
if [ ! -r "$config" ]; then
  exit 3
fi
head -c {} "$config""#,
        TARGET_SSH_CONFIG_MAX_BYTES + 1,
    );
    target_login_user_bootstrap_script(&script, login_user)
}

fn target_ssh_config_write_bootstrap_script(login_user: &str, backup_limit: usize) -> String {
    let script = format!(
        r#"set -eu
dir="${{HOME:-}}/.ssh"
config="$dir/config"
tmp="$dir/config.webshell.tmp.$$"
backup=""
backup_limit={backup_limit}
mkdir -p "$dir"
chmod 700 "$dir" 2>/dev/null || true
if [ -f "$config" ]; then
  ts=$(date +%Y%m%d_%H%M%S 2>/dev/null || date +%s)
  backup="$dir/config.webshell.bak.$ts"
  cp -p "$config" "$backup"
fi
cat > "$tmp"
chmod 600 "$tmp" 2>/dev/null || true
mv "$tmp" "$config"
if [ "$backup_limit" -gt 0 ]; then
  ls -1t "$dir"/config.webshell.bak.* 2>/dev/null | awk "NR>$backup_limit" | while IFS= read -r old_backup; do
    rm -f "$old_backup"
  done
fi
printf '%s' "$backup""#,
    );
    target_login_user_bootstrap_script(&script, login_user)
}

fn target_ssh_file_read_bootstrap_script(login_user: &str, path: &str) -> String {
    let script = format!(
        r#"set -eu
input_path={}
target=$(resolve_ssh_file_path "$input_path")
if [ ! -r "$target" ]; then
  exit 3
fi
head -c {} "$target""#,
        shell_script_quote(path),
        TARGET_SSH_KEY_MAX_BYTES + 1,
    );
    target_ssh_file_bootstrap_script(&script, login_user)
}

fn target_ssh_file_write_bootstrap_script(
    login_user: &str,
    path: &str,
    backup_limit: usize,
) -> String {
    let script = format!(
        r#"set -eu
input_path={}
backup_limit={}
target=$(resolve_ssh_file_path "$input_path")
dir=$(dirname "$target")
base=$(basename "$target")
tmp="$dir/$base.webshell.tmp.$$"
backup=""
mkdir -p "$dir"
chmod 700 "$dir" 2>/dev/null || true
if [ -f "$target" ]; then
  ts=$(date +%Y%m%d_%H%M%S 2>/dev/null || date +%s)
  backup="$dir/$base.webshell.bak.$ts"
  cp -p "$target" "$backup"
fi
cat > "$tmp"
chmod 600 "$tmp" 2>/dev/null || true
mv "$tmp" "$target"
if [ "$backup_limit" -gt 0 ]; then
  ls -1t "$dir"/"$base".webshell.bak.* 2>/dev/null | awk "NR>$backup_limit" | while IFS= read -r old_backup; do
    rm -f "$old_backup"
  done
fi
printf '%s' "$backup""#,
        shell_script_quote(path),
        backup_limit,
    );
    target_ssh_file_bootstrap_script(&script, login_user)
}

fn target_ssh_file_bootstrap_script(script: &str, login_user: &str) -> String {
    let resolver = r#"resolve_ssh_file_path() {
  raw="$1"
  case "$raw" in
    "~/"*) target="$HOME/${raw#~/}" ;;
    "$HOME/"*) target="$raw" ;;
    /*) target="$raw" ;;
    *) target="$HOME/$raw" ;;
  esac
  case "$target" in
    "$HOME/.ssh/"*) printf '%s\n' "$target" ;;
    *) echo "SSH key file must be under ~/.ssh" >&2; exit 4 ;;
  esac
}"#;
    target_login_user_bootstrap_script(&format!("{resolver}\n{script}"), login_user)
}

fn target_login_user_bootstrap_script(script: &str, login_user: &str) -> String {
    let login_user = login_user.trim();
    if !login_user_needs_switch(login_user) {
        return script.to_owned();
    }
    format!(
        r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
user={}
probe_script={}
uid=$(id -u "$user" 2>/dev/null) || exit 127
gid=$(id -g "$user" 2>/dev/null) || exit 127
entry=$(getent passwd "$user" 2>/dev/null) || exit 127
home=$(printf '%s\n' "$entry" | cut -d: -f6)
if [ -z "$home" ]; then
  home=/
fi
PATH="$home/.local/bin:$home/bin:$PATH"
export PATH
if command -v setpriv >/dev/null 2>&1; then
  exec env HOME="$home" USER="$user" LOGNAME="$user" PATH="$PATH" setpriv --reuid "$uid" --regid "$gid" --init-groups /bin/sh -lc "$probe_script"
fi
if command -v su >/dev/null 2>&1; then
  export HOME="$home" USER="$user" LOGNAME="$user" PATH="$PATH"
  exec su -s /bin/sh "$user" -c "$probe_script"
fi
exit 127"#,
        shell_script_quote(login_user),
        shell_script_quote(script),
    )
}

fn login_user_needs_switch(login_user: &str) -> bool {
    !matches!(login_user.trim(), "" | "root")
}

fn validate_target_ssh_file_path(path: &str) -> Result<(), ConnectError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(ConnectError::invalid_argument(
            "SSH key file path is required",
        ));
    }
    if path.starts_with('-') || path.chars().any(char::is_control) {
        return Err(ConnectError::invalid_argument("invalid SSH key file path"));
    }
    if Path::new(path)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ConnectError::invalid_argument(
            "SSH key file path must not contain ..",
        ));
    }
    Ok(())
}

fn shell_script_quote(value: &str) -> String {
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

async fn authorized_instance(
    selector: &str,
    require_running: bool,
) -> Result<LightOsInstance, ConnectError> {
    validate_selector(selector)?;
    let instances = load_lightos_instances().await?;
    let Some(instance) = instances
        .iter()
        .find(|item| selector_for_instance(item).is_some_and(|value| value == selector))
    else {
        return Err(ConnectError::permission_denied(
            "selector is not visible to this LightOS account",
        ));
    };
    if require_running && instance.status != "running" {
        return Err(ConnectError::failed_precondition(format!(
            "target instance is not running: {}",
            instance.status
        )));
    }
    Ok(instance.clone())
}

async fn load_lightos_instances() -> Result<Vec<LightOsInstance>, ConnectError> {
    let output = run_lightosctl(["ps"]).await?;
    parse_lightos_instances(&output)
}

fn parse_lightos_instances(output: &[u8]) -> Result<Vec<LightOsInstance>, ConnectError> {
    serde_json::from_slice(output)
        .map_err(|err| ConnectError::internal(format!("invalid lightosctl ps JSON: {err}")))
}

fn selector_for_instance(item: &LightOsInstance) -> Option<String> {
    let selector = item.selector.trim();
    if !selector.is_empty() && validate_selector(selector).is_ok() {
        return Some(selector.to_owned());
    }
    let name = item.name.trim();
    let owner_deploy_id = item.owner_deploy_id.trim();
    if name.is_empty() || owner_deploy_id.is_empty() {
        return None;
    }
    Some(format!("{name}@{owner_deploy_id}"))
}

pub async fn admin_info() -> Result<AdminInfo, ConnectError> {
    let output = run_lightosctl(["system", "admin-info", "--json"]).await?;
    parse_admin_info(&output)
}

fn parse_admin_info(output: &[u8]) -> Result<AdminInfo, ConnectError> {
    let mut info: AdminInfo = serde_json::from_slice(output)
        .map_err(|err| ConnectError::internal(format!("invalid admin-info JSON: {err}")))?;
    trim_string(&mut info.deploy_id);
    trim_string(&mut info.domain);
    trim_string(&mut info.base_url);
    if info.base_url.is_empty() {
        return Err(ConnectError::failed_precondition(
            "lightos-admin base_url is unavailable",
        ));
    }
    let uri = info.base_url.parse::<http::Uri>().map_err(|err| {
        ConnectError::failed_precondition(format!("invalid lightos-admin base_url: {err}"))
    })?;
    if uri.scheme_str().is_none() || uri.authority().is_none() {
        return Err(ConnectError::failed_precondition(
            "lightos-admin base_url must include scheme and host",
        ));
    }
    Ok(info)
}

fn trim_string(value: &mut String) {
    let trimmed = value.trim();
    if trimmed.len() == value.len() {
        return;
    }
    let owned = trimmed.to_owned();
    value.clear();
    value.push_str(&owned);
}

async fn run_lightosctl<const N: usize>(args: [&str; N]) -> Result<Vec<u8>, ConnectError> {
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command.args(args);
    let output = timeout(Duration::from_secs(8), command.output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("lightosctl timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "lightosctl failed: {detail}"
        )));
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_admin_info, parse_lightos_instances, selector_for_instance,
        target_command_probe_bootstrap_script, target_command_probe_script,
    };

    #[test]
    fn parses_lightos_instances_and_trims_selector_parts() {
        let instances = parse_lightos_instances(
            br#"[
                {"name":" app ","owner_deploy_id":" owner ","status":"running","username":" admin "},
                {"name":"","owner_deploy_id":"skip","status":"running"}
            ]"#,
        )
        .expect("lightos instances parse");

        assert_eq!(
            instances.first().and_then(selector_for_instance).as_deref(),
            Some("app@owner")
        );
        assert_eq!(
            instances.first().map(|item| item.username.trim()),
            Some("admin")
        );
        assert_eq!(instances.get(1).and_then(selector_for_instance), None);
    }

    #[test]
    fn parses_explicit_lightos_selector() {
        let instances = parse_lightos_instances(
            br#"[{"selector":" alpha@deploy-a ","status":"running","username":"alice"}]"#,
        )
        .expect("lightos instances parse");

        assert_eq!(
            instances.first().and_then(selector_for_instance).as_deref(),
            Some("alpha@deploy-a")
        );
    }

    #[test]
    fn command_probe_checks_user_local_bin() {
        let zellij = target_command_probe_script("zellij");
        assert!(zellij.contains("$HOME/.local/bin:$HOME/bin:$PATH"));
        assert!(zellij.contains("target_command=\"$(command -v zellij"));
        assert!(zellij.contains("\"$target_command\" --version"));

        let herdr = target_command_probe_script("herdr");
        assert!(herdr.contains("$HOME/.local/bin:$HOME/bin:$PATH"));
        assert!(herdr.contains("target_command=\"$(command -v herdr"));
        assert!(herdr.contains("$HOME/.local/bin/herdr"));
        assert!(!herdr.contains("--version"));
    }

    #[test]
    fn command_probe_switches_to_instance_login_user() {
        let script = target_command_probe_bootstrap_script("herdr", "admin");

        assert!(script.contains("user='admin'"));
        assert!(script.contains(
            "setpriv --reuid \"$uid\" --regid \"$gid\" --init-groups /bin/sh -lc \"$probe_script\""
        ));
        assert!(script.contains("exec su -s /bin/sh \"$user\" -c \"$probe_script\""));
        assert!(script.contains("PATH=\"$home/.local/bin:$home/bin:$PATH\""));
    }

    #[test]
    fn parses_admin_info_with_base_url() {
        let info = parse_admin_info(br#"{"deploy_id":" deploy-a ","domain":" admin.local ","base_url":" https://admin.local/root/ "}"#)
            .expect("admin info parses");

        assert_eq!(info.deploy_id, "deploy-a");
        assert_eq!(info.domain, "admin.local");
        assert_eq!(info.base_url, "https://admin.local/root/");
    }

    #[test]
    fn rejects_admin_info_without_absolute_base_url() {
        let err = parse_admin_info(br#"{"base_url":"/"}"#).expect_err("base_url must be absolute");

        assert!(err.message.unwrap_or_default().contains("scheme and host"));
    }
}
