use neko_plugin::{
    BoxFuture, InvokeReply, InvokeRequest, LightOsForward, PluginConfiguration, PluginError,
    Resources, RuntimePlugin,
};
use std::sync::Arc;
pub const PLUGIN_ID: &str = "lightos-port-forward";
pub fn register(resources: &Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let host = resources.require::<Arc<dyn LightOsForward>>("lightos-forward")?;
    Ok(Arc::new(ForwardPlugin {
        host: Arc::clone(&host),
    }))
}
struct ForwardPlugin {
    host: Arc<dyn LightOsForward>,
}
impl RuntimePlugin for ForwardPlugin {
    fn id(&self) -> &'static str {
        PLUGIN_ID
    }
    fn invoke(&self, request: InvokeRequest) -> BoxFuture<'_, Result<InvokeReply, PluginError>> {
        Box::pin(async move { self.host.invoke(&request.target, &request.operation).await })
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

impl ForwardPlugin {
    async fn stop(&self) -> Result<(), PluginError> {
        let host = Arc::clone(&self.host);
        tokio::task::spawn_blocking(move || host.stop_all())
            .await
            .map_err(|error| PluginError::internal(error.to_string()))?
    }
}
