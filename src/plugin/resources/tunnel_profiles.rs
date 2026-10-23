use crate::database::{AppDatabase, TunnelProviderProfile, TunnelProviderProfileUpsert};
use connectrpc::ConnectError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
const TUNNEL_PROVIDER_PROFILES_METADATA: &str = "tunnelProviderProfiles";
const TUNNEL_PROVIDER_NGROK: &str = "ngrok";
const MAX_TUNNEL_PROVIDER_PROFILES: usize = 16;

pub struct ProfileStore {
    pub database: Arc<AppDatabase>,
}
impl ProfileStore {
    pub fn public_metadata(&self) -> Result<HashMap<String, String>, ConnectError> {
        let profiles = self
            .database
            .list_tunnel_provider_profiles(Some(TUNNEL_PROVIDER_NGROK))
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        let summaries = profiles
            .iter()
            .map(tunnel_provider_profile_summary)
            .collect::<Vec<_>>();
        let profiles_json = serde_json::to_string(&summaries)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        Ok(HashMap::from([
            (TUNNEL_PROVIDER_PROFILES_METADATA.to_owned(), profiles_json),
            ("ngrokProfileCount".to_owned(), summaries.len().to_string()),
        ]))
    }

    pub fn replace(&self, profiles_json: &str) -> Result<(), ConnectError> {
        let inputs = serde_json::from_str::<Vec<TunnelProviderProfileInput>>(profiles_json)
            .map_err(|err| {
                ConnectError::invalid_argument(format!("invalid tunnel provider profiles: {err}"))
            })?;
        if inputs.len() > MAX_TUNNEL_PROVIDER_PROFILES {
            return Err(ConnectError::invalid_argument(format!(
                "at most {MAX_TUNNEL_PROVIDER_PROFILES} tunnel provider profiles are supported"
            )));
        }
        let existing = self
            .database
            .list_tunnel_provider_profiles(Some(TUNNEL_PROVIDER_NGROK))
            .map_err(|err| ConnectError::internal(err.to_string()))?
            .into_iter()
            .map(|profile| (profile.id.clone(), profile))
            .collect::<HashMap<_, _>>();
        let mut seen = std::collections::HashSet::new();
        let mut upserts = Vec::with_capacity(inputs.len());
        for input in inputs {
            let provider = input.provider.trim();
            if provider != TUNNEL_PROVIDER_NGROK {
                return Err(ConnectError::invalid_argument(
                    "only ngrok tunnel provider profiles are supported",
                ));
            }
            let id = input.id.trim();
            if !valid_profile_id(id) {
                return Err(ConnectError::invalid_argument(
                    "invalid tunnel provider profile id",
                ));
            }
            if !seen.insert(id.to_owned()) {
                return Err(ConnectError::invalid_argument(
                    "duplicate tunnel provider profile id",
                ));
            }
            let name = input.name.trim();
            if name.is_empty() || name.len() > 80 {
                return Err(ConnectError::invalid_argument(
                    "tunnel provider profile name must be 1-80 bytes",
                ));
            }
            let authtoken = input
                .authtoken
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if authtoken.is_none()
                && existing
                    .get(id)
                    .and_then(|profile| ngrok_authtoken_from_secret(&profile.secret_json))
                    .is_none()
            {
                return Err(ConnectError::invalid_argument(
                    "ngrok authtoken is required for new profiles",
                ));
            }
            let secret_json =
                authtoken.map(|value| serde_json::json!({ "authtoken": value }).to_string());
            upserts.push(TunnelProviderProfileUpsert {
                id: id.to_owned(),
                provider: provider.to_owned(),
                name: name.to_owned(),
                enabled: input.enabled.unwrap_or(true),
                config_json: "{}".to_owned(),
                secret_json,
            });
        }
        self.database
            .replace_tunnel_provider_profiles(TUNNEL_PROVIDER_NGROK, &upserts)
            .map_err(|err| ConnectError::internal(err.to_string()))
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelProviderProfileInput {
    id: String,
    provider: String,
    name: String,
    enabled: Option<bool>,
    authtoken: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelProviderProfileSummary {
    id: String,
    provider: String,
    name: String,
    enabled: bool,
    configured: bool,
    created_at_ms: u64,
    updated_at_ms: u64,
    last_used_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelNgrokSecret {
    authtoken: Option<String>,
}

fn tunnel_provider_profile_summary(
    profile: &TunnelProviderProfile,
) -> TunnelProviderProfileSummary {
    let _ = &profile.config_json;
    TunnelProviderProfileSummary {
        id: profile.id.clone(),
        provider: profile.provider.clone(),
        name: profile.name.clone(),
        enabled: profile.enabled,
        configured: ngrok_authtoken_from_secret(&profile.secret_json).is_some(),
        created_at_ms: profile.created_at_ms,
        updated_at_ms: profile.updated_at_ms,
        last_used_at_ms: profile.last_used_at_ms,
    }
}

fn ngrok_authtoken_from_secret(secret_json: &str) -> Option<String> {
    serde_json::from_str::<TunnelNgrokSecret>(secret_json)
        .ok()
        .and_then(|secret| secret.authtoken)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn valid_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
