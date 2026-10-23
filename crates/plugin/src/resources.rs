use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{BoxFuture, InvokeReply, PluginError, SessionContext, TargetRequest};

/// A host builds the table; each plugin receives a copy containing only its grants.
/// This is an API boundary for trusted native code, not a native-code sandbox.
#[derive(Clone, Default)]
pub struct Resources {
    grants: HashSet<String>,
    services: HashMap<String, Arc<dyn Any + Send + Sync>>,
}

impl Resources {
    pub fn provide<T: Send + Sync + 'static>(&mut self, name: &str, service: T) {
        self.services.insert(name.to_owned(), Arc::new(service));
    }

    pub fn scoped(&self, grants: &[String]) -> Self {
        Self {
            grants: grants.iter().cloned().collect(),
            services: self
                .services
                .iter()
                .filter(|(key, _)| grants.contains(key))
                .map(|(key, value)| (key.clone(), Arc::clone(value)))
                .collect(),
        }
    }

    pub fn require<T: Send + Sync + 'static>(&self, name: &str) -> Result<Arc<T>, PluginError> {
        if !self.grants.contains(name) {
            return Err(PluginError::permission_denied(format!(
                "plugin resource was not granted: {name}"
            )));
        }
        self.services
            .get(name)
            .and_then(|service| Arc::clone(service).downcast::<T>().ok())
            .ok_or_else(|| {
                PluginError::unavailable(format!("plugin resource is unavailable: {name}"))
            })
    }
}

/// Canonical identity returned by the host, used to bind transient file operations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetIdentity {
    pub session_id: String,
    pub selector: String,
    pub login_user: String,
}
impl TargetIdentity {
    pub fn upload_owner(&self) -> String {
        serde_json::to_string(&(&self.selector, &self.login_user, &self.session_id))
            .expect("string tuple serialization")
    }
}

pub enum FileOperation {
    List { path: String },
    Stat { path: String },
    Read { path: String, content_type: String },
    Write { path: String, data: Vec<u8> },
}

pub trait TargetFiles: Send + Sync {
    fn authorize<'a>(
        &'a self,
        target: &'a TargetRequest,
    ) -> BoxFuture<'a, Result<TargetIdentity, PluginError>>;
    fn execute<'a>(
        &'a self,
        target: &'a TargetRequest,
        operation: FileOperation,
    ) -> BoxFuture<'a, Result<InvokeReply, PluginError>>;
}

pub trait TargetContext: Send + Sync {
    fn resolve<'a>(
        &'a self,
        target: &'a TargetRequest,
    ) -> BoxFuture<'a, Result<SessionContext, PluginError>>;
}

/// The host binds a namespace and maps legacy persisted keys before supplying this.
pub trait PluginStorage: Send + Sync {
    fn load(&self, key: &str) -> io::Result<Option<Vec<u8>>>;
    fn store(&self, key: &str, value: &[u8]) -> io::Result<()>;
}

pub trait AiPreferences: Send + Sync {
    fn load(&self) -> io::Result<Vec<u8>>;
}

pub trait TunnelProfiles: Send + Sync {
    fn public_metadata(&self) -> Result<HashMap<String, String>, PluginError>;
    fn replace(&self, profiles: &str) -> Result<(), PluginError>;
    fn ngrok_token(&self, profile_id: &str) -> Result<String, PluginError>;
    fn mark_used(&self, profile_id: &str) -> Result<(), PluginError>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebshellNotification {
    pub id: String,
    pub source_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub kind: String,
    pub severity: String,
    #[serde(default = "default_presentation_hint")]
    pub presentation_hint: String,
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub actions: Vec<NotificationAction>,
    pub state: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

fn default_presentation_hint() -> String {
    "center".to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct NewNotification {
    pub source_kind: String,
    pub source_id: Option<String>,
    pub kind: String,
    pub severity: String,
    pub presentation_hint: String,
    pub title: String,
    pub body: String,
    pub url: Option<String>,
    pub actions: Vec<NotificationAction>,
}

pub trait PluginNotifications: Send + Sync {
    fn add(&self, input: NewNotification) -> io::Result<WebshellNotification>;
    fn notification(&self, id: &str) -> io::Result<Option<WebshellNotification>>;
    fn dismiss(&self, id: &str) -> io::Result<Option<WebshellNotification>>;
    fn mark_actioned(&self, id: &str) -> io::Result<Option<WebshellNotification>>;
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().try_into().unwrap_or(u64::MAX)
        })
}

pub trait LightOsForward: Send + Sync {
    fn invoke<'a>(
        &'a self,
        target: &'a TargetRequest,
        operation: &'a str,
    ) -> BoxFuture<'a, Result<InvokeReply, PluginError>>;
    fn stop_all(&self) -> Result<(), PluginError>;
}
