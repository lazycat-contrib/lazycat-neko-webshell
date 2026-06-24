use std::collections::HashMap;
use std::future::Future;

use anyhow::{Context, anyhow};
use futures::{StreamExt, stream::BoxStream};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::database::{KV_KEY_SETTINGS, KV_NAMESPACE_PREFERENCES};
use crate::state::AppState;

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOOL_LOOPS: usize = 4;
const MAX_MCP_SERVERS: usize = 8;
const MAX_MCP_TOOL_RESULT_CHARS: usize = 20_000;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct AiSettings {
    #[serde(rename = "aiProvider", default)]
    provider: String,
    #[serde(rename = "aiBaseUrl", default)]
    base_url: String,
    #[serde(rename = "aiApiKey", default)]
    api_key: String,
    #[serde(rename = "aiModel", default)]
    model: String,
    #[serde(rename = "aiMcpServers", default)]
    mcp_servers: String,
}

#[derive(Clone, Debug, Deserialize)]
struct McpServerConfig {
    #[serde(default)]
    name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    transport: String,
    #[serde(default)]
    authorization: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Clone, Debug)]
struct McpTool {
    server_index: usize,
    external_name: String,
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Clone, Debug, Default)]
struct McpToolCatalog {
    servers: Vec<McpServerConfig>,
    tools: Vec<McpTool>,
}

#[derive(Clone, Debug)]
struct ToolCall {
    external_name: String,
    call_id: String,
    arguments: Value,
}

#[derive(Debug)]
struct StreamResult {
    tool_calls: Vec<ToolCall>,
    response_items: Vec<Value>,
}

#[derive(Debug)]
struct SseEvent {
    event: String,
    data: String,
}

pub fn load_ai_settings(state: &AppState) -> anyhow::Result<AiSettings> {
    let Some(bytes) = state
        .database()
        .load_kv(KV_NAMESPACE_PREFERENCES, KV_KEY_SETTINGS)?
    else {
        return Ok(AiSettings::default());
    };
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn ai_access_configured(settings: &AiSettings) -> bool {
    !settings.base_url.trim().is_empty() && !settings.api_key.trim().is_empty()
}

pub fn ai_model_configured(settings: &AiSettings) -> bool {
    !settings.model.trim().is_empty()
}

pub async fn fetch_ai_models(settings: &AiSettings) -> anyhow::Result<Vec<String>> {
    let response = match provider(settings) {
        AiProvider::Anthropic => {
            anthropic_request(
                settings,
                reqwest::Client::new().get(models_endpoint(&settings.base_url)),
            )
            .send()
            .await?
        }
        AiProvider::OpenAiChat | AiProvider::OpenAiResponses => {
            reqwest::Client::new()
                .get(models_endpoint(&settings.base_url))
                .bearer_auth(settings.api_key.trim())
                .send()
                .await?
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "model list request failed ({status}): {}",
            truncate_detail(&detail)
        ));
    }
    let value = response.json::<Value>().await?;
    let mut models = parse_model_ids(&value);
    models.sort();
    models.dedup();
    Ok(models)
}

pub async fn test_ai_access(settings: &AiSettings) -> anyhow::Result<Value> {
    if !ai_model_configured(settings) {
        let models = fetch_ai_models(settings).await?;
        let count = models.len();
        return Ok(json!({
            "ok": true,
            "mode": "models",
            "message": format!("model endpoint ok, {count} model(s) returned"),
            "models": models,
            "count": count,
        }));
    }

    match provider(settings) {
        AiProvider::OpenAiChat => test_openai_chat(settings).await,
        AiProvider::OpenAiResponses => test_openai_responses(settings).await,
        AiProvider::Anthropic => test_anthropic(settings).await,
    }
}

pub async fn stream_ai_chat<F, Fut>(
    settings: &AiSettings,
    action: &str,
    payload: &Value,
    emit: F,
) -> anyhow::Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let prompt = redact_sensitive(&build_prompt(action, payload));
    match provider(settings) {
        AiProvider::OpenAiChat => stream_openai_chat_with_tools(settings, &prompt, emit).await,
        AiProvider::OpenAiResponses => {
            stream_openai_responses_with_tools(settings, &prompt, emit).await
        }
        AiProvider::Anthropic => stream_anthropic_with_tools(settings, &prompt, emit).await,
    }
}

async fn test_openai_chat(settings: &AiSettings) -> anyhow::Result<Value> {
    let response = reqwest::Client::new()
        .post(chat_completions_endpoint(&settings.base_url))
        .bearer_auth(settings.api_key.trim())
        .json(&json!({
            "model": settings.model.trim(),
            "stream": false,
            "temperature": 0,
            "max_tokens": 8,
            "messages": [{ "role": "user", "content": "Reply with OK." }]
        }))
        .send()
        .await?;
    parse_test_response(settings, response, parse_openai_chat_message_content).await
}

async fn test_openai_responses(settings: &AiSettings) -> anyhow::Result<Value> {
    let response = reqwest::Client::new()
        .post(responses_endpoint(&settings.base_url))
        .bearer_auth(settings.api_key.trim())
        .json(&json!({
            "model": settings.model.trim(),
            "stream": false,
            "temperature": 0,
            "max_output_tokens": 16,
            "input": "Reply with OK."
        }))
        .send()
        .await?;
    parse_test_response(settings, response, parse_openai_response_text).await
}

