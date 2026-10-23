//! Composition of built-in plugins and the host-owned resources they may use.
pub mod catalog;
mod configuration;
pub mod http;
pub(crate) mod resources;
pub(crate) mod settings;

use self::resources::forward_process::LightOsPortForwardManager;
use self::settings::{PluginRecord, PluginStore, builtin_plugins};
use crate::database::AppDatabase;
use crate::notifications::NotificationHub;
use crate::plugins::{
    ai_chat::AiChatAccess,
    file_transfer::{FileTransferResource, FileTransferUploadManager},
    pomodoro::PomodoroManager,
    terminal_mcp::TerminalMcpManager,
    tunnel::TunnelManager,
};
use crate::state::AppState;
use connectrpc::ConnectError;
use neko_plugin::{
    AiPreferences, LightOsForward, PluginNotifications, PluginStorage, Registration, Resources,
    Runtime, TargetContext, TunnelProfiles,
};
use std::collections::HashMap;
use std::io;
use std::sync::{Arc, RwLock};
use tokio::sync::OnceCell;
use tracing::warn;

#[derive(Clone)]
pub struct PluginHost {
    pub settings: Arc<RwLock<HashMap<String, PluginRecord>>>,
    pub terminal_mcp: Arc<TerminalMcpManager>,
    pub lightos_port_forwards: Arc<LightOsPortForwardManager>,
    pub file_uploads: Arc<FileTransferUploadManager>,
    pub public_tunnels: Arc<TunnelManager>,
    pub pomodoro: Arc<PomodoroManager>,
    pub ai_chat: Arc<AiChatAccess>,
    database: Arc<AppDatabase>,
    notifications: Arc<NotificationHub>,
    runtime: Arc<OnceCell<Runtime>>,
    pub configuration_lock: Arc<tokio::sync::Mutex<()>>,
    configuration_locks: Arc<HashMap<String, tokio::sync::Mutex<()>>>,
}

