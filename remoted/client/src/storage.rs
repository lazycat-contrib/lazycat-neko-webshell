use anyhow::{Context, Result, ensure};
use neko_remoted_protocol::{self as protocol, RelayAddress, crypto::Identity};
use serde::{Deserialize, Serialize};

const IDENTITY: &str = "remoted.identity.v1";
const BINDINGS: &str = "remoted.bindings.v1";
const LAST_RELAY: &str = "remoted.last-relay.v1";

pub async fn last_relay() -> Result<Option<RelayAddress>> {
    parse_relay_preference(crate::platform::secure_get(LAST_RELAY).await?.as_deref())
}

fn parse_relay_preference(value: Option<&str>) -> Result<Option<RelayAddress>> {
    value
        .map(RelayAddress::parse)
        .transpose()
        .context("已保存的 Relay 地址无效，请重新填写")
}

pub async fn remember_relay(relay: &RelayAddress) -> Result<()> {
    crate::platform::secure_set(LAST_RELAY, relay.origin()).await
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub relay: RelayAddress,
    pub route: String,
    pub host_key: String,
    pub device_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Secret {
    private: String,
    public: String,
}

pub async fn identity() -> Result<Identity> {
    if let Some(value) = crate::platform::secure_get(IDENTITY).await? {
        let saved: Secret =
            serde_json::from_str(&value).context("设备身份存储损坏；请勿覆盖现有身份")?;
        return Ok(Identity::restore(
            protocol::decode32(&saved.private)?,
            protocol::decode32(&saved.public)?,
        ));
    }
    let identity = Identity::generate()?;
    let (private, public) = identity.protected_export();
    let value = serde_json::to_string(&Secret {
        private: protocol::encode(private),
        public: protocol::encode(public),
    })?;
    crate::platform::secure_set(IDENTITY, &value).await?;
    Ok(identity)
}

pub async fn bindings() -> Result<Vec<Binding>> {
    let Some(value) = crate::platform::secure_get(BINDINGS).await? else {
        return Ok(Vec::new());
    };
    let bindings: Vec<Binding> = serde_json::from_str(&value).context("已配对设备存储损坏")?;
    ensure!(bindings.len() <= protocol::MAX_DEVICES, "已配对设备过多");
    for binding in &bindings {
        validate(binding)?;
    }
    Ok(bindings)
}

fn validate(binding: &Binding) -> Result<()> {
    protocol::decode32(&binding.route)?;
    protocol::decode32(&binding.host_key)?;
    ensure!(
        !binding.device_id.is_empty() && binding.device_id.len() <= 256,
        "设备标识无效"
    );
    Ok(())
}

pub async fn remember(binding: Binding) -> Result<Vec<Binding>> {
    let saved = remember_in(bindings().await?, binding)?;
    crate::platform::secure_set(BINDINGS, &serde_json::to_string(&saved)?).await?;
    Ok(saved)
}

fn remember_in(mut saved: Vec<Binding>, binding: Binding) -> Result<Vec<Binding>> {
    validate(&binding)?;
    saved.retain(|item| !(item.relay == binding.relay && item.route == binding.route));
    ensure!(saved.len() < protocol::MAX_DEVICES, "已配对设备已达上限");
    saved.push(binding);
    Ok(saved)
}

pub async fn forget(binding: &Binding) -> Result<Vec<Binding>> {
    let saved = forget_from(bindings().await?, binding);
    crate::platform::secure_set(BINDINGS, &serde_json::to_string(&saved)?).await?;
    Ok(saved)
}

fn forget_from(mut saved: Vec<Binding>, binding: &Binding) -> Vec<Binding> {
    saved.retain(|item| {
        !(item.relay == binding.relay
            && item.route == binding.route
            && item.host_key == binding.host_key)
    });
    saved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_binding_is_not_a_reconnect_target() {
        let binding = Binding {
            relay: RelayAddress::parse("https://relay.example.com").unwrap(),
            route: "bad".into(),
            host_key: protocol::encode(&[1; 32]),
            device_id: "device".into(),
        };
        assert!(validate(&binding).is_err());
    }

    #[test]
    fn saved_relay_prefill_is_canonical_and_missing_is_unconfigured() {
        assert_eq!(parse_relay_preference(None).unwrap(), None);
        assert_eq!(
            parse_relay_preference(Some("https://relay.example.com"))
                .unwrap()
                .unwrap()
                .origin(),
            "wss://relay.example.com"
        );
    }

    #[test]
    fn malformed_or_insecure_saved_relay_is_an_explicit_error() {
        for value in [
            "",
            "not a relay",
            "http://relay.example.com",
            "https://relay.example.com/path",
            "https://user:secret@relay.example.com",
        ] {
            assert!(
                parse_relay_preference(Some(value)).is_err(),
                "preference {value}"
            );
        }
    }

    fn binding(index: u8) -> Binding {
        Binding {
            relay: RelayAddress::parse("https://relay.example.com").unwrap(),
            route: protocol::encode(&[index; 32]),
            host_key: protocol::encode(&[2; 32]),
            device_id: format!("device-{index}"),
        }
    }

    #[test]
    fn local_forget_matches_relay_route_and_host_key_without_deleting_rotated_binding() {
        let original = binding(1);
        let mut rotated = original.clone();
        rotated.host_key = protocol::encode(&[9; 32]);
        let mut other_relay = original.clone();
        other_relay.relay = RelayAddress::parse("https://other.example.com").unwrap();
        let other_route = binding(2);
        let saved = forget_from(
            vec![
                original.clone(),
                rotated.clone(),
                other_relay.clone(),
                other_route.clone(),
            ],
            &original,
        );
        assert_eq!(saved, vec![rotated, other_relay, other_route]);
        assert_eq!(forget_from(saved.clone(), &original), saved);
    }

    #[test]
    fn forgetting_one_binding_recovers_the_full_device_limit() {
        let saved = (0..32).map(binding).collect::<Vec<_>>();
        assert!(remember_in(saved.clone(), binding(32)).is_err());
        let saved = forget_from(saved, &binding(7));
        let saved = remember_in(saved, binding(32)).unwrap();
        assert_eq!(saved.len(), 32);
        assert!(!saved.iter().any(|item| item.route == binding(7).route));
    }
}
