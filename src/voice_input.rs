use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, anyhow};
use async_openai::{
    Client,
    config::{Config, OpenAIConfig},
    error::OpenAIError,
    types::audio::{
        AudioInput, AudioResponseFormat, CreateSpeechRequestArgs, CreateTranscriptionRequest,
        CreateTranscriptionRequestArgs, CreateTranscriptionResponseStreamEvent, SpeechModel,
        SpeechResponseFormat, Voice,
    },
};
use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderValue as AxumHeaderValue, StatusCode};
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use reqwest13::header::{HeaderMap, HeaderName, HeaderValue};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::{MAX_VOICE_INPUT_BYTES, MAX_VOICE_SPEECH_TEXT_CHARS};
use crate::database::{KV_KEY_SETTINGS, KV_NAMESPACE_PREFERENCES};
use crate::state::AppState;

const XIAOMI_MIMO_API_BASE: &str = "https://api.xiaomimimo.com/v1";
const XIAOMI_MIMO_TOKEN_PLAN_API_BASE: &str = "https://token-plan-cn.xiaomimimo.com/v1";
const XIAOMI_MIMO_MODEL: &str = "mimo-v2.5-asr";
const XIAOMI_MIMO_TTS_MODEL: &str = "mimo-v2.5-tts";
const OPENAI_TRANSCRIBE_MODEL: &str = "gpt-4o-mini-transcribe";
const OPENAI_SPEECH_MODEL: &str = "gpt-4o-mini-tts";
const DEFAULT_MIMO_SPEECH_VOICE: &str = "mimo_default";
const DEFAULT_OPENAI_SPEECH_VOICE: &str = "alloy";
const DEFAULT_SPEECH_FORMAT: &str = "wav";

#[derive(Clone, Debug, Default, Deserialize)]
struct VoiceSettings {
    #[serde(rename = "aiVoiceInputEnabled", default)]
    enabled: bool,
    #[serde(rename = "aiVoiceProviderProfiles", default)]
    profiles: Vec<VoiceProviderProfile>,
    #[serde(rename = "aiVoiceActiveProviderProfileId", default)]
    active_profile_id: String,
    #[serde(rename = "aiVoiceReplyEnabled", default)]
    reply_enabled: bool,
    #[serde(rename = "aiVoiceReplyProviderProfiles", default)]
    reply_profiles: Vec<VoiceSpeechProviderProfile>,
    #[serde(rename = "aiVoiceReplyActiveProviderProfileId", default)]
    active_reply_profile_id: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceProviderProfile {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    endpoint_type: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    language: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceSpeechProviderProfile {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    endpoint_type: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    voice: String,
    #[serde(default)]
    format: String,
    #[serde(default)]
    instructions: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptionResponse {
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpeechRequest {
    text: String,
    #[serde(default)]
    test: bool,
}

struct VoiceSpeechAudio {
    bytes: Bytes,
    mime_type: String,
}

struct ChatSpeechAudio {
    bytes: Bytes,
    mime_type: Option<String>,
}

struct VoiceAudioUpload {
    bytes: Bytes,
    mime_type: String,
    filename: String,
}

#[derive(Clone, Debug)]
struct ApiKeyHeaderConfig {
    api_base: String,
    api_key: SecretString,
    api_key_header: HeaderValue,
}

impl ApiKeyHeaderConfig {
    fn new(api_base: String, api_key: String) -> anyhow::Result<Self> {
        let api_key = api_key.trim().to_owned();
        let api_key_header =
            HeaderValue::from_str(&api_key).context("invalid api-key header value")?;
        Ok(Self {
            api_base,
            api_key: SecretString::from(api_key),
            api_key_header,
        })
    }
}

impl Config for ApiKeyHeaderConfig {
    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("api-key"),
            self.api_key_header.clone(),
        );
        headers
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.api_base, path)
    }

    fn query(&self) -> Vec<(&str, &str)> {
        Vec::new()
    }

    fn api_base(&self) -> &str {
        &self.api_base
    }

    fn api_key(&self) -> &SecretString {
        &self.api_key
    }
}

pub async fn post_voice_transcription(
    State(state): State<Arc<AppState>>,
    multipart: Multipart,
) -> Result<Json<VoiceTranscriptionResponse>, (StatusCode, String)> {
    let settings = load_voice_settings(&state).map_err(internal_error)?;
    if !settings.enabled {
        return Err((StatusCode::FORBIDDEN, "voice input is disabled".to_owned()));
    }
    let profile = selected_voice_profile(&settings).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "voice provider is not configured".to_owned(),
        )
    })?;
    validate_voice_profile(&profile)?;

    let upload = read_voice_audio_upload(multipart).await?;
    let text = transcribe_voice(&profile, upload)
        .await
        .map_err(|err| (StatusCode::BAD_GATEWAY, err.to_string()))?;
    Ok(Json(VoiceTranscriptionResponse { text }))
}

