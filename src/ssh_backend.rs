use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use connectrpc::{ConnectError, error::ErrorCode};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;
use uuid::Uuid;

use crate::config::{DEFAULT_SSH_KEY_DIR, ENV_SSH_CONFIG_FILE, ENV_SSH_KEY_DIR};
use crate::database::{AppDatabase, SshProfileRecord, SshProfileRecordUpsert};
use crate::proto::lazycat::webshell::v1::Instance;
use crate::state::AppState;

const SSH_OWNER_DEPLOY_ID: &str = "ssh";
const SSH_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SSH_CONFIG_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SshProfileKind {
    ManagedKey,
    #[serde(rename = "device-openssh")]
    DeviceOpenSsh,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfileView {
    pub id: String,
    pub selector: String,
    pub name: String,
    pub kind: SshProfileKind,
    pub enabled: bool,
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub target: String,
    pub public_key: String,
    pub strict_host_key_checking: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_used_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfileRequest {
    id: Option<String>,
    name: String,
    kind: SshProfileKind,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    host: String,
    port: Option<u16>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    strict_host_key_checking: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshConnectionTestResponse {
    ok: bool,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHostView {
    pub alias: String,
    pub host: String,
    pub username: String,
    pub port: Option<u16>,
    pub source: String,
}

#[derive(Clone, Debug)]
pub struct SshProfile {
    record: SshProfileRecord,
    kind: SshProfileKind,
}

pub async fn list_ssh_profiles(State(state): State<std::sync::Arc<AppState>>) -> Response {
    match list_profile_views(&state.database()) {
        Ok(profiles) => Json(profiles).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

pub async fn list_ssh_config_hosts() -> Response {
    match list_device_ssh_config_hosts() {
        Ok(hosts) => Json(hosts).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

pub async fn upsert_ssh_profile(
    State(state): State<std::sync::Arc<AppState>>,
    Json(request): Json<SshProfileRequest>,
) -> Response {
    let database = state.database();
    match normalize_profile_request(&database, request).await {
        Ok(profile) => match database.upsert_ssh_profile(&profile) {
            Ok(()) => match database.load_ssh_profile(&profile.id) {
                Ok(Some(record)) => Json(profile_view(record)).into_response(),
                Ok(None) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "SSH profile was not saved",
                )
                    .into_response(),
                Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
            },
            Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
        },
        Err(err) => err.into_response(),
    }
}

pub async fn delete_ssh_profile(
    State(state): State<std::sync::Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let id = normalize_profile_id(&id).unwrap_or_default();
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "invalid SSH profile id").into_response();
    }
    match state.database().delete_ssh_profile(&id) {
        Ok(Some(record)) => {
            if parse_kind(&record.kind) == Some(SshProfileKind::ManagedKey)
                && !record.private_key_path.trim().is_empty()
            {
                let _ = fs::remove_file(&record.private_key_path);
                let _ = fs::remove_file(format!("{}.pub", record.private_key_path));
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "SSH profile not found").into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

pub async fn test_ssh_profile(
    State(state): State<std::sync::Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let selector = selector_for_profile_id(&id);
    let profile = match load_enabled_profile(&state.database(), &selector) {
        Ok(profile) => profile,
        Err(err) => return connect_error_response(err),
    };
    let message = match run_profile_script(&profile, "printf '%s' webshell-ssh-ok", &[]).await {
        Ok(output) if output.as_slice() == b"webshell-ssh-ok" => {
            "SSH connection succeeded".to_owned()
        }
        Ok(output) => format!(
            "SSH command returned unexpected output: {}",
            String::from_utf8_lossy(&output)
        ),
        Err(err) => return connect_error_response(err),
    };
    Json(SshConnectionTestResponse { ok: true, message }).into_response()
}

pub fn list_profile_views(database: &AppDatabase) -> io::Result<Vec<SshProfileView>> {
    database
        .list_ssh_profiles()
        .map(|profiles| profiles.into_iter().map(profile_view).collect())
}

pub fn list_profile_instances(database: &AppDatabase) -> io::Result<Vec<Instance>> {
    let mut profiles = database.list_ssh_profiles()?;
    profiles.retain(|profile| profile.enabled);
    profiles.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(profiles
        .into_iter()
        .map(|profile| Instance {
            selector: Some(selector_for_profile_id(&profile.id)),
            name: Some(profile.name),
            owner_deploy_id: Some(SSH_OWNER_DEPLOY_ID.to_owned()),
            status: Some("running".to_owned()),
            ..Default::default()
        })
        .collect())
}

pub fn list_device_ssh_config_hosts() -> io::Result<Vec<SshConfigHostView>> {
    let Some(path) = device_ssh_config_path() else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_SSH_CONFIG_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "OpenSSH config is too large to inspect",
        ));
    }
    let contents = fs::read_to_string(&path)?;
    Ok(parse_ssh_config_hosts(&contents, &path.to_string_lossy()))
}

pub fn is_ssh_selector(selector: &str) -> bool {
    profile_id_from_selector(selector).is_some()
}

pub fn profile_id_from_selector(selector: &str) -> Option<&str> {
    let (id, owner) = selector.trim().split_once('@')?;
    (owner == SSH_OWNER_DEPLOY_ID && valid_profile_id(id)).then_some(id)
}

pub fn selector_for_profile_id(id: &str) -> String {
    format!(
        "{}@{SSH_OWNER_DEPLOY_ID}",
        normalize_profile_id(id).unwrap_or_default()
    )
}

pub fn load_enabled_profile(
    database: &AppDatabase,
    selector: &str,
) -> Result<SshProfile, ConnectError> {
    let profile_id = profile_id_from_selector(selector)
        .ok_or_else(|| ConnectError::invalid_argument("invalid SSH profile selector"))?;
    let record = database
        .load_ssh_profile(profile_id)
        .map_err(|err| ConnectError::internal(err.to_string()))?
        .ok_or_else(|| ConnectError::not_found("SSH profile not found"))?;
    if !record.enabled {
        return Err(ConnectError::failed_precondition("SSH profile is disabled"));
    }
    let kind = parse_kind(&record.kind)
        .ok_or_else(|| ConnectError::failed_precondition("invalid SSH profile kind"))?;
    Ok(SshProfile { record, kind })
}

pub fn terminal_command_for_profile(profile: &SshProfile) -> (String, Vec<String>) {
    let mut args = ssh_base_args(profile);
    args.push("-tt".to_owned());
    args.push(profile.target());
    ("ssh".to_owned(), args)
}

pub async fn run_profile_script(
    profile: &SshProfile,
    script: &str,
    stdin: &[u8],
) -> Result<Vec<u8>, ConnectError> {
    let mut args = ssh_base_args(profile);
    args.push(profile.target());
    args.push("/bin/sh".to_owned());
    args.push("-lc".to_owned());
    args.push(shell_quote(script));
    let mut command = tokio::process::Command::new("ssh");
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| ConnectError::unavailable(format!("failed to run ssh: {err}")))?;
    if let Some(mut child_stdin) = child.stdin.take() {
        let input = stdin.to_vec();
        tokio::spawn(async move {
            if !input.is_empty() {
                let _ = child_stdin.write_all(&input).await;
            }
        });
    }
    let output = timeout(SSH_COMMAND_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("SSH command timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("SSH command failed: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "SSH command exited with {}: {detail}",
            output.status
        )));
    }
    Ok(output.stdout)
}

pub fn mark_profile_used(database: &AppDatabase, selector: &str) {
    let Some(profile_id) = profile_id_from_selector(selector) else {
        return;
    };
    let _ = database.mark_ssh_profile_used(profile_id);
}

impl SshProfile {
    pub fn login_user(&self) -> String {
        self.record.username.trim().to_owned()
    }

    fn target(&self) -> String {
        match self.kind {
            SshProfileKind::ManagedKey => {
                let host = self.record.host.trim();
                let username = self.record.username.trim();
                if username.is_empty() {
                    host.to_owned()
                } else {
                    format!("{username}@{host}")
                }
            }
            SshProfileKind::DeviceOpenSsh => self.record.target.trim().to_owned(),
        }
    }
}

fn ssh_base_args(profile: &SshProfile) -> Vec<String> {
    let mut args = vec![
        "-o".to_owned(),
        "ServerAliveInterval=30".to_owned(),
        "-o".to_owned(),
        "ServerAliveCountMax=3".to_owned(),
        "-o".to_owned(),
        format!(
            "StrictHostKeyChecking={}",
            normalize_host_key_policy(&profile.record.strict_host_key_checking)
        ),
    ];
    if let Some(port) = profile.record.port {
        args.push("-p".to_owned());
        args.push(port.to_string());
    }
    if profile.kind == SshProfileKind::ManagedKey {
        args.push("-o".to_owned());
        args.push("IdentitiesOnly=yes".to_owned());
        args.push("-i".to_owned());
        args.push(profile.record.private_key_path.clone());
    }
    args
}

async fn normalize_profile_request(
    database: &AppDatabase,
    request: SshProfileRequest,
) -> Result<SshProfileRecordUpsert, SshProfileError> {
    let id = request
        .id
        .as_deref()
        .and_then(normalize_profile_id)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = normalize_name(&request.name)?;
    let strict_host_key_checking = normalize_host_key_policy(&request.strict_host_key_checking);
    let existing = database
        .load_ssh_profile(&id)
        .map_err(|err| SshProfileError::internal(err.to_string()))?;

    match request.kind {
        SshProfileKind::ManagedKey => {
            let host = normalize_host(&request.host)?;
            let username = normalize_optional_user(&request.username)?;
            let (private_key_path, public_key) =
                managed_key_for_profile(existing.as_ref(), &id).await?;
            Ok(SshProfileRecordUpsert {
                id,
                name,
                kind: "managed-key".to_owned(),
                enabled: request.enabled,
                host,
                port: normalize_port(request.port),
                username,
                target: String::new(),
                private_key_path,
                public_key,
                strict_host_key_checking,
            })
        }
        SshProfileKind::DeviceOpenSsh => {
            let target = normalize_ssh_target(&request.target)?;
            Ok(SshProfileRecordUpsert {
                id,
                name,
                kind: "device-openssh".to_owned(),
                enabled: request.enabled,
                host: normalize_optional_host(&request.host)?,
                port: normalize_port(request.port),
                username: normalize_optional_user(&request.username)?,
                target,
                private_key_path: String::new(),
                public_key: String::new(),
                strict_host_key_checking,
            })
        }
    }
}

async fn managed_key_for_profile(
    existing: Option<&SshProfileRecord>,
    profile_id: &str,
) -> Result<(String, String), SshProfileError> {
    if let Some(existing) = existing
        && parse_kind(&existing.kind) == Some(SshProfileKind::ManagedKey)
        && !existing.private_key_path.trim().is_empty()
        && !existing.public_key.trim().is_empty()
        && Path::new(&existing.private_key_path).exists()
    {
        return Ok((
            existing.private_key_path.clone(),
            existing.public_key.clone(),
        ));
    }
    let key_dir = ssh_key_dir();
    fs::create_dir_all(&key_dir).map_err(|err| SshProfileError::internal(err.to_string()))?;
    let private_key_path = key_dir.join(format!("{profile_id}.ed25519"));
    let public_key_path = PathBuf::from(format!("{}.pub", private_key_path.display()));
    if private_key_path.exists() {
        fs::remove_file(&private_key_path)
            .map_err(|err| SshProfileError::internal(err.to_string()))?;
    }
    if public_key_path.exists() {
        fs::remove_file(&public_key_path)
            .map_err(|err| SshProfileError::internal(err.to_string()))?;
    }
    let output = tokio::process::Command::new("ssh-keygen")
        .args([
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            &format!("lazycat-neko-webshell:{profile_id}"),
            "-f",
            private_key_path
                .to_str()
                .ok_or_else(|| SshProfileError::internal("invalid SSH key path"))?,
        ])
        .output()
        .await
        .map_err(|err| SshProfileError::internal(format!("failed to run ssh-keygen: {err}")))?;
    if !output.status.success() {
        return Err(SshProfileError::bad_request(format!(
            "ssh-keygen failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(&private_key_path, fs::Permissions::from_mode(0o600));
    }
    let public_key = fs::read_to_string(public_key_path)
        .map_err(|err| SshProfileError::internal(format!("failed to read SSH public key: {err}")))?
        .trim()
        .to_owned();
    Ok((private_key_path.to_string_lossy().to_string(), public_key))
}

fn profile_view(record: SshProfileRecord) -> SshProfileView {
    let kind = parse_kind(&record.kind).unwrap_or(SshProfileKind::DeviceOpenSsh);
    SshProfileView {
        selector: selector_for_profile_id(&record.id),
        id: record.id,
        name: record.name,
        kind,
        enabled: record.enabled,
        host: record.host,
        port: record.port,
        username: record.username,
        target: record.target,
        public_key: record.public_key,
        strict_host_key_checking: normalize_host_key_policy(&record.strict_host_key_checking),
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
        last_used_at_ms: record.last_used_at_ms,
    }
}

fn parse_kind(value: &str) -> Option<SshProfileKind> {
    match value.trim() {
        "managed-key" => Some(SshProfileKind::ManagedKey),
        "device-openssh" => Some(SshProfileKind::DeviceOpenSsh),
        _ => None,
    }
}

fn normalize_profile_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    valid_profile_id(trimmed).then_some(trimmed.to_owned())
}

fn valid_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn normalize_name(value: &str) -> Result<String, SshProfileError> {
    let name = value.trim();
    if name.is_empty() {
        return Err(SshProfileError::bad_request("SSH profile name is required"));
    }
    Ok(name.chars().take(120).collect())
}

fn normalize_host(value: &str) -> Result<String, SshProfileError> {
    let host = normalize_optional_host(value)?;
    if host.is_empty() {
        return Err(SshProfileError::bad_request("SSH host is required"));
    }
    Ok(host)
}

fn normalize_optional_host(value: &str) -> Result<String, SshProfileError> {
    let host = value.trim();
    if host.is_empty() {
        return Ok(String::new());
    }
    if host.starts_with('-')
        || host.chars().any(char::is_control)
        || host.contains(char::is_whitespace)
    {
        return Err(SshProfileError::bad_request("invalid SSH host"));
    }
    Ok(host.to_owned())
}

fn normalize_optional_user(value: &str) -> Result<String, SshProfileError> {
    let user = value.trim();
    if user.is_empty() {
        return Ok(String::new());
    }
    if user.starts_with('-')
        || user.chars().any(char::is_control)
        || user.contains(char::is_whitespace)
        || user.contains('@')
    {
        return Err(SshProfileError::bad_request("invalid SSH username"));
    }
    Ok(user.to_owned())
}

fn normalize_ssh_target(value: &str) -> Result<String, SshProfileError> {
    let target = value.trim();
    if target.is_empty() {
        return Err(SshProfileError::bad_request("OpenSSH target is required"));
    }
    if target.starts_with('-')
        || target.chars().any(char::is_control)
        || target.contains(char::is_whitespace)
    {
        return Err(SshProfileError::bad_request("invalid OpenSSH target"));
    }
    Ok(target.to_owned())
}

fn normalize_port(port: Option<u16>) -> Option<u16> {
    port.filter(|port| *port > 0)
}

fn normalize_host_key_policy(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "yes" => "yes".to_owned(),
        "no" => "no".to_owned(),
        _ => "accept-new".to_owned(),
    }
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

fn ssh_key_dir() -> PathBuf {
    std::env::var_os(ENV_SSH_KEY_DIR)
        .map_or_else(|| PathBuf::from(DEFAULT_SSH_KEY_DIR), PathBuf::from)
}

fn device_ssh_config_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(ENV_SSH_CONFIG_FILE) {
        return Some(PathBuf::from(path));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".ssh/config"))
}

fn parse_ssh_config_hosts(contents: &str, source: &str) -> Vec<SshConfigHostView> {
    let mut hosts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current: Option<SshConfigBlock> = None;

    for line in contents.lines() {
        let words = split_ssh_config_words(strip_ssh_config_comment(line));
        let Some((keyword, values)) = words.split_first() else {
            continue;
        };
        match keyword.to_ascii_lowercase().as_str() {
            "host" => {
                flush_ssh_config_block(&mut hosts, &mut seen, current.take(), source);
                let aliases = values
                    .iter()
                    .filter(|alias| ssh_config_alias_is_selectable(alias))
                    .cloned()
                    .collect::<Vec<_>>();
                current = (!aliases.is_empty()).then_some(SshConfigBlock {
                    aliases,
                    host: String::new(),
                    username: String::new(),
                    port: None,
                });
            }
            "match" => {
                flush_ssh_config_block(&mut hosts, &mut seen, current.take(), source);
            }
            "hostname" => {
                if let Some(block) = current.as_mut()
                    && let Some(value) = values.first()
                    && ssh_config_value_is_safe(value)
                {
                    block.host.clone_from(value);
                }
            }
            "user" => {
                if let Some(block) = current.as_mut()
                    && let Some(value) = values.first()
                    && ssh_config_value_is_safe(value)
                {
                    block.username.clone_from(value);
                }
            }
            "port" => {
                if let Some(block) = current.as_mut() {
                    block.port = values
                        .first()
                        .and_then(|value| value.parse::<u16>().ok())
                        .filter(|port| *port > 0);
                }
            }
            _ => {}
        }
    }
    flush_ssh_config_block(&mut hosts, &mut seen, current, source);
    hosts
}

fn flush_ssh_config_block(
    hosts: &mut Vec<SshConfigHostView>,
    seen: &mut std::collections::HashSet<String>,
    block: Option<SshConfigBlock>,
    source: &str,
) {
    let Some(block) = block else {
        return;
    };
    for alias in block.aliases {
        if !seen.insert(alias.clone()) {
            continue;
        }
        hosts.push(SshConfigHostView {
            alias: alias.clone(),
            host: if block.host.is_empty() {
                alias
            } else {
                block.host.clone()
            },
            username: block.username.clone(),
            port: block.port,
            source: source.to_owned(),
        });
    }
}

#[derive(Debug)]
struct SshConfigBlock {
    aliases: Vec<String>,
    host: String,
    username: String,
    port: Option<u16>,
}

fn ssh_config_alias_is_selectable(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(['-', '!', '*'])
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || matches!(ch, '*' | '?' | '['))
}

fn ssh_config_value_is_safe(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
}

fn strip_ssh_config_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    for (index, ch) in line.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => return &line[..index],
            _ => {}
        }
    }
    line
}

