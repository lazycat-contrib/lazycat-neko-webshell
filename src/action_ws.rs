use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tracing::warn;

use crate::database::{KV_KEY_SETTINGS, KV_NAMESPACE_PREFERENCES};
use crate::service::CapabilityServiceImpl;
use crate::state::AppState;

type ActionSender = Arc<Mutex<SplitSink<WebSocket, Message>>>;
type ActionReceiver = SplitStream<WebSocket>;

const MAX_TRANSFER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ActionMessage {
    id: String,
    #[serde(rename = "type")]
    message_type: String,
    action: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
struct ActionResponse {
    id: String,
    #[serde(rename = "type")]
    response_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<Value>,
}

#[derive(Debug)]
struct UploadState {
    session_id: String,
    remote_path: String,
    name: String,
    size: usize,
    received: usize,
    data: Vec<u8>,
}

#[derive(Debug, Default, Deserialize)]
struct AiSettings {
    #[serde(rename = "aiBaseUrl", default)]
    base_url: String,
    #[serde(rename = "aiApiKey", default)]
    api_key: String,
    #[serde(rename = "aiModel", default)]
    model: String,
}

pub async fn action_ws(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "invalid websocket origin").into_response();
    }

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_action_socket(socket, state).await {
            warn!(error = %err, "action websocket ended with error");
        }
    })
}

async fn handle_action_socket(socket: WebSocket, state: Arc<AppState>) -> anyhow::Result<()> {
    let (sender, receiver) = socket.split();
    let sender = Arc::new(Mutex::new(sender));
    serve_action_socket(sender, receiver, state).await;
    Ok(())
}