async fn test_anthropic(settings: &AiSettings) -> anyhow::Result<Value> {
    let response = anthropic_request(
        settings,
        reqwest::Client::new().post(messages_endpoint(&settings.base_url)),
    )
    .json(&json!({
        "model": settings.model.trim(),
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "Reply with OK." }]
    }))
    .send()
    .await?;
    parse_test_response(settings, response, parse_anthropic_message_text).await
}

async fn parse_test_response(
    settings: &AiSettings,
    response: reqwest::Response,
    parse_content: fn(&Value) -> String,
) -> anyhow::Result<Value> {
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "AI test failed ({status}): {}",
            truncate_detail(&detail)
        ));
    }
    let value = response.json::<Value>().await?;
    Ok(json!({
        "ok": true,
        "mode": "chat",
        "model": settings.model.trim(),
        "content": parse_content(&value),
        "message": "AI test passed",
    }))
}

async fn stream_openai_chat_with_tools<F, Fut>(
    settings: &AiSettings,
    prompt: &str,
    mut emit: F,
) -> anyhow::Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let catalog = discover_mcp_tools(settings).await?;
    let mut messages = vec![
        json!({ "role": "system", "content": core_ai_system_prompt() }),
        json!({ "role": "user", "content": prompt }),
    ];
    for _ in 0..MAX_TOOL_LOOPS {
        let result =
            stream_openai_chat_once(settings, &catalog, &messages, |chunk| emit(chunk)).await?;
        if result.tool_calls.is_empty() {
            return Ok(());
        }
        messages.push(openai_chat_tool_call_message(&result.tool_calls));
        for call in result.tool_calls {
            let output = call_mcp_tool(&catalog, &call.external_name, call.arguments).await?;
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call.call_id,
                "content": output,
            }));
        }
    }
    Err(anyhow!("AI tool loop exceeded {MAX_TOOL_LOOPS} rounds"))
}

async fn stream_openai_chat_once<F, Fut>(
    settings: &AiSettings,
    catalog: &McpToolCatalog,
    messages: &[Value],
    mut emit: F,
) -> anyhow::Result<StreamResult>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let mut body = json!({
        "model": settings.model.trim(),
        "stream": true,
        "messages": messages,
    });
    if !catalog.tools.is_empty() {
        body["tools"] = Value::Array(catalog.tools.iter().map(openai_chat_tool).collect());
    }
    let response = reqwest::Client::new()
        .post(chat_completions_endpoint(&settings.base_url))
        .bearer_auth(settings.api_key.trim())
        .json(&body)
        .send()
        .await?;
    let mut stream = ensure_success(response, "AI request").await?;
    let mut result = OpenAiChatStreamState::default();
    while let Some(event) = stream.next().await? {
        if event.data.trim() == "[DONE]" {
            break;
        }
        if let Some(delta) = parse_openai_chat_delta(&event.data) {
            emit(delta).await?;
        }
        result.ingest(&event);
    }
    Ok(result.finish())
}

async fn stream_openai_responses_with_tools<F, Fut>(
    settings: &AiSettings,
    prompt: &str,
    mut emit: F,
) -> anyhow::Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let catalog = discover_mcp_tools(settings).await?;
    let mut input = vec![
        json!({ "role": "system", "content": core_ai_system_prompt() }),
        json!({ "role": "user", "content": prompt }),
    ];
    for _ in 0..MAX_TOOL_LOOPS {
        let result =
            stream_openai_responses_once(settings, &catalog, &input, |chunk| emit(chunk)).await?;
        if result.tool_calls.is_empty() {
            return Ok(());
        }
        for item in result.response_items {
            input.push(item);
        }
        for call in result.tool_calls {
            let output = call_mcp_tool(&catalog, &call.external_name, call.arguments).await?;
            input.push(json!({
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": output,
            }));
        }
    }
    Err(anyhow!("AI tool loop exceeded {MAX_TOOL_LOOPS} rounds"))
}

async fn stream_openai_responses_once<F, Fut>(
    settings: &AiSettings,
    catalog: &McpToolCatalog,
    input: &[Value],
    mut emit: F,
) -> anyhow::Result<StreamResult>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let mut body = json!({
        "model": settings.model.trim(),
        "stream": true,
        "input": input,
    });
    if !catalog.tools.is_empty() {
        body["tools"] = Value::Array(catalog.tools.iter().map(openai_response_tool).collect());
    }
    let response = reqwest::Client::new()
        .post(responses_endpoint(&settings.base_url))
        .bearer_auth(settings.api_key.trim())
        .json(&body)
        .send()
        .await?;
    let mut stream = ensure_success(response, "AI request").await?;
    let mut result = OpenAiResponsesStreamState::default();
    while let Some(event) = stream.next().await? {
        if let Some(delta) = parse_openai_response_text_delta(&event) {
            emit(delta).await?;
        }
        result.ingest(&event);
    }
    Ok(result.finish())
}

