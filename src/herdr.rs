use std::time::Duration;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::time::timeout;
use tracing::warn;

use crate::config::LIGHTOSCTL;
use crate::lightos;
use crate::validation::validate_selector;

const HERDR_API_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Deserialize)]
pub struct HerdrQuery {
    name: String,
}

#[derive(Debug, Deserialize)]
pub struct HerdrActionRequest {
    name: String,
    action: HerdrAction,
    workspace_id: Option<String>,
    tab_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HerdrAction {
    FocusWorkspace,
    FocusTab,
    CreateTab,
}

#[derive(Debug, Serialize)]
pub struct HerdrBridgeState {
    selector: String,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    workspaces: Vec<HerdrWorkspaceInfo>,
    tabs: Vec<HerdrTabInfo>,
}

#[derive(Debug, Serialize)]
pub struct HerdrWorkspaceInfo {
    workspace_id: String,
    number: usize,
    label: String,
    focused: bool,
    active_tab_id: String,
    tab_count: usize,
    pane_count: usize,
}

#[derive(Debug, Serialize)]
pub struct HerdrTabInfo {
    tab_id: String,
    workspace_id: String,
    number: usize,
    label: String,
    focused: bool,
    pane_count: usize,
}

struct AuthorizedHerdrTarget {
    selector: String,
    login_user: String,
}

#[derive(Debug)]
pub(crate) struct HerdrBridgeError {
    status: StatusCode,
    message: String,
}

pub(crate) async fn get_herdr_state(
    Query(query): Query<HerdrQuery>,
) -> Result<Json<HerdrBridgeState>, HerdrBridgeError> {
    let target = authorize_herdr_target(&query.name).await?;
    Ok(Json(snapshot_herdr_state(&target).await))
}

pub(crate) async fn post_herdr_action(
    State(_state): State<std::sync::Arc<crate::state::AppState>>,
    Json(request): Json<HerdrActionRequest>,
) -> Result<Json<HerdrBridgeState>, HerdrBridgeError> {
    let target = authorize_herdr_target(&request.name).await?;
    match request.action {
        HerdrAction::FocusWorkspace => {
            let workspace_id = required_id(request.workspace_id.as_deref(), "workspace_id")?;
            run_herdr_request(
                &target,
                "workspace.focus",
                json!({ "workspace_id": workspace_id }),
            )
            .await?;
        }
        HerdrAction::FocusTab => {
            let tab_id = required_id(request.tab_id.as_deref(), "tab_id")?;
            run_herdr_request(&target, "tab.focus", json!({ "tab_id": tab_id })).await?;
        }
        HerdrAction::CreateTab => {
            run_herdr_request(
                &target,
                "tab.create",
                json!({
                    "workspace_id": request.workspace_id,
                    "focus": true,
                }),
            )
            .await?;
        }
    }
    Ok(Json(snapshot_herdr_state(&target).await))
}

async fn authorize_herdr_target(selector: &str) -> Result<AuthorizedHerdrTarget, HerdrBridgeError> {
    let selector = selector.trim();
    validate_selector(selector).map_err(|err| HerdrBridgeError {
        status: StatusCode::BAD_REQUEST,
        message: err
            .message
            .unwrap_or_else(|| "invalid LightOS selector".to_owned()),
    })?;
    let login_user = lightos::login_user_for_selector(selector, true)
        .await
        .map_err(|err| HerdrBridgeError {
            status: StatusCode::FORBIDDEN,
            message: err
                .message
                .unwrap_or_else(|| "selector is not authorized".to_owned()),
        })?;
    Ok(AuthorizedHerdrTarget {
        selector: selector.to_owned(),
        login_user,
    })
}

async fn snapshot_herdr_state(target: &AuthorizedHerdrTarget) -> HerdrBridgeState {
    if let Err(err) = run_herdr_request(target, "ping", json!({})).await {
        return HerdrBridgeState {
            selector: target.selector.clone(),
            available: false,
            message: Some(err.message),
            workspaces: Vec::new(),
            tabs: Vec::new(),
        };
    }

    let workspaces = match run_herdr_request(target, "workspace.list", json!({})).await {
        Ok(response) => parse_workspaces(&response),
        Err(err) => {
            return HerdrBridgeState {
                selector: target.selector.clone(),
                available: true,
                message: Some(err.message),
                workspaces: Vec::new(),
                tabs: Vec::new(),
            };
        }
    };
    let focused_workspace = workspaces
        .iter()
        .find(|workspace| workspace.focused)
        .or_else(|| workspaces.first());
    let tabs = if let Some(workspace) = focused_workspace {
        match run_herdr_request(
            target,
            "tab.list",
            json!({ "workspace_id": workspace.workspace_id }),
        )
        .await
        {
            Ok(response) => parse_tabs(&response),
            Err(err) => {
                warn!(
                    error = %err.message,
                    selector = %target.selector,
                    "failed to list Herdr tabs"
                );
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    HerdrBridgeState {
        selector: target.selector.clone(),
        available: true,
        message: None,
        workspaces,
        tabs,
    }
}

async fn run_herdr_request(
    target: &AuthorizedHerdrTarget,
    method: &str,
    params: Value,
) -> Result<Value, HerdrBridgeError> {
    let request = json!({
        "id": format!("lazycat-webshell:{method}"),
        "method": method,
        "params": params,
    });
    let script = herdr_socket_script(&target.login_user, &request.to_string());
    let mut command = Command::new(LIGHTOSCTL);
    command.args([
        "exec",
        "-i",
        target.selector.as_str(),
        "/bin/sh",
        "-lc",
        script.as_str(),
    ]);
    let output = timeout(HERDR_API_TIMEOUT, command.output())
        .await
        .map_err(|_| HerdrBridgeError {
            status: StatusCode::GATEWAY_TIMEOUT,
            message: "Herdr socket request timed out".to_owned(),
        })?
        .map_err(|err| HerdrBridgeError {
            status: StatusCode::BAD_GATEWAY,
            message: format!("failed to enter target instance: {err}"),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_GATEWAY,
            message: format!("Herdr bridge command failed: {detail}"),
        });
    }
    if stdout.is_empty() {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_GATEWAY,
            message: "Herdr socket returned an empty response".to_owned(),
        });
    }
    let response = serde_json::from_str::<Value>(&stdout).map_err(|err| HerdrBridgeError {
        status: StatusCode::BAD_GATEWAY,
        message: format!("invalid Herdr socket response: {err}"),
    })?;
    if let Some(error) = response.get("error") {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_GATEWAY,
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Herdr socket request failed")
                .to_owned(),
        });
    }
    Ok(response)
}