impl PluginHost {
    pub fn new(database: Arc<AppDatabase>, notifications: Arc<NotificationHub>) -> Self {
        let settings = PluginStore::new(Arc::clone(&database))
            .load()
            .unwrap_or_else(|err| {
                warn!(error = %err, "failed to load persisted plugin settings");
                builtin_plugins()
            });
        let storage: Arc<dyn PluginStorage> = Arc::new(resources::StorageAccess {
            database: Arc::clone(&database),
            plugin_id: "pomodoro",
        });
        let notifier: Arc<dyn PluginNotifications> = Arc::new(resources::NotificationAccess {
            hub: Arc::clone(&notifications),
            source: "pomodoro",
        });
        let preferences: Arc<dyn AiPreferences> = Arc::new(resources::AiSettingsAccess {
            database: Arc::clone(&database),
        });
        Self {
            settings: Arc::new(RwLock::new(settings)),
            terminal_mcp: Arc::default(),
            lightos_port_forwards: Arc::default(),
            file_uploads: Arc::default(),
            public_tunnels: Arc::default(),
            pomodoro: Arc::new(PomodoroManager::new(storage, notifier)),
            ai_chat: Arc::new(AiChatAccess { preferences }),
            database,
            notifications,
            runtime: Arc::new(OnceCell::new()),
            configuration_lock: Arc::new(tokio::sync::Mutex::new(())),
            configuration_locks: Arc::new(
                catalog::ENTRIES
                    .iter()
                    .map(|entry| (entry.id.to_owned(), tokio::sync::Mutex::new(())))
                    .collect(),
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(
        database: Arc<AppDatabase>,
        notifications: Arc<NotificationHub>,
    ) -> Self {
        let host = Self::new(database, notifications);
        host.settings.write().unwrap().clear();
        host
    }

    pub fn persist_settings(&self, settings: &HashMap<String, PluginRecord>) -> io::Result<()> {
        PluginStore::new(Arc::clone(&self.database)).save(settings)
    }

    pub async fn runtime<'a>(&'a self, state: &Arc<AppState>) -> Result<&'a Runtime, ConnectError> {
        self.runtime
            .get_or_try_init(|| async {
                let mut resources = Resources::default();
                resources.provide(
                    "files",
                    FileTransferResource {
                        files: Arc::new(resources::files::FileAccess {
                            state: Arc::downgrade(state),
                        }),
                        uploads: Arc::clone(&self.file_uploads),
                    },
                );
                let context: Arc<dyn TargetContext> = Arc::new(resources::ContextAccess {
                    state: Arc::downgrade(state),
                });
                resources.provide("terminal-context", context);
                resources.provide("ai-preferences", Arc::clone(&self.ai_chat));
                resources.provide("storage", Arc::clone(&self.pomodoro));
                resources.provide("terminal-control", Arc::clone(&self.terminal_mcp));
                let forward: Arc<dyn LightOsForward> = Arc::new(resources::ForwardAccess {
                    state: Arc::downgrade(state),
                    manager: Arc::clone(&self.lightos_port_forwards),
                });
                resources.provide("lightos-forward", forward);
                let profiles: Arc<dyn TunnelProfiles> = Arc::new(resources::TunnelProfileAccess {
                    database: Arc::clone(&self.database),
                });
                resources.provide("tunnel-profiles", profiles);
                resources.provide("network", Arc::clone(&self.public_tunnels));
                let mut registrations = Vec::new();
                for entry in catalog::ENTRIES {
                    let manifest: neko_plugin::Manifest = serde_json::from_str(entry.json)
                        .map_err(|err| ConnectError::internal(err.to_string()))?;
                    let mut scoped = resources.scoped(&manifest.resources);
                    let notifier: Arc<dyn PluginNotifications> =
                        Arc::new(resources::NotificationAccess {
                            hub: Arc::clone(&self.notifications),
                            source: entry.id,
                        });
                    if manifest
                        .resources
                        .iter()
                        .any(|resource| resource == "notifications")
                    {
                        scoped.provide("notifications", notifier);
                    }
                    let plugin = (entry.register)(&scoped);
                    let record = self
                        .settings
                        .read()
                        .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?
                        .get(entry.id)
                        .cloned();
                    let configuration = record.as_ref().map_or_else(
                        || neko_plugin::PluginConfiguration::from(false),
                        PluginRecord::configuration,
                    );
                    let plugin = if configuration.version > 1 {
                        Err(neko_plugin::PluginError::failed_precondition(
                            "plugin configuration was saved by a newer version",
                        ))
                    } else {
                        plugin
                    };
                    registrations.push(Registration {
                        manifest,
                        resources: scoped,
                        plugin,
                        configuration,
                    });
                }
                let runtime = Runtime::start(registrations)
                    .await
                    .map_err(resources::connect_error)?;
                for (id, error) in runtime.failures() {
                    warn!(plugin_id = %id, error = %error, "plugin failed to initialize");
                }
                Ok(runtime)
            })
            .await
    }

    pub fn require_enabled(&self, id: &str) -> Result<(), ConnectError> {
        let records = self
            .settings
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
        let plugin = records
            .get(id)
            .ok_or_else(|| ConnectError::not_found(format!("plugin is not registered: {id}")))?;
        if !settings::plugin_available_in_current_runtime(plugin) {
            return Err(ConnectError::not_found(format!(
                "plugin is not available in this runtime: {id}"
            )));
        }
        if plugin.configuration_version > 1 {
            return Err(ConnectError::failed_precondition(
                "plugin configuration was saved by a newer version",
            ));
        }
        if !plugin.enabled {
            return Err(ConnectError::failed_precondition(format!(
                "plugin is disabled: {id}"
            )));
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), ConnectError> {
        if let Some(runtime) = self.runtime.get() {
            runtime.shutdown().await.map_err(resources::connect_error)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
