use super::TerminalMcpManager;
use neko_plugin::{BoxFuture, PluginConfiguration, PluginError, Resources, RuntimePlugin};
use std::sync::Arc;

pub fn register(resources: &Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let manager = resources.require::<Arc<TerminalMcpManager>>("terminal-control")?;
    Ok(Arc::new(TerminalMcpPlugin {
        manager: Arc::clone(&manager),
    }))
}
struct TerminalMcpPlugin {
    manager: Arc<TerminalMcpManager>,
}
impl RuntimePlugin for TerminalMcpPlugin {
    fn id(&self) -> &'static str {
        super::PLUGIN_ID
    }
    fn configure(
        &self,
        _configuration: PluginConfiguration,
    ) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async {
            self.manager.revoke_all();
            Ok(())
        })
    }
    fn shutdown(&self) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async {
            self.manager.revoke_all();
            Ok(())
        })
    }
}
