use super::targets::authorize_session_target;
use crate::config::LIGHTOSCTL;
use crate::proto::lazycat::webshell::v1::InvokePluginResponse;
use crate::ssh_backend;
use crate::state::{AppState, SessionRecord};
use crate::tty_init::lightos_features_enabled;
use connectrpc::{ConnectError, Response as ConnectResponse, ServiceResult};
use neko_plugin::{
    BoxFuture, FileOperation, InvokeReply, PluginError, TargetFiles, TargetIdentity, TargetRequest,
};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const PLUGIN_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

pub struct FileAccess {
    pub state: Weak<AppState>,
}

impl FileAccess {
    async fn session(
        &self,
        target: &TargetRequest,
    ) -> Result<(Arc<AppState>, SessionRecord), ConnectError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| ConnectError::unavailable("plugin host has stopped"))?;
        let session = super::targets::resolve(&state, &target.session_id, &target.metadata).await?;
        authorize_session_target(&state, &session, true).await?;
        Ok((state, session))
    }
}

impl TargetFiles for FileAccess {
    fn authorize<'a>(
        &'a self,
        target: &'a TargetRequest,
    ) -> BoxFuture<'a, Result<TargetIdentity, PluginError>> {
        Box::pin(async move {
            let (_, session) = self.session(target).await.map_err(super::plugin_error)?;
            Ok(TargetIdentity {
                session_id: session.id,
                selector: session.selector,
                login_user: session
                    .metadata
                    .get("loginUser")
                    .cloned()
                    .unwrap_or_default(),
            })
        })
    }
    fn execute<'a>(
        &'a self,
        target: &'a TargetRequest,
        operation: FileOperation,
    ) -> BoxFuture<'a, Result<InvokeReply, PluginError>> {
        Box::pin(async move {
            let (state, session) = self.session(target).await.map_err(super::plugin_error)?;
            let result = match operation {
                FileOperation::List { path } => {
                    invoke_file_list(
                        &state,
                        &session,
                        "list",
                        &HashMap::from([("path".to_owned(), path)]),
                    )
                    .await
                }
                FileOperation::Stat { path } => {
                    invoke_file_stat(
                        &state,
                        &session,
                        "stat",
                        &HashMap::from([("path".to_owned(), path)]),
                    )
                    .await
                }
                FileOperation::Read { path, content_type } => {
                    invoke_file_read(
                        &state,
                        &session,
                        "read",
                        &content_type,
                        &HashMap::from([("path".to_owned(), path)]),
                    )
                    .await
                }
                FileOperation::Write { path, data } => {
                    invoke_file_write(
                        &state,
                        &session,
                        "write",
                        &data,
                        &HashMap::from([("path".to_owned(), path)]),
                    )
                    .await
                }
            }
            .map_err(super::plugin_error)?
            .body;
            Ok(InvokeReply {
                status: result.status.unwrap_or_default(),
                content_type: result.content_type.unwrap_or_default(),
                payload: result.payload.unwrap_or_default(),
                metadata: result.metadata.into_iter().collect(),
            })
        })
    }
}

