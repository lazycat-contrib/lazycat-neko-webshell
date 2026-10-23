pub mod engine;
pub use engine::{
    ai_access_configured, ai_model_configured, fetch_ai_models, stream_ai_chat, test_ai_access,
};
use neko_plugin::{
    AiPreferences, BoxFuture, InvokeReply, InvokeRequest, PluginError, Resources, RuntimePlugin,
    TargetContext,
};
use std::sync::Arc;

pub struct AiChatAccess {
    pub preferences: Arc<dyn AiPreferences>,
}
impl AiChatAccess {
    pub fn load_settings(&self) -> anyhow::Result<engine::AiSettings> {
        Ok(serde_json::from_slice(&self.preferences.load()?)?)
    }
}

pub fn register(resources: &Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let _preferences = resources.require::<Arc<AiChatAccess>>("ai-preferences")?;
    let context = resources.require::<Arc<dyn TargetContext>>("terminal-context")?;
    Ok(Arc::new(AiChatPlugin {
        context: Arc::clone(&context),
    }))
}
struct AiChatPlugin {
    context: Arc<dyn TargetContext>,
}
impl RuntimePlugin for AiChatPlugin {
    fn id(&self) -> &'static str {
        "ai-chat"
    }
    fn invoke(&self, request: InvokeRequest) -> BoxFuture<'_, Result<InvokeReply, PluginError>> {
        Box::pin(async move {
            let session = self.context.resolve(&request.target).await?;
            match request.operation.as_str() {
                "default" | "status" => InvokeReply::json(
                    "complete",
                    &serde_json::json!({
                        "sessionId": session.id, "selector": session.selector, "status": session.status,
                        "plugin": "ai-chat", "transport": "action-websocket",
                    }),
                ),
                _ => Err(PluginError::invalid_argument(format!(
                    "unsupported ai-chat operation: {}",
                    request.operation
                ))),
            }
        })
    }
}