async fn stream_anthropic_with_tools<F, Fut>(
    settings: &AiSettings,
    prompt: &str,
    mut emit: F,
) -> anyhow::Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let catalog = discover_mcp_tools(settings).await?;
    let mut messages = vec![json!({ "role": "user", "content": prompt })];
    for _ in 0..MAX_TOOL_LOOPS {
        let result =
            stream_anthropic_once(settings, &catalog, &messages, |chunk| emit(chunk)).await?;
        if result.tool_calls.is_empty() {
            return Ok(());
        }
        let assistant_blocks = result
            .tool_calls
            .iter()
            .map(|call| {
                json!({
                    "type": "tool_use",
                    "id": call.call_id,
                    "name": call.external_name,
                    "input": call.arguments,
                })
            })
            .collect::<Vec<_>>();
        messages.push(json!({ "role": "assistant", "content": assistant_blocks }));
        let mut result_blocks = Vec::new();
        for call in result.tool_calls {
            let output = call_mcp_tool(&catalog, &call.external_name, call.arguments).await?;
            result_blocks.push(json!({
                "type": "tool_result",
                "tool_use_id": call.call_id,
                "content": output,
            }));
        }
        messages.push(json!({ "role": "user", "content": result_blocks }));
    }
    Err(anyhow!("AI tool loop exceeded {MAX_TOOL_LOOPS} rounds"))
}

async fn stream_anthropic_once<F, Fut>(
    settings: &AiSettings,
    catalog: &McpToolCatalog,
    messages: &[Value],
    mut emit: F,
) -> anyhow::Result<StreamResult>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let mut body = json!({
        "model": settings.model.trim(),
        "max_tokens": 4096,
        "stream": true,
        "system": core_ai_system_prompt(),
        "messages": messages,
    });
    if !catalog.tools.is_empty() {
        body["tools"] = Value::Array(catalog.tools.iter().map(anthropic_tool).collect());
    }
    let response = anthropic_request(
        settings,
        reqwest::Client::new().post(messages_endpoint(&settings.base_url)),
    )
    .json(&body)
    .send()
    .await?;
    let mut stream = ensure_success(response, "AI request").await?;
    let mut result = AnthropicStreamState::default();
    while let Some(event) = stream.next().await? {
        if let Some(delta) = parse_anthropic_text_delta(&event) {
            emit(delta).await?;
        }
        result.ingest(&event);
    }
    Ok(result.finish())
}

#[derive(Default)]
struct OpenAiChatStreamState {
    calls: HashMap<u64, OpenAiChatToolCallDelta>,
}

#[derive(Default)]
struct OpenAiChatToolCallDelta {
    id: String,
    name: String,
    arguments: String,
}

impl OpenAiChatStreamState {
    fn ingest(&mut self, event: &SseEvent) {
        let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
            return;
        };
        let Some(tool_calls) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("tool_calls"))
            .and_then(Value::as_array)
        else {
            return;
        };
        for item in tool_calls {
            let index = item.get("index").and_then(Value::as_u64).unwrap_or(0);
            let call = self.calls.entry(index).or_default();
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                call.id = id.to_owned();
            }
            if let Some(function) = item.get("function") {
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    call.name = name.to_owned();
                }
                if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                    call.arguments.push_str(arguments);
                }
            }
        }
    }

    fn finish(self) -> StreamResult {
        StreamResult {
            tool_calls: self
                .calls
                .into_values()
                .filter_map(|call| {
                    if call.id.is_empty() || call.name.is_empty() {
                        return None;
                    }
                    Some(ToolCall {
                        external_name: call.name,
                        call_id: call.id,
                        arguments: parse_json_object(&call.arguments).unwrap_or_else(|| json!({})),
                    })
                })
                .collect(),
            response_items: Vec::new(),
        }
    }
}

#[derive(Default)]
struct OpenAiResponsesStreamState {
    calls: HashMap<String, ToolCall>,
    call_ids_by_item_id: HashMap<String, String>,
    output_items: Vec<Value>,
}

impl OpenAiResponsesStreamState {
    fn ingest(&mut self, event: &SseEvent) {
        let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
            return;
        };
        if let Some(item) = value
            .get("item")
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        {
            let call = tool_call_from_openai_item(item);
            if let Some(call) = call {
                if let Some(item_id) = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    self.call_ids_by_item_id
                        .insert(item_id.to_owned(), call.call_id.clone());
                }
                self.calls.insert(call.call_id.clone(), call);
                self.output_items.push(item.clone());
            }
            return;
        }
        if event_type(&value, event) == "response.function_call_arguments.done" {
            let call_key = value
                .get("call_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| {
                    value
                        .get("item_id")
                        .and_then(Value::as_str)
                        .and_then(|item_id| self.call_ids_by_item_id.get(item_id).cloned())
                });
            let arguments = value
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(parse_json_object)
                .unwrap_or_else(|| json!({}));
            if let Some(call_key) = call_key {
                if let Some(call) = self.calls.get_mut(&call_key) {
                    call.arguments = arguments.clone();
                }
                if let Some(item_id) = value.get("item_id").and_then(Value::as_str) {
                    if let Some(item) = self
                        .output_items
                        .iter_mut()
                        .find(|item| item.get("id").and_then(Value::as_str) == Some(item_id))
                    {
                        item["arguments"] = Value::String(arguments.to_string());
                    }
                }
            }
        }
    }

    fn finish(self) -> StreamResult {
        StreamResult {
            tool_calls: self.calls.into_values().collect(),
            response_items: self.output_items,
        }
    }
}

