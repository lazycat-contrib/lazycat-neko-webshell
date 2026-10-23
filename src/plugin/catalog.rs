use neko_plugin::{PluginError, Resources, RuntimePlugin};
use std::sync::Arc;

pub struct Entry {
    pub id: &'static str,
    pub json: &'static str,
    pub register: fn(&Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError>,
}
include!(concat!(env!("OUT_DIR"), "/plugin_catalog.rs"));
