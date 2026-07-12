use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use reqwest::Url;
use serde::Deserialize;

use crate::http_body::read_limited_body;
use crate::lightos;
use crate::proto::lazycat::webshell::v1::{Instance, InstanceKind};
use crate::validation::validate_selector;

const LIGHTOS_USER_ID_HEADER: &str = "x-hc-user-id";
const LIGHTOS_REQUIRE_COOKIE_AUTH_ENV: &str = "LIGHTOS_REQUIRE_COOKIE_AUTH";
const LIGHTOS_ADMIN_INTERNAL_BASE_URL_ENV: &str = "LIGHTOS_ADMIN_INTERNAL_BASE_URL";
const LIGHTOS_ADMIN_APP_ID: &str = "cloud.lazycat.lightos.entry";
const DEFAULT_LIGHTOS_ADMIN_INTERNAL_BASE_URL: &str = "http://127.0.0.1:18081";
const LAZYCAT_APP_ID_ENV: &str = "LAZYCAT_APP_ID";
const DEPLOY_UID_ENV_NAMES: [&str; 7] = [
    "LAZYCAT_APP_DEPLOY_UID",
    "LAZYCAT_DEPLOY_UID",
    "LAZYCAT_USER_ID",
    "LAZYCAT_USER_UID",
    "LAZYCAT_APP_DEPLOY_ID",
    "LAZYCAT_DEPLOY_ID",
    LAZYCAT_APP_ID_ENV,
];
const MAX_ADMIN_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug)]
pub struct LightOsAdminError {
    pub status: StatusCode,
    pub message: String,
}

impl LightOsAdminError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct VisibleInstance {
    #[serde(default)]
    selector: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    owner_deploy_id: String,
    #[serde(default)]
    status: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct ClientInstanceSummary {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub owner_user_id: String,
}

pub async fn list_visible_instances(
    headers: &HeaderMap,
) -> Result<Vec<Instance>, LightOsAdminError> {
    let account_id = current_request_account_id(headers)
        .ok_or_else(|| LightOsAdminError::unauthorized("account id is required"))?;
    let info = lightos::admin_info().await.map_err(|error| {
        LightOsAdminError::bad_gateway(
            error
                .message
                .unwrap_or_else(|| "failed to resolve LightOS admin info".to_owned()),
        )
    })?;
    let base_url = resolve_admin_base_url(&info.base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| LightOsAdminError::bad_gateway(error.to_string()))?;
    list_visible_instances_from(&client, &base_url, headers, &account_id).await
}

async fn list_visible_instances_from(
    client: &reqwest::Client,
    base_url: &str,
    source_headers: &HeaderMap,
    account_id: &str,
) -> Result<Vec<Instance>, LightOsAdminError> {
    let headers = build_upstream_headers(source_headers, account_id)
        .map_err(LightOsAdminError::bad_gateway)?;
    let webshell_url = build_admin_url(base_url, "/api/webshell/instances")
        .map_err(|error| LightOsAdminError::bad_gateway(error.to_string()))?;
    let client_url = build_admin_url(base_url, "/api/client-instances")
        .map_err(|error| LightOsAdminError::bad_gateway(error.to_string()))?;
    let webshell = fetch_admin_json(client, webshell_url, headers.clone()).await?;
    let client_instances = fetch_admin_json(client, client_url, headers).await?;
    let mut instances =
        parse_visible_instances(&webshell).map_err(LightOsAdminError::bad_gateway)?;
    instances
        .extend(parse_client_instances(&client_instances).map_err(LightOsAdminError::bad_gateway)?);
    instances.sort_by_key(|instance| instance.status.as_deref() != Some("running"));
    let mut seen = HashSet::new();
    instances.retain(|instance| {
        instance
            .selector
            .as_deref()
            .is_some_and(|selector| seen.insert(selector.to_owned()))
    });
    Ok(instances)
}

pub(crate) async fn list_visible_client_instances(
    headers: &HeaderMap,
) -> Result<Vec<ClientInstanceSummary>, LightOsAdminError> {
    let account_id = current_request_account_id(headers)
        .ok_or_else(|| LightOsAdminError::unauthorized("account id is required"))?;
    let info = lightos::admin_info().await.map_err(|error| {
        LightOsAdminError::bad_gateway(
            error
                .message
                .unwrap_or_else(|| "failed to resolve LightOS admin info".to_owned()),
        )
    })?;
    let base_url = resolve_admin_base_url(&info.base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| LightOsAdminError::bad_gateway(error.to_string()))?;
    list_visible_client_instances_from(&client, &base_url, headers, &account_id).await
}

pub(crate) async fn list_visible_client_instances_from(
    client: &reqwest::Client,
    base_url: &str,
    source_headers: &HeaderMap,
    account_id: &str,
) -> Result<Vec<ClientInstanceSummary>, LightOsAdminError> {
    let url = build_admin_url(base_url, "/api/client-instances")
        .map_err(|error| LightOsAdminError::bad_gateway(error.to_string()))?;
    let headers = build_upstream_headers(source_headers, account_id)
        .map_err(LightOsAdminError::bad_gateway)?;
    let body = fetch_admin_json(client, url, headers).await?;
    parse_client_instance_summaries(&body).map_err(LightOsAdminError::bad_gateway)
}

async fn fetch_admin_json(
    client: &reqwest::Client,
    url: Url,
    headers: HeaderMap,
) -> Result<Vec<u8>, LightOsAdminError> {
    let response = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|error| LightOsAdminError::bad_gateway(error.to_string()))?;
    let status = response.status();
    let body = read_limited_body(response, MAX_ADMIN_RESPONSE_BYTES, "LightOS admin response")
        .await
        .map_err(LightOsAdminError::bad_gateway)?;
    if status != StatusCode::OK {
        let detail = String::from_utf8_lossy(&body).trim().to_owned();
        let message = if detail.is_empty() {
            status.to_string()
        } else {
            detail
        };
        return Err(LightOsAdminError {
            status: if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                status
            } else {
                StatusCode::BAD_GATEWAY
            },
            message,
        });
    }
    Ok(body)
}