#[derive(Default)]
struct AnthropicStreamState {
    blocks: HashMap<u64, AnthropicToolBlock>,
}

#[derive(Default)]
struct AnthropicToolBlock {
    id: String,
    name: String,
    input: String,
}

impl AnthropicStreamState {
    fn ingest(&mut self, event: &SseEvent) {
        let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
            return;
        };
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
        if event.event == "content_block_start" {
            let Some(block) = value.get("content_block") else {
                return;
            };
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                self.blocks.insert(
                    index,
                    AnthropicToolBlock {
                        id: block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        name: block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        input: block
                            .get("input")
                            .map_or_else(String::new, Value::to_string),
                    },
                );
            }
            return;
        }
        if event.event == "content_block_delta" {
            let Some(block) = self.blocks.get_mut(&index) else {
                return;
            };
            let Some(delta) = value.get("delta") else {
                return;
            };
            if delta.get("type").and_then(Value::as_str) == Some("input_json_delta") {
                block.input.push_str(
                    delta
                        .get("partial_json")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
            }
        }
    }

    fn finish(self) -> StreamResult {
        StreamResult {
            tool_calls: self
                .blocks
                .into_values()
                .filter_map(|block| {
                    if block.id.is_empty() || block.name.is_empty() {
                        return None;
                    }
                    Some(ToolCall {
                        external_name: block.name,
                        call_id: block.id,
                        arguments: parse_json_object(&block.input).unwrap_or_else(|| json!({})),
                    })
                })
                .collect(),
            response_items: Vec::new(),
        }
    }
}

async fn discover_mcp_tools(settings: &AiSettings) -> anyhow::Result<McpToolCatalog> {
    let servers = parse_mcp_servers(&settings.mcp_servers)?;
    if servers.is_empty() {
        return Ok(McpToolCatalog::default());
    }
    let mut catalog = McpToolCatalog {
        servers: servers.clone(),
        tools: Vec::new(),
    };
    let mut used_names = HashMap::<String, usize>::new();
    for (server_index, server) in servers.iter().enumerate() {
        let tools = McpSession::connect(server).await?.list_tools().await?;
        for tool in tools {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if name.is_empty() {
                continue;
            }
            let base = external_tool_name(&server.name, name);
            let count = used_names
                .entry(base.clone())
                .and_modify(|value| *value += 1)
                .or_insert(1);
            let external_name = if *count == 1 {
                base
            } else {
                format!("{}_{}", truncate_ascii(&base, 58), count)
            };
            catalog.tools.push(McpTool {
                server_index,
                external_name,
                name: name.to_owned(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                input_schema: tool
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object" })),
            });
        }
    }
    Ok(catalog)
}

async fn call_mcp_tool(
    catalog: &McpToolCatalog,
    external_name: &str,
    arguments: Value,
) -> anyhow::Result<String> {
    let tool = catalog
        .tools
        .iter()
        .find(|tool| tool.external_name == external_name)
        .ok_or_else(|| anyhow!("unknown MCP tool: {external_name}"))?;
    let result = McpSession::connect(&catalog.servers[tool.server_index])
        .await?
        .call_tool(&tool.name, arguments)
        .await?;
    Ok(truncate_detail_with_limit(
        &mcp_tool_result_text(&result),
        MAX_MCP_TOOL_RESULT_CHARS,
    ))
}

enum McpSession {
    Streamable(StreamableMcpSession),
    LegacySse(LegacySseMcpSession),
}

impl McpSession {
    async fn connect(config: &McpServerConfig) -> anyhow::Result<Self> {
        let transport = config.transport.trim();
        if transport.eq_ignore_ascii_case("sse")
            || config.url.trim_end_matches('/').ends_with("/sse")
        {
            let mut session = LegacySseMcpSession::connect(config).await?;
            session.initialize().await?;
            Ok(Self::LegacySse(session))
        } else {
            let mut session = StreamableMcpSession::new(config)?;
            session.initialize().await?;
            Ok(Self::Streamable(session))
        }
    }

    async fn list_tools(&mut self) -> anyhow::Result<Vec<Value>> {
        let result = match self {
            Self::Streamable(session) => session.request("tools/list", json!({})).await?,
            Self::LegacySse(session) => session.request("tools/list", json!({})).await?,
        };
        Ok(result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    async fn call_tool(&mut self, name: &str, arguments: Value) -> anyhow::Result<Value> {
        match self {
            Self::Streamable(session) => {
                session
                    .request(
                        "tools/call",
                        json!({ "name": name, "arguments": arguments }),
                    )
                    .await
            }
            Self::LegacySse(session) => {
                session
                    .request(
                        "tools/call",
                        json!({ "name": name, "arguments": arguments }),
                    )
                    .await
            }
        }
    }
}

struct StreamableMcpSession {
    client: reqwest::Client,
    config: McpServerConfig,
    endpoint: String,
    session_id: Option<String>,
    next_id: u64,
}

impl StreamableMcpSession {
    fn new(config: &McpServerConfig) -> anyhow::Result<Self> {
        Ok(Self {
            client: reqwest::Client::new(),
            endpoint: normalize_url(&config.url)?,
            config: config.clone(),
            session_id: None,
            next_id: 1,
        })
    }

    async fn initialize(&mut self) -> anyhow::Result<()> {
        self.request("initialize", json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "lazycat-neko-webshell", "version": env!("CARGO_PKG_VERSION") },
        })).await?;
        self.notification("notifications/initialized", json!({}))
            .await?;
        Ok(())
    }

    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json_rpc_request(id, method, params);
        let response = self.post_json(request, true).await?;
        response_result(response, id)
    }

    async fn notification(&mut self, method: &str, params: Value) -> anyhow::Result<()> {
        self.post_json(json_rpc_notification(method, params), false)
            .await?;
        Ok(())
    }

    async fn post_json(&mut self, body: Value, expect_response: bool) -> anyhow::Result<Value> {
        let response = self
            .client
            .post(&self.endpoint)
            .headers(mcp_headers(&self.config, self.session_id.as_deref())?)
            .json(&body)
            .send()
            .await?;
        if let Some(session_id) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.trim().is_empty())
        {
            self.session_id = Some(session_id.to_owned());
        }
        if !expect_response || response.status().as_u16() == 202 {
            return Ok(Value::Null);
        }
        parse_mcp_response(
            response,
            body.get("id").and_then(Value::as_u64).unwrap_or(0),
        )
        .await
    }
}