fn split_ssh_config_words(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for ch in line.trim().chars() {
        if escaped {
            word.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if !in_single => escaped = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            ch if ch.is_whitespace() && !in_single && !in_double => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(ch),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

fn default_true() -> bool {
    true
}

fn connect_error_response(err: ConnectError) -> Response {
    let status = match err.code {
        ErrorCode::InvalidArgument => StatusCode::BAD_REQUEST,
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::FailedPrecondition => StatusCode::PRECONDITION_FAILED,
        ErrorCode::DeadlineExceeded => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    };
    (
        status,
        err.message
            .unwrap_or_else(|| "SSH backend request failed".to_owned()),
    )
        .into_response()
}

#[derive(Debug)]
struct SshProfileError {
    status: StatusCode,
    message: String,
}

impl SshProfileError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for SshProfileError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        SshProfileKind, is_ssh_selector, normalize_host_key_policy, parse_ssh_config_hosts,
        profile_id_from_selector, selector_for_profile_id, shell_quote,
    };

    #[test]
    fn parses_ssh_selector() {
        assert!(is_ssh_selector("demo@ssh"));
        assert_eq!(profile_id_from_selector("demo@ssh"), Some("demo"));
        assert_eq!(selector_for_profile_id("demo"), "demo@ssh");
        assert!(!is_ssh_selector("demo@owner"));
        assert!(!is_ssh_selector("-bad@ssh"));
    }

    #[test]
    fn normalizes_host_key_policy() {
        assert_eq!(normalize_host_key_policy("yes"), "yes");
        assert_eq!(normalize_host_key_policy("no"), "no");
        assert_eq!(normalize_host_key_policy(""), "accept-new");
    }

    #[test]
    fn serializes_profile_kind() {
        assert_eq!(
            serde_json::to_string(&SshProfileKind::ManagedKey).unwrap(),
            "\"managed-key\""
        );
        assert_eq!(
            serde_json::to_string(&SshProfileKind::DeviceOpenSsh).unwrap(),
            "\"device-openssh\""
        );
        assert_eq!(
            serde_json::from_str::<SshProfileKind>("\"device-openssh\"").unwrap(),
            SshProfileKind::DeviceOpenSsh
        );
    }

    #[test]
    fn quotes_remote_shell_script_as_single_argument() {
        assert_eq!(
            shell_quote("printf '%s' ok"),
            "'printf '\"'\"'%s'\"'\"' ok'"
        );
    }

    #[test]
    fn parses_selectable_openssh_config_hosts() {
        let hosts = parse_ssh_config_hosts(
            r#"
Host dev-box dev-short *.internal !blocked
  HostName 10.0.0.5
  User root
  Port 2222

Host *
  User ignored

Match host example.com
  User ignored

Host quoted
  HostName "example.org" # trailing comment

Host cert-box
  HostName cert.example.com
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  CertificateFile ~/.ssh/id_ed25519-cert.pub
"#,
            "/home/user/.ssh/config",
        );

        assert_eq!(hosts.len(), 4);
        assert_eq!(hosts[0].alias, "dev-box");
        assert_eq!(hosts[0].host, "10.0.0.5");
        assert_eq!(hosts[0].username, "root");
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[1].alias, "dev-short");
        assert_eq!(hosts[2].alias, "quoted");
        assert_eq!(hosts[2].host, "example.org");
        assert_eq!(hosts[3].alias, "cert-box");
        assert_eq!(hosts[3].host, "cert.example.com");
        assert_eq!(hosts[3].username, "deploy");
    }
}