async fn serve_action_socket(
    sender: ActionSender,
    mut receiver: ActionReceiver,
    state: Arc<AppState>,
) {
    let mut uploads = HashMap::<String, UploadState>::new();
    while let Some(message) = receiver.next().await {
        let Ok(message) = message else {
            break;
        };
        match message {
            Message::Text(text) => {
                let parsed = serde_json::from_str::<ActionMessage>(&text);
                let Ok(message) = parsed else {
                    continue;
                };
                match message.message_type.as_str() {
                    "ping" => {
                        let _ = send_done(&sender, &message.id, json!({ "pong": true })).await;
                    }
                    "transfer" => {
                        let message_id = message.id.clone();
                        if let Err(err) =
                            handle_transfer(&sender, Arc::clone(&state), &mut uploads, message)
                                .await
                        {
                            warn!(error = %err, "transfer websocket action failed");
                            let _ = send_error(&sender, &message_id, &err.to_string()).await;
                        }
                    }
                    "ai" => {
                        let message_id = message.id.clone();
                        let sender = Arc::clone(&sender);
                        let state = Arc::clone(&state);
                        tokio::spawn(async move {
                            if let Err(err) = handle_ai(&sender, state, message).await {
                                warn!(error = %err, "ai websocket action failed");
                                let _ = send_error(&sender, &message_id, &err.to_string()).await;
                            }
                        });
                    }
                    _ => {
                        let _ = send_error(&sender, &message.id, "unsupported message type").await;
                    }
                }
            }
            Message::Ping(payload) => {
                let _ = sender.lock().await.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

async fn handle_transfer(
    sender: &ActionSender,
    state: Arc<AppState>,
    uploads: &mut HashMap<String, UploadState>,
    message: ActionMessage,
) -> anyhow::Result<()> {
    ensure_plugin_enabled(&state, "file-transfer")?;
    match message.action.as_str() {
        "upload_start" => handle_upload_start(sender, uploads, &message).await?,
        "upload_chunk" => {
            handle_upload_chunk(sender, state, uploads, &message).await?;
        }
        "download" | "list" | "read" | "stat" => {
            handle_transfer_operation(sender, state, &message).await?;
        }
        _ => {
            send_error(sender, &message.id, "unsupported transfer action").await?;
        }
    }
    Ok(())
}

async fn handle_upload_start(
    sender: &ActionSender,
    uploads: &mut HashMap<String, UploadState>,
    message: &ActionMessage,
) -> anyhow::Result<()> {
    let name = payload_string(&message.payload, "name")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "upload".to_owned());
    let session_id = required_payload_string(&message.payload, "sessionId")?;
    let remote_path = required_payload_string(&message.payload, "remotePath")?;
    let size = payload_u64(&message.payload, "size")
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0);
    if size > MAX_TRANSFER_BYTES {
        send_error(
            sender,
            &message.id,
            "file size is outside the supported transfer limit",
        )
        .await?;
        return Ok(());
    }
    uploads.insert(
        message.id.clone(),
        UploadState {
            session_id,
            remote_path,
            name: name.clone(),
            size,
            received: 0,
            data: Vec::with_capacity(size),
        },
    );
    send_transfer_progress(
        sender,
        &message.id,
        json!({ "name": name, "percent": 0, "done": false }),
    )
    .await
}

async fn handle_upload_chunk(
    sender: &ActionSender,
    state: Arc<AppState>,
    uploads: &mut HashMap<String, UploadState>,
    message: &ActionMessage,
) -> anyhow::Result<()> {
    let Some(upload) = uploads.get_mut(&message.id) else {
        send_error(sender, &message.id, "upload is not initialized").await?;
        return Ok(());
    };
    let offset = payload_u64(&message.payload, "offset")
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(usize::MAX);
    if offset != upload.received {
        send_error(sender, &message.id, "upload chunk offset mismatch").await?;
        uploads.remove(&message.id);
        return Ok(());
    }
    let data = required_payload_string(&message.payload, "data")?;
    let chunk = BASE64
        .decode(data)
        .map_err(|err| anyhow::anyhow!("invalid upload chunk: {err}"))?;
    if upload.received + chunk.len() > upload.size
        || upload.received + chunk.len() > MAX_TRANSFER_BYTES
    {
        send_error(sender, &message.id, "upload exceeds declared file size").await?;
        uploads.remove(&message.id);
        return Ok(());
    }
    upload.data.extend_from_slice(&chunk);
    upload.received += chunk.len();
    send_transfer_progress(
        sender,
        &message.id,
        json!({ "name": upload.name, "percent": transfer_percent(upload.received, upload.size), "done": false }),
    )
    .await?;
    if payload_bool(&message.payload, "final") {
        finish_upload(sender, state, uploads, message).await?;
    }
    Ok(())
}

async fn finish_upload(
    sender: &ActionSender,
    state: Arc<AppState>,
    uploads: &mut HashMap<String, UploadState>,
    message: &ActionMessage,
) -> anyhow::Result<()> {
    let upload = uploads.remove(&message.id).expect("upload exists");
    if upload.received != upload.size {
        send_error(sender, &message.id, "upload ended before declared size").await?;
        return Ok(());
    }
    let service = CapabilityServiceImpl::new(Arc::clone(&state));
    let response = service
        .invoke_plugin_runtime(
            "file-transfer",
            &upload.session_id,
            "upload",
            "application/octet-stream",
            upload.data,
            HashMap::from([("path".to_owned(), upload.remote_path.clone())]),
        )
        .await
        .map_err(|err| anyhow::anyhow!(err.to_string()))?
        .body;
    send_transfer_progress(
        sender,
        &message.id,
        json!({ "name": upload.name, "percent": 100, "done": true }),
    )
    .await?;
    send_done(
        sender,
        &message.id,
        json!({
            "status": response.status.unwrap_or_default(),
            "contentType": response.content_type.unwrap_or_default(),
            "content": String::from_utf8_lossy(response.payload.as_deref().unwrap_or(&[])),
        }),
    )
    .await
}

async fn handle_transfer_operation(
    sender: &ActionSender,
    state: Arc<AppState>,
    message: &ActionMessage,
) -> anyhow::Result<()> {
    let session_id = required_payload_string(&message.payload, "sessionId")?;
    let path = required_payload_string(&message.payload, "path")?;
    let service = CapabilityServiceImpl::new(Arc::clone(&state));
    let response = service
        .invoke_plugin_runtime(
            "file-transfer",
            &session_id,
            &message.action,
            transfer_content_type(&message.action),
            Vec::new(),
            HashMap::from([("path".to_owned(), path.clone())]),
        )
        .await
        .map_err(|err| anyhow::anyhow!(err.to_string()))?
        .body;
    if message.action == "download" {
        send_transfer_progress(
            sender,
            &message.id,
            json!({ "name": file_name_from_path(&path), "percent": 100, "done": true }),
        )
        .await?;
        send_done(
            sender,
            &message.id,
            json!({
                "name": file_name_from_path(&path),
                "contentType": response.content_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
                "data": BASE64.encode(response.payload.unwrap_or_default()),
            }),
        )
        .await?;
    } else {
        send_stream(
            sender,
            &message.id,
            String::from_utf8_lossy(response.payload.as_deref().unwrap_or(&[])).as_ref(),
        )
        .await?;
        send_done(
            sender,
            &message.id,
            json!({ "status": response.status.unwrap_or_default() }),
        )
        .await?;
    }
    Ok(())
}

fn transfer_content_type(action: &str) -> &'static str {
    if action == "download" {
        "application/octet-stream"
    } else {
        "text/plain"
    }
}

async fn handle_ai(
    sender: &ActionSender,
    state: Arc<AppState>,
    message: ActionMessage,
) -> anyhow::Result<()> {
    ensure_plugin_enabled(&state, "ai-chat")?;
    let settings = load_ai_settings(&state)?;
    if settings.base_url.trim().is_empty() || settings.api_key.trim().is_empty() {
        send_error(
            sender,
            &message.id,
            "AI access is not configured. Set Base URL and API key first.",
        )
        .await?;
        return Ok(());
    }
    match message.action.as_str() {
        "models" | "list_models" => {
            let models = fetch_openai_models(&settings).await?;
            let count = models.len();
            send_done(
                sender,
                &message.id,
                json!({ "models": models, "count": count }),
            )
            .await?;
            return Ok(());
        }
        "test" => {
            test_openai_compatible(sender, &message.id, &settings).await?;
            return Ok(());
        }
        _ => {}
    }
    if settings.model.trim().is_empty() {
        send_error(
            sender,
            &message.id,
            "AI model is not configured. Fetch or enter a model first.",
        )
        .await?;
        return Ok(());
    }
    let prompt = build_prompt(&message.action, &message.payload);
    stream_openai_compatible(sender, &message.id, &settings, &redact_sensitive(&prompt)).await
}

async fn fetch_openai_models(settings: &AiSettings) -> anyhow::Result<Vec<String>> {
    let response = reqwest::Client::new()
        .get(models_endpoint(&settings.base_url))
        .bearer_auth(settings.api_key.trim())
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "model list request failed ({status}): {}",
            truncate_detail(&detail)
        ));
    }
    let value = response.json::<Value>().await?;
    let mut models = parse_openai_model_ids(&value);
    models.sort();
    models.dedup();
    Ok(models)
}