pub(crate) fn current_request_account_id(headers: &HeaderMap) -> Option<String> {
    account_id_from(
        headers,
        lightos_cookie_auth_required(),
        current_deploy_uid().as_deref(),
    )
}

fn account_id_from(
    headers: &HeaderMap,
    cookie_auth_required: bool,
    fallback_deploy_uid: Option<&str>,
) -> Option<String> {
    if let Some(account_id) = non_empty_header(headers, LIGHTOS_USER_ID_HEADER) {
        return Some(account_id.to_owned());
    }
    if cookie_auth_required {
        return None;
    }
    fallback_deploy_uid
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn lightos_cookie_auth_required() -> bool {
    !matches!(
        lightos_config_value(LIGHTOS_REQUIRE_COOKIE_AUTH_ENV)
            .to_ascii_lowercase()
            .as_str(),
        "0" | "false" | "no" | "off"
    )
}

fn current_deploy_uid() -> Option<String> {
    DEPLOY_UID_ENV_NAMES
        .iter()
        .find_map(|name| non_empty_env(name))
}

pub(crate) fn resolve_admin_base_url(public_base_url: &str) -> String {
    let configured = lightos_config_value(LIGHTOS_ADMIN_INTERNAL_BASE_URL_ENV);
    if !configured.is_empty() {
        return configured;
    }
    if non_empty_env(LAZYCAT_APP_ID_ENV).as_deref() == Some(LIGHTOS_ADMIN_APP_ID) {
        return DEFAULT_LIGHTOS_ADMIN_INTERNAL_BASE_URL.to_owned();
    }
    public_base_url.trim().to_owned()
}

pub(crate) fn build_admin_url(base_url: &str, request_path: &str) -> Result<Url, url::ParseError> {
    let mut url = Url::parse(base_url.trim())?;
    let base_path = url.path().trim_end_matches('/');
    let request_path = request_path.trim().trim_start_matches('/');
    let joined = if base_path.is_empty() || base_path == "/" {
        format!("/{request_path}")
    } else {
        format!("{base_path}/{request_path}")
    };
    url.set_path(&joined);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

pub(crate) fn build_upstream_headers(
    source: &HeaderMap,
    account_id: &str,
) -> Result<HeaderMap, String> {
    let mut target = HeaderMap::new();
    for name in [
        "accept",
        "accept-language",
        "authorization",
        "content-type",
        "cookie",
        "lzc-auth-token",
        "lzc-api-auth-token",
        "x-csrf-token",
        "x-requested-with",
    ] {
        copy_header(source, &mut target, name);
    }
    target.insert("accept", HeaderValue::from_static("application/json"));
    target.insert(
        HeaderName::from_static(LIGHTOS_USER_ID_HEADER),
        HeaderValue::from_str(account_id.trim()).map_err(|error| error.to_string())?,
    );
    for name in ["x-hc-user-role", "x-hc-device-id", "x-hc-login-time"] {
        copy_header(source, &mut target, name);
    }
    Ok(target)
}

fn copy_header(source: &HeaderMap, target: &mut HeaderMap, name: &'static str) {
    let header_name = HeaderName::from_static(name);
    for value in source.get_all(&header_name) {
        target.append(header_name.clone(), value.clone());
    }
}

fn non_empty_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn parse_visible_instances(output: &[u8]) -> Result<Vec<Instance>, String> {
    let items: Vec<VisibleInstance> = serde_json::from_slice(output)
        .map_err(|error| format!("invalid LightOS webshell instances JSON: {error}"))?;
    let mut instances = items
        .into_iter()
        .filter_map(instance_from_visible)
        .collect::<Vec<_>>();
    instances.sort_by_key(|instance| instance.status.as_deref() != Some("running"));
    let mut seen = HashSet::new();
    instances.retain(|instance| {
        instance
            .selector
            .as_deref()
            .is_some_and(|selector| seen.insert(selector.to_owned()))
    });
    Ok(instances)
}

fn instance_from_visible(item: VisibleInstance) -> Option<Instance> {
    let explicit_selector = item.selector.trim();
    let legacy_name = item.name.trim();
    let legacy_owner = item.owner_deploy_id.trim();
    let selector = if !explicit_selector.is_empty() && validate_selector(explicit_selector).is_ok()
    {
        explicit_selector.to_owned()
    } else if !legacy_name.is_empty() && !legacy_owner.is_empty() {
        format!("{legacy_name}@{legacy_owner}")
    } else {
        return None;
    };
    let (selector_name, selector_owner) = selector.split_once('@')?;
    let selector_name = selector_name.to_owned();
    let selector_owner = selector_owner.to_owned();
    Some(Instance {
        selector: Some(selector),
        name: Some(if legacy_name.is_empty() {
            selector_name
        } else {
            legacy_name.to_owned()
        }),
        owner_deploy_id: Some(if legacy_owner.is_empty() {
            selector_owner
        } else {
            legacy_owner.to_owned()
        }),
        status: Some(item.status.trim().to_owned()),
        kind: Some(InstanceKind::INSTANCE_KIND_LIGHTOS.into()),
        ..Default::default()
    })
}

fn parse_client_instance_summaries(output: &[u8]) -> Result<Vec<ClientInstanceSummary>, String> {
    serde_json::from_slice(output)
        .map_err(|error| format!("invalid LightOS client instances JSON: {error}"))
}

fn parse_client_instances(output: &[u8]) -> Result<Vec<Instance>, String> {
    Ok(parse_client_instance_summaries(output)?
        .into_iter()
        .filter_map(instance_from_client)
        .collect())
}

fn instance_from_client(item: ClientInstanceSummary) -> Option<Instance> {
    let id = item.id.trim();
    let selector = format!("client:{id}");
    if parse_client_selector(&selector).is_none() {
        return None;
    }
    let name = item.name.trim();
    let status = item.status.trim();
    Some(Instance {
        selector: Some(selector),
        name: Some(if name.is_empty() { "PC Client" } else { name }.to_owned()),
        owner_deploy_id: Some(String::new()),
        status: Some(if status.is_empty() { "running" } else { status }.to_owned()),
        kind: Some(InstanceKind::INSTANCE_KIND_REMOTE_CLIENT.into()),
        platform: Some(item.platform.trim().to_owned()),
        owner_user_id: Some(item.owner_user_id.trim().to_owned()),
        ..Default::default()
    })
}

pub(crate) fn is_client_selector(selector: &str) -> bool {
    selector.trim().starts_with("client:")
}

pub(crate) fn parse_client_selector(selector: &str) -> Option<&str> {
    let value = selector.trim();
    let id = value.strip_prefix("client:")?;
    if id.is_empty()
        || id.len() > 256
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return None;
    }
    Some(id)
}

fn lightos_config_value(name: &str) -> String {
    if let Some(value) = non_empty_env(name) {
        return value;
    }
    config_env_files()
        .into_iter()
        .find_map(|path| read_config_file_value(&path, name))
        .unwrap_or_default()
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn config_env_files() -> Vec<PathBuf> {
    let mut files = vec![
        PathBuf::from("/lzcapp/pkg/content/.env"),
        PathBuf::from("/lzcapp/run/.env"),
    ];
    if let Ok(executable) = std::env::current_exe()
        && let Some(parent) = executable.parent()
    {
        files.push(parent.join(".env"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        files.push(cwd.join(".env"));
    }
    files
}

fn read_config_file_value(path: &std::path::Path, name: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let prefix = format!("{name}=");
    let export_prefix = format!("export {prefix}");
    content.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        line.strip_prefix(&prefix)
            .or_else(|| line.strip_prefix(&export_prefix))
            .map(unquote_config_value)
    })
}

fn unquote_config_value(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if matches!(bytes[0], b'\'' | b'"') && bytes[0] == bytes[value.len() - 1] {
            return value[1..value.len() - 1].trim().to_owned();
        }
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;

    use super::{
        account_id_from, build_admin_url, build_upstream_headers, fetch_admin_json,
        list_visible_instances_from, parse_client_instances, parse_visible_instances,
    };
    use crate::proto::lazycat::webshell::v1::InstanceKind;

    #[test]
    fn account_id_prefers_lightos_user_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-hc-user-id", HeaderValue::from_static("login-user-a"));

        assert_eq!(
            account_id_from(&headers, true, Some("deploy-user")),
            Some("login-user-a".to_owned())
        );
    }

    #[test]
    fn account_id_uses_deploy_fallback_only_when_cookie_auth_is_disabled() {
        let headers = HeaderMap::new();

        assert_eq!(account_id_from(&headers, true, Some("deploy-user")), None);
        assert_eq!(
            account_id_from(&headers, false, Some("deploy-user")),
            Some("deploy-user".to_owned())
        );
    }

    #[test]
    fn builds_official_webshell_instances_url_under_admin_base_path() {
        assert_eq!(
            build_admin_url("https://admin.example/root/", "/api/webshell/instances")
                .expect("admin URL")
                .as_str(),
            "https://admin.example/root/api/webshell/instances"
        );
    }

    #[test]
    fn forwards_browser_auth_headers_and_sets_lightos_account() {
        let mut source = HeaderMap::new();
        source.insert("cookie", HeaderValue::from_static("session=abc"));
        source.insert("x-csrf-token", HeaderValue::from_static("csrf-token"));
        source.insert("x-hc-user-role", HeaderValue::from_static("NORMAL"));
        source.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.10"));

        let upstream = build_upstream_headers(&source, "login-user-a").expect("headers");

        assert_eq!(
            upstream.get("cookie").and_then(|value| value.to_str().ok()),
            Some("session=abc")
        );
        assert_eq!(
            upstream
                .get("x-csrf-token")
                .and_then(|value| value.to_str().ok()),
            Some("csrf-token")
        );
        assert_eq!(
            upstream
                .get("x-hc-user-id")
                .and_then(|value| value.to_str().ok()),
            Some("login-user-a")
        );
        assert_eq!(
            upstream
                .get("x-hc-user-role")
                .and_then(|value| value.to_str().ok()),
            Some("NORMAL")
        );
        assert!(!upstream.contains_key("x-forwarded-for"));
    }

    #[test]
    fn parses_explicit_and_legacy_visible_instance_selectors() {
        let instances = parse_visible_instances(
            br#"[
                {"selector":"alpha@deploy-a","status":"running","username":"alice"},
                {"name":"beta","owner_deploy_id":"deploy-b","status":"stopped","username":"bob"}
            ]"#,
        )
        .expect("visible instances");

        assert_eq!(instances.len(), 2);
        assert_eq!(instances[0].selector.as_deref(), Some("alpha@deploy-a"));
        assert_eq!(instances[0].name.as_deref(), Some("alpha"));
        assert_eq!(instances[0].owner_deploy_id.as_deref(), Some("deploy-a"));
        assert_eq!(instances[1].selector.as_deref(), Some("beta@deploy-b"));
        assert_eq!(
            instances[0].kind.as_ref().and_then(|kind| kind.as_known()),
            Some(InstanceKind::INSTANCE_KIND_LIGHTOS)
        );
    }

    #[test]
    fn parses_remote_client_instances_with_typed_selectors() {
        let instances = parse_client_instances(
            br#"[
                {"id":"client-a","name":"Alice PC","platform":"darwin","status":"running","owner_user_id":"alice"},
                {"id":"","name":"invalid","platform":"linux","status":"running"}
            ]"#,
        )
        .expect("client instances");

        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].selector.as_deref(), Some("client:client-a"));
        assert_eq!(instances[0].name.as_deref(), Some("Alice PC"));
        assert_eq!(instances[0].platform.as_deref(), Some("darwin"));
        assert_eq!(instances[0].owner_user_id.as_deref(), Some("alice"));
        assert_eq!(
            instances[0].kind.as_ref().and_then(|kind| kind.as_known()),
            Some(InstanceKind::INSTANCE_KIND_REMOTE_CLIENT)
        );
    }

    #[tokio::test]
    async fn loads_visible_instances_from_official_admin_endpoint_with_account_context() {
        let app = Router::new()
            .route(
                "/root/api/webshell/instances",
                get(|headers: HeaderMap| async move {
                    let authorized = headers
                        .get("x-hc-user-id")
                        .and_then(|value| value.to_str().ok())
                        == Some("login-user-a")
                        && headers.get("cookie").and_then(|value| value.to_str().ok())
                            == Some("session=abc");
                    if !authorized {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    Json(json!([{
                        "selector": "alpha@deploy-a",
                        "status": "running"
                    }]))
                    .into_response()
                }),
            )
            .route(
                "/root/api/client-instances",
                get(|headers: HeaderMap| async move {
                    let authorized = headers
                        .get("x-hc-user-id")
                        .and_then(|value| value.to_str().ok())
                        == Some("login-user-a")
                        && headers.get("cookie").and_then(|value| value.to_str().ok())
                            == Some("session=abc");
                    if !authorized {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    Json(json!([])).into_response()
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        let mut headers = HeaderMap::new();
        headers.insert("cookie", HeaderValue::from_static("session=abc"));

        let instances = list_visible_instances_from(
            &reqwest::Client::new(),
            &format!("http://{address}/root/"),
            &headers,
            "login-user-a",
        )
        .await
        .expect("visible instances");

        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].selector.as_deref(), Some("alpha@deploy-a"));
    }

    #[tokio::test]
    async fn preserves_upstream_authentication_status() {
        let app = Router::new().route(
            "/forbidden",
            get(|| async { (StatusCode::FORBIDDEN, "account denied") }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        let url = reqwest::Url::parse(&format!("http://{address}/forbidden")).expect("test URL");

        let error = fetch_admin_json(&reqwest::Client::new(), url, HeaderMap::new())
            .await
            .expect_err("forbidden response must remain forbidden");

        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.message, "account denied");
    }
}