pub async fn post_voice_speech(
    State(state): State<Arc<AppState>>,
    Json(request): Json<VoiceSpeechRequest>,
) -> Result<Response, (StatusCode, String)> {
    let settings = load_voice_settings(&state).map_err(internal_error)?;
    if !settings.reply_enabled && !request.test {
        return Err((StatusCode::FORBIDDEN, "voice reply is disabled".to_owned()));
    }
    let profile = selected_voice_reply_profile(&settings).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "voice reply provider is not configured".to_owned(),
        )
    })?;
    validate_voice_speech_profile(&profile)?;
    let text = request.text.trim();
    if text.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "speech text is required".to_owned(),
        ));
    }
    if text.chars().count() > MAX_VOICE_SPEECH_TEXT_CHARS {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("speech text must be at most {MAX_VOICE_SPEECH_TEXT_CHARS} characters"),
        ));
    }

    let audio = synthesize_voice(&profile, text)
        .await
        .map_err(|err| (StatusCode::BAD_GATEWAY, err.to_string()))?;
    let mut response = Response::new(Body::from(audio.bytes));
    let content_type = AxumHeaderValue::from_str(&audio.mime_type)
        .map_err(|err| (StatusCode::BAD_GATEWAY, err.to_string()))?;
    response.headers_mut().insert(CONTENT_TYPE, content_type);
    Ok(response)
}

fn load_voice_settings(state: &AppState) -> anyhow::Result<VoiceSettings> {
    let Some(bytes) = state
        .database()
        .load_kv(KV_NAMESPACE_PREFERENCES, KV_KEY_SETTINGS)?
    else {
        return Ok(VoiceSettings::default());
    };
    Ok(serde_json::from_slice(&bytes)?)
}

async fn read_voice_audio_upload(
    mut multipart: Multipart,
) -> Result<VoiceAudioUpload, (StatusCode, String)> {
    let mut audio: Option<Bytes> = None;
    let mut audio_mime = String::new();
    let mut requested_mime = String::new();
    let mut filename = String::new();

    while let Some(field) = multipart.next_field().await.map_err(|err| {
        (
            StatusCode::BAD_REQUEST,
            format!("invalid voice upload: {err}"),
        )
    })? {
        let name = field.name().unwrap_or_default().to_owned();
        if name == "mimeType" {
            requested_mime = field
                .text()
                .await
                .map_err(|err| (StatusCode::BAD_REQUEST, format!("invalid mime type: {err}")))?
                .trim()
                .to_owned();
            continue;
        }
        if name != "audio" && name != "file" {
            continue;
        }
        audio_mime = field.content_type().unwrap_or_default().trim().to_owned();
        filename = field.file_name().unwrap_or_default().trim().to_owned();
        let bytes = field.bytes().await.map_err(|err| {
            (
                StatusCode::BAD_REQUEST,
                format!("invalid audio field: {err}"),
            )
        })?;
        if bytes.len() > MAX_VOICE_INPUT_BYTES {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("audio must be at most {MAX_VOICE_INPUT_BYTES} bytes"),
            ));
        }
        audio = Some(bytes);
    }

    let bytes =
        audio.ok_or_else(|| (StatusCode::BAD_REQUEST, "audio file is required".to_owned()))?;
    if bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "audio file is empty".to_owned()));
    }
    let mime_type = normalize_audio_mime(if requested_mime.is_empty() {
        &audio_mime
    } else {
        &requested_mime
    });
    let extension = audio_extension(&mime_type).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!("unsupported audio type: {mime_type}"),
        )
    })?;
    let filename = if filename.is_empty() {
        format!("voice-input.{extension}")
    } else {
        filename
    };
    Ok(VoiceAudioUpload {
        bytes,
        mime_type,
        filename,
    })
}

async fn transcribe_voice(
    profile: &VoiceProviderProfile,
    upload: VoiceAudioUpload,
) -> anyhow::Result<String> {
    match profile.endpoint_type.as_str() {
        "chat-input-audio" => transcribe_chat_input_audio(profile, upload).await,
        _ => transcribe_audio_api(profile, upload).await,
    }
}

async fn transcribe_audio_api(
    profile: &VoiceProviderProfile,
    upload: VoiceAudioUpload,
) -> anyhow::Result<String> {
    let client = openai_client(profile);
    let request = build_audio_transcription_request(profile, &upload, true)?;
    match client.audio().transcription().create_stream(request).await {
        Ok(mut stream) => {
            let mut text = String::new();
            while let Some(event) = stream.next().await {
                match event {
                    Ok(CreateTranscriptionResponseStreamEvent::TranscriptTextDelta(delta)) => {
                        text.push_str(&delta.delta);
                    }
                    Ok(CreateTranscriptionResponseStreamEvent::TranscriptTextDone(done)) => {
                        text = done.text;
                        break;
                    }
                    Ok(CreateTranscriptionResponseStreamEvent::TranscriptTextSegment(segment)) => {
                        if !segment.text.trim().is_empty() {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(&segment.text);
                        }
                    }
                    Err(_) => {
                        return transcribe_audio_api_raw(profile, upload).await;
                    }
                }
            }
            if text.trim().is_empty() {
                return transcribe_audio_api_raw(profile, upload).await;
            }
            Ok(text.trim().to_owned())
        }
        Err(_) => transcribe_audio_api_raw(profile, upload).await,
    }
}