async fn test_openai_compatible(
    sender: &ActionSender,
    id: &str,
    settings: &AiSettings,
) -> anyhow::Result<()> {
    if settings.model.trim().is_empty() {
        let models = fetch_openai_models(settings).await?;
        let count = models.len();
        send_done(
            sender,
            id,
            json!({
                "ok": true,
                "mode": "models",
                "message": format!("model endpoint ok, {count} model(s) returned"),
                "models": models,
                "count": count,
            }),
        )
        .await?;
        return Ok(());
    }

    let endpoint = chat_completions_endpoint(&settings.base_url);
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(settings.api_key.trim())
        .json(&json!({
            "model": settings.model.trim(),
            "stream": false,
            "temperature": 0,
            "max_tokens": 8,
            "messages": [
                { "role": "user", "content": "Reply with OK." }
            ]
        }))
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        send_error(
            sender,
            id,
            &format!("AI test failed ({status}): {}", truncate_detail(&detail)),
        )
        .await?;
        return Ok(());
    }
    let value = response.json::<Value>().await?;
    send_done(
        sender,
        id,
        json!({
            "ok": true,
            "mode": "chat",
            "model": settings.model.trim(),
            "content": parse_openai_message_content(&value),
            "message": "AI test passed",
        }),
    )
    .await?;
    Ok(())
}

async fn stream_openai_compatible(
    sender: &ActionSender,
    id: &str,
    settings: &AiSettings,
    prompt: &str,
) -> anyhow::Result<()> {
    let endpoint = chat_completions_endpoint(&settings.base_url);
    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .bearer_auth(settings.api_key.trim())
        .json(&json!({
            "model": settings.model.trim(),
            "stream": true,
            "messages": [
                { "role": "system", "content": core_ai_system_prompt() },
                { "role": "user", "content": prompt }
            ]
        }))
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        send_error(
            sender,
            id,
            &format!("AI request failed ({status}): {detail}"),
        )
        .await?;
        return Ok(());
    }
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].trim().to_owned();
            buffer = buffer[index + 1..].to_owned();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data == "[DONE]" {
                    send_done(sender, id, json!({})).await?;
                    return Ok(());
                }
                if let Some(delta) = parse_openai_delta(data) {
                    send_stream(sender, id, &delta).await?;
                }
            }
        }
    }
    send_done(sender, id, json!({})).await?;
    Ok(())
}

