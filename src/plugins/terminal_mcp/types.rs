use std::collections::BTreeSet;

use rmcp::schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::state::PluginRecord;

pub const DEFAULT_POLICY_METADATA: &str = "defaultPolicy";
pub const TRUSTED_CALLERS_METADATA: &str = "trustedCallers";
pub const DENIED_CALLERS_METADATA: &str = "deniedCallers";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalMcpPolicyMode {
    #[default]
    Confirm,
    TrustedCallers,
    SameUserAutomatic,
    ReadOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyAccess {
    Confirm,
    Automatic,
    Denied,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TerminalMcpPolicy {
    pub mode: TerminalMcpPolicyMode,
    pub trusted_callers: BTreeSet<String>,
    pub denied_callers: BTreeSet<String>,
}

impl TerminalMcpPolicy {
    pub fn from_plugin(plugin: &PluginRecord) -> Self {
        let mode = plugin
            .metadata
            .get(DEFAULT_POLICY_METADATA)
            .and_then(|value| serde_json::from_value(serde_json::Value::String(value.clone())).ok())
            .unwrap_or_default();
        Self {
            mode,
            trusted_callers: parse_caller_list(plugin.metadata.get(TRUSTED_CALLERS_METADATA)),
            denied_callers: parse_caller_list(plugin.metadata.get(DENIED_CALLERS_METADATA)),
        }
    }

    pub fn access_for(&self, caller_app_id: &str) -> PolicyAccess {
        if self.denied_callers.contains(caller_app_id) {
            return PolicyAccess::Denied;
        }
        match self.mode {
            TerminalMcpPolicyMode::Confirm => PolicyAccess::Confirm,
            TerminalMcpPolicyMode::TrustedCallers => {
                if self.trusted_callers.contains(caller_app_id) {
                    PolicyAccess::Automatic
                } else {
                    PolicyAccess::Confirm
                }
            }
            TerminalMcpPolicyMode::SameUserAutomatic => PolicyAccess::Automatic,
            TerminalMcpPolicyMode::ReadOnly => PolicyAccess::Denied,
        }
    }
}

fn parse_caller_list(value: Option<&String>) -> BTreeSet<String> {
    value
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .take(128)
        .collect()
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum TerminalCapability {
    Interact,
    Create,
    Terminate,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalBackend {
    Webshell,
    Ssh,
    Herdr,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlDecision {
    Pending,
    Approved,
    Denied,
    Revoked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlTarget {
    pub session_id: String,
    pub backend: String,
    pub label: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub id: String,
    pub user_id: String,
    pub caller_app_id: String,
    pub caller_name: String,
    pub target: ControlTarget,
    pub capability: TerminalCapability,
    pub reason: String,
    pub decision: ControlDecision,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGrant {
    pub id: String,
    pub user_id: String,
    pub caller_app_id: String,
    pub caller_name: String,
    pub target: ControlTarget,
    pub capabilities: BTreeSet<TerminalCapability>,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlAccess {
    Granted(ControlGrant),
    ApprovalRequired(ControlRequest),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSummary {
    pub session_id: String,
    pub backend: TerminalBackend,
    pub title: String,
    pub selector: String,
    pub status: String,
    pub cols: u16,
    pub rows: u16,
    pub busy: bool,
    pub control_granted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFrame {
    pub sequence: u64,
    pub data_base64: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadResult {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub frames: Vec<TerminalOutputFrame>,
    pub next_sequence: u64,
    pub last_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_sequence: Option<u64>,
    pub timed_out: bool,
    pub truncated: bool,
    pub replay_gap: bool,
    pub exited: bool,
}

#[derive(Clone, Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct TerminalMcpError {
    pub code: &'static str,
    pub message: String,
    pub request_id: Option<String>,
}

impl TerminalMcpError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            request_id: None,
        }
    }

    pub fn unauthenticated() -> Self {
        Self::new(
            "UNAUTHENTICATED_CALLER",
            "LazyCat caller identity is required",
        )
    }

    pub fn caller_not_authorized() -> Self {
        Self::new(
            "CALLER_NOT_AUTHORIZED",
            "The caller is not allowed to control terminals",
        )
    }

    pub fn control_denied() -> Self {
        Self::new("CONTROL_DENIED", "Terminal control was denied")
    }

    pub fn control_revoked() -> Self {
        Self::new("CONTROL_REVOKED", "Terminal control was revoked")
    }

    pub fn approval_required(request_id: impl Into<String>) -> Self {
        let request_id = request_id.into();
        Self {
            code: "CONTROL_APPROVAL_REQUIRED",
            message: "Terminal-side approval is required".to_owned(),
            request_id: Some(request_id),
        }
    }

    pub fn disabled() -> Self {
        Self::new("TERMINAL_MCP_DISABLED", "Terminal MCP is disabled")
    }

    pub fn session_not_found() -> Self {
        Self::new("SESSION_NOT_FOUND", "Terminal session was not found")
    }

    pub fn backend_not_supported() -> Self {
        Self::new("BACKEND_NOT_SUPPORTED", "Terminal backend is not supported")
    }

    pub fn pane_not_found() -> Self {
        Self::new("PANE_NOT_FOUND", "Terminal pane was not found")
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("INVALID_INPUT", message)
    }

    pub fn input_backpressure() -> Self {
        Self::new(
            "TERMINAL_INPUT_BACKPRESSURE",
            "Terminal input queue is full; retry later",
        )
    }

    pub fn operation_timeout() -> Self {
        Self::new("OPERATION_TIMEOUT", "Terminal operation timed out")
    }

    pub fn terminal_exited() -> Self {
        Self::new("TERMINAL_EXITED", "Terminal process has exited")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn plugin(mode: &str, trusted: &str, denied: &str) -> PluginRecord {
        PluginRecord {
            id: "terminal-mcp".to_owned(),
            kind: "integration".to_owned(),
            display_name: "Terminal MCP".to_owned(),
            description: String::new(),
            scopes: Vec::new(),
            accepted_content_types: Vec::new(),
            produced_content_types: Vec::new(),
            input_schema_json: "{}".to_owned(),
            output_schema_json: "{}".to_owned(),
            enabled: true,
            metadata: HashMap::from([
                (DEFAULT_POLICY_METADATA.to_owned(), mode.to_owned()),
                (TRUSTED_CALLERS_METADATA.to_owned(), trusted.to_owned()),
                (DENIED_CALLERS_METADATA.to_owned(), denied.to_owned()),
            ]),
        }
    }

    #[test]
    fn parses_policy_and_applies_deny_precedence() {
        let policy = TerminalMcpPolicy::from_plugin(&plugin(
            "trusted_callers",
            r#"["trusted","denied","trusted"]"#,
            r#"["denied"]"#,
        ));

        assert_eq!(policy.mode, TerminalMcpPolicyMode::TrustedCallers);
        assert_eq!(policy.access_for("trusted"), PolicyAccess::Automatic);
        assert_eq!(policy.access_for("unknown"), PolicyAccess::Confirm);
        assert_eq!(policy.access_for("denied"), PolicyAccess::Denied);
    }

    #[test]
    fn malformed_policy_falls_back_to_confirmation() {
        let policy = TerminalMcpPolicy::from_plugin(&plugin("unknown", "not-json", "{}"));

        assert_eq!(policy.mode, TerminalMcpPolicyMode::Confirm);
        assert!(policy.trusted_callers.is_empty());
        assert!(policy.denied_callers.is_empty());
    }

    #[test]
    fn automatic_and_read_only_modes_are_explicit() {
        let automatic = TerminalMcpPolicy::from_plugin(&plugin("same_user_automatic", "[]", "[]"));
        let read_only = TerminalMcpPolicy::from_plugin(&plugin("read_only", "[]", "[]"));

        assert_eq!(automatic.access_for("agent"), PolicyAccess::Automatic);
        assert_eq!(read_only.access_for("agent"), PolicyAccess::Denied);
    }
}