async fn transcribe_audio_api_raw(
    profile: &VoiceProviderProfile,
    upload: VoiceAudioUpload,
) -> anyhow::Result<String> {
    let client = openai_client(profile);
    let request = build_audio_transcription_request(profile, &upload, false)?;
    let bytes = client
        .audio()
        .transcription()
        .create_raw(request)
        .await
        .context("audio transcription request failed")?;
    parse_transcription_bytes(&bytes)
}

async fn transcribe_chat_input_audio(
    profile: &VoiceProviderProfile,
    upload: VoiceAudioUpload,
) -> anyhow::Result<String> {
    let stream_payload = build_chat_input_audio_payload(profile, &upload, true);
    if is_xiaomi_voice_provider(profile) {
        let client = xiaomi_mimo_client(profile)?;
        match transcribe_chat_input_audio_stream(&client, stream_payload).await {
            Ok(text) => Ok(text),
            Err(_) => {
                let payload = build_chat_input_audio_payload(profile, &upload, false);
                transcribe_chat_input_audio_raw(&client, payload).await
            }
        }
    } else {
        let client = openai_client(profile);
        match transcribe_chat_input_audio_stream(&client, stream_payload).await {
            Ok(text) => Ok(text),
            Err(_) => {
                let payload = build_chat_input_audio_payload(profile, &upload, false);
                transcribe_chat_input_audio_raw(&client, payload).await
            }
        }
    }
}

async fn transcribe_chat_input_audio_stream<C: Config>(
    client: &Client<C>,
    payload: Value,
) -> anyhow::Result<String> {
    type JsonStream = Pin<Box<dyn Stream<Item = Result<Value, OpenAIError>> + Send>>;

    let mut stream: JsonStream = client
        .chat()
        .create_stream_byot(payload)
        .await
        .context("chat input_audio streaming request failed")?;
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        let event = event.context("chat input_audio streaming event failed")?;
        if let Some(delta) = parse_chat_completion_delta_text(&event) {
            text.push_str(&delta);
        } else if let Some(done) = parse_chat_completion_message_text(&event) {
            text = done;
        }
    }
    if text.trim().is_empty() {
        return Err(anyhow!("chat transcription stream did not include text"));
    }
    Ok(text.trim().to_owned())
}

async fn transcribe_chat_input_audio_raw(
    client: &Client<impl Config>,
    payload: Value,
) -> anyhow::Result<String> {
    let response: Value = client
        .chat()
        .create_byot(payload)
        .await
        .context("chat input_audio transcription request failed")?;
    parse_chat_completion_text(&response)
}

async fn synthesize_voice(
    profile: &VoiceSpeechProviderProfile,
    text: &str,
) -> anyhow::Result<VoiceSpeechAudio> {
    match profile.endpoint_type.as_str() {
        "chat-audio" => synthesize_chat_audio(profile, text).await,
        _ => synthesize_audio_speech(profile, text).await,
    }
}

async fn synthesize_chat_audio(
    profile: &VoiceSpeechProviderProfile,
    text: &str,
) -> anyhow::Result<VoiceSpeechAudio> {
    let payload = build_chat_speech_payload(profile, text);
    let response: Value = if is_xiaomi_provider(&profile.provider) {
        let client = xiaomi_mimo_client_parts(&profile.base_url, &profile.api_key)?;
        client
            .chat()
            .create_byot(payload)
            .await
            .context("chat audio speech request failed")?
    } else {
        let client = openai_client_parts(&profile.base_url, &profile.api_key);
        client
            .chat()
            .create_byot(payload)
            .await
            .context("chat audio speech request failed")?
    };
    let format = normalized_speech_format(&profile.format);
    let audio = parse_chat_speech_audio(&response)?;
    Ok(VoiceSpeechAudio {
        bytes: audio.bytes,
        mime_type: audio
            .mime_type
            .unwrap_or_else(|| speech_mime_type(&format).to_owned()),
    })
}

async fn synthesize_audio_speech(
    profile: &VoiceSpeechProviderProfile,
    text: &str,
) -> anyhow::Result<VoiceSpeechAudio> {
    let format = normalized_speech_format(&profile.format);
    let mut builder = CreateSpeechRequestArgs::default();
    builder
        .input(text.to_owned())
        .model(SpeechModel::Other(profile.model.trim().to_owned()))
        .voice(Voice::Other(profile.voice.trim().to_owned()))
        .response_format(speech_response_format(&format));
    let instructions = profile.instructions.trim();
    if !instructions.is_empty() {
        builder.instructions(instructions.to_owned());
    }
    let request = builder.build().map_err(|err| anyhow!(err))?;
    let response = openai_client_parts(&profile.base_url, &profile.api_key)
        .audio()
        .speech()
        .create(request)
        .await
        .context("audio speech request failed")?;
    Ok(VoiceSpeechAudio {
        bytes: response.bytes,
        mime_type: speech_mime_type(&format).to_owned(),
    })
}

