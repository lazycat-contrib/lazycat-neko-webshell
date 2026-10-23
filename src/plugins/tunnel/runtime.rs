use super::{PLUGIN_ID, TunnelManager};
use neko_plugin::{
    BoxFuture, InvokeReply, InvokeRequest, PluginConfiguration, PluginError, Resources,
    RuntimePlugin, TunnelProfiles,
};
use std::sync::Arc;

pub fn register(resources: &Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let profiles = resources.require::<Arc<dyn TunnelProfiles>>("tunnel-profiles")?;
    let manager = resources.require::<Arc<TunnelManager>>("network")?;
    Ok(Arc::new(TunnelPlugin {
        profiles: Arc::clone(&profiles),
        manager: Arc::clone(&manager),
    }))
}
struct TunnelPlugin {
    profiles: Arc<dyn TunnelProfiles>,
    manager: Arc<TunnelManager>,
}
impl RuntimePlugin for TunnelPlugin {
    fn id(&self) -> &'static str {
        PLUGIN_ID
    }
    fn invoke(&self, request: InvokeRequest) -> BoxFuture<'_, Result<InvokeReply, PluginError>> {
        Box::pin(async move {
            let mut metadata = request.target.metadata;
            metadata.remove("ngrokAuthtoken");
            let operation = request.operation.trim().to_owned();
            let profile = if operation == "start"
                && metadata.get("provider").map(String::as_str).map(str::trim) == Some("ngrok")
            {
                let id = metadata
                    .get("ngrokProfileId")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        PluginError::invalid_argument("metadata.ngrokProfileId is required")
                    })?
                    .to_owned();
                metadata.insert("ngrokAuthtoken".into(), self.profiles.ngrok_token(&id)?);
                Some(id)
            } else {
                None
            };
            let manager = Arc::clone(&self.manager);
            let response =
                tokio::task::spawn_blocking(move || manager.invoke_metadata(&operation, &metadata))
                    .await
                    .map_err(|err| PluginError::internal(format!("plugin task failed: {err}")))?
                    .map_err(|err| PluginError::failed_precondition(err.to_string()))?;
            if let Some(profile) = profile {
                self.profiles.mark_used(&profile)?;
            }
            Ok(InvokeReply {
                status: response.status,
                content_type: response.content_type,
                payload: response.payload,
                metadata: response.metadata,
            })
        })
    }
    fn public_metadata(&self) -> Result<std::collections::HashMap<String, String>, PluginError> {
        self.profiles.public_metadata()
    }
    fn prepare_configuration(
        &self,
        mut metadata: std::collections::HashMap<String, String>,
    ) -> Result<std::collections::HashMap<String, String>, PluginError> {
        if let Some(profiles) = metadata.remove("tunnelProviderProfiles") {
            self.profiles.replace(&profiles)?;
        }
        metadata.remove("ngrokAuthtoken");
        metadata.remove("ngrokConfigured");
        Ok(metadata)
    }
    fn configure(
        &self,
        configuration: PluginConfiguration,
    ) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async move {
            if !configuration.enabled {
                self.stop().await?;
            }
            Ok(())
        })
    }
    fn shutdown(&self) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async { self.stop().await })
    }
}

impl TunnelPlugin {
    async fn stop(&self) -> Result<(), PluginError> {
        let manager = Arc::clone(&self.manager);
        tokio::task::spawn_blocking(move || manager.stop_all())
            .await
            .map_err(|error| PluginError::internal(error.to_string()))?
    }
}
