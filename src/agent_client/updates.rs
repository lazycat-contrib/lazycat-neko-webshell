use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};

use super::{
    AgentClient, AgentProtocolCompatibility, RemoteAgentLock, agent_payload_identity,
    agent_protocol_compatibility, ensure_agent_binary_installed, invalidate_agent_ensured,
    mark_agent_ensured, ping_agent, prepare_agent_replacement, probe_installed_agent_payload,
    prune_stale_agent_payloads, restart_agent, running_agent_version, scoped_socket_path,
    selector_ensure_lock, wait_for_agent,
};
use crate::agent_protocol::{AGENT_VERSION, MIN_SUPPORTED_AGENT_VERSION};
use crate::proto::lazycat::webshell::v1::AgentResponse;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUpdateStatus {
    pub selector: String,
    pub kind: &'static str,
    pub current_version: Option<u64>,
    pub latest_version: u64,
    pub minimum_version: u64,
    pub protocol: Option<String>,
    pub payload_manifest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentUpdateRequest {
    pub name: String,
    pub optional: bool,
    pub expected_version: Option<u64>,
    pub expected_protocol: Option<String>,
    pub expected_manifest: Option<String>,
}

fn client(selector: &str, username: &str) -> AgentClient {
    AgentClient {
        selector: selector.to_owned(),
        username: username.to_owned(),
        socket_path: scoped_socket_path(selector),
    }
}

fn classify(
    selector: &str,
    response: Option<&AgentResponse>,
    installed: Option<(bool, u64)>,
) -> AgentUpdateStatus {
    let protocol = response.and_then(|value| value.version.clone());
    let current_version = response.and_then(running_agent_version);
    let compatibility = agent_protocol_compatibility(protocol.as_deref());
    let kind = if compatibility == AgentProtocolCompatibility::Newer
        || installed.is_some_and(|(newer, _)| newer)
    {
        "provider_older"
    } else if compatibility != AgentProtocolCompatibility::Current
        || current_version.is_none_or(|version| version < MIN_SUPPORTED_AGENT_VERSION)
    {
        "required"
    } else if current_version.is_some_and(|version| version >= AGENT_VERSION) {
        "ready"
    } else if installed.is_some_and(|(_, version)| version >= AGENT_VERSION) {
        "pending_restart"
    } else {
        "optional"
    };
    AgentUpdateStatus {
        selector: selector.to_owned(),
        kind,
        current_version,
        latest_version: AGENT_VERSION,
        minimum_version: MIN_SUPPORTED_AGENT_VERSION,
        protocol,
        payload_manifest: response.and_then(|value| value.payload_manifest.clone()),
    }
}

pub(crate) async fn inspect(selector: &str, username: &str) -> anyhow::Result<AgentUpdateStatus> {
    let response = ping_agent(&client(selector, username)).await?;
    let installed = probe_installed_agent_payload(selector).await?;
    let installed = installed.as_ref().map(|identity| {
        (
            agent_protocol_compatibility(Some(&identity.protocol_version))
                == AgentProtocolCompatibility::Newer,
            if agent_protocol_compatibility(Some(&identity.protocol_version))
                == AgentProtocolCompatibility::Current
            {
                identity
                    .payload
                    .as_ref()
                    .map_or(0, |payload| payload.agent_version)
            } else {
                0
            },
        )
    });
    Ok(classify(selector, Some(&response), installed))
}

fn validate_update(response: &AgentResponse, request: &AgentUpdateRequest) -> anyhow::Result<()> {
    let status = classify(&request.name, Some(response), None);
    if status.kind == "provider_older" {
        bail!("provider_older");
    }
    let required_kind = if request.optional {
        "optional"
    } else {
        "required"
    };
    if status.kind != required_kind {
        bail!("target_changed");
    }
    if response.version != request.expected_protocol
        || running_agent_version(response) != request.expected_version
        || response.payload_manifest != request.expected_manifest
    {
        bail!("target_changed");
    }
    Ok(())
}

pub(crate) async fn update(
    request: AgentUpdateRequest,
    username: String,
) -> anyhow::Result<AgentUpdateStatus> {
    let lock = selector_ensure_lock(&request.name);
    let _guard = lock.lock().await;
    let remote = RemoteAgentLock::acquire(&request.name).await?;
    let result = async {
        let response = ping_agent(&client(&request.name, &username)).await?;
        let status = classify(&request.name, Some(&response), None);
        if status.kind == "ready" {
            return inspect(&request.name, &username).await;
        }
        validate_update(&response, &request)?;
        let expected = agent_payload_identity().await?;
        if !request.optional {
            let target = client(&request.name, &username);
            let replacement =
                prepare_agent_replacement(&target, &expected, MIN_SUPPORTED_AGENT_VERSION).await?;
            // Revalidate immediately before touching the live process. An unreadable
            // target or a changed identity must never fall into startup recovery.
            let latest = ping_agent(&target).await?;
            let latest_status = classify(&request.name, Some(&latest), None);
            if matches!(latest_status.kind, "ready" | "optional") {
                return inspect(&request.name, &username).await;
            }
            validate_update(&latest, &request)?;
            invalidate_agent_ensured(&request.name);
            restart_agent(&target, &replacement).await?;
            wait_for_agent(&target, &replacement, MIN_SUPPORTED_AGENT_VERSION).await?;
            mark_agent_ensured(&request.name, MIN_SUPPORTED_AGENT_VERSION);
            prune_stale_agent_payloads(&request.name, &replacement).await;
            return inspect(&request.name, &username).await;
        }
        if let Some(installed) = probe_installed_agent_payload(&request.name).await? {
            let compatibility = agent_protocol_compatibility(Some(&installed.protocol_version));
            if compatibility == AgentProtocolCompatibility::Newer {
                bail!("provider_older");
            }
            if compatibility == AgentProtocolCompatibility::Current
                && installed
                    .payload
                    .is_some_and(|payload| payload.agent_version >= AGENT_VERSION)
            {
                return inspect(&request.name, &username).await;
            }
        }
        // Prepare the next launch only. Never restart, signal, or prune a live agent here.
        ensure_agent_binary_installed(&request.name, &expected).await?;
        inspect(&request.name, &username).await
    }
    .await;
    remote
        .release()
        .await
        .map_err(|error| anyhow!("failed to release update lock: {error}"))?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_protocol::AGENT_PROTOCOL_VERSION;
    fn response(protocol: &str, version: u64) -> AgentResponse {
        AgentResponse {
            ok: Some(true),
            version: Some(protocol.to_owned()),
            agent_version: Some(version),
            payload_manifest: Some(format!("sha256:{}", "1".repeat(64))),
            ..Default::default()
        }
    }
    #[test]
    fn update_policy_checks_protocol_before_version_and_never_downgrades() {
        assert_eq!(
            classify(
                "target",
                Some(&response("lazycat-neko-webshell-agent-v3", 999)),
                None
            )
            .kind,
            "required"
        );
        assert_eq!(
            classify(
                "target",
                Some(&response("lazycat-neko-webshell-agent-v5", 1)),
                None
            )
            .kind,
            "provider_older"
        );
        assert_eq!(
            classify(
                "target",
                Some(&response(
                    AGENT_PROTOCOL_VERSION,
                    MIN_SUPPORTED_AGENT_VERSION - 1
                )),
                None
            )
            .kind,
            "required"
        );
        assert_eq!(
            classify(
                "target",
                Some(&response(AGENT_PROTOCOL_VERSION, AGENT_VERSION + 1)),
                None
            )
            .kind,
            "ready"
        );
    }
    #[test]
    fn compatible_old_agents_are_optional_and_staged_payloads_wait_for_restart() {
        let old = response(AGENT_PROTOCOL_VERSION, MIN_SUPPORTED_AGENT_VERSION);
        assert_eq!(classify("target", Some(&old), None).kind, "optional");
        assert_eq!(
            classify("target", Some(&old), Some((false, AGENT_VERSION))).kind,
            "pending_restart"
        );
        assert_eq!(
            classify("target", Some(&old), Some((true, 1))).kind,
            "provider_older"
        );
        let mut same = response(AGENT_PROTOCOL_VERSION, AGENT_VERSION);
        same.payload_manifest = Some(format!("sha256:{}", "2".repeat(64)));
        assert_eq!(classify("target", Some(&same), None).kind, "ready");
    }
    #[test]
    fn required_update_rejects_changed_identity_or_a_now_compatible_agent() {
        let old = response("lazycat-neko-webshell-agent-v3", 999);
        let request = AgentUpdateRequest {
            name: "target".into(),
            optional: false,
            expected_version: old.agent_version,
            expected_protocol: old.version.clone(),
            expected_manifest: old.payload_manifest.clone(),
        };
        assert!(validate_update(&old, &request).is_ok());
        let mut changed = old.clone();
        changed.payload_manifest = Some("changed".into());
        assert!(validate_update(&changed, &request).is_err());
        assert!(
            validate_update(
                &response(AGENT_PROTOCOL_VERSION, MIN_SUPPORTED_AGENT_VERSION),
                &request
            )
            .is_err()
        );
        assert!(validate_update(&response("lazycat-neko-webshell-agent-v5", 1), &request).is_err());
    }
    #[test]
    fn optional_preparation_rejects_changed_running_payloads() {
        let old = response(AGENT_PROTOCOL_VERSION, MIN_SUPPORTED_AGENT_VERSION);
        let mut request = AgentUpdateRequest {
            name: "target".into(),
            optional: true,
            expected_version: old.agent_version,
            expected_protocol: old.version.clone(),
            expected_manifest: old.payload_manifest.clone(),
        };
        assert!(validate_update(&old, &request).is_ok());
        request.expected_manifest = Some("changed".into());
        assert!(validate_update(&old, &request).is_err());
        request.expected_manifest = old.payload_manifest.clone();
        request.expected_version = Some(1);
        assert!(validate_update(&old, &request).is_err());
    }
}