fn build_chat_input_audio_payload(
    profile: &VoiceProviderProfile,
    upload: &VoiceAudioUpload,
    stream: bool,
) -> Value {
    let audio_b64 = BASE64_STANDARD.encode(&upload.bytes);
    let data_url = format!(
        "data:{};base64,{audio_b64}",
        audio_data_url_mime(&upload.mime_type)
    );
    let mut payload = json!({
        "model": profile.model.trim(),
        "stream": stream,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": {
                    "data": data_url
                }
            }]
        }]
    });
    if let Some(language) = normalized_language(&profile.language) {
        payload["asr_options"] = json!({ "language": language });
    }
    payload
}

fn audio_data_url_mime(mime_type: &str) -> &str {
    mime_type.split(';').next().unwrap_or(mime_type).trim()
}

fn build_chat_speech_payload(profile: &VoiceSpeechProviderProfile, text: &str) -> Value {
    let instructions = profile.instructions.trim();
    let style_prompt = if instructions.is_empty() {
        "Use a natural, clear speaking style."
    } else {
        instructions
    };
    json!({
        "model": profile.model.trim(),
        "messages": [
            {
                "role": "user",
                "content": style_prompt
            },
            {
                "role": "assistant",
                "content": text
            }
        ],
        "audio": {
            "format": normalized_speech_format(&profile.format),
            "voice": profile.voice.trim()
        }
    })
}

fn build_audio_transcription_request(
    profile: &VoiceProviderProfile,
    upload: &VoiceAudioUpload,
    stream: bool,
) -> anyhow::Result<CreateTranscriptionRequest> {
    let mut builder = CreateTranscriptionRequestArgs::default();
    builder
        .file(AudioInput::from_bytes(
            upload.filename.clone(),
            upload.bytes.clone(),
        ))
        .model(profile.model.trim().to_owned())
        .response_format(AudioResponseFormat::Json);
    if stream {
        builder.stream(true);
    }
    if let Some(language) = normalized_language(&profile.language) {
        builder.language(language);
    }
    builder.build().map_err(|err| anyhow!(err))
}

fn parse_transcription_bytes(bytes: &[u8]) -> anyhow::Result<String> {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        if let Some(text) = value.get("text").and_then(Value::as_str) {
            return Ok(text.trim().to_owned());
        }
        return Err(anyhow!("transcription response did not include text"));
    }
    let text = String::from_utf8(bytes.to_vec()).context("transcription response was not utf-8")?;
    Ok(text.trim().to_owned())
}

fn parse_chat_completion_text(value: &Value) -> anyhow::Result<String> {
    let text = parse_chat_completion_message_text(value).unwrap_or_default();
    if text.is_empty() {
        return Err(anyhow!("chat transcription response did not include text"));
    }
    Ok(text)
}

fn parse_chat_speech_audio(value: &Value) -> anyhow::Result<ChatSpeechAudio> {
    let data = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("audio"))
        .and_then(|audio| audio.get("data"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("chat audio speech response did not include audio data"))?;
    let (mime_type, base64_data) = parse_audio_data_url(data);
    let bytes = BASE64_STANDARD
        .decode(base64_data)
        .context("chat audio speech data was not valid base64")?;
    if bytes.is_empty() {
        return Err(anyhow!("chat audio speech response was empty"));
    }
    Ok(ChatSpeechAudio {
        bytes: Bytes::from(bytes),
        mime_type,
    })
}

fn parse_audio_data_url(data: &str) -> (Option<String>, &str) {
    let trimmed = data.trim();
    if !trimmed.starts_with("data:") {
        return (None, trimmed);
    }
    let Some((meta, encoded)) = trimmed.split_once(";base64,") else {
        return (None, trimmed);
    };
    let mime_type = meta
        .strip_prefix("data:")
        .map(str::trim)
        .filter(|value| value.starts_with("audio/"))
        .map(|value| value.to_owned());
    (mime_type, encoded.trim())
}

fn parse_chat_completion_message_text(value: &Value) -> Option<String> {
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(content_text)
}

fn parse_chat_completion_delta_text(value: &Value) -> Option<String> {
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("content"))
        .and_then(content_text)
}

fn content_text(value: &Value) -> Option<String> {
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_owned());
    }
    let parts = value.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>()
        .trim()
        .to_owned();
    (!text.is_empty()).then_some(text)
}

fn openai_client(profile: &VoiceProviderProfile) -> Client<OpenAIConfig> {
    openai_client_parts(&profile.base_url, &profile.api_key)
}

fn openai_client_parts(base_url: &str, api_key: &str) -> Client<OpenAIConfig> {
    let config = OpenAIConfig::new()
        .with_api_base(normalize_openai_api_base(base_url))
        .with_api_key(api_key.trim().to_owned());
    Client::with_config(config)
}

fn xiaomi_mimo_client(
    profile: &VoiceProviderProfile,
) -> anyhow::Result<Client<ApiKeyHeaderConfig>> {
    xiaomi_mimo_client_parts(&profile.base_url, &profile.api_key)
}

fn xiaomi_mimo_client_parts(
    base_url: &str,
    api_key: &str,
) -> anyhow::Result<Client<ApiKeyHeaderConfig>> {
    let config = ApiKeyHeaderConfig::new(
        normalize_openai_api_base(base_url),
        api_key.trim().to_owned(),
    )?;
    Ok(Client::with_config(config))
}

