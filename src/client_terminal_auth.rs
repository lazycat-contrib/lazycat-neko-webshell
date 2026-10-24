use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::os::unix::fs::MetadataExt as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context as _;
use lzc_sdk::{ClientCredentials, CredentialPaths, TokenProvider};
use reqwest::Url;
use tokio::sync::{Mutex, OnceCell};

const MAX_DEVICE_PROVIDERS: usize = 32;
const DEVICE_PROVIDER_IDLE_TIMEOUT: Duration = Duration::from_mins(5);

#[derive(Clone, Eq, Hash, PartialEq)]
struct CredentialFile {
    device: u64,
    inode: u64,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct CredentialGeneration([CredentialFile; 3]);

impl CredentialGeneration {
    async fn read(paths: &CredentialPaths) -> anyhow::Result<Self> {
        let mut files = Vec::with_capacity(3);
        for path in [
            &paths.box_certificate,
            &paths.application_certificate,
            &paths.application_private_key,
        ] {
            let metadata = tokio::fs::metadata(path)
                .await
                .context("device credentials are unavailable")?;
            files.push(CredentialFile {
                device: metadata.dev(),
                inode: metadata.ino(),
                size: metadata.size(),
                modified: (metadata.mtime(), metadata.mtime_nsec()),
                changed: (metadata.ctime(), metadata.ctime_nsec()),
            });
        }
        let files = files
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid credential generation"))?;
        Ok(Self(files))
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct ProviderKey {
    account: String,
    client_id: String,
    endpoint: String,
    generation: CredentialGeneration,
}

pub(crate) struct DeviceAuthLease {
    key: ProviderKey,
    pub provider: Arc<TokenProvider>,
}

pub(crate) struct DeviceAuthCache {
    providers: ProviderCache<ProviderKey, TokenProvider>,
}

impl Default for DeviceAuthCache {
    fn default() -> Self {
        Self {
            providers: ProviderCache::new(MAX_DEVICE_PROVIDERS, DEVICE_PROVIDER_IDLE_TIMEOUT),
        }
    }
}

impl DeviceAuthCache {
    pub async fn provider(
        &self,
        account: &str,
        client_id: &str,
        endpoint: &Url,
    ) -> anyhow::Result<DeviceAuthLease> {
        let paths = CredentialPaths::runtime();
        let generation = CredentialGeneration::read(&paths).await?;
        let key = ProviderKey {
            account: account.to_owned(),
            client_id: client_id.to_owned(),
            endpoint: endpoint.as_str().to_owned(),
            generation: generation.clone(),
        };
        let provider = self
            .providers
            .get_or_try_init(key.clone(), || async {
                let credentials = ClientCredentials::load(paths.clone())
                    .await
                    .context("failed to load device credentials")?;
                if CredentialGeneration::read(&paths).await? != generation {
                    anyhow::bail!("device credentials changed while loading");
                }
                TokenProvider::connect(endpoint.as_str(), credentials)
                    .await
                    .context("failed to connect device authentication")
            })
            .await?;
        Ok(DeviceAuthLease { key, provider })
    }

    pub async fn invalidate(&self, lease: &DeviceAuthLease) {
        self.providers
            .remove_if_same(&lease.key, &lease.provider)
            .await;
    }
}

struct ProviderSlot<Value> {
    value: Arc<OnceCell<Arc<Value>>>,
    last_used: Instant,
}

struct ProviderCache<Key, Value> {
    capacity: usize,
    idle_timeout: Duration,
    slots: Mutex<HashMap<Key, ProviderSlot<Value>>>,
}

impl<Key: Clone + Eq + Hash, Value> ProviderCache<Key, Value> {
    fn new(capacity: usize, idle_timeout: Duration) -> Self {
        Self {
            capacity,
            idle_timeout,
            slots: Mutex::new(HashMap::new()),
        }
    }

    async fn get_or_try_init<Init, Pending>(
        &self,
        key: Key,
        init: Init,
    ) -> anyhow::Result<Arc<Value>>
    where
        Init: FnOnce() -> Pending,
        Pending: Future<Output = anyhow::Result<Value>>,
    {
        let cell = {
            let mut slots = self.slots.lock().await;
            let now = Instant::now();
            slots.retain(|_, slot| {
                Arc::strong_count(&slot.value) > 1
                    || now.duration_since(slot.last_used) < self.idle_timeout
            });
            if !slots.contains_key(&key) && slots.len() >= self.capacity {
                let oldest = slots
                    .iter()
                    .filter(|(_, slot)| Arc::strong_count(&slot.value) == 1)
                    .min_by_key(|(_, slot)| slot.last_used)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    slots.remove(&oldest);
                } else {
                    anyhow::bail!("device authentication cache is busy");
                }
            }
            let slot = slots.entry(key).or_insert_with(|| ProviderSlot {
                value: Arc::new(OnceCell::new()),
                last_used: now,
            });
            slot.last_used = now;
            Arc::clone(&slot.value)
        };
        cell.get_or_try_init(|| async { init().await.map(Arc::new) })
            .await
            .map(Arc::clone)
    }

    async fn remove_if_same(&self, key: &Key, value: &Arc<Value>) {
        let mut slots = self.slots.lock().await;
        if slots
            .get(key)
            .and_then(|slot| slot.value.get())
            .is_some_and(|cached| Arc::ptr_eq(cached, value))
        {
            slots.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use tokio::sync::oneshot;

    use super::ProviderCache;

    #[tokio::test]
    async fn concurrent_requests_share_one_provider() {
        let cache = ProviderCache::new(4, Duration::from_mins(1));
        let connects = AtomicUsize::new(0);
        let load = || {
            cache.get_or_try_init("device-a", || async {
                connects.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok(42)
            })
        };
        let (first, second) = tokio::join!(load(), load());
        let (first, second) = (first.unwrap(), second.unwrap());
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(connects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn distinct_endpoints_and_credentials_never_share() {
        let cache = ProviderCache::new(4, Duration::from_mins(1));
        let first = cache
            .get_or_try_init(("device-a/root", 1), || async { Ok(1) })
            .await
            .unwrap();
        let other_path = cache
            .get_or_try_init(("device-a/other", 1), || async { Ok(2) })
            .await
            .unwrap();
        let rotated = cache
            .get_or_try_init(("device-a/root", 2), || async { Ok(3) })
            .await
            .unwrap();
        assert_eq!((*first, *other_path, *rotated), (1, 2, 3));
    }

    #[tokio::test]
    async fn failed_initialization_can_retry() {
        let cache = ProviderCache::new(1, Duration::from_mins(1));
        assert!(
            cache
                .get_or_try_init("device", || async { anyhow::bail!("unavailable") })
                .await
                .is_err()
        );
        let provider = cache
            .get_or_try_init("device", || async { Ok(42) })
            .await
            .unwrap();
        assert_eq!(*provider, 42);
        let reused = cache
            .get_or_try_init("device", || async { Ok(99) })
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&provider, &reused));
    }

    #[tokio::test]
    async fn cancelled_initialization_can_retry() {
        let cache = Arc::new(ProviderCache::new(1, Duration::from_mins(1)));
        let task_cache = Arc::clone(&cache);
        let (started, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            task_cache
                .get_or_try_init("device", || async {
                    let _ = started.send(());
                    std::future::pending::<anyhow::Result<i32>>().await
                })
                .await
        });
        ready.await.unwrap();
        task.abort();
        let _ = task.await;
        assert_eq!(
            *cache
                .get_or_try_init("device", || async { Ok(42) })
                .await
                .unwrap(),
            42
        );
        assert_eq!(
            *cache
                .get_or_try_init("device", || async { Ok(99) })
                .await
                .unwrap(),
            42
        );
    }

    #[tokio::test]
    async fn waiting_request_recovers_when_initializer_is_cancelled() {
        let cache = Arc::new(ProviderCache::new(1, Duration::from_mins(1)));
        let task_cache = Arc::clone(&cache);
        let (started, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            task_cache
                .get_or_try_init("device", || async {
                    let _ = started.send(());
                    std::future::pending::<anyhow::Result<i32>>().await
                })
                .await
        });
        ready.await.unwrap();
        let waiter_cache = Arc::clone(&cache);
        let waiter = tokio::spawn(async move {
            waiter_cache
                .get_or_try_init("device", || async { Ok(42) })
                .await
        });
        tokio::task::yield_now().await;
        task.abort();
        let _ = task.await;
        let value = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(*value, 42);
    }

    #[tokio::test]
    async fn unrelated_device_does_not_wait_for_slow_connection() {
        let cache = ProviderCache::new(2, Duration::from_mins(1));
        let slow = cache.get_or_try_init("slow", std::future::pending::<anyhow::Result<i32>>);
        let fast = cache.get_or_try_init("fast", || async { Ok(42) });
        tokio::select! {
            _ = slow => panic!("slow initializer unexpectedly completed"),
            result = fast => assert_eq!(*result.unwrap(), 42),
            () = tokio::time::sleep(Duration::from_secs(1)) => panic!("unrelated device was blocked"),
        }
    }

    #[tokio::test]
    async fn cache_evicts_idle_provider_at_capacity() {
        let cache = ProviderCache::new(1, Duration::from_mins(1));
        let first = cache
            .get_or_try_init("first", || async { Ok(1) })
            .await
            .unwrap();
        let second = cache
            .get_or_try_init("second", || async { Ok(2) })
            .await
            .unwrap();
        assert_eq!((*first, *second), (1, 2));
        assert_eq!(cache.slots.lock().await.len(), 1);
        let replaced = cache
            .get_or_try_init("first", || async { Ok(3) })
            .await
            .unwrap();
        assert_eq!(*replaced, 3);
    }

    #[tokio::test]
    async fn expired_provider_is_rebuilt() {
        let cache = ProviderCache::new(1, Duration::from_mins(1));
        let first = cache
            .get_or_try_init("device", || async { Ok(1) })
            .await
            .unwrap();
        cache
            .slots
            .lock()
            .await
            .get_mut("device")
            .unwrap()
            .last_used -= Duration::from_secs(61);
        let replacement = cache
            .get_or_try_init("device", || async { Ok(2) })
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &replacement));
        assert_eq!(*replacement, 2);
    }