struct LegacySseMcpSession {
    client: reqwest::Client,
    config: McpServerConfig,
    post_endpoint: String,
    reader: SseReader,
    next_id: u64,
}

impl LegacySseMcpSession {
    async fn connect(config: &McpServerConfig) -> anyhow::Result<Self> {
        let client = reqwest::Client::new();
        let endpoint = normalize_url(&config.url)?;
        let response = client
            .get(&endpoint)
            .headers(mcp_headers(config, None)?)
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "MCP SSE connect failed ({status}): {}",
                truncate_detail(&detail)
            ));
        }
        let mut reader = SseReader::from_response(response);
        let post_endpoint = loop {
            let event = reader
                .next()
                .await?
                .ok_or_else(|| anyhow!("MCP SSE server closed before endpoint event"))?;
            if event.event == "endpoint" && !event.data.trim().is_empty() {
                break reqwest::Url::parse(&endpoint)?
                    .join(event.data.trim())?
                    .to_string();
            }
        };
        Ok(Self {
            client,
            config: config.clone(),
            post_endpoint,
            reader,
            next_id: 1,
        })
    }

    async fn initialize(&mut self) -> anyhow::Result<()> {
        self.request("initialize", json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "lazycat-neko-webshell", "version": env!("CARGO_PKG_VERSION") },
        })).await?;
        self.notification("notifications/initialized", json!({}))
            .await?;
        Ok(())
    }

    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.post(json_rpc_request(id, method, params)).await?;
        loop {
            let event = self
                .reader
                .next()
                .await?
                .ok_or_else(|| anyhow!("MCP SSE server closed before response"))?;
            if event.event != "message" {
                continue;
            }
            let value = serde_json::from_str::<Value>(&event.data)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                return response_result(value, id);
            }
        }
    }

    async fn notification(&mut self, method: &str, params: Value) -> anyhow::Result<()> {
        self.post(json_rpc_notification(method, params)).await
    }

    async fn post(&mut self, body: Value) -> anyhow::Result<()> {
        let response = self
            .client
            .post(&self.post_endpoint)
            .headers(mcp_headers(&self.config, None)?)
            .json(&body)
            .send()
            .await?;
        if response.status().is_success() || response.status().as_u16() == 202 {
            Ok(())
        } else {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            Err(anyhow!(
                "MCP request failed ({status}): {}",
                truncate_detail(&detail)
            ))
        }
    }
}

struct SseReader {
    stream: BoxStream<'static, Result<bytes::Bytes, reqwest::Error>>,
    buffer: String,
}

impl SseReader {
    fn from_response(response: reqwest::Response) -> Self {
        Self {
            stream: response.bytes_stream().boxed(),
            buffer: String::new(),
        }
    }

    async fn next(&mut self) -> anyhow::Result<Option<SseEvent>> {
        loop {
            if let Some((event, rest)) = split_sse_event(&self.buffer) {
                self.buffer = rest;
                if let Some(event) = parse_sse_event(&event) {
                    return Ok(Some(event));
                }
                continue;
            }
            let Some(chunk) = self.stream.next().await else {
                let event = std::mem::take(&mut self.buffer);
                return Ok(parse_sse_event(&event));
            };
            self.buffer.push_str(&String::from_utf8_lossy(&chunk?));
        }
    }
}

async fn ensure_success(response: reqwest::Response, label: &str) -> anyhow::Result<SseReader> {
    if response.status().is_success() {
        Ok(SseReader::from_response(response))
    } else {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        Err(anyhow!("{label} failed ({status}): {detail}"))
    }
}