fn is_xiaomi_voice_provider(profile: &VoiceProviderProfile) -> bool {
    is_xiaomi_provider(&profile.provider)
}

fn is_xiaomi_provider(provider: &str) -> bool {
    provider == "mimo" || provider == "mimo-token-plan"
}

fn validate_voice_profile(profile: &VoiceProviderProfile) -> Result<(), (StatusCode, String)> {
    if profile.base_url.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "voice base URL is required".to_owned(),
        ));
    }
    if profile.api_key.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "voice API key is required".to_owned(),
        ));
    }
    if profile.model.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "voice model is required".to_owned(),
        ));
    }
    Ok(())
}

fn validate_voice_speech_profile(
    profile: &VoiceSpeechProviderProfile,
) -> Result<(), (StatusCode, String)> {
    if profile.base_url.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "voice reply base URL is required".to_owned(),
        ));
    }
    if profile.api_key.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "voice reply API key is required".to_owned(),
        ));
    }
    if profile.model.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "voice reply model is required".to_owned(),
        ));
    }
    if profile.voice.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "voice reply voice is required".to_owned(),
        ));
    }
    Ok(())
}

fn selected_voice_profile(settings: &VoiceSettings) -> Option<VoiceProviderProfile> {
    let profiles = merged_voice_profiles(&settings.profiles);
    profiles
        .iter()
        .find(|profile| profile.id == settings.active_profile_id)
        .cloned()
        .or_else(|| profiles.into_iter().next())
}

fn selected_voice_reply_profile(settings: &VoiceSettings) -> Option<VoiceSpeechProviderProfile> {
    let profiles = merged_voice_reply_profiles(&settings.reply_profiles);
    profiles
        .iter()
        .find(|profile| profile.id == settings.active_reply_profile_id)
        .cloned()
        .or_else(|| profiles.into_iter().next())
}

fn merged_voice_profiles(stored: &[VoiceProviderProfile]) -> Vec<VoiceProviderProfile> {
    let mut profiles = builtin_voice_profiles();
    for profile in stored {
        let normalized = normalize_voice_profile(profile.clone(), profiles.len());
        if let Some(existing) = profiles.iter_mut().find(|item| item.id == normalized.id) {
            *existing = normalized;
        } else {
            profiles.push(normalized);
        }
    }
    profiles
}

fn merged_voice_reply_profiles(
    stored: &[VoiceSpeechProviderProfile],
) -> Vec<VoiceSpeechProviderProfile> {
    let mut profiles = builtin_voice_reply_profiles();
    for profile in stored {
        let normalized = normalize_voice_speech_profile(profile.clone(), profiles.len());
        if let Some(existing) = profiles.iter_mut().find(|item| item.id == normalized.id) {
            *existing = normalized;
        } else {
            profiles.push(normalized);
        }
    }
    profiles
}

fn builtin_voice_profiles() -> Vec<VoiceProviderProfile> {
    vec![
        VoiceProviderProfile {
            id: "mimo".to_owned(),
            name: "Xiaomi Mimo".to_owned(),
            provider: "mimo".to_owned(),
            endpoint_type: "chat-input-audio".to_owned(),
            base_url: XIAOMI_MIMO_API_BASE.to_owned(),
            api_key: String::new(),
            model: XIAOMI_MIMO_MODEL.to_owned(),
            language: "zh".to_owned(),
        },
        VoiceProviderProfile {
            id: "mimo-token-plan".to_owned(),
            name: "Xiaomi Mimo Token Plan".to_owned(),
            provider: "mimo-token-plan".to_owned(),
            endpoint_type: "chat-input-audio".to_owned(),
            base_url: XIAOMI_MIMO_TOKEN_PLAN_API_BASE.to_owned(),
            api_key: String::new(),
            model: XIAOMI_MIMO_MODEL.to_owned(),
            language: "zh".to_owned(),
        },
    ]
}

fn builtin_voice_reply_profiles() -> Vec<VoiceSpeechProviderProfile> {
    vec![
        VoiceSpeechProviderProfile {
            id: "mimo".to_owned(),
            name: "Xiaomi Mimo".to_owned(),
            provider: "mimo".to_owned(),
            endpoint_type: "chat-audio".to_owned(),
            base_url: XIAOMI_MIMO_API_BASE.to_owned(),
            api_key: String::new(),
            model: XIAOMI_MIMO_TTS_MODEL.to_owned(),
            voice: DEFAULT_MIMO_SPEECH_VOICE.to_owned(),
            format: DEFAULT_SPEECH_FORMAT.to_owned(),
            instructions: "Use a natural, clear speaking style.".to_owned(),
        },
        VoiceSpeechProviderProfile {
            id: "mimo-token-plan".to_owned(),
            name: "Xiaomi Mimo Token Plan".to_owned(),
            provider: "mimo-token-plan".to_owned(),
            endpoint_type: "chat-audio".to_owned(),
            base_url: XIAOMI_MIMO_TOKEN_PLAN_API_BASE.to_owned(),
            api_key: String::new(),
            model: XIAOMI_MIMO_TTS_MODEL.to_owned(),
            voice: DEFAULT_MIMO_SPEECH_VOICE.to_owned(),
            format: DEFAULT_SPEECH_FORMAT.to_owned(),
            instructions: "Use a natural, clear speaking style.".to_owned(),
        },
        VoiceSpeechProviderProfile {
            id: "openai-compatible".to_owned(),
            name: "OpenAI compatible".to_owned(),
            provider: "openai-compatible".to_owned(),
            endpoint_type: "audio-speech".to_owned(),
            base_url: "https://api.openai.com/v1".to_owned(),
            api_key: String::new(),
            model: OPENAI_SPEECH_MODEL.to_owned(),
            voice: DEFAULT_OPENAI_SPEECH_VOICE.to_owned(),
            format: DEFAULT_SPEECH_FORMAT.to_owned(),
            instructions: String::new(),
        },
    ]
}

