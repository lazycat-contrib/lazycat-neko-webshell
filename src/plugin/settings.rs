use crate::database::{AppDatabase, KV_KEY_PLUGINS, KV_NAMESPACE_STATE};
use crate::proto::lazycat::webshell::v1::PluginDescriptor;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use tracing::warn;

#[derive(Clone, Debug, Deserialize)]
pub struct PluginRecord {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub description: String,
    pub scopes: Vec<String>,
    pub accepted_content_types: Vec<String>,
    pub produced_content_types: Vec<String>,
    pub input_schema_json: String,
    pub output_schema_json: String,
    pub enabled: bool,
    #[serde(default = "configuration_version")]
    pub configuration_version: u32,
    pub metadata: HashMap<String, String>,
}

impl PluginRecord {
    pub fn configuration(&self) -> neko_plugin::PluginConfiguration {
        neko_plugin::PluginConfiguration {
            version: self.configuration_version,
            enabled: self.enabled,
            metadata: self.metadata.clone(),
        }
    }

    pub fn to_proto(&self) -> PluginDescriptor {
        PluginDescriptor {
            id: Some(self.id.clone()),
            kind: Some(self.kind.clone()),
            display_name: Some(self.display_name.clone()),
            description: Some(self.description.clone()),
            scopes: self.scopes.clone(),
            accepted_content_types: self.accepted_content_types.clone(),
            produced_content_types: self.produced_content_types.clone(),
            input_schema_json: Some(self.input_schema_json.clone()),
            output_schema_json: Some(self.output_schema_json.clone()),
            enabled: Some(self.enabled),
            metadata: self.public_metadata().into_iter().collect(),
            ..Default::default()
        }
    }

    fn public_metadata(&self) -> HashMap<String, String> {
        let mut metadata = self.metadata.clone();
        if let Some(entry) = super::catalog::ENTRIES
            .iter()
            .find(|entry| entry.id == self.id)
        {
            let manifest: serde_json::Value =
                serde_json::from_str(entry.json).expect("validated plugin manifest");
            for field in ["secrets", "privateMetadata"] {
                if let Some(keys) = manifest["configuration"][field].as_array() {
                    for key in keys.iter().filter_map(serde_json::Value::as_str) {
                        metadata.remove(key);
                    }
                }
            }
        }
        metadata
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedPluginState {
    version: u32,
    plugins: Vec<PersistedPluginRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedPluginRecord {
    id: String,
    enabled: bool,
    #[serde(default = "configuration_version")]
    configuration_version: u32,
    #[serde(default)]
    metadata: HashMap<String, String>,
}

pub(crate) struct PluginStore {
    database: Arc<AppDatabase>,
}

impl PluginStore {
    pub(crate) fn new(database: Arc<AppDatabase>) -> Self {
        Self { database }
    }

    pub(crate) fn load(&self) -> io::Result<HashMap<String, PluginRecord>> {
        let mut plugins = builtin_plugins();
        let Some(bytes) = self.database.load_kv(KV_NAMESPACE_STATE, KV_KEY_PLUGINS)? else {
            return Ok(plugins);
        };
        let persisted = serde_json::from_slice::<PersistedPluginState>(&bytes)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
        for record in persisted.plugins {
            let id = record.id.trim();
            if id.is_empty() {
                continue;
            }
            let Some(plugin) = plugins.get_mut(id) else {
                warn!(plugin_id = %id, "ignored persisted settings for unknown plugin");
                continue;
            };
            let builtin_metadata = plugin.metadata.clone();
            plugin.enabled = record.enabled;
            plugin.configuration_version = record.configuration_version;
            plugin.metadata.extend(record.metadata);
            for key in builtin_owned_metadata_keys(id) {
                if let Some(value) = builtin_metadata.get(*key) {
                    plugin.metadata.insert((*key).to_owned(), value.to_owned());
                } else {
                    plugin.metadata.remove(*key);
                }
            }
        }
        Ok(plugins)
    }

    pub(crate) fn save(&self, plugins: &HashMap<String, PluginRecord>) -> io::Result<()> {
        let mut plugins = plugins
            .values()
            .map(|plugin| PersistedPluginRecord {
                id: plugin.id.clone(),
                enabled: plugin.enabled,
                configuration_version: plugin.configuration_version,
                metadata: plugin.metadata.clone(),
            })
            .collect::<Vec<_>>();
        plugins.sort_by(|left, right| left.id.cmp(&right.id));
        let persisted = PersistedPluginState {
            version: 1,
            plugins,
        };
        let bytes =
            serde_json::to_vec(&persisted).map_err(|err| io::Error::other(err.to_string()))?;
        self.database
            .store_kv(KV_NAMESPACE_STATE, KV_KEY_PLUGINS, &bytes)
    }
}

fn builtin_owned_metadata_keys(_plugin_id: &str) -> &'static [&'static str] {
    &[
        "builtin",
        "runtime",
        "backends",
        "requiresRuntime",
        "defaultEnabled",
    ]
}

pub(crate) fn builtin_plugins() -> HashMap<String, PluginRecord> {
    super::catalog::ENTRIES
        .iter()
        .map(|entry| {
            let record: PluginRecord =
                serde_json::from_str(entry.json).expect("validated built-in plugin manifest");
            (record.id.clone(), record)
        })
        .collect()
}

pub(crate) fn plugin_available_in_current_runtime(plugin: &PluginRecord) -> bool {
    match plugin.metadata.get("requiresRuntime").map(String::as_str) {
        Some("lightos") => crate::tty_init::lightos_features_enabled(),
        _ => true,
    }
}

fn configuration_version() -> u32 {
    1
}
