use crate::database::{AppDatabase, KV_KEY_SETTINGS, KV_NAMESPACE_PREFERENCES, KV_NAMESPACE_STATE};
use crate::notifications::NotificationHub;
use neko_plugin::{
    AiPreferences, NewNotification, PluginError, PluginNotifications, PluginStorage,
    TunnelProfiles, WebshellNotification,
};
use std::io;
use std::sync::Arc;

pub struct StorageAccess {
    pub database: Arc<AppDatabase>,
    pub plugin_id: &'static str,
}
impl StorageAccess {
    fn namespace(&self, key: &str) -> String {
        if self.plugin_id == "pomodoro" && key == "pomodoro" {
            KV_NAMESPACE_STATE.to_owned()
        } else {
            format!("plugin:{}", self.plugin_id)
        }
    }
}
impl PluginStorage for StorageAccess {
    fn load(&self, key: &str) -> io::Result<Option<Vec<u8>>> {
        self.database.load_kv(&self.namespace(key), key)
    }
    fn store(&self, key: &str, value: &[u8]) -> io::Result<()> {
        self.database.store_kv(&self.namespace(key), key, value)
    }
}

pub struct AiSettingsAccess {
    pub database: Arc<AppDatabase>,
}
impl AiPreferences for AiSettingsAccess {
    fn load(&self) -> io::Result<Vec<u8>> {
        let bytes = self
            .database
            .load_kv(KV_NAMESPACE_PREFERENCES, KV_KEY_SETTINGS)?
            .unwrap_or_else(|| b"{}".to_vec());
        let settings: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        let mut selected = serde_json::Map::new();
        for key in [
            "aiProvider",
            "aiBaseUrl",
            "aiApiKey",
            "aiModel",
            "aiMcpServers",
        ] {
            if let Some(value) = settings.get(key) {
                selected.insert(key.to_owned(), value.clone());
            }
        }
        serde_json::to_vec(&selected).map_err(io::Error::other)
    }
}

pub struct TunnelProfileAccess {
    pub database: Arc<AppDatabase>,
}
impl TunnelProfiles for TunnelProfileAccess {
    fn public_metadata(&self) -> Result<std::collections::HashMap<String, String>, PluginError> {
        super::tunnel_profiles::ProfileStore {
            database: Arc::clone(&self.database),
        }
        .public_metadata()
        .map_err(super::plugin_error)
    }
    fn replace(&self, profiles: &str) -> Result<(), PluginError> {
        super::tunnel_profiles::ProfileStore {
            database: Arc::clone(&self.database),
        }
        .replace(profiles)
        .map_err(super::plugin_error)
    }
    fn ngrok_token(&self, profile_id: &str) -> Result<String, PluginError> {
        let profile = self
            .database
            .load_tunnel_provider_profile(profile_id)
            .map_err(|err| PluginError::internal(err.to_string()))?
            .ok_or_else(|| PluginError::not_found("ngrok profile not found"))?;
        if profile.provider != "ngrok" {
            return Err(PluginError::invalid_argument(
                "tunnel provider profile is not ngrok",
            ));
        }
        if !profile.enabled {
            return Err(PluginError::failed_precondition(
                "ngrok profile is disabled",
            ));
        }
        serde_json::from_str::<serde_json::Value>(&profile.secret_json)
            .ok()
            .and_then(|secret| {
                secret
                    .get("authtoken")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            })
            .ok_or_else(|| PluginError::failed_precondition("ngrok profile is not configured"))
    }
    fn mark_used(&self, profile_id: &str) -> Result<(), PluginError> {
        self.database
            .mark_tunnel_provider_profile_used(profile_id)
            .map_err(|err| PluginError::internal(err.to_string()))
    }
}

pub struct NotificationAccess {
    pub hub: Arc<NotificationHub>,
    pub source: &'static str,
}
impl PluginNotifications for NotificationAccess {
    fn add(&self, input: NewNotification) -> io::Result<WebshellNotification> {
        if input.source_kind != self.source {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "notification source was not granted",
            ));
        }
        self.hub.add(input)
    }
    fn notification(&self, id: &str) -> io::Result<Option<WebshellNotification>> {
        Ok(self
            .hub
            .notification(id)?
            .filter(|notification| notification.source_kind == self.source))
    }
    fn dismiss(&self, id: &str) -> io::Result<Option<WebshellNotification>> {
        if self.notification(id)?.is_none() {
            return Ok(None);
        }
        self.hub.dismiss(id)
    }
    fn mark_actioned(&self, id: &str) -> io::Result<Option<WebshellNotification>> {
        if self.notification(id)?.is_none() {
            return Ok(None);
        }
        self.hub.mark_actioned(id)
    }
}