fn normalize_voice_profile(
    mut profile: VoiceProviderProfile,
    index: usize,
) -> VoiceProviderProfile {
    profile.id = sanitize_profile_id(&profile.id, index);
    profile.provider = match profile.provider.trim() {
        "mimo" => "mimo".to_owned(),
        "mimo-token-plan" => "mimo-token-plan".to_owned(),
        _ => "openai-compatible".to_owned(),
    };
    if profile.name.trim().is_empty() {
        profile.name = match profile.provider.as_str() {
            "mimo" => "Xiaomi Mimo".to_owned(),
            "mimo-token-plan" => "Xiaomi Mimo Token Plan".to_owned(),
            _ => format!("Voice Provider {}", index + 1),
        };
    } else {
        profile.name = profile.name.trim().chars().take(48).collect();
    }
    profile.endpoint_type = if profile.provider == "openai-compatible" {
        match profile.endpoint_type.trim() {
            "chat-input-audio" => "chat-input-audio".to_owned(),
            _ => "audio-transcriptions".to_owned(),
        }
    } else {
        "chat-input-audio".to_owned()
    };
    if profile.base_url.trim().is_empty() {
        profile.base_url = match profile.provider.as_str() {
            "mimo" => XIAOMI_MIMO_API_BASE.to_owned(),
            "mimo-token-plan" => XIAOMI_MIMO_TOKEN_PLAN_API_BASE.to_owned(),
            _ => "https://api.openai.com/v1".to_owned(),
        };
    } else {
        profile.base_url = profile.base_url.trim().trim_end_matches('/').to_owned();
    }
    if profile.model.trim().is_empty() {
        profile.model = if profile.endpoint_type == "chat-input-audio" {
            XIAOMI_MIMO_MODEL.to_owned()
        } else {
            OPENAI_TRANSCRIBE_MODEL.to_owned()
        };
    } else {
        profile.model = profile.model.trim().to_owned();
    }
    if profile.language.trim().is_empty() {
        profile.language = if profile.provider == "openai-compatible" {
            "auto".to_owned()
        } else {
            "zh".to_owned()
        };
    } else {
        profile.language = profile.language.trim().to_owned();
    }
    profile
}

fn normalize_voice_speech_profile(
    mut profile: VoiceSpeechProviderProfile,
    index: usize,
) -> VoiceSpeechProviderProfile {
    profile.id = sanitize_profile_id(&profile.id, index);
    profile.provider = match profile.provider.trim() {
        "mimo" => "mimo".to_owned(),
        "mimo-token-plan" => "mimo-token-plan".to_owned(),
        _ => "openai-compatible".to_owned(),
    };
    if profile.name.trim().is_empty() {
        profile.name = match profile.provider.as_str() {
            "mimo" => "Xiaomi Mimo".to_owned(),
            "mimo-token-plan" => "Xiaomi Mimo Token Plan".to_owned(),
            _ => format!("Voice Reply Provider {}", index + 1),
        };
    } else {
        profile.name = profile.name.trim().chars().take(48).collect();
    }
    profile.endpoint_type = if profile.provider == "openai-compatible" {
        match profile.endpoint_type.trim() {
            "chat-audio" => "chat-audio".to_owned(),
            _ => "audio-speech".to_owned(),
        }
    } else {
        "chat-audio".to_owned()
    };
    if profile.base_url.trim().is_empty() {
        profile.base_url = match profile.provider.as_str() {
            "mimo" => XIAOMI_MIMO_API_BASE.to_owned(),
            "mimo-token-plan" => XIAOMI_MIMO_TOKEN_PLAN_API_BASE.to_owned(),
            _ => "https://api.openai.com/v1".to_owned(),
        };
    } else {
        profile.base_url = profile.base_url.trim().trim_end_matches('/').to_owned();
    }
    if profile.model.trim().is_empty() {
        profile.model = if profile.endpoint_type == "chat-audio" {
            XIAOMI_MIMO_TTS_MODEL.to_owned()
        } else {
            OPENAI_SPEECH_MODEL.to_owned()
        };
    } else {
        profile.model = profile.model.trim().to_owned();
    }
    if profile.voice.trim().is_empty() {
        profile.voice = if profile.endpoint_type == "chat-audio" {
            DEFAULT_MIMO_SPEECH_VOICE.to_owned()
        } else {
            DEFAULT_OPENAI_SPEECH_VOICE.to_owned()
        };
    } else {
        profile.voice = profile.voice.trim().chars().take(64).collect();
    }
    profile.format = normalized_speech_format(&profile.format);
    profile.instructions = profile.instructions.trim().chars().take(1000).collect();
    profile
}

