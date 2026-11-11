//! App-owned Android services. SAF handles are opaque and chunks are at most 64 KiB.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::path::PathBuf;

pub async fn scan_code() -> Result<String> {
    request(json!({"op":"scan"}))
        .await?
        .as_str()
        .map(str::to_owned)
        .context("Scanning cancelled")
}

pub async fn secure_get(key: &str) -> Result<Option<String>> {
    let value = request(json!({"op":"secureGet", "key":key})).await?;
    if value.is_null() {
        Ok(None)
    } else {
        Ok(Some(
            value.as_str().context("Invalid storage reply")?.to_owned(),
        ))
    }
}

pub async fn secure_set(key: &str, value: &str) -> Result<()> {
    request(json!({"op":"secureSet", "key":key, "value":value})).await?;
    Ok(())
}

pub fn data_dir() -> Result<PathBuf> {
    android::data_dir()
}

pub fn drain_events() -> Vec<Value> {
    android::drain_events()
}

pub async fn request(value: Value) -> Result<Value> {
    android::request(value).await
}

const MAX_BUFFERED_FILE: usize = 16 * 1024 * 1024;

pub async fn pick_upload() -> Result<Option<(String, Vec<u8>)>> {
    let picked = request(json!({"op":"pickUpload"})).await?;
    if picked.is_null() {
        return Ok(None);
    }
    let handle = picked["handle"].as_str().context("Missing SAF handle")?;
    let result = async {
        ensure!(
            picked["size"].as_i64().unwrap_or(-1) <= MAX_BUFFERED_FILE as i64,
            "Use streaming upload for files larger than 16 MiB"
        );
        let mut bytes = Vec::new();
        loop {
            let chunk = request(json!({"op":"read", "handle":handle})).await?;
            if chunk["eof"] == true {
                break;
            }
            let decoded = neko_remoted_protocol::decode(
                chunk["data"].as_str().context("Missing file chunk")?,
                65536,
            )?;
            ensure!(
                bytes.len() + decoded.len() <= MAX_BUFFERED_FILE,
                "Use streaming upload for files larger than 16 MiB"
            );
            bytes.extend_from_slice(&decoded);
        }
        Ok(Some((
            picked["name"].as_str().unwrap_or("file").to_owned(),
            bytes,
        )))
    }
    .await;
    let closed = request(json!({"op":"close", "handle":handle})).await;
    match result {
        Ok(value) => {
            closed?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

pub async fn save_download(name: &str, bytes: Vec<u8>) -> Result<()> {
    ensure!(
        bytes.len() <= MAX_BUFFERED_FILE,
        "Use streaming download for files larger than 16 MiB"
    );
    let picked = request(json!({"op":"pickDownload", "name":name})).await?;
    ensure!(!picked.is_null(), "Save cancelled");
    let handle = picked["handle"].as_str().context("Missing SAF handle")?;
    let result = async {
        for chunk in bytes.chunks(65536) {
            request(
                json!({"op":"write", "handle":handle, "data":neko_remoted_protocol::encode(chunk)}),
            )
            .await?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        let cleanup = request(json!({"op":"cancel", "handle":handle})).await;
        return match cleanup {
            Ok(_) => Err(error),
            Err(cleanup) => Err(error.context(format!("Download cleanup failed: {cleanup}"))),
        };
    }
    request(json!({"op":"commit", "handle":handle})).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_requests_can_run_on_controller_workers() {
        fn assert_send(_: impl Send) {}
        assert_send(request(json!({"op":"pickUpload"})));
        assert_send(scan_code());
        assert_send(secure_get("identity"));
        assert_send(secure_set("binding", "{}"));
        assert_send(pick_upload());
        assert_send(save_download("file.bin", Vec::new()));
    }
}

#[cfg(not(target_os = "android"))]
mod android {
    use super::*;
    pub fn data_dir() -> Result<PathBuf> {
        bail!("Android platform host is unavailable")
    }
    pub fn drain_events() -> Vec<Value> {
        Vec::new()
    }
    pub async fn request(_: Value) -> Result<Value> {
        bail!("Android platform host is unavailable")
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::{
        JNIEnv, JavaVM,
        objects::{GlobalRef, JClass, JObject, JString, JValue},
        sys::jlong,
    };
    use std::{
        collections::{HashMap, VecDeque},
        sync::{
            Arc, Mutex, OnceLock,
            atomic::{AtomicU64, Ordering},
        },
        time::Duration,
    };
    use tokio::sync::oneshot;

    struct Host {
        vm: JavaVM,
        bridge: GlobalRef,
        directory: PathBuf,
    }
    type Reply = oneshot::Sender<Result<Value>>;
    static HOST: Mutex<Option<Arc<Host>>> = Mutex::new(None);
    static NEXT: AtomicU64 = AtomicU64::new(1);
    static PENDING: OnceLock<Mutex<HashMap<u64, Reply>>> = OnceLock::new();
    static EVENTS: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());

    fn pending() -> &'static Mutex<HashMap<u64, Reply>> {
        PENDING.get_or_init(Mutex::default)
    }

    pub fn data_dir() -> Result<PathBuf> {
        Ok(HOST
            .lock()
            .map_err(|_| anyhow::anyhow!("Platform lock poisoned"))?
            .as_ref()
            .context("Android host not attached")?
            .directory
            .clone())
    }

    pub fn drain_events() -> Vec<Value> {
        EVENTS
            .lock()
            .map(|mut events| events.drain(..).collect())
            .unwrap_or_default()
    }

    pub async fn request(value: Value) -> Result<Value> {
        let host = HOST
            .lock()
            .map_err(|_| anyhow::anyhow!("Platform lock poisoned"))?
            .clone()
            .context("Android host not attached")?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        ensure!(
            id > 0 && id <= i64::MAX as u64,
            "Platform request IDs exhausted"
        );
        let (sender, receiver) = oneshot::channel();
        {
            let mut replies = pending()
                .lock()
                .map_err(|_| anyhow::anyhow!("Platform lock poisoned"))?;
            ensure!(replies.len() < 64, "Too many pending platform requests");
            replies.insert(id, sender);
        }
        struct RemovePending(u64, Arc<Host>);
        impl Drop for RemovePending {
            fn drop(&mut self) {
                let cancelled = pending()
                    .lock()
                    .map(|mut replies| replies.remove(&self.0).is_some())
                    .unwrap_or(false);
                if cancelled && let Ok(mut env) = self.1.vm.attach_current_thread() {
                    let _ = env.call_method(
                        self.1.bridge.as_obj(),
                        "cancel",
                        "(J)V",
                        &[JValue::Long(self.0 as jlong)],
                    );
                    let _ = env.exception_clear();
                }
            }
        }
        let _guard = RemovePending(id, host.clone());
        {
            let mut env = host.vm.attach_current_thread()?;
            let request = env.new_string(value.to_string())?;
            let called = env.call_method(
                host.bridge.as_obj(),
                "request",
                "(Ljava/lang/String;J)V",
                &[JValue::Object(request.as_ref()), JValue::Long(id as jlong)],
            );
            if env.exception_check()? {
                env.exception_clear()?;
                bail!("Android platform call failed");
            }
            called?;
        }
        tokio::time::timeout(Duration::from_secs(300), receiver)
            .await
            .context("Platform request timed out")?
            .context("Android host dropped reply")?
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_community_lazycat_neko_remoted_PlatformBridge_nativeAttach(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        bridge: JObject<'_>,
        directory: JString<'_>,
    ) {
        let result = (|| -> Result<()> {
            let host = Host {
                vm: env.get_java_vm()?,
                bridge: env.new_global_ref(bridge)?,
                directory: PathBuf::from(String::from(env.get_string(&directory)?)),
            };
            EVENTS
                .lock()
                .map_err(|_| anyhow::anyhow!("Platform event lock poisoned"))?
                .clear();
            *HOST
                .lock()
                .map_err(|_| anyhow::anyhow!("Platform lock poisoned"))? = Some(Arc::new(host));
            Ok(())
        })();
        if result.is_err() {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "Cannot attach Android platform",
            );
        }
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_community_lazycat_neko_remoted_PlatformBridge_nativeEvent(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        id: jlong,
        text: JString<'_>,
    ) {
        let result = (|| -> Result<Value> {
            let text = String::from(env.get_string(&text)?);
            ensure!(text.len() <= 2 * 1024 * 1024, "Platform response too large");
            Ok(serde_json::from_str(&text)?)
        })();
        if id == 0 {
            if let Ok(value) = result {
                if value["result"]["lifecycle"] == "destroyed"
                    && let Ok(mut host) = HOST.lock()
                {
                    host.take();
                }
                if let Ok(mut events) = EVENTS.lock() {
                    if events.len() == 64 {
                        events.pop_front();
                    }
                    events.push_back(value["result"].clone());
                }
            }
        } else if let Ok(mut replies) = pending().lock()
            && let Some(sender) = replies.remove(&(id as u64))
        {
            let _ = sender.send(result.and_then(|value| {
                if let Some(error) = value["error"].as_str() {
                    bail!("{error}");
                }
                Ok(value["result"].clone())
            }));
        }
    }
}
