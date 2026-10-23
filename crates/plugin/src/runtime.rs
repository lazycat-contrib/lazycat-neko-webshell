use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rutis::{BoxFuture, CordisError, Ctx, Effect, FiberState, Plugin, TypeKey};

use crate::{InvokeReply, InvokeRequest, Manifest, PluginConfiguration, PluginError, Resources};
use tokio::sync::{Mutex, RwLock};

pub trait RuntimePlugin: Send + Sync + 'static {
    fn id(&self) -> &'static str;

    fn invoke(&self, _request: InvokeRequest) -> BoxFuture<'_, Result<InvokeReply, PluginError>> {
        Box::pin(async {
            Err(PluginError::unimplemented(
                "plugin uses its declared browser, HTTP or streaming transport",
            ))
        })
    }

    /// Called after a saved configuration change, including policy changes.
    fn configure(
        &self,
        _configuration: PluginConfiguration,
    ) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async { Ok(()) })
    }

    fn public_metadata(&self) -> Result<HashMap<String, String>, PluginError> {
        Ok(HashMap::new())
    }
    fn prepare_configuration(
        &self,
        metadata: HashMap<String, String>,
    ) -> Result<HashMap<String, String>, PluginError> {
        Ok(metadata)
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async { Ok(()) })
    }
}

pub struct Registration {
    pub manifest: Manifest,
    pub resources: Resources,
    pub plugin: Result<Arc<dyn RuntimePlugin>, PluginError>,
    pub configuration: PluginConfiguration,
}

struct NativePlugin {
    plugin: Arc<dyn RuntimePlugin>,
    injects: [TypeKey; 1],
    configuration: PluginConfiguration,
}

impl Plugin for NativePlugin {
    fn name(&self) -> &str {
        self.plugin.id()
    }
    fn injects(&self) -> &[TypeKey] {
        &self.injects
    }
    fn apply<'a>(&'a self, ctx: &'a Ctx) -> BoxFuture<'a, Result<Effect, CordisError>> {
        Box::pin(async move {
            ctx.require_as::<Resources>(self.injects[0].clone())?;
            let plugin = Arc::clone(&self.plugin);
            ctx.effect(move || {
                Effect::AsyncDisposer(Box::new(move || {
                    Box::pin(async move {
                        plugin
                            .shutdown()
                            .await
                            .map_err(|err| CordisError::PluginFailed(Box::new(err)))
                    })
                }))
            })?;
            self.plugin
                .configure(self.configuration.clone())
                .await
                .map_err(|err| CordisError::PluginFailed(Box::new(err)))?;
            ctx.provide_as::<dyn RuntimePlugin>(
                TypeKey::keyed::<dyn RuntimePlugin>(self.plugin.id()),
                Arc::clone(&self.plugin),
            )?;
            Ok(Effect::Done)
        })
    }
}

/// Root is deliberately private: callers cannot place terminal sessions into its graph.
pub struct Runtime {
    root: Ctx,
    failures: HashMap<String, String>,
    gates: HashMap<String, Arc<RwLock<bool>>>,
    closing: Arc<AtomicBool>,
    shutdown_lock: Arc<Mutex<()>>,
}