fn herdr_socket_script(login_user: &str, request_json: &str) -> String {
    let login_user = shell_quote(login_user.trim());
    let request_json = shell_quote(request_json);
    format!(
        r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
login_user={login_user}
request_json={request_json}
home_dir=""
if [ -n "$login_user" ]; then
  entry="$(getent passwd "$login_user" 2>/dev/null || true)"
  home_dir="$(printf '%s\n' "$entry" | cut -d: -f6)"
fi
if [ -z "$home_dir" ]; then
  home_dir="${{HOME:-/root}}"
fi
socket_path=""
check_socket() {{
  if [ -n "$1" ] && [ -S "$1" ]; then
    socket_path="$1"
    return 0
  fi
  return 1
}}
check_socket "${{HERDR_SOCKET_PATH:-}}" ||
check_socket "$home_dir/.config/herdr/herdr.sock" ||
check_socket "/root/.config/herdr/herdr.sock" ||
true
if [ -z "$socket_path" ]; then
  for candidate in "$home_dir"/.config/herdr/sessions/*/herdr.sock /root/.config/herdr/sessions/*/herdr.sock; do
    if [ -S "$candidate" ]; then
      socket_path="$candidate"
      break
    fi
  done
fi
if [ -z "$socket_path" ]; then
  printf '%s\n' '{{"id":"lazycat-webshell","error":{{"code":"unavailable","message":"Herdr socket not found"}}}}'
  exit 0
fi
export HERDR_WEB_REQUEST="$request_json"
export HERDR_WEB_SOCKET="$socket_path"
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import os
import socket
import sys

request = os.environ["HERDR_WEB_REQUEST"].encode("utf-8")
path = os.environ["HERDR_WEB_SOCKET"]
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(5)
client.connect(path)
client.sendall(request + b"\n")
chunks = []
while True:
    data = client.recv(65536)
    if not data:
        break
    chunks.append(data)
    if b"\n" in data:
        break
payload = b"".join(chunks).split(b"\n", 1)[0]
sys.stdout.buffer.write(payload + b"\n")
PY
elif command -v socat >/dev/null 2>&1; then
  printf '%s\n' "$request_json" | socat -t 5 - "UNIX-CONNECT:$socket_path" | sed -n '1p'
elif command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -q -- ' -U\|-U '; then
  printf '%s\n' "$request_json" | nc -U "$socket_path" | sed -n '1p'
else
  printf '%s\n' '{{"id":"lazycat-webshell","error":{{"code":"unavailable","message":"python3, socat, or nc -U is required for Herdr socket access"}}}}'
fi"#
    )
}

