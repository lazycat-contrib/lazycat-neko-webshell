use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use reqwest::{Method, Url};
use secrecy::ExposeSecret as _;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::device_api_auth;
use crate::lightos;
use crate::lightos_admin::{
    self, build_admin_url, build_upstream_headers, current_request_account_id,
    list_visible_client_instances, parse_client_selector, resolve_admin_base_url,
};
use crate::workspace::{
    SessionBackend, SplitDirection, WorkspaceAction, WorkspaceActionRequest, WorkspaceLayoutNode,
    WorkspacePaneState, WorkspaceState, WorkspaceTabState,
};

const CLIENT_TERMINAL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TICKET_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_WORKSPACE_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Error)]
#[error("{message}")]
pub(crate) struct ClientTerminalError {
    pub status: StatusCode,
    message: String,
}

impl ClientTerminalError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, message)
    }
}

impl IntoResponse for ClientTerminalError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

impl From<lightos_admin::LightOsAdminError> for ClientTerminalError {
    fn from(error: lightos_admin::LightOsAdminError) -> Self {
        Self::new(error.status, error.message)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ClientTerminalTicket {
    #[serde(default)]
    client_instance_id: String,
    #[serde(default)]
    device_api_url: String,
    #[serde(default)]
    terminal_service_name: String,
    #[serde(default)]
    ticket: String,
}

#[derive(Serialize)]
struct ClientTerminalTicketRequest<'a> {
    id: &'a str,
}

struct ClientTerminalDialInfo {
    ticket: ClientTerminalTicket,
    device_api_url: Url,
    auth_token: secrecy::SecretString,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RemoteWorkspaceState {
    #[serde(default)]
    selector: String,
    #[serde(default)]
    active_tab_id: String,
    #[serde(default)]
    tabs: Vec<RemoteWorkspaceTab>,
}

#[derive(Debug, Deserialize)]
struct RemoteWorkspaceTab {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    custom_label: bool,
    #[serde(default)]
    active_pane_id: String,
    layout: Option<WorkspaceLayoutNode>,
    #[serde(default)]
    panes: Vec<RemoteWorkspacePane>,
}

#[derive(Debug, Deserialize)]
struct RemoteWorkspacePane {
    #[serde(default)]
    id: String,
    #[serde(default)]
    cols: u16,
    #[serde(default)]
    rows: u16,
    #[serde(default)]
    exited: bool,
    #[serde(default)]
    exit_code: i32,
}

#[derive(Debug, Serialize)]
struct RemoteWorkspaceActionRequest {
    action: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    tab_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pane_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    direction: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    layout: Option<WorkspaceLayoutNode>,
    #[serde(skip_serializing_if = "String::is_empty")]
    active_pane_id: String,
    cols: u16,
    rows: u16,
}

pub(crate) async fn authorize_client(
    headers: &HeaderMap,
    selector: &str,
) -> Result<String, ClientTerminalError> {
    if parse_client_selector(selector).is_none() {
        return Err(ClientTerminalError::bad_request("invalid client target"));
    }
    if current_request_account_id(headers).is_none() {
        return Err(ClientTerminalError::unauthorized("account id is required"));
    }
    let visible = list_visible_client_instances(headers).await?;
    authorize_client_id(selector, &visible)
}

fn authorize_client_id(
    selector: &str,
    visible: &[lightos_admin::ClientInstanceSummary],
) -> Result<String, ClientTerminalError> {
    let client_id = parse_client_selector(selector)
        .ok_or_else(|| ClientTerminalError::bad_request("invalid client target"))?;
    visible
        .iter()
        .any(|item| item.id.trim() == client_id)
        .then(|| client_id.to_owned())
        .ok_or_else(|| {
            ClientTerminalError::forbidden("instance is not accessible by current account")
        })
}

pub(crate) async fn get_workspace(
    headers: &HeaderMap,
    selector: &str,
    cols: u16,
    rows: u16,
) -> Result<WorkspaceState, ClientTerminalError> {
    let query = [("cols", cols.to_string()), ("rows", rows.to_string())];
    let body =
        client_terminal_json(headers, selector, Method::GET, "/workspace", &query, None).await?;
    let remote = serde_json::from_slice::<RemoteWorkspaceState>(&body).map_err(|error| {
        ClientTerminalError::bad_gateway(format!("invalid remote workspace response: {error}"))
    })?;
    Ok(convert_remote_workspace(selector, remote))
}

pub(crate) async fn apply_workspace_action(
    headers: &HeaderMap,
    selector: &str,
    cols: u16,
    rows: u16,
    request: &WorkspaceActionRequest,
) -> Result<WorkspaceState, ClientTerminalError> {
    let outbound = remote_workspace_action(request, cols, rows)?;
    let payload = serde_json::to_vec(&outbound).map_err(|error| {
        ClientTerminalError::bad_request(format!("invalid workspace action: {error}"))
    })?;
    let query = [("cols", cols.to_string()), ("rows", rows.to_string())];
    let body = client_terminal_json(
        headers,
        selector,
        Method::POST,
        "/workspace",
        &query,
        Some(payload),
    )
    .await?;
    let remote = serde_json::from_slice::<RemoteWorkspaceState>(&body).map_err(|error| {
        ClientTerminalError::bad_gateway(format!("invalid remote workspace response: {error}"))
    })?;
    Ok(convert_remote_workspace(selector, remote))
}

async fn client_terminal_json(
    headers: &HeaderMap,
    selector: &str,
    method: Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<Vec<u8>>,
) -> Result<Vec<u8>, ClientTerminalError> {
    let dial = client_terminal_dial_info(headers, selector).await?;
    let mut url = client_terminal_url(&dial.ticket, path)?;
    if url.scheme() != dial.device_api_url.scheme()
        || url.host_str() != dial.device_api_url.host_str()
        || url.port_or_known_default() != dial.device_api_url.port_or_known_default()
    {
        return Err(ClientTerminalError::bad_gateway(
            "client terminal target origin mismatch",
        ));
    }
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            if !value.is_empty() && value != "0" {
                pairs.append_pair(key, value);
            }
        }
        pairs.append_pair("ticket", &dial.ticket.ticket);
    }
    let safe_url = sanitize_client_terminal_url(&url);
    let client = reqwest::Client::builder()
        .timeout(CLIENT_TERMINAL_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    let mut request = client
        .request(method, url)
        .header(
            "lzc_dapi_auth_token",
            HeaderValue::from_str(dial.auth_token.expose_secret())
                .map_err(|_| ClientTerminalError::bad_gateway("invalid device auth token"))?,
        )
        .header("accept", "application/json");
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body);
    }
    let response = request.send().await.map_err(|_| {
        ClientTerminalError::bad_gateway(format!(
            "remote client terminal request failed: {safe_url}"
        ))
    })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    if bytes.len() > MAX_WORKSPACE_RESPONSE_BYTES {
        return Err(ClientTerminalError::bad_gateway(
            "remote workspace response is too large",
        ));
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(ClientTerminalError::forbidden(
            "instance is not accessible by current account",
        ));
    }
    if !status.is_success() {
        let detail = redact_sensitive_text(
            String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).trim(),
            &dial.ticket.ticket,
            dial.auth_token.expose_secret(),
        );
        return Err(ClientTerminalError::bad_gateway(if detail.is_empty() {
            format!("remote client terminal returned {status}")
        } else {
            format!("remote client terminal returned {status}: {detail}")
        }));
    }
    Ok(bytes.to_vec())
}

