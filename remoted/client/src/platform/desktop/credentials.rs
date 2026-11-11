//! Generation manifests keep large bindings below Windows' per-credential limit.
use super::*;
use serde::{Deserialize, Serialize};

const CHUNK: usize = 512; // Base64 in Windows' UTF-16 password blob stays below 2560 bytes.
const MAX_CHUNKS: usize = 128;

trait Store {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn put(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}
struct SystemStore;
impl Store for SystemStore {
    fn get(&self, key: &str) -> Result<Option<String>> {
        match keyring::Entry::new(SERVICE, key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    fn put(&self, key: &str, value: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, key)?.set_password(value)?;
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, key)?.delete_credential()?;
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    generation: String,
    chunks: usize,
}
impl Manifest {
    fn parse(value: &str) -> Result<Self> {
        let manifest: Self = serde_json::from_str(value)
            .context("Credential manifest is damaged; do not replace the identity")?;
        uuid::Uuid::parse_str(&manifest.generation).context("Invalid credential generation")?;
        ensure!(
            manifest.chunks > 0 && manifest.chunks <= MAX_CHUNKS,
            "Invalid credential chunk count"
        );
        Ok(manifest)
    }
    fn key(&self, key: &str, index: usize) -> String {
        format!("{key}.{}.{index}", self.generation)
    }
}
fn load(store: &impl Store, key: &str) -> Result<Option<String>> {
    let Some(value) = store.get(key)? else {
        return Ok(None);
    };
    let manifest = Manifest::parse(&value)?;
    let mut bytes = Vec::new();
    for index in 0..manifest.chunks {
        let chunk = store
            .get(&manifest.key(key, index))?
            .context("Saved credential chunk is missing; identity was not replaced")?;
        bytes.extend(neko_remoted_protocol::decode(&chunk, CHUNK)?);
    }
    Ok(Some(
        String::from_utf8(bytes).context("Invalid saved credential encoding")?,
    ))
}
fn save(store: &impl Store, key: &str, value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= CHUNK * MAX_CHUNKS,
        "Credential exceeds 64 KiB"
    );
    let old = store
        .get(key)?
        .map(|value| Manifest::parse(&value))
        .transpose()?;
    let manifest = Manifest {
        generation: uuid::Uuid::new_v4().to_string(),
        chunks: value.len().div_ceil(CHUNK),
    };
    for (index, chunk) in value.as_bytes().chunks(CHUNK).enumerate() {
        let name = manifest.key(key, index);
        let encoded = neko_remoted_protocol::encode(chunk);
        if let Err(error) = store.put(&name, &encoded).and_then(|()| {
            ensure!(
                store.get(&name)?.as_deref() == Some(encoded.as_str()),
                "Credential chunk verification failed"
            );
            Ok(())
        }) {
            for written in 0..=index {
                let _ = store.delete(&manifest.key(key, written));
            }
            return Err(
                error.context("Cannot persist credential; previous generation remains active")
            );
        }
    }
    // A failed/ambiguous publication must retain the new chunks: it may have succeeded.
    store.put(key, &serde_json::to_string(&manifest)?)?;
    ensure!(
        load(store, key)?.as_deref() == Some(value),
        "Saved credential verification failed"
    );
    if let Some(old) = old {
        for index in 0..old.chunks {
            let _ = store.delete(&old.key(key, index));
        }
    }
    Ok(())
}
pub(super) fn request(value: &Value) -> Result<Value> {
    let _guard = CREDENTIALS
        .lock()
        .map_err(|_| anyhow::anyhow!("Credential lock poisoned"))?;
    let key = value["key"].as_str().context("Missing credential key")?;
    ensure!(
        [
            "remoted.identity.v1",
            "remoted.bindings.v1",
            "remoted.last-relay.v1"
        ]
        .contains(&key),
        "Unknown credential key"
    );
    if value["op"] == "secureGet" {
        Ok(load(&SystemStore, key)
            .context("Cannot read system credential store; no plaintext fallback")?
            .map_or(Value::Null, Value::String))
    } else {
        save(
            &SystemStore,
            key,
            value["value"]
                .as_str()
                .context("Missing credential value")?,
        )
        .context("Cannot persist system credential store; no plaintext fallback")?;
        Ok(Value::Null)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    #[derive(Default)]
    struct Memory {
        values: RefCell<HashMap<String, String>>,
        fail: RefCell<Option<usize>>,
    }
    impl Store for Memory {
        fn get(&self, key: &str) -> Result<Option<String>> {
            Ok(self.values.borrow().get(key).cloned())
        }
        fn put(&self, key: &str, value: &str) -> Result<()> {
            if let Some(left) = self.fail.borrow_mut().as_mut() {
                ensure!(*left > 0, "store unavailable");
                *left -= 1;
            }
            ensure!(
                value.encode_utf16().count() * 2 <= 2560,
                "Windows credential blob overflow"
            );
            self.values.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.values.borrow_mut().remove(key);
            Ok(())
        }
    }
    #[test]
    fn large_unicode_bindings_persist_and_update_under_windows_blob_limit() {
        let store = Memory::default();
        assert_eq!(load(&store, "bindings").unwrap(), None);
        let first = "配对设备".repeat(2000);
        save(&store, "bindings", &first).unwrap();
        assert_eq!(load(&store, "bindings").unwrap().unwrap(), first);
        save(&store, "bindings", "next").unwrap();
        assert_eq!(load(&store, "bindings").unwrap().unwrap(), "next");
        assert_eq!(store.values.borrow().len(), 2);
    }
    #[test]
    fn unavailable_write_or_missing_chunk_never_becomes_absent_identity() {
        let store = Memory::default();
        save(&store, "identity", "old identity").unwrap();
        *store.fail.borrow_mut() = Some(1);
        assert!(save(&store, "identity", &"x".repeat(2000)).is_err());
        assert_eq!(load(&store, "identity").unwrap().unwrap(), "old identity");
        let manifest = Manifest::parse(store.values.borrow().get("identity").unwrap()).unwrap();
        store.delete(&manifest.key("identity", 0)).unwrap();
        assert!(load(&store, "identity").is_err());
    }
    /// Run only inside an isolated, unlocked Secret Service session; never uses production keys.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires isolated Secret Service; see native-desktop.md"]
    fn real_secret_service_survives_entry_recreation() {
        let key = format!("desktop-test.{}", uuid::Uuid::new_v4());
        save(&SystemStore, &key, "secret identity").unwrap();
        assert_eq!(
            load(&SystemStore, &key).unwrap().unwrap(),
            "secret identity"
        );
        let manifest = Manifest::parse(&SystemStore.get(&key).unwrap().unwrap()).unwrap();
        for index in 0..manifest.chunks {
            SystemStore.delete(&manifest.key(&key, index)).unwrap();
        }
        SystemStore.delete(&key).unwrap();
    }
}
