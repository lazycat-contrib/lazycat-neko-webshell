use super::{
    PluginHost, catalog, resources,
    settings::{PluginRecord, plugin_available_in_current_runtime},
};
use crate::proto::lazycat::webshell::v1::PluginDescriptor;
use crate::state::AppState;
use connectrpc::ConnectError;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

const RESERVED: &[&str] = &[
    "builtin",
    "runtime",
    "backends",
    "requiresRuntime",
    "defaultEnabled",
    "configurationVersion",
];

pub(super) fn validate_metadata(
    id: &str,
    updates: &HashMap<String, String>,
) -> Result<(), ConnectError> {
    let entry = catalog::ENTRIES
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| ConnectError::not_found("plugin not found"))?;
    let manifest: Value =
        serde_json::from_str(entry.json).map_err(|err| ConnectError::internal(err.to_string()))?;
    let fields = &manifest["configuration"]["metadata"];
    for (key, value) in updates {
        let rule = &fields[key];
        let valid = match rule["type"].as_str() {
            Some("boolean") => matches!(value.as_str(), "true" | "false"),
            Some("enum") => rule["values"]
                .as_array()
                .is_some_and(|values| values.iter().any(|allowed| allowed.as_str() == Some(value))),
            Some("csv") => {
                let allowed = rule["values"]
                    .as_array()
                    .ok_or_else(|| ConnectError::internal("invalid plugin configuration schema"))?;
                value.trim().is_empty()
                    || value.split(',').all(|item| {
                        allowed.iter().any(|entry| {
                            entry.as_str() == Some(item.trim().to_ascii_lowercase().as_str())
                        })
                    })
            }
            Some("string-array") => {
                serde_json::from_str::<Vec<String>>(value).is_ok_and(|values| {
                    u64::try_from(values.len())
                        .is_ok_and(|length| length <= rule["maxItems"].as_u64().unwrap_or(128))
                        && values
                            .iter()
                            .all(|value| !value.trim().is_empty() && value.len() <= 256)
                })
            }
            _ => true,
        };
        if !valid {
            return Err(ConnectError::invalid_argument(format!(
                "invalid configuration for {id}.{key}"
            )));
        }
    }
    Ok(())
}

impl PluginHost {
    pub fn descriptor(&self, plugin: &PluginRecord) -> PluginDescriptor {
        let mut descriptor = plugin.to_proto();
        descriptor.metadata.insert(
            "configurationVersion".into(),
            plugin.configuration_version.to_string(),
        );
        if let Some(runtime) = self.runtime.get() {
            match runtime.public_metadata(&plugin.id) {
                Ok(metadata) => descriptor.metadata.extend(metadata),
                Err(error) => {
                    descriptor
                        .metadata
                        .insert("runtimeError".into(), error.to_string());
                }
            }
        }
        descriptor
    }

    pub async fn configure(
        &self,
        state: &Arc<AppState>,
        id: &str,
        enabled: bool,
        updates: HashMap<String, String>,
    ) -> Result<PluginDescriptor, ConnectError> {
        let host = self.clone();
        let state = Arc::clone(state);
        let id = id.to_owned();
        tokio::spawn(async move {
            host.configure_committed(&state, &id, enabled, updates)
                .await
        })
        .await
        .map_err(|error| {
            ConnectError::internal(format!("plugin configuration task failed: {error}"))
        })?
    }

    async fn configure_committed(
        &self,
        state: &Arc<AppState>,
        id: &str,
        enabled: bool,
        updates: HashMap<String, String>,
    ) -> Result<PluginDescriptor, ConnectError> {
        let plugin_lock = self
            .configuration_locks
            .get(id)
            .ok_or_else(|| ConnectError::not_found("plugin not found"))?;
        let _plugin_guard = plugin_lock.lock().await;
        let commit_guard = self.configuration_lock.lock().await;
        let mut snapshot = self
            .settings
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?
            .clone();
        let record = snapshot
            .get_mut(id)
            .filter(|record| plugin_available_in_current_runtime(record))
            .ok_or_else(|| ConnectError::not_found("plugin not found"))?;
        if record.configuration_version > 1 {
            return Err(ConnectError::failed_precondition(
                "plugin configuration was saved by a newer version",
            ));
        }
        validate_metadata(id, &updates)?;
        let runtime = self.runtime(state).await?;
        if enabled && runtime.failures().contains_key(id) {
            return Err(ConnectError::unavailable("plugin failed to initialize"));
        }
        let updates = runtime
            .prepare_configuration(id, updates)
            .map_err(resources::connect_error)?;
        record.enabled = enabled;
        for (key, value) in updates {
            if !RESERVED.contains(&key.as_str()) {
                record.metadata.insert(key, value);
            }
        }
        let record = record.clone();
        self.persist_settings(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        *self
            .settings
            .write()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))? = snapshot;
        drop(commit_guard);
        runtime
            .configure(id, record.configuration())
            .await
            .map_err(resources::connect_error)?;
        Ok(self.descriptor(&record))
    }
}