async fn client_terminal_dial_info(
    headers: &HeaderMap,
    selector: &str,
) -> Result<ClientTerminalDialInfo, ClientTerminalError> {
    let client_id = authorize_client(headers, selector).await?;
    let ticket = request_terminal_ticket(headers, &client_id).await?;
    let ticket = validate_ticket(ticket, &client_id)?;
    let device_api_url = Url::parse(&ticket.device_api_url)
        .map_err(|_| ClientTerminalError::bad_gateway("invalid client terminal device URL"))?;
    let auth_token = device_api_auth::resolve_auth_token(&device_api_url)
        .await
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    Ok(ClientTerminalDialInfo {
        ticket,
        device_api_url,
        auth_token,
    })
}

async fn request_terminal_ticket(
    headers: &HeaderMap,
    client_id: &str,
) -> Result<ClientTerminalTicket, ClientTerminalError> {
    let account_id = current_request_account_id(headers)
        .ok_or_else(|| ClientTerminalError::unauthorized("account id is required"))?;
    let info = lightos::admin_info().await.map_err(|error| {
        ClientTerminalError::bad_gateway(
            error
                .message
                .unwrap_or_else(|| "failed to resolve LightOS admin info".to_owned()),
        )
    })?;
    let base_url = resolve_admin_base_url(&info.base_url);
    let url = build_admin_url(&base_url, "/api/client-instances/terminal-ticket")
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    let mut upstream_headers =
        build_upstream_headers(headers, &account_id).map_err(ClientTerminalError::bad_gateway)?;
    upstream_headers.insert("content-type", HeaderValue::from_static("application/json"));
    let client = reqwest::Client::builder()
        .timeout(CLIENT_TERMINAL_TIMEOUT)
        .build()
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    let response = client
        .post(url)
        .headers(upstream_headers)
        .json(&ClientTerminalTicketRequest { id: client_id })
        .send()
        .await
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| ClientTerminalError::bad_gateway(error.to_string()))?;
    if body.len() > MAX_TICKET_RESPONSE_BYTES {
        return Err(ClientTerminalError::bad_gateway(
            "client terminal ticket response is too large",
        ));
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(ClientTerminalError::forbidden(
            "instance is not accessible by current account",
        ));
    }
    if !status.is_success() {
        return Err(ClientTerminalError::bad_gateway(format!(
            "client terminal ticket request returned {status}"
        )));
    }
    serde_json::from_slice(&body).map_err(|error| {
        ClientTerminalError::bad_gateway(format!("invalid client terminal ticket: {error}"))
    })
}

