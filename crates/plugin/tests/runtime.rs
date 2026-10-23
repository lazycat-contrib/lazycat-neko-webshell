use std::future::{Future, poll_fn};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::Poll;

use neko_plugin::{
    BoxFuture, ErrorCode, FrontendEntry, InvokeReply, InvokeRequest, Manifest, PluginConfiguration,
    PluginError, Registration, Resources, Runtime, RuntimePlugin, TargetRequest,
};
use tokio::sync::Notify;

#[derive(Default)]
struct Probe {
    id: &'static str,
    invoked: AtomicUsize,
    disabled: AtomicUsize,
    stopped: AtomicUsize,
    block: bool,
    entered: Notify,
    release: Notify,
}
impl RuntimePlugin for Probe {
    fn id(&self) -> &'static str {
        self.id
    }
    fn invoke(&self, _: InvokeRequest) -> BoxFuture<'_, Result<InvokeReply, PluginError>> {
        Box::pin(async {
            self.invoked.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            if self.block {
                self.release.notified().await;
            }
            InvokeReply::json("complete", &serde_json::json!({ "id": self.id }))
        })
    }
    fn configure(
        &self,
        configuration: PluginConfiguration,
    ) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async move {
            if !configuration.enabled {
                self.disabled.fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        })
    }
    fn shutdown(&self) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async {
            self.stopped.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

fn registration(plugin: Arc<dyn RuntimePlugin>, enabled: bool) -> Registration {
    Registration {
        manifest: Manifest {
            id: plugin.id().into(),
            resources: vec![],
            frontend: FrontendEntry {
                entry: "entry.ts".into(),
                tool: true,
                icon: "plug".into(),
                name_key: "name".into(),
                description_key: "description".into(),
            },
        },
        resources: Resources::default(),
        plugin: Ok(plugin),
        configuration: enabled.into(),
    }
}
fn request() -> InvokeRequest {
    InvokeRequest {
        target: TargetRequest::default(),
        operation: "status".into(),
        content_type: "application/json".into(),
        payload: vec![],
    }
}

#[test]
fn plugins_receive_only_declared_typed_resources() {
    let mut host = Resources::default();
    host.provide("files", 42_u64);
    host.provide("terminal-control", "host-only".to_owned());
    let plugin = host.scoped(&["files".into()]);
    assert_eq!(*plugin.require::<u64>("files").unwrap(), 42);
    assert_eq!(
        plugin
            .require::<String>("terminal-control")
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        plugin.require::<String>("files").unwrap_err().code,
        ErrorCode::Unavailable
    );
}

#[tokio::test]
async fn disabled_plugin_keeps_its_registration_but_cannot_invoke() {
    let probe = Arc::new(Probe {
        id: "probe",
        ..Default::default()
    });
    let runtime = Runtime::start(vec![registration(probe.clone(), false)])
        .await
        .unwrap();
    assert!(runtime.failures().is_empty());
    assert_eq!(
        runtime.invoke("probe", request()).await.unwrap_err().code,
        ErrorCode::FailedPrecondition
    );
    assert_eq!(probe.invoked.load(Ordering::SeqCst), 0);
    runtime.configure("probe", true).await.unwrap();
    assert_eq!(
        runtime.invoke("probe", request()).await.unwrap().status,
        "complete"
    );
    runtime.shutdown().await.unwrap();
    assert_eq!(probe.stopped.load(Ordering::SeqCst), 1);
    assert!(runtime.invoke("probe", request()).await.is_err());
    runtime.shutdown().await.unwrap();
    assert_eq!(probe.stopped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn configuration_waits_for_its_inflight_request_without_restarting_another_plugin() {
    let probe = Arc::new(Probe {
        id: "probe",
        block: true,
        ..Default::default()
    });
    let other = Arc::new(Probe {
        id: "other",
        ..Default::default()
    });
    let runtime = Arc::new(
        Runtime::start(vec![
            registration(probe.clone(), true),
            registration(other.clone(), true),
        ])
        .await
        .unwrap(),
    );
    let request_runtime = runtime.clone();
    let task = tokio::spawn(async move { request_runtime.invoke("probe", request()).await });
    probe.entered.notified().await;
    let mut configure = Box::pin(runtime.configure("probe", false));
    assert!(poll_fn(|cx| Poll::Ready(configure.as_mut().poll(cx).is_pending())).await);
    assert_eq!(other.stopped.load(Ordering::SeqCst), 0);
    assert_eq!(
        runtime.invoke("other", request()).await.unwrap().status,
        "complete"
    );
    probe.release.notify_one();
    task.await.unwrap().unwrap();
    configure.await.unwrap();
    assert_eq!(probe.disabled.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.invoke("probe", request()).await.unwrap_err().code,
        ErrorCode::FailedPrecondition
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn duplicate_registrations_fail_before_starting_any_resources() {
    let probe = Arc::new(Probe {
        id: "probe",
        ..Default::default()
    });
    let result = Runtime::start(vec![
        registration(probe.clone(), true),
        registration(probe.clone(), true),
    ])
    .await;
    assert_eq!(
        result.err().expect("duplicate must fail").code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(probe.stopped.load(Ordering::SeqCst), 0);
}

struct BlockingProbe {
    started: Arc<Notify>,
    finished: Arc<Notify>,
    released: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    resources: Arc<AtomicUsize>,
}
impl BlockingProbe {
    fn new() -> Self {
        Self {
            started: Arc::default(),
            finished: Arc::default(),
            released: Arc::default(),
            resources: Arc::default(),
        }
    }
    fn release(&self) {
        *self.released.0.lock().unwrap() = true;
        self.released.1.notify_one();
    }
}
impl RuntimePlugin for BlockingProbe {
    fn id(&self) -> &'static str {
        "blocking"
    }
    fn invoke(&self, _: InvokeRequest) -> BoxFuture<'_, Result<InvokeReply, PluginError>> {
        let started = self.started.clone();
        let finished = self.finished.clone();
        let released = self.released.clone();
        let resources = self.resources.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                started.notify_one();
                let _guard = released
                    .1
                    .wait_while(released.0.lock().unwrap(), |released| !*released)
                    .unwrap();
                resources.fetch_add(1, Ordering::SeqCst);
                finished.notify_one();
            })
            .await
            .map_err(|error| PluginError::internal(error.to_string()))?;
            InvokeReply::json("complete", &serde_json::json!({}))
        })
    }
    fn configure(
        &self,
        configuration: PluginConfiguration,
    ) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async move {
            if !configuration.enabled {
                self.resources.store(0, Ordering::SeqCst);
            }
            Ok(())
        })
    }
    fn shutdown(&self) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async {
            self.resources.store(0, Ordering::SeqCst);
            Ok(())
        })
    }
}

