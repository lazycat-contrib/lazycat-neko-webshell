//! Contracts for statically linked, trusted WebShell plugins.
//! Platform authority and terminal ownership stay with the host.
mod resources;
mod runtime;

pub use resources::*;
pub use runtime::*;
pub use rutis::BoxFuture;

use std::collections::HashMap;

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub resources: Vec<String>,
    pub frontend: FrontendEntry,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FrontendEntry {
    pub entry: String,
    pub tool: bool,
    pub icon: String,
    #[serde(rename = "nameKey")]
    pub name_key: String,
    #[serde(rename = "descriptionKey")]
    pub description_key: String,
}

#[derive(Clone, Debug, Default)]
pub struct TargetRequest {
    pub session_id: String,
    pub metadata: HashMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct SessionContext {
    pub id: String,
    pub selector: String,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct PluginConfiguration {
    pub version: u32,
    pub enabled: bool,
    pub metadata: HashMap<String, String>,
}
impl From<bool> for PluginConfiguration {
    fn from(enabled: bool) -> Self {
        Self {
            version: 1,
            enabled,
            metadata: HashMap::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct InvokeRequest {
    pub target: TargetRequest,
    pub operation: String,
    pub content_type: String,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct InvokeReply {
    pub status: String,
    pub content_type: String,
    pub payload: Vec<u8>,
    pub metadata: HashMap<String, String>,
}

impl InvokeReply {
    pub fn json(status: &str, value: &serde_json::Value) -> Result<Self, PluginError> {
        Ok(Self {
            status: status.to_owned(),
            content_type: "application/json".to_owned(),
            payload: serde_json::to_vec(value)
                .map_err(|err| PluginError::internal(err.to_string()))?,
            metadata: HashMap::new(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCode {
    InvalidArgument,
    NotFound,
    FailedPrecondition,
    PermissionDenied,
    Unauthenticated,
    Unavailable,
    DeadlineExceeded,
    ResourceExhausted,
    Unimplemented,
    Internal,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PluginError {
    pub code: ErrorCode,
    pub message: String,
}

macro_rules! errors {
    ($($name:ident => $code:ident),* $(,)?) => {
        impl PluginError {
            $(pub fn $name(message: impl Into<String>) -> Self {
                Self { code: ErrorCode::$code, message: message.into() }
            })*
        }
    };
}
errors! {
    invalid_argument => InvalidArgument,
    not_found => NotFound,
    failed_precondition => FailedPrecondition,
    permission_denied => PermissionDenied,
    unauthenticated => Unauthenticated,
    unavailable => Unavailable,
    deadline_exceeded => DeadlineExceeded,
    resource_exhausted => ResourceExhausted,
    unimplemented => Unimplemented,
    internal => Internal,
}