    #[tokio::test]
    async fn stale_rejection_cannot_invalidate_replacement() {
        let cache = ProviderCache::new(1, Duration::from_mins(1));
        let first = cache
            .get_or_try_init("device", || async { Ok(1) })
            .await
            .unwrap();
        cache.remove_if_same(&"device", &first).await;
        let replacement = cache
            .get_or_try_init("device", || async { Ok(2) })
            .await
            .unwrap();
        cache.remove_if_same(&"device", &first).await;
        let reused = cache
            .get_or_try_init("device", || async { Ok(3) })
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&replacement, &reused));
    }

    #[tokio::test]
    async fn in_flight_initialization_is_bounded_and_not_evicted() {
        let cache = Arc::new(ProviderCache::new(1, Duration::from_mins(1)));
        let task_cache = Arc::clone(&cache);
        let (started, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            task_cache
                .get_or_try_init("slow", || async {
                    let _ = started.send(());
                    std::future::pending::<anyhow::Result<i32>>().await
                })
                .await
        });
        ready.await.unwrap();
        let error = cache
            .get_or_try_init("other", || async { Ok(2) })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("busy"));
        assert_eq!(cache.slots.lock().await.len(), 1);
        task.abort();
        let _ = task.await;
        assert_eq!(
            *cache
                .get_or_try_init("other", || async { Ok(2) })
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn credential_rotation_and_missing_files_change_generation() {
        use super::CredentialGeneration;
        use lzc_sdk::CredentialPaths;

        let directory =
            std::env::temp_dir().join(format!("neko-auth-generation-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&directory).await.unwrap();
        let paths = CredentialPaths {
            box_certificate: directory.join("box"),
            application_certificate: directory.join("cert"),
            application_private_key: directory.join("key"),
        };
        for path in [
            &paths.box_certificate,
            &paths.application_certificate,
            &paths.application_private_key,
        ] {
            tokio::fs::write(path, b"fixture").await.unwrap();
        }
        let first = CredentialGeneration::read(&paths).await.unwrap();
        assert!(first == CredentialGeneration::read(&paths).await.unwrap());
        let replacement = directory.join("replacement");
        tokio::fs::write(&replacement, b"changed").await.unwrap();
        tokio::fs::rename(replacement, &paths.application_certificate)
            .await
            .unwrap();
        assert!(first != CredentialGeneration::read(&paths).await.unwrap());
        tokio::fs::remove_file(&paths.application_private_key)
            .await
            .unwrap();
        assert!(CredentialGeneration::read(&paths).await.is_err());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