fn sanitize_profile_id(value: &str, index: usize) -> String {
    let sanitized = value
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(64)
        .collect::<String>();
    if sanitized.is_empty() {
        format!("voice-provider-{}", index + 1)
    } else {
        sanitized
    }
}

fn normalize_openai_api_base(base_url: &str) -> String {
    let mut trimmed = base_url.trim().trim_end_matches('/').to_owned();
    for suffix in [
        "/audio/transcriptions",
        "/audio/speech",
        "/chat/completions",
        "/responses",
        "/models",
    ] {
        if let Some(prefix) = trimmed.strip_suffix(suffix) {
            trimmed = prefix.to_owned();
            break;
        }
    }
    trimmed
}

fn normalized_language(language: &str) -> Option<String> {
    let language = language.trim();
    if language.is_empty() || language.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(language.to_owned())
    }
}

fn normalize_audio_mime(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "application/octet-stream" {
        "audio/webm".to_owned()
    } else {
        trimmed.to_ascii_lowercase()
    }
}

fn audio_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type.split(';').next().unwrap_or_default().trim() {
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/mp4" => Some("mp4"),
        "audio/mpga" => Some("mpga"),
        "audio/m4a" | "audio/x-m4a" => Some("m4a"),
        "audio/wav" | "audio/wave" | "audio/x-wav" => Some("wav"),
        "audio/webm" => Some("webm"),
        _ => None,
    }
}

fn normalized_speech_format(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "mp3" => "mp3".to_owned(),
        "opus" => "opus".to_owned(),
        "aac" => "aac".to_owned(),
        "flac" => "flac".to_owned(),
        "pcm" => "pcm".to_owned(),
        _ => DEFAULT_SPEECH_FORMAT.to_owned(),
    }
}

fn speech_response_format(value: &str) -> SpeechResponseFormat {
    match normalized_speech_format(value).as_str() {
        "mp3" => SpeechResponseFormat::Mp3,
        "opus" => SpeechResponseFormat::Opus,
        "aac" => SpeechResponseFormat::Aac,
        "flac" => SpeechResponseFormat::Flac,
        "pcm" => SpeechResponseFormat::Pcm,
        _ => SpeechResponseFormat::Wav,
    }
}

fn speech_mime_type(value: &str) -> &'static str {
    match normalized_speech_format(value).as_str() {
        "mp3" => "audio/mpeg",
        "opus" => "audio/opus",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "pcm" => "audio/pcm",
        _ => "audio/wav",
    }
}