async fn invoke_file_list(
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = metadata.get("path").map_or(".", String::as_str);
    let script = format!(
        r#"path={}
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${{path#~/}}" ;;
esac
if [ ! -e "$path" ]; then
  echo "path not found: $path" >&2
  exit 2
fi
if [ -d "$path" ]; then
  find "$path" -maxdepth 1 -mindepth 1 -printf '%f\t%y\t%s\t%n\t%l\n' | sort
else
  find "$path" -maxdepth 0 -printf '%f\t%y\t%s\t%n\t%l\n'
fi"#,
        shell_quote(path)
    );
    let output = run_session_script(state, session, &script, &[]).await?;
    plugin_response(
        "complete",
        "text/plain",
        output,
        HashMap::from([("operation".to_owned(), operation.to_owned())]),
    )
}

async fn invoke_file_read(
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    content_type: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = format!(
        r#"path={}
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${{path#~/}}" ;;
esac
if [ ! -f "$path" ]; then
  echo "file not found: $path" >&2
  exit 2
fi
cat -- "$path""#,
        shell_quote(path)
    );
    let output = run_session_script(state, session, &script, &[]).await?;
    plugin_response(
        "complete",
        if content_type == "application/json" {
            "application/octet-stream"
        } else {
            content_type
        },
        output,
        plugin_path_metadata(operation, path),
    )
}

async fn invoke_file_write(
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    payload: &[u8],
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = file_write_script(path);
    let output = run_session_script(state, session, &script, payload).await?;
    plugin_response(
        "complete",
        "application/json",
        output,
        plugin_path_metadata(operation, path),
    )
}

fn file_write_script(path: &str) -> String {
    format!(
        r#"path={}
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${{path#~/}}" ;;
esac
parent="${{path%/*}}"
if [ "$parent" = "$path" ]; then
  parent="."
fi
if [ -z "$parent" ]; then
  parent="/"
fi
mkdir -p "$parent"
tmp="$path.webshell-upload.$$"
cat > "$tmp"
mv -f "$tmp" "$path"
bytes="$(wc -c < "$path" | tr -d ' ')"
printf '{{"path":%s,"bytes":%s}}\n' "$(printf '%s' "$path" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" "$bytes""#,
        shell_quote(path)
    )
}

async fn invoke_file_stat(
    state: &AppState,
    session: &SessionRecord,
    operation: &str,
    metadata: &HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    let path = required_metadata(metadata, "path")?;
    let script = format!(
        r#"path={}
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${{path#~/}}" ;;
esac
if [ ! -e "$path" ]; then
  echo "path not found: $path" >&2
  exit 2
fi
if command -v stat >/dev/null 2>&1; then
  stat -- "$path"
else
  ls -ld -- "$path"
fi"#,
        shell_quote(path)
    );
    let output = run_session_script(state, session, &script, &[]).await?;
    plugin_response(
        "complete",
        "text/plain",
        output,
        plugin_path_metadata(operation, path),
    )
}

fn plugin_path_metadata(operation: &str, path: &str) -> HashMap<String, String> {
    HashMap::from([
        ("operation".to_owned(), operation.to_owned()),
        ("path".to_owned(), path.to_owned()),
    ])
}

async fn run_session_script(
    state: &AppState,
    session: &SessionRecord,
    script: &str,
    stdin: &[u8],
) -> Result<Vec<u8>, ConnectError> {
    if ssh_backend::is_ssh_selector(&session.selector) {
        let profile = ssh_backend::load_enabled_profile(&state.database(), &session.selector)?;
        ssh_backend::mark_profile_used(&state.database(), &session.selector);
        return ssh_backend::run_profile_script(&profile, script, stdin).await;
    }
    if !lightos_features_enabled() {
        return Err(ConnectError::not_found("LightOS integration is disabled"));
    }
    let script = script_for_session_user(session, script);
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command
        .args([
            "exec",
            "-i",
            session.selector.as_str(),
            "/bin/sh",
            "-lc",
            script.as_str(),
        ])
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;
    let operation = async move {
        if let Some(mut child_stdin) = child.stdin.take()
            && !stdin.is_empty()
            && let Err(err) = child_stdin.write_all(stdin).await
        {
            let _ = child.kill().await;
            return Err(ConnectError::unavailable(format!(
                "plugin command input failed: {err}"
            )));
        }
        child
            .wait_with_output()
            .await
            .map_err(|err| ConnectError::unavailable(format!("plugin command failed: {err}")))
    };
    let output = tokio::time::timeout(PLUGIN_COMMAND_TIMEOUT, operation)
        .await
        .map_err(|_| ConnectError::deadline_exceeded("plugin command timed out"))??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "plugin command exited with {}: {detail}",
            output.status
        )));
    }
    Ok(output.stdout)
}

fn script_for_session_user(session: &SessionRecord, script: &str) -> String {
    let login_user = session
        .metadata
        .get("loginUser")
        .map(String::as_str)
        .unwrap_or_default()
        .trim();
    let script = format!(
        "if [ -f /run/catlink/shell-env.sh ]; then . /run/catlink/shell-env.sh; fi\n{script}"
    );
    if login_user.is_empty() || login_user == "root" {
        return script;
    }
    let quoted_user = shell_quote(login_user);
    let quoted_script = shell_quote(&script);
    format!(
        r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
user={quoted_user}
uid="$(id -u "$user" 2>/dev/null)" || exit 127
gid="$(id -g "$user" 2>/dev/null)" || exit 127
entry="$(getent passwd "$user" 2>/dev/null)" || exit 127
home="$(printf '%s\n' "$entry" | cut -d: -f6)"
if [ -z "$home" ]; then home=/; fi
if command -v setpriv >/dev/null 2>&1; then
  exec env HOME="$home" USER="$user" LOGNAME="$user" setpriv --reuid "$uid" --regid "$gid" --init-groups /bin/sh -lc {quoted_script}
fi
if command -v su >/dev/null 2>&1; then
  exec su -s /bin/sh "$user" -c {quoted_script}
fi
echo "cannot switch to the session login user" >&2
exit 127"#
    )
}

fn required_metadata<'a>(
    metadata: &'a HashMap<String, String>,
    key: &str,
) -> Result<&'a str, ConnectError> {
    metadata
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ConnectError::invalid_argument(format!("metadata.{key} is required")))
}

fn plugin_response(
    status: &str,
    content_type: &str,
    payload: Vec<u8>,
    metadata: HashMap<String, String>,
) -> ServiceResult<InvokePluginResponse> {
    ConnectResponse::ok(InvokePluginResponse {
        invocation_id: Some(Uuid::new_v4().to_string()),
        status: Some(status.to_owned()),
        content_type: Some(content_type.to_owned()),
        payload: Some(payload),
        metadata: metadata.into_iter().collect(),
        ..Default::default()
    })
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
    fn service_shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("dev'user"), "'dev'\"'\"'user'");
    }

    #[test]
    fn plugin_script_runs_as_session_login_user_when_present() {
        let session = test_session(HashMap::from([(
            "loginUser".to_owned(),
            "dev'user".to_owned(),
        )]));

        let script = script_for_session_user(&session, "printf ok");

        assert!(script.contains("user='dev'\"'\"'user'"));
        assert!(script.contains("/run/catlink/shell-env.sh"));
        assert!(script.contains("setpriv --reuid \"$uid\""));
        assert!(script.contains("exec su -s /bin/sh \"$user\""));
    }

    #[test]
    fn file_transfer_write_script_uses_portable_parent_directory() {
        let script = file_write_script("/tmp/lazycat-webshell-uploads/a/b.txt");

        assert!(script.contains("parent=\"${path%/*}\""));
        assert!(script.contains("mkdir -p \"$parent\""));
        assert!(script.contains("mv -f \"$tmp\" \"$path\""));
        assert!(!script.contains("dirname --"));
        assert!(!script.contains("mkdir -p --"));
        assert!(!script.contains("mv -f --"));
    }

    fn test_session(metadata: HashMap<String, String>) -> SessionRecord {
        SessionRecord {
            id: "test".into(),
            host: "demo".into(),
            selector: "demo@owner".into(),
            status: "running".into(),
            cols: 80,
            rows: 24,
            command: String::new(),
            args: vec![],
            metadata,
        }
    }
    #[test]
    fn target_file_commands_never_fall_back_to_the_provider_identity() {
        let session = test_session(HashMap::from([("loginUser".to_owned(), "dev".to_owned())]));
        let script = script_for_session_user(&session, "printf ok");
        assert!(script.ends_with("exit 127"));
        assert!(script.contains("cannot switch to the session login user"));
    }
}