#[tokio::test]
async fn cancelled_startup_stays_tracked_until_disable_can_clean_it_up() {
    let plugin = Arc::new(BlockingProbe::new());
    let runtime = Arc::new(
        Runtime::start(vec![registration(plugin.clone(), true)])
            .await
            .unwrap(),
    );
    let request_runtime = runtime.clone();
    let request = tokio::spawn(async move { request_runtime.invoke("blocking", request()).await });
    plugin.started.notified().await;
    request.abort();
    let _ = request.await;
    let configure_runtime = runtime.clone();
    let mut configure =
        tokio::spawn(async move { configure_runtime.configure("blocking", false).await });
    let early = tokio::time::timeout(std::time::Duration::from_millis(30), &mut configure).await;
    plugin.release();
    plugin.finished.notified().await;
    let completed_early = match early {
        Ok(result) => {
            result.unwrap().unwrap();
            true
        }
        Err(_) => {
            configure.await.unwrap().unwrap();
            false
        }
    };
    let active_resources = plugin.resources.load(Ordering::SeqCst);
    runtime.shutdown().await.unwrap();
    assert!(
        !completed_early,
        "disable must wait for uncancellable startup even when its caller disconnects"
    );
    assert_eq!(
        active_resources, 0,
        "a cancelled startup must not register resources after cleanup"
    );
}