fn internal_error(err: anyhow::Error) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_api_base_from_endpoint_urls() {
        assert_eq!(
            normalize_openai_api_base("https://api.example.com/v1/chat/completions"),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_openai_api_base("https://api.example.com/v1/audio/transcriptions/"),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn resolves_audio_extensions_from_browser_mime_types() {
        assert_eq!(audio_extension("audio/webm;codecs=opus"), Some("webm"));
        assert_eq!(audio_extension("audio/wav"), Some("wav"));
        assert_eq!(audio_extension("audio/ogg"), None);
    }

    #[test]
    fn applies_mimo_defaults() {
        let profile = normalize_voice_profile(
            VoiceProviderProfile {
                id: "mimo".to_owned(),
                provider: "mimo".to_owned(),
                ..VoiceProviderProfile::default()
            },
            0,
        );
        assert_eq!(profile.endpoint_type, "chat-input-audio");
        assert_eq!(profile.base_url, XIAOMI_MIMO_API_BASE);
        assert_eq!(profile.model, XIAOMI_MIMO_MODEL);
        assert_eq!(profile.language, "zh");
    }

    #[test]
    fn applies_mimo_speech_defaults() {
        let profile = normalize_voice_speech_profile(
            VoiceSpeechProviderProfile {
                id: "mimo-token-plan".to_owned(),
                provider: "mimo-token-plan".to_owned(),
                ..VoiceSpeechProviderProfile::default()
            },
            1,
        );

        assert_eq!(profile.endpoint_type, "chat-audio");
        assert_eq!(profile.base_url, XIAOMI_MIMO_TOKEN_PLAN_API_BASE);
        assert_eq!(profile.model, XIAOMI_MIMO_TTS_MODEL);
        assert_eq!(profile.voice, DEFAULT_MIMO_SPEECH_VOICE);
        assert_eq!(profile.format, DEFAULT_SPEECH_FORMAT);
    }

    #[test]
    fn builds_mimo_chat_input_audio_payload_like_provider_api() {
        let profile = normalize_voice_profile(
            VoiceProviderProfile {
                id: "mimo".to_owned(),
                provider: "mimo".to_owned(),
                api_key: "secret".to_owned(),
                ..VoiceProviderProfile::default()
            },
            0,
        );
        let upload = VoiceAudioUpload {
            bytes: Bytes::from_static(b"audio"),
            mime_type: "audio/wav".to_owned(),
            filename: "audio.wav".to_owned(),
        };
        let payload = build_chat_input_audio_payload(&profile, &upload, true);

        assert_eq!(payload["model"], XIAOMI_MIMO_MODEL);
        assert_eq!(payload["stream"], true);
        assert_eq!(payload["asr_options"]["language"], "zh");
        assert_eq!(payload["messages"][0]["content"][0]["type"], "input_audio");
        assert_eq!(
            payload["messages"][0]["content"][0]["input_audio"]["data"],
            "data:audio/wav;base64,YXVkaW8="
        );
    }

    #[test]
    fn strips_audio_data_url_mime_parameters() {
        let profile = normalize_voice_profile(
            VoiceProviderProfile {
                id: "compatible".to_owned(),
                provider: "openai-compatible".to_owned(),
                endpoint_type: "chat-input-audio".to_owned(),
                api_key: "secret".to_owned(),
                ..VoiceProviderProfile::default()
            },
            0,
        );
        let upload = VoiceAudioUpload {
            bytes: Bytes::from_static(b"audio"),
            mime_type: "audio/webm;codecs=opus".to_owned(),
            filename: "audio.webm".to_owned(),
        };
        let payload = build_chat_input_audio_payload(&profile, &upload, false);

        assert_eq!(
            payload["messages"][0]["content"][0]["input_audio"]["data"],
            "data:audio/webm;base64,YXVkaW8="
        );
    }

    #[test]
    fn builds_mimo_chat_speech_payload_like_provider_api() {
        let profile = normalize_voice_speech_profile(
            VoiceSpeechProviderProfile {
                id: "mimo".to_owned(),
                provider: "mimo".to_owned(),
                api_key: "secret".to_owned(),
                voice: "冰糖".to_owned(),
                instructions: "用轻快、清晰的中文播报。".to_owned(),
                ..VoiceSpeechProviderProfile::default()
            },
            0,
        );
        let payload = build_chat_speech_payload(&profile, "你好，欢迎使用语音回复。");

        assert_eq!(payload["model"], XIAOMI_MIMO_TTS_MODEL);
        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(
            payload["messages"][0]["content"],
            "用轻快、清晰的中文播报。"
        );
        assert_eq!(payload["messages"][1]["role"], "assistant");
        assert_eq!(
            payload["messages"][1]["content"],
            "你好，欢迎使用语音回复。"
        );
        assert_eq!(payload["audio"]["format"], "wav");
        assert_eq!(payload["audio"]["voice"], "冰糖");
    }

    #[test]
    fn parses_chat_speech_audio_data_urls_and_plain_base64() {
        const WAV_BASE64: &str = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
        let data_url = json!({
            "choices": [{
                "message": {
                    "audio": {
                        "data": format!("data:audio/wav;base64,{WAV_BASE64}")
                    }
                }
            }]
        });
        let plain = json!({
            "choices": [{
                "message": {
                    "audio": {
                        "data": WAV_BASE64
                    }
                }
            }]
        });

        let parsed_data_url = parse_chat_speech_audio(&data_url).unwrap();
        assert_eq!(parsed_data_url.mime_type.as_deref(), Some("audio/wav"));
        assert!(parsed_data_url.bytes.starts_with(b"RIFF"));
        assert!(
            parsed_data_url
                .bytes
                .windows(4)
                .any(|window| window == b"WAVE")
        );

        let parsed_plain = parse_chat_speech_audio(&plain).unwrap();
        assert_eq!(parsed_plain.mime_type, None);
        assert_eq!(parsed_plain.bytes, parsed_data_url.bytes);
    }

    #[test]
    fn normalizes_speech_formats_and_mime_types() {
        assert_eq!(normalized_speech_format("MP3"), "mp3");
        assert_eq!(normalized_speech_format("unknown"), "wav");
        assert_eq!(speech_mime_type("mp3"), "audio/mpeg");
        assert_eq!(speech_mime_type("wav"), "audio/wav");
    }

    #[test]
    fn parses_chat_input_audio_stream_delta_and_message_text() {
        let delta = json!({
            "choices": [{
                "delta": {
                    "content": "你好"
                }
            }]
        });
        let message = json!({
            "choices": [{
                "message": {
                    "content": "终端命令"
                }
            }]
        });

        assert_eq!(
            parse_chat_completion_delta_text(&delta).as_deref(),
            Some("你好")
        );
        assert_eq!(parse_chat_completion_text(&message).unwrap(), "终端命令");
    }

    #[test]
    fn xiaomi_config_uses_api_key_header_without_bearer_auth() {
        let config =
            ApiKeyHeaderConfig::new(XIAOMI_MIMO_API_BASE.to_owned(), "secret".to_owned()).unwrap();
        let headers = config.headers();

        assert_eq!(headers.get("api-key").unwrap().to_str().unwrap(), "secret");
        assert!(headers.get("authorization").is_none());
        assert_eq!(
            config.url("/chat/completions"),
            "https://api.xiaomimimo.com/v1/chat/completions"
        );
    }
}