async fn parse_mcp_response(response: reqwest::Response, id: u64) -> anyhow::Result<Value> {
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "MCP request failed ({status}): {}",
            truncate_detail(&detail)
        ));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_type.contains("text/event-stream") {
        let mut reader = SseReader::from_response(response);
        while let Some(event) = reader.next().await? {
            if event.event != "message" {
                continue;
            }
            let value = serde_json::from_str::<Value>(&event.data)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                return Ok(value);
            }
        }
        return Err(anyhow!("MCP stream ended before JSON-RPC response {id}"));
    }
    Ok(response.json::<Value>().await?)
}

fn response_result(response: Value, id: u64) -> anyhow::Result<Value> {
    if let Some(error) = response.get("error") {
        return Err(anyhow!(
            "MCP JSON-RPC error for {id}: {}",
            truncate_detail(&error.to_string())
        ));
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| anyhow!("MCP JSON-RPC response {id} is missing result"))
}

fn mcp_headers(config: &McpServerConfig, session_id: Option<&str>) -> anyhow::Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("mcp-protocol-version"),
        HeaderValue::from_static(MCP_PROTOCOL_VERSION),
    );
    if let Some(session_id) = session_id {
        headers.insert(
            HeaderName::from_static("mcp-session-id"),
            HeaderValue::from_str(session_id).context("invalid MCP session id")?,
        );
    }
    if !config.authorization.trim().is_empty() {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(config.authorization.trim())
                .context("invalid MCP authorization header")?,
        );
    }
    for (key, value) in &config.headers {
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(key.as_bytes()).context("invalid MCP header name")?;
        headers.insert(
            name,
            HeaderValue::from_str(value).context("invalid MCP header value")?,
        );
    }
    Ok(headers)
}

fn anthropic_request(
    settings: &AiSettings,
    builder: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    builder
        .header("x-api-key", settings.api_key.trim())
        .header("anthropic-version", ANTHROPIC_VERSION)
}

fn openai_chat_tool(tool: &McpTool) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.external_name,
            "description": tool.description,
            "parameters": tool.input_schema,
        },
    })
}

fn openai_response_tool(tool: &McpTool) -> Value {
    json!({
        "type": "function",
        "name": tool.external_name,
        "description": tool.description,
        "parameters": tool.input_schema,
    })
}

fn anthropic_tool(tool: &McpTool) -> Value {
    json!({
        "name": tool.external_name,
        "description": tool.description,
        "input_schema": tool.input_schema,
    })
}

fn openai_chat_tool_call_message(calls: &[ToolCall]) -> Value {
    json!({
        "role": "assistant",
        "content": Value::Null,
        "tool_calls": calls.iter().map(|call| json!({
            "id": call.call_id,
            "type": "function",
            "function": {
                "name": call.external_name,
                "arguments": call.arguments.to_string(),
            },
        })).collect::<Vec<_>>(),
    })
}

fn parse_mcp_servers(source: &str) -> anyhow::Result<Vec<McpServerConfig>> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let value = serde_json::from_str::<Value>(trimmed).context("invalid MCP server JSON")?;
    let servers_value = value.get("servers").unwrap_or(&value);
    let servers = serde_json::from_value::<Vec<McpServerConfig>>(servers_value.clone())
        .context("MCP server config must be an array or {\"servers\": [...]}")?;
    if servers.len() > MAX_MCP_SERVERS {
        return Err(anyhow!(
            "at most {MAX_MCP_SERVERS} MCP servers are supported"
        ));
    }
    servers
        .into_iter()
        .filter(|server| !server.url.trim().is_empty())
        .map(|server| {
            normalize_url(&server.url)?;
            Ok(McpServerConfig {
                name: if server.name.trim().is_empty() {
                    "mcp".to_owned()
                } else {
                    server.name.trim().to_owned()
                },
                url: server.url.trim().to_owned(),
                transport: server.transport.trim().to_owned(),
                authorization: server.authorization.trim().to_owned(),
                headers: server.headers,
            })
        })
        .collect()
}