impl Runtime {
    pub async fn start(registrations: Vec<Registration>) -> Result<Self, PluginError> {
        let mut ids = HashSet::new();
        for registration in &registrations {
            if registration
                .plugin
                .as_ref()
                .is_ok_and(|plugin| registration.manifest.id != plugin.id())
                || !ids.insert(registration.manifest.id.clone())
            {
                return Err(PluginError::invalid_argument(
                    "duplicate or mismatched plugin registration",
                ));
            }
        }
        let root = Ctx::root().map_err(runtime_error)?;
        let mut failures = HashMap::new();
        let mut gates = HashMap::new();
        for registration in registrations {
            gates.insert(
                registration.manifest.id.clone(),
                Arc::new(RwLock::new(registration.configuration.enabled)),
            );
            let plugin = match registration.plugin {
                Ok(plugin) => plugin,
                Err(error) => {
                    failures.insert(registration.manifest.id, error.to_string());
                    continue;
                }
            };
            let id = plugin.id();
            let key = TypeKey::keyed::<Resources>(id);
            root.provide_as::<Resources>(key.clone(), Arc::new(registration.resources))
                .map_err(runtime_error)?;
            let view = root.plugin(NativePlugin {
                plugin,
                injects: [key],
                configuration: registration.configuration,
            });
            match (&view).await {
                Ok(()) if view.state().state == FiberState::Active => {}
                result => {
                    let message = result.err().map_or_else(
                        || format!("plugin did not become active: {:?}", view.state()),
                        |err| err.to_string(),
                    );
                    failures.insert(id.to_owned(), message);
                    let _ = view.dispose().await;
                }
            }
        }
        Ok(Self {
            root,
            failures,
            gates,
            closing: Arc::new(AtomicBool::new(false)),
            shutdown_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn failures(&self) -> &HashMap<String, String> {
        &self.failures
    }

    fn plugin(&self, id: &str) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
        self.root
            .get_as::<dyn RuntimePlugin>(TypeKey::keyed_dynamic::<dyn RuntimePlugin>(id.to_owned()))
            .ok_or_else(|| {
                PluginError::unavailable(
                    self.failures
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| format!("plugin is not active: {id}")),
                )
            })
    }

    pub async fn invoke(
        &self,
        id: &str,
        request: InvokeRequest,
    ) -> Result<InvokeReply, PluginError> {
        self.require_open()?;
        let gate = Arc::clone(
            self.gates
                .get(id)
                .ok_or_else(|| PluginError::not_found("plugin is not registered"))?,
        );
        let plugin = self.plugin(id)?;
        let closing = Arc::clone(&self.closing);
        // The task, including spawn_blocking work it awaits, owns the read guard.
        // Dropping an HTTP/RPC future cannot detach resource creation from cleanup.
        self.root
            .handle()
            .spawn(async move {
                let enabled = gate.read_owned().await;
                if closing.load(Ordering::Acquire) {
                    return Err(PluginError::unavailable("plugin runtime is shutting down"));
                }
                if !*enabled {
                    return Err(PluginError::failed_precondition(format!(
                        "plugin is disabled: {}",
                        plugin.id()
                    )));
                }
                plugin.invoke(request).await
            })
            .await
            .map_err(runtime_error)?
    }

    pub async fn configure(
        &self,
        id: &str,
        configuration: impl Into<PluginConfiguration>,
    ) -> Result<(), PluginError> {
        self.require_open()?;
        let configuration = configuration.into();
        let enabled = configuration.enabled;
        let gate = Arc::clone(
            self.gates
                .get(id)
                .ok_or_else(|| PluginError::not_found("plugin is not registered"))?,
        );
        let plugin = self.plugin(id);
        let closing = Arc::clone(&self.closing);
        self.root
            .handle()
            .spawn(async move {
                let mut current = gate.write_owned().await;
                if closing.load(Ordering::Acquire) {
                    return Err(PluginError::unavailable("plugin runtime is shutting down"));
                }
                *current = enabled;
                match plugin {
                    Ok(plugin) => plugin.configure(configuration).await,
                    Err(_) if !enabled => Ok(()),
                    Err(error) => Err(error),
                }
            })
            .await
            .map_err(runtime_error)?
    }

    pub fn public_metadata(&self, id: &str) -> Result<HashMap<String, String>, PluginError> {
        self.plugin(id)?.public_metadata()
    }
    pub fn prepare_configuration(
        &self,
        id: &str,
        metadata: HashMap<String, String>,
    ) -> Result<HashMap<String, String>, PluginError> {
        match self.plugin(id) {
            Ok(plugin) => plugin.prepare_configuration(metadata),
            Err(_) if self.failures.contains_key(id) => Ok(metadata),
            Err(error) => Err(error),
        }
    }

    fn require_open(&self) -> Result<(), PluginError> {
        if self.closing.load(Ordering::Acquire) {
            Err(PluginError::unavailable("plugin runtime is shutting down"))
        } else {
            Ok(())
        }
    }

    pub async fn shutdown(&self) -> Result<(), PluginError> {
        self.closing.store(true, Ordering::Release);
        let root = self.root.clone();
        let shutdown_lock = Arc::clone(&self.shutdown_lock);
        let mut gates = self
            .gates
            .iter()
            .map(|(id, gate)| (id.clone(), Arc::clone(gate)))
            .collect::<Vec<_>>();
        gates.sort_by(|left, right| left.0.cmp(&right.0));
        // Keep shutdown itself alive if its initiating request disappears.
        self.root
            .handle()
            .spawn(async move {
                let _shutdown = shutdown_lock.lock().await;
                let mut held = Vec::with_capacity(gates.len());
                for (_, gate) in gates {
                    let mut guard = gate.write_owned().await;
                    *guard = false;
                    held.push(guard);
                }
                root.shutdown().await.map_err(runtime_error)
            })
            .await
            .map_err(runtime_error)?
    }
}

fn runtime_error(err: impl std::fmt::Display) -> PluginError {
    PluginError::internal(err.to_string())
}
