use neko_plugin::{PluginError, Resources, RuntimePlugin};
use std::sync::Arc;

#[allow(
    clippy::unnecessary_wraps,
    reason = "The generated registry uses a shared fallible registration signature."
)]
pub fn register(_resources: &Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Ok(Arc::new(TerminalDiagnosticsPlugin))
}

struct TerminalDiagnosticsPlugin;
impl RuntimePlugin for TerminalDiagnosticsPlugin {
    fn id(&self) -> &'static str {
        "terminal-diagnostics"
    }
}
