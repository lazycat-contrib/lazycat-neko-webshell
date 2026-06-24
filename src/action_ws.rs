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

use crate::ai_chat::{
    ai_access_configured, ai_model_configured, fetch_ai_models, load_ai_settings, stream_ai_chat,
    test_ai_access,
};
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
    if !ai_access_configured(&settings) {
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
            let models = fetch_ai_models(&settings).await?;
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
            send_done(sender, &message.id, test_ai_access(&settings).await?).await?;
            return Ok(());
        }
        _ => {}
    }
    if !ai_model_configured(&settings) {
        send_error(
            sender,
            &message.id,
            "AI model is not configured. Fetch or enter a model first.",
        )
        .await?;
        return Ok(());
    }
    let id = message.id.clone();
    stream_ai_chat(&settings, &message.action, &message.payload, |chunk| {
        let sender = Arc::clone(sender);
        let id = id.clone();
        async move { send_stream(&sender, &id, &chunk).await }
    })
    .await?;
    send_done(sender, &message.id, json!({})).await
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