fn parse_openai_delta(data: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(data).ok()?;
    value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn parse_openai_message_content(value: &Value) -> String {
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn parse_openai_model_ids(value: &Value) -> Vec<String> {
    let mut models = Vec::new();
    collect_model_ids(value, &mut models);
    models
}

fn collect_model_ids(value: &Value, models: &mut Vec<String>) {
    if let Some(model) = model_id_from_value(value) {
        models.push(model.to_owned());
    }
    if let Some(items) = value.as_array() {
        collect_model_array(items, models);
        return;
    }
    let Some(object) = value.as_object() else {
        return;
    };
    for key in ["data", "models", "available_models", "availableModels"] {
        let Some(child) = object.get(key) else {
            continue;
        };
        if let Some(items) = child.as_array() {
            collect_model_array(items, models);
        } else {
            collect_model_ids(child, models);
        }
    }
}

fn collect_model_array(items: &[Value], models: &mut Vec<String>) {
    for item in items {
        if let Some(model) = model_id_from_value(item) {
            models.push(model.to_owned());
        } else {
            collect_model_ids(item, models);
        }
    }
}

fn model_id_from_value(value: &Value) -> Option<&str> {
    let raw = value.as_str().or_else(|| {
        let object = value.as_object()?;
        ["id", "name", "model"]
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str))
    })?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn build_prompt(action: &str, payload: &Value) -> String {
    let ctx = payload.get("ctx").unwrap_or(&Value::Null);
    let cwd = json_string(ctx, "cwd", "~");
    let shell = json_string(ctx, "shell", "sh");
    let os = json_string(ctx, "os", "LightOS");
    let recent_output = json_string(ctx, "recent_output", "");
    let conversation = payload
        .get("conversation")
        .map_or_else(String::new, Value::to_string);
    match action {
        "chat" => format!(
            "你是 WebShell 内的 Chat 工具，不控制终端，也不会替用户执行命令。\n当前上下文：{cwd} | {shell} | {os}\n最近终端输出（可能为空，已脱敏）：\n{recent_output}\n\n当前模型会话历史（JSON，可能为空）：\n{conversation}\n\n用户：{}\n\n要求：\n- 简洁回答，优先给可执行建议。\n- 需要命令时用 ```shell 代码块，但不要声称已经执行。\n- 对删除、覆盖、sudo、系统路径写入等风险操作明确提醒。\n- 不要把终端输出逐行复述。",
            json_string(payload, "input", "")
        ),
        _ => format!("用户：{}", json_string(payload, "input", "")),
    }
}

fn core_ai_system_prompt() -> &'static str {
    "你是 WebShell 内的聊天助手。你可以利用用户显式允许的终端上下文回答问题，但你不能控制终端、不能执行命令、不能假装已经操作设备。"
}