fn parse_workspaces(response: &Value) -> Vec<HerdrWorkspaceInfo> {
    response
        .get("result")
        .and_then(|result| result.get("workspaces"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some(HerdrWorkspaceInfo {
                workspace_id: value.get("workspace_id")?.as_str()?.to_owned(),
                number: json_usize(value, "number"),
                label: value
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("workspace")
                    .to_owned(),
                focused: value
                    .get("focused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                active_tab_id: value
                    .get("active_tab_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                tab_count: json_usize(value, "tab_count"),
                pane_count: json_usize(value, "pane_count"),
            })
        })
        .collect()
}

fn parse_tabs(response: &Value) -> Vec<HerdrTabInfo> {
    response
        .get("result")
        .and_then(|result| result.get("tabs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some(HerdrTabInfo {
                tab_id: value.get("tab_id")?.as_str()?.to_owned(),
                workspace_id: value.get("workspace_id")?.as_str()?.to_owned(),
                number: json_usize(value, "number"),
                label: value
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("tab")
                    .to_owned(),
                focused: value
                    .get("focused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                pane_count: json_usize(value, "pane_count"),
            })
        })
        .collect()
}

fn json_usize(value: &Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|number| usize::try_from(number).ok())
        .unwrap_or(0)
}

fn required_id(value: Option<&str>, name: &str) -> Result<String, HerdrBridgeError> {
    let value = value.map(str::trim).unwrap_or_default();
    if value.is_empty() {
        return Err(HerdrBridgeError {
            status: StatusCode::BAD_REQUEST,
            message: format!("{name} is required"),
        });
    }
    Ok(value.to_owned())
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

impl IntoResponse for HerdrBridgeError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_tabs, parse_workspaces, shell_quote};

    #[test]
    fn parses_workspace_and_tab_lists_from_herdr_responses() {
        let workspaces = parse_workspaces(&json!({
            "result": {
                "type": "workspace_list",
                "workspaces": [{
                    "workspace_id": "w1",
                    "number": 1,
                    "label": "repo",
                    "focused": true,
                    "active_tab_id": "w1:t2",
                    "tab_count": 2,
                    "pane_count": 3
                }]
            }
        }));
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].workspace_id, "w1");
        assert!(workspaces[0].focused);

        let tabs = parse_tabs(&json!({
            "result": {
                "type": "tab_list",
                "tabs": [{
                    "tab_id": "w1:t2",
                    "workspace_id": "w1",
                    "number": 2,
                    "label": "tests",
                    "focused": true,
                    "pane_count": 1
                }]
            }
        }));
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].tab_id, "w1:t2");
        assert!(tabs[0].focused);
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("dev'user"), "'dev'\"'\"'user'");
    }
}