fn parse_model_ids(value: &Value) -> Vec<String> {
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

fn parse_openai_chat_delta(data: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(data).ok()?;
    value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn parse_openai_chat_message_content(value: &Value) -> String {
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

fn parse_openai_response_text(value: &Value) -> String {
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return text.trim().to_owned();
    }
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_owned()
}

fn parse_anthropic_message_text(value: &Value) -> String {
    value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_owned()
}

fn parse_openai_response_text_delta(event: &SseEvent) -> Option<String> {
    let value = serde_json::from_str::<Value>(&event.data).ok()?;
    if event_type(&value, event) != "response.output_text.delta" {
        return None;
    }
    value
        .get("delta")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn parse_anthropic_text_delta(event: &SseEvent) -> Option<String> {
    if event.event != "content_block_delta" {
        return None;
    }
    let value = serde_json::from_str::<Value>(&event.data).ok()?;
    let delta = value.get("delta")?;
    if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
        return None;
    }
    delta
        .get("text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn tool_call_from_openai_item(item: &Value) -> Option<ToolCall> {
    let external_name = item.get("name").and_then(Value::as_str)?.to_owned();
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .or_else(|| item.get("id").and_then(Value::as_str))?
        .to_owned();
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .and_then(parse_json_object)
        .unwrap_or_else(|| json!({}));
    Some(ToolCall {
        external_name,
        call_id,
        arguments,
    })
}

fn event_type<'a>(value: &'a Value, event: &'a SseEvent) -> &'a str {
    value
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&event.event)
}

fn mcp_tool_result_text(value: &Value) -> String {
    if value
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return format!("Tool returned an error: {}", mcp_content_text(value));
    }
    mcp_content_text(value)
}

fn mcp_content_text(value: &Value) -> String {
    let Some(content) = value.get("content").and_then(Value::as_array) else {
        return value.to_string();
    };
    content
        .iter()
        .map(|item| {
            if item.get("type").and_then(Value::as_str) == Some("text") {
                item.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            } else {
                item.to_string()
            }
        })
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_prompt(action: &str, payload: &Value) -> String {
    let ctx = payload.get("ctx").unwrap_or(&Value::Null);
    let cwd = json_string(ctx, "cwd", "~");
    let shell = json_string(ctx, "shell", "sh");
    let os = json_string(ctx, "os", "LightOS");
    let backend = json_string(ctx, "backend", "");
    let selector = json_string(ctx, "selector", "");
    let recent_output = json_string(ctx, "recent_output", "");
    let conversation = payload
        .get("conversation")
        .map_or_else(String::new, Value::to_string);
    let terminal_context = terminal_context_block(
        &cwd,
        &shell,
        &os,
        &backend,
        &selector,
        &recent_output,
    );
    match action {
        "chat" => format!(
            "你是 WebShell 内的 Chat 工具，不控制终端，也不会替用户执行命令。\n{terminal_context}\n\n当前模型会话历史（JSON，可能为空）：\n{conversation}\n\n用户：{}\n\n要求：\n- 如果提供了终端上下文，优先依据上下文回答；上下文不足时明确说明缺少什么。\n- 简洁回答，优先给可执行建议。\n- 需要命令时用 ```shell 代码块，但不要声称已经执行。\n- 对删除、覆盖、sudo、系统路径写入等风险操作明确提醒。\n- 不要把终端输出逐行复述。",
            json_string(payload, "input", "")
        ),
        _ => format!("用户：{}", json_string(payload, "input", "")),
    }
}

fn terminal_context_block(
    cwd: &str,
    shell: &str,
    os: &str,
    backend: &str,
    selector: &str,
    recent_output: &str,
) -> String {
    let backend_line = if backend.trim().is_empty() {
        String::new()
    } else {
        format!("\n- 后端：{backend}")
    };
    let selector_line = if selector.trim().is_empty() {
        String::new()
    } else {
        format!("\n- 实例：{selector}")
    };
    let output = if recent_output.trim().is_empty() {
        "（未提供最近终端输出）"
    } else {
        recent_output
    };
    format!(
        "用户允许提供的终端上下文：\n- 当前目录：{cwd}\n- Shell：{shell}\n- OS：{os}{backend_line}{selector_line}\n- 最近终端输出（已脱敏）：\n```text\n{output}\n```"
    )
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

fn responses_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/responses") {
        trimmed.to_owned()
    } else if let Some(prefix) = trimmed.strip_suffix("/models") {
        format!("{prefix}/responses")
    } else {
        format!("{trimmed}/responses")
    }
}

fn messages_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/messages") {
        trimmed.to_owned()
    } else if let Some(prefix) = trimmed.strip_suffix("/models") {
        format!("{prefix}/messages")
    } else {
        format!("{trimmed}/messages")
    }
}

fn models_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    for suffix in ["/chat/completions", "/responses", "/messages"] {
        if let Some(prefix) = trimmed.strip_suffix(suffix) {
            return format!("{prefix}/models");
        }
    }
    if trimmed.ends_with("/models") {
        trimmed.to_owned()
    } else {
        format!("{trimmed}/models")
    }
}

enum AiProvider {
    OpenAiChat,
    OpenAiResponses,
    Anthropic,
}

fn provider(settings: &AiSettings) -> AiProvider {
    match settings.provider.trim() {
        "openai-responses" => AiProvider::OpenAiResponses,
        "anthropic" | "claude" => AiProvider::Anthropic,
        _ => AiProvider::OpenAiChat,
    }
}

fn json_rpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn json_rpc_notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

fn parse_json_object(source: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(source).ok()?;
    value.is_object().then_some(value)
}

fn json_string(payload: &Value, key: &str, fallback: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map_or_else(|| fallback.to_owned(), ToOwned::to_owned)
}

fn normalize_url(url: &str) -> anyhow::Result<String> {
    let parsed = reqwest::Url::parse(url.trim()).context("invalid URL")?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed.to_string()),
        _ => Err(anyhow!("URL scheme must be http or https")),
    }
}

fn external_tool_name(server_name: &str, tool_name: &str) -> String {
    let raw = if server_name.trim().is_empty() {
        tool_name.to_owned()
    } else {
        format!("{server_name}_{tool_name}")
    };
    let sanitized = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('_');
    let fallback = if trimmed.is_empty() {
        "mcp_tool"
    } else {
        trimmed
    };
    truncate_ascii(fallback, 64)
}

