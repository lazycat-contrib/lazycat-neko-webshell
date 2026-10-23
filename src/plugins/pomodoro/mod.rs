pub mod engine;
pub use engine::PomodoroManager;
use neko_plugin::{BoxFuture, PluginError, Resources, RuntimePlugin};
use std::sync::Arc;

pub fn register(resources: &Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let manager = resources.require::<Arc<PomodoroManager>>("storage")?;
    Ok(Arc::new(PomodoroPlugin {
        _manager: Arc::clone(&manager),
    }))
}
struct PomodoroPlugin {
    _manager: Arc<PomodoroManager>,
}
impl RuntimePlugin for PomodoroPlugin {
    fn id(&self) -> &'static str {
        "pomodoro"
    }
    // Timer state is persisted. Disabling its UI must not erase a saved timer.
    fn shutdown(&self) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async { Ok(()) })
    }
}