#[tokio::test]
async fn shutdown_drains_actual_work_before_releasing_resources() {
    let plugin = Arc::new(BlockingProbe::new());
    let runtime = Arc::new(
        Runtime::start(vec![registration(plugin.clone(), true)])
            .await
            .unwrap(),
    );
    let request_runtime = runtime.clone();
    let request = tokio::spawn(async move { request_runtime.invoke("blocking", request()).await });
    plugin.started.notified().await;
    let shutdown_runtime = runtime.clone();
    let mut shutdown = tokio::spawn(async move { shutdown_runtime.shutdown().await });
    let early = tokio::time::timeout(std::time::Duration::from_millis(30), &mut shutdown).await;
    plugin.release();
    request.await.unwrap().unwrap();
    let completed_early = match early {
        Ok(result) => {
            result.unwrap().unwrap();
            true
        }
        Err(_) => {
            shutdown.await.unwrap().unwrap();
            false
        }
    };
    assert!(
        !completed_early,
        "unload must wait for actual work rather than only dropping service registrations"
    );
    assert_eq!(plugin.resources.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn failed_registration_does_not_disable_healthy_plugins() {
    let healthy = Arc::new(Probe {
        id: "healthy",
        ..Default::default()
    });
    let broken = Arc::new(Probe {
        id: "broken",
        ..Default::default()
    });
    let mut failed = registration(broken, false);
    failed.plugin = Err(PluginError::permission_denied("missing resource grant"));
    let runtime = Runtime::start(vec![failed, registration(healthy.clone(), true)])
        .await
        .unwrap();
    assert!(runtime.failures().contains_key("broken"));
    assert_eq!(
        runtime.invoke("broken", request()).await.unwrap_err().code,
        ErrorCode::Unavailable
    );
    assert_eq!(
        runtime.invoke("healthy", request()).await.unwrap().status,
        "complete"
    );
    runtime.configure("broken", false).await.unwrap();
    runtime.shutdown().await.unwrap();
    assert_eq!(healthy.stopped.load(Ordering::SeqCst), 1);
}

struct FailingInitialization {
    stopped: AtomicUsize,
}

impl RuntimePlugin for FailingInitialization {
    fn id(&self) -> &'static str {
        "failing-initialization"
    }

    fn configure(&self, _: PluginConfiguration) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async { Err(PluginError::unavailable("initialization failed")) })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async {
            self.stopped.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

#[tokio::test]
async fn failed_initialization_disposes_once_and_keeps_healthy_plugins_available() {
    let broken = Arc::new(FailingInitialization {
        stopped: AtomicUsize::new(0),
    });
    let healthy = Arc::new(Probe {
        id: "healthy",
        ..Default::default()
    });
    let runtime = Runtime::start(vec![
        registration(broken.clone(), true),
        registration(healthy.clone(), true),
    ])
    .await
    .unwrap();
    assert!(runtime.failures().contains_key(broken.id()));
    assert_eq!(broken.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime
            .invoke(broken.id(), request())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unavailable
    );
    assert_eq!(
        runtime
            .invoke(healthy.id(), request())
            .await
            .unwrap()
            .status,
        "complete"
    );
    runtime.shutdown().await.unwrap();
    assert_eq!(broken.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(healthy.stopped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dropping_the_configuration_request_does_not_cancel_its_cleanup() {
    let probe = Arc::new(Probe {
        id: "probe",
        block: true,
        ..Default::default()
    });
    let runtime = Arc::new(
        Runtime::start(vec![registration(probe.clone(), true)])
            .await
            .unwrap(),
    );
    let request_runtime = runtime.clone();
    let request_task =
        tokio::spawn(async move { request_runtime.invoke("probe", request()).await });
    probe.entered.notified().await;
    let mut configure = Box::pin(runtime.configure("probe", false));
    assert!(poll_fn(|cx| Poll::Ready(configure.as_mut().poll(cx).is_pending())).await);
    drop(configure);
    probe.release.notify_one();
    request_task.await.unwrap().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while probe.disabled.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cleanup must survive request cancellation");
    assert_eq!(
        runtime.invoke("probe", request()).await.unwrap_err().code,
        ErrorCode::FailedPrecondition
    );
    runtime.shutdown().await.unwrap();
}
