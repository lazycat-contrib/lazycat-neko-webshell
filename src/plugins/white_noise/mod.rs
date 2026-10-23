use neko_plugin::{PluginError, Resources, RuntimePlugin};
use std::sync::Arc;

#[allow(
    clippy::unnecessary_wraps,
    reason = "The generated registry uses a shared fallible registration signature."
)]
pub fn register(_resources: &Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Ok(Arc::new(BrowserPlugin))
}
struct BrowserPlugin;
impl RuntimePlugin for BrowserPlugin {
    fn id(&self) -> &'static str {
        include_str!("id.txt").trim()
    }
}