fn truncate_ascii(source: &str, max: usize) -> String {
    source.chars().take(max).collect()
}

fn split_sse_event(buffer: &str) -> Option<(String, String)> {
    if let Some(index) = buffer.find("\n\n") {
        return Some((buffer[..index].to_owned(), buffer[index + 2..].to_owned()));
    }
    if let Some(index) = buffer.find("\r\n\r\n") {
        return Some((buffer[..index].to_owned(), buffer[index + 4..].to_owned()));
    }
    None
}

fn parse_sse_event(source: &str) -> Option<SseEvent> {
    let mut event = String::from("message");
    let mut data = Vec::new();
    for line in source.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event = value.trim().to_owned();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start().to_owned());
        }
    }
    if data.is_empty() {
        return None;
    }
    Some(SseEvent {
        event,
        data: data.join("\n"),
    })
}

fn truncate_detail(detail: &str) -> String {
    truncate_detail_with_limit(detail, 500)
}

fn truncate_detail_with_limit(detail: &str, max: usize) -> String {
    let trimmed = detail.trim();
    if trimmed.chars().count() <= max {
        trimmed.to_owned()
    } else {
        format!("{}...", trimmed.chars().take(max).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_and_anthropic_model_lists() {
        assert_eq!(
            parse_model_ids(&json!({
                "data": [
                    { "id": "gpt-4.1" },
                    { "id": " claude-3-5-sonnet-20241022 " }
                ]
            })),
            vec!["gpt-4.1", "claude-3-5-sonnet-20241022"]
        );

        assert_eq!(
            parse_model_ids(&json!({
                "models": [
                    "claude-opus-4-20250514",
                    { "name": "claude-sonnet-4-20250514" }
                ]
            })),
            vec!["claude-opus-4-20250514", "claude-sonnet-4-20250514"]
        );
    }

    #[test]
    fn parses_sse_events() {
        let event =
            parse_sse_event("event: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n")
                .unwrap();
        assert_eq!(event.event, "response.output_text.delta");
        assert_eq!(event.data, "{\"delta\":\"hi\"}");
    }

    #[test]
    fn parses_provider_stream_deltas() {
        assert_eq!(
            parse_openai_chat_delta(r#"{"choices":[{"delta":{"content":"hello"}}]}"#),
            Some("hello".to_owned())
        );
        let openai_event = SseEvent {
            event: "response.output_text.delta".to_owned(),
            data: r#"{"type":"response.output_text.delta","delta":"world"}"#.to_owned(),
        };
        assert_eq!(
            parse_openai_response_text_delta(&openai_event),
            Some("world".to_owned())
        );
        let anthropic_event = SseEvent {
            event: "content_block_delta".to_owned(),
            data: r#"{"delta":{"type":"text_delta","text":"ok"}}"#.to_owned(),
        };
        assert_eq!(
            parse_anthropic_text_delta(&anthropic_event),
            Some("ok".to_owned())
        );
    }

    #[test]
    fn chat_prompt_includes_terminal_context_block() {
        let prompt = build_prompt(
            "chat",
            &json!({
                "input": "当前有哪些文件？",
                "ctx": {
                    "cwd": "/",
                    "shell": "zsh",
                    "os": "LightOS",
                    "backend": "webshell",
                    "selector": "lzcapp",
                    "recent_output": "drwxr-xr-x root root bin\n-rw-r--r-- root root .dockerenv"
                },
                "conversation": []
            }),
        );

        assert!(prompt.contains("用户允许提供的终端上下文"));
        assert!(prompt.contains("- 当前目录：/"));
        assert!(prompt.contains("- 后端：webshell"));
        assert!(prompt.contains("drwxr-xr-x root root bin"));
        assert!(prompt.contains("当前有哪些文件？"));
    }

    #[test]
    fn tracks_openai_response_tool_arguments_by_item_id() {
        let mut state = OpenAiResponsesStreamState::default();
        state.ingest(&SseEvent {
            event: "response.output_item.added".to_owned(),
            data: json!({
                "type": "response.output_item.added",
                "item": {
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": "search_web",
                    "arguments": ""
                }
            })
            .to_string(),
        });
        state.ingest(&SseEvent {
            event: "response.function_call_arguments.done".to_owned(),
            data: json!({
                "type": "response.function_call_arguments.done",
                "item_id": "fc_1",
                "arguments": "{\"query\":\"rust\"}"
            })
            .to_string(),
        });

        let result = state.finish();
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].call_id, "call_1");
        assert_eq!(result.tool_calls[0].arguments, json!({ "query": "rust" }));
        assert_eq!(
            result.response_items[0]
                .get("arguments")
                .and_then(Value::as_str),
            Some("{\"query\":\"rust\"}")
        );
    }

    #[test]
    fn parses_mcp_server_config() {
        let servers = parse_mcp_servers(
            r#"[{"name":"search","url":"https://example.test/mcp","headers":{"x-test":"yes"}}]"#,
        )
        .unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "search");
    }

    #[test]
    fn normalizes_external_tool_names() {
        assert_eq!(
            external_tool_name("my server", "read.file"),
            "my_server_read_file"
        );
    }
}