fn redact_sensitive(input: &str) -> String {
    input
        .lines()
        .map(redact_sensitive_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_sensitive_line(line: &str) -> String {
    if line.contains("-----BEGIN") || line.contains("PRIVATE KEY-----") {
        return "[REDACTED private key material]".to_owned();
    }
    line.split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            if part.starts_with("sk-")
                || part.starts_with("ghp_")
                || part.starts_with("github_pat_")
                || part.starts_with("eyJ")
                || lower.starts_with("passwd=")
                || lower.starts_with("password=")
                || lower.starts_with("token=")
                || lower.starts_with("api_key=")
                || lower.starts_with("--password=")
                || lower == "-p"
                || lower.starts_with("-p=")
            {
                "[REDACTED]".to_owned()
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn load_ai_settings(state: &AppState) -> anyhow::Result<AiSettings> {
    let Some(bytes) = state
        .database()
        .load_kv(KV_NAMESPACE_PREFERENCES, KV_KEY_SETTINGS)?
    else {
        return Ok(AiSettings::default());
    };
    Ok(serde_json::from_slice(&bytes)?)
}

fn ensure_plugin_enabled(state: &AppState, plugin_id: &str) -> anyhow::Result<()> {
    let plugins = state
        .plugins
        .read()
        .map_err(|_| anyhow::anyhow!("plugin store lock poisoned"))?;
    let plugin = plugins
        .get(plugin_id)
        .ok_or_else(|| anyhow::anyhow!("plugin is not registered: {plugin_id}"))?;
    if plugin.enabled {
        Ok(())
    } else {
        Err(anyhow::anyhow!("plugin is disabled: {plugin_id}"))
    }
}

async fn send_stream(sender: &ActionSender, id: &str, content: &str) -> anyhow::Result<()> {
    send_response(
        sender,
        ActionResponse {
            id: id.to_owned(),
            response_type: "stream".to_owned(),
            content: Some(content.to_owned()),
            meta: None,
        },
    )
    .await
}

async fn send_done(sender: &ActionSender, id: &str, meta: Value) -> anyhow::Result<()> {
    send_response(
        sender,
        ActionResponse {
            id: id.to_owned(),
            response_type: "done".to_owned(),
            content: None,
            meta: Some(meta),
        },
    )
    .await
}

async fn send_error(sender: &ActionSender, id: &str, message: &str) -> anyhow::Result<()> {
    send_response(
        sender,
        ActionResponse {
            id: id.to_owned(),
            response_type: "error".to_owned(),
            content: Some(message.to_owned()),
            meta: None,
        },
    )
    .await
}

async fn send_transfer_progress(
    sender: &ActionSender,
    id: &str,
    meta: Value,
) -> anyhow::Result<()> {
    send_response(
        sender,
        ActionResponse {
            id: id.to_owned(),
            response_type: "transfer_progress".to_owned(),
            content: None,
            meta: Some(meta),
        },
    )
    .await
}

async fn send_response(sender: &ActionSender, response: ActionResponse) -> anyhow::Result<()> {
    let text = serde_json::to_string(&response)?;
    sender.lock().await.send(Message::Text(text.into())).await?;
    Ok(())
}

fn payload_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)?
        .as_str()
        .map(str::trim)
        .map(ToOwned::to_owned)
}

fn required_payload_string(payload: &Value, key: &str) -> anyhow::Result<String> {
    payload_string(payload, key)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("payload.{key} is required"))
}

fn payload_u64(payload: &Value, key: &str) -> Option<u64> {
    payload.get(key)?.as_u64()
}

fn payload_bool(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn json_string(payload: &Value, key: &str, fallback: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map_or_else(|| fallback.to_owned(), ToOwned::to_owned)
}

fn transfer_percent(received: usize, total: usize) -> u8 {
    if total == 0 {
        return 0;
    }
    u8::try_from(((received.saturating_mul(100)) / total).min(100)).unwrap_or(100)
}

fn file_name_from_path(path: &str) -> &str {
    path.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("download")
}

fn chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_owned()
    } else if let Some(prefix) = trimmed.strip_suffix("/models") {
        format!("{prefix}/chat/completions")
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn models_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/models") {
        return trimmed.to_owned();
    }
    if let Some(prefix) = trimmed.strip_suffix("/chat/completions") {
        return format!("{prefix}/models");
    }
    format!("{trimmed}/models")
}

fn truncate_detail(detail: &str) -> String {
    const MAX_DETAIL_CHARS: usize = 500;
    let trimmed = detail.trim();
    if trimmed.chars().count() <= MAX_DETAIL_CHARS {
        trimmed.to_owned()
    } else {
        format!(
            "{}...",
            trimmed.chars().take(MAX_DETAIL_CHARS).collect::<String>()
        )
    }
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };
    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    origin
        .parse::<Uri>()
        .ok()
        .and_then(|uri| uri.authority().map(|authority| authority.as_str() == host))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::parse_openai_model_ids;
    use serde_json::json;

    #[test]
    fn parses_openai_and_anthropic_model_lists() {
        assert_eq!(
            parse_openai_model_ids(&json!({
                "data": [
                    { "id": "gpt-4.1" },
                    { "id": " claude-3-5-sonnet-20241022 " }
                ]
            })),
            vec!["gpt-4.1", "claude-3-5-sonnet-20241022"]
        );

        assert_eq!(
            parse_openai_model_ids(&json!({
                "models": [
                    "claude-opus-4-20250514",
                    { "name": "claude-sonnet-4-20250514" }
                ]
            })),
            vec!["claude-opus-4-20250514", "claude-sonnet-4-20250514"]
        );
    }

    #[test]
    fn parses_string_and_model_object_arrays() {
        assert_eq!(
            parse_openai_model_ids(&json!([
                "deepseek-chat",
                { "model": "qwen-max" },
                { "id": "" }
            ])),
            vec!["deepseek-chat", "qwen-max"]
        );
    }
}