fn validate_ticket(
    ticket: ClientTerminalTicket,
    expected_client_id: &str,
) -> Result<ClientTerminalTicket, ClientTerminalError> {
    if ticket.client_instance_id.trim() != expected_client_id {
        return Err(ClientTerminalError::bad_gateway(
            "client terminal ticket does not match requested client",
        ));
    }
    let device_url = Url::parse(ticket.device_api_url.trim())
        .map_err(|_| ClientTerminalError::bad_gateway("invalid client terminal device URL"))?;
    if !matches!(device_url.scheme(), "http" | "https") || device_url.host_str().is_none() {
        return Err(ClientTerminalError::bad_gateway(
            "invalid client terminal device URL",
        ));
    }
    let service = ticket.terminal_service_name.trim();
    if service.is_empty()
        || service.len() > 256
        || !service
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(ClientTerminalError::bad_gateway(
            "invalid client terminal service name",
        ));
    }
    if ticket.ticket.trim().is_empty() || ticket.ticket.len() > 8192 {
        return Err(ClientTerminalError::bad_gateway(
            "invalid client terminal ticket",
        ));
    }
    Ok(ticket)
}

fn client_terminal_url(
    ticket: &ClientTerminalTicket,
    request_path: &str,
) -> Result<Url, ClientTerminalError> {
    let mut url = Url::parse(ticket.device_api_url.trim())
        .map_err(|_| ClientTerminalError::bad_gateway("invalid client terminal device URL"))?;
    let base_path = url.path().trim_end_matches('/');
    let path = request_path.trim_start_matches('/');
    url.set_path(&format!(
        "{base_path}/s/{}/{}",
        ticket.terminal_service_name.trim(),
        path
    ));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn sanitize_client_terminal_url(url: &Url) -> String {
    let mut redacted = url.clone();
    let pairs = redacted
        .query_pairs()
        .map(|(key, value)| {
            if key == "ticket" {
                (key.into_owned(), "[REDACTED]".to_owned())
            } else {
                (key.into_owned(), value.into_owned())
            }
        })
        .collect::<Vec<_>>();
    redacted.set_query(None);
    if !pairs.is_empty() {
        redacted.query_pairs_mut().extend_pairs(pairs);
    }
    redacted.to_string()
}

fn redact_sensitive_text(text: &str, ticket: &str, auth_token: &str) -> String {
    let mut redacted = text.to_owned();
    for secret in [ticket, auth_token] {
        if !secret.is_empty() {
            redacted = redacted.replace(secret, "[REDACTED]");
        }
    }
    redacted
}

fn convert_remote_workspace(selector: &str, remote: RemoteWorkspaceState) -> WorkspaceState {
    let _remote_selector = remote.selector;
    WorkspaceState {
        selector: selector.to_owned(),
        active_tab_id: non_empty(remote.active_tab_id),
        tabs: remote
            .tabs
            .into_iter()
            .filter(|tab| !tab.id.trim().is_empty())
            .map(|tab| {
                let label = if tab.label.trim().is_empty() {
                    tab.id.clone()
                } else {
                    tab.label.trim().to_owned()
                };
                WorkspaceTabState {
                    id: tab.id,
                    label: label.clone(),
                    custom_label: tab.custom_label.then_some(label),
                    pinned: false,
                    pinned_order: None,
                    active_pane_id: non_empty(tab.active_pane_id),
                    layout: tab.layout,
                    panes: tab
                        .panes
                        .into_iter()
                        .filter(|pane| !pane.id.trim().is_empty())
                        .map(|pane| {
                            let _exit_code = pane.exit_code;
                            WorkspacePaneState {
                                session_id: pane.id.clone(),
                                id: pane.id,
                                status: if pane.exited { "exited" } else { "running" }.to_owned(),
                                session_backend: "webshell".to_owned(),
                                herdr_output_sequence: None,
                                cols: pane.cols,
                                rows: pane.rows,
                            }
                        })
                        .collect(),
                }
            })
            .collect(),
    }
}

fn remote_workspace_action(
    request: &WorkspaceActionRequest,
    cols: u16,
    rows: u16,
) -> Result<RemoteWorkspaceActionRequest, ClientTerminalError> {
    if request
        .session_backend
        .is_some_and(|backend| backend != SessionBackend::Webshell)
    {
        return Err(ClientTerminalError::bad_request(
            "remote clients support the native WebShell backend only",
        ));
    }
    let action = match request.action {
        WorkspaceAction::CreateTab => "create_tab",
        WorkspaceAction::CloseTab => "close_tab",
        WorkspaceAction::RenameTab => "rename_tab",
        WorkspaceAction::ActivateTab => "activate_tab",
        WorkspaceAction::SplitPane => "split_pane",
        WorkspaceAction::ClosePane => "close_pane",
        WorkspaceAction::ActivatePane => "activate_pane",
        WorkspaceAction::PromotePaneToTab => "promote_pane_to_tab",
        WorkspaceAction::UpdateLayout => "update_layout",
        WorkspaceAction::SetTabPinned => {
            return Err(ClientTerminalError::bad_request(
                "remote clients do not support pinned terminal tabs",
            ));
        }
    };
    Ok(RemoteWorkspaceActionRequest {
        action,
        tab_id: request.tab_id.clone().unwrap_or_default(),
        pane_id: request.pane_id.clone().unwrap_or_default(),
        direction: request
            .direction
            .map(direction_name)
            .unwrap_or_default()
            .to_owned(),
        label: request.label.clone().unwrap_or_default(),
        layout: request.layout.clone(),
        active_pane_id: request.active_pane_id.clone().unwrap_or_default(),
        cols,
        rows,
    })
}

fn direction_name(direction: SplitDirection) -> &'static str {
    match direction {
        SplitDirection::Up => "up",
        SplitDirection::Down => "down",
        SplitDirection::Left => "left",
        SplitDirection::Right => "right",
    }
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::{
        ClientTerminalTicket, RemoteWorkspaceState, authorize_client_id, client_terminal_url,
        convert_remote_workspace, redact_sensitive_text, remote_workspace_action,
        sanitize_client_terminal_url, validate_ticket,
    };
    use crate::lightos_admin::ClientInstanceSummary;
    use crate::workspace::{SessionBackend, WorkspaceAction, WorkspaceActionRequest};

    fn ticket() -> ClientTerminalTicket {
        ClientTerminalTicket {
            client_instance_id: "client-a".to_owned(),
            device_api_url: "https://device.example/root".to_owned(),
            terminal_service_name: "cloud.lazycat.lightos.client-terminal.client-a".to_owned(),
            ticket: "terminal-secret".to_owned(),
        }
    }

    #[test]
    fn validates_ticket_and_builds_redacted_remote_url() {
        let ticket = validate_ticket(ticket(), "client-a").expect("validated ticket");
        let mut url = client_terminal_url(&ticket, "/workspace").expect("workspace URL");
        url.query_pairs_mut().append_pair("ticket", &ticket.ticket);

        assert_eq!(
            url.as_str(),
            "https://device.example/root/s/cloud.lazycat.lightos.client-terminal.client-a/workspace?ticket=terminal-secret"
        );
        assert_eq!(
            sanitize_client_terminal_url(&url),
            "https://device.example/root/s/cloud.lazycat.lightos.client-terminal.client-a/workspace?ticket=%5BREDACTED%5D"
        );
    }

    #[test]
    fn rejects_ticket_for_a_different_client() {
        let error = validate_ticket(ticket(), "client-b").expect_err("mismatched ticket");
        assert!(error.to_string().contains("does not match"));
        assert!(!error.to_string().contains("terminal-secret"));
    }

    #[test]
    fn redacts_ticket_and_device_auth_token_from_remote_errors() {
        let redacted = redact_sensitive_text(
            "request ticket=terminal-secret token=device-auth-secret",
            "terminal-secret",
            "device-auth-secret",
        );
        assert_eq!(redacted, "request ticket=[REDACTED] token=[REDACTED]");
    }

    #[test]
    fn converts_official_remote_workspace_to_native_webshell_state() {
        let remote: RemoteWorkspaceState = serde_json::from_str(
            r#"{
                "selector":"remote-internal",
                "active_tab_id":"tab-1",
                "tabs":[{
                    "id":"tab-1",
                    "label":"Build",
                    "custom_label":true,
                    "active_pane_id":"pane-1",
                    "layout":{"type":"pane","paneId":"pane-1"},
                    "panes":[
                        {"id":"pane-1","cols":120,"rows":32,"exited":false,"exit_code":0},
                        {"id":"pane-2","cols":80,"rows":24,"exited":true,"exit_code":7}
                    ]
                }]
            }"#,
        )
        .expect("remote workspace");

        let workspace = convert_remote_workspace("client:client-a", remote);

        assert_eq!(workspace.selector, "client:client-a");
        assert_eq!(workspace.active_tab_id.as_deref(), Some("tab-1"));
        assert_eq!(workspace.tabs[0].custom_label.as_deref(), Some("Build"));
        assert_eq!(workspace.tabs[0].panes[0].session_id, "pane-1");
        assert_eq!(workspace.tabs[0].panes[0].session_backend, "webshell");
        assert_eq!(workspace.tabs[0].panes[0].status, "running");
        assert_eq!(workspace.tabs[0].panes[1].status, "exited");
    }

    #[test]
    fn authorizes_only_visible_remote_clients() {
        let visible = vec![ClientInstanceSummary {
            id: "client-a".to_owned(),
            name: "Alice PC".to_owned(),
            platform: "darwin".to_owned(),
            status: "running".to_owned(),
            owner_user_id: "alice".to_owned(),
        }];

        assert_eq!(
            authorize_client_id("client:client-a", &visible).expect("visible client"),
            "client-a"
        );
        let error = authorize_client_id("client:client-b", &visible).expect_err("hidden client");
        assert_eq!(error.status, axum::http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn forwards_only_native_remote_workspace_actions() {
        let request = WorkspaceActionRequest {
            name: "client:client-a".to_owned(),
            action: WorkspaceAction::CreateTab,
            tab_id: None,
            pane_id: None,
            direction: None,
            label: Some("Build".to_owned()),
            layout: None,
            active_pane_id: None,
            cols: Some(120),
            rows: Some(32),
            output_limit: None,
            auto_restart: None,
            session_backend: Some(SessionBackend::Webshell),
            pinned: None,
            pinned_order: None,
        };
        let outbound = remote_workspace_action(&request, 120, 32).expect("remote action");
        let value = serde_json::to_value(outbound).expect("action JSON");
        assert_eq!(value["action"], "create_tab");
        assert_eq!(value["label"], "Build");
        assert_eq!(value["cols"], 120);
        assert!(value.get("name").is_none());

        let unsupported = WorkspaceActionRequest {
            session_backend: Some(SessionBackend::Herdr),
            ..request
        };
        let error = remote_workspace_action(&unsupported, 120, 32)
            .expect_err("Herdr must not be forwarded to a remote client");
        assert!(error.to_string().contains("native WebShell"));
    }
}
