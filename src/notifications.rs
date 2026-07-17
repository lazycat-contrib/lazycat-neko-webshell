use std::io;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::database::{AppDatabase, KV_NAMESPACE_STATE};
use crate::state::AppState;

const KV_KEY_NOTIFICATIONS: &str = "notifications";
const MAX_RETAINED_NOTIFICATIONS: usize = 100;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedNotifications {
    #[serde(default)]
    notifications: Vec<WebshellNotification>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationListResponse {
    notifications: Vec<WebshellNotification>,
}

#[derive(Clone)]
pub struct NotificationHub {
    database: Arc<AppDatabase>,
    lock: Arc<Mutex<()>>,
}

impl NotificationHub {
    pub fn new(database: Arc<AppDatabase>) -> Self {
        Self {
            database,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn add(&self, input: NewNotification) -> io::Result<WebshellNotification> {
        let _guard = self.lock.lock().expect("notification hub lock poisoned");
        let mut persisted = self.load_unlocked()?;
        let notification = build_notification(input);
        persisted.notifications.push(notification.clone());
        prune_notifications(&mut persisted.notifications);
        self.save_unlocked(&persisted)?;
        Ok(notification)
    }

    pub fn add_if_absent(
        &self,
        source_kind: &str,
        source_id: &str,
        input: NewNotification,
    ) -> io::Result<(WebshellNotification, bool)> {
        let _guard = self.lock.lock().expect("notification hub lock poisoned");
        let mut persisted = self.load_unlocked()?;
        if let Some(notification) = persisted.notifications.iter().find(|notification| {
            notification.source_kind == source_kind
                && notification.source_id.as_deref() == Some(source_id)
                && notification.state != "dismissed"
        }) {
            return Ok((notification.clone(), false));
        }
        let notification = build_notification(input);
        persisted.notifications.push(notification.clone());
        prune_notifications(&mut persisted.notifications);
        self.save_unlocked(&persisted)?;
        Ok((notification, true))
    }

    pub fn list_active(&self) -> io::Result<Vec<WebshellNotification>> {
        let _guard = self.lock.lock().expect("notification hub lock poisoned");
        let mut notifications = self.load_unlocked()?.notifications;
        notifications.retain(|notification| notification.state != "dismissed");
        notifications.sort_by(|left, right| {
            right
                .created_at_ms
                .cmp(&left.created_at_ms)
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(notifications)
    }

    pub fn notification(&self, id: &str) -> io::Result<Option<WebshellNotification>> {
        let _guard = self.lock.lock().expect("notification hub lock poisoned");
        Ok(self
            .load_unlocked()?
            .notifications
            .into_iter()
            .find(|notification| notification.id == id))
    }

    pub fn mark_read(&self, id: &str) -> io::Result<Option<WebshellNotification>> {
        self.update_state(id, |notification, now| {
            if notification.state == "unread" {
                "read".clone_into(&mut notification.state);
                notification.updated_at_ms = now;
            }
        })
    }

    pub fn dismiss(&self, id: &str) -> io::Result<Option<WebshellNotification>> {
        self.update_state(id, |notification, now| {
            "dismissed".clone_into(&mut notification.state);
            notification.updated_at_ms = now;
        })
    }

    pub fn mark_actioned(&self, id: &str) -> io::Result<Option<WebshellNotification>> {
        self.update_state(id, |notification, now| {
            "actioned".clone_into(&mut notification.state);
            notification.updated_at_ms = now;
        })
    }

    pub fn mark_source_actioned(
        &self,
        source_kind: &str,
        source_id: &str,
    ) -> io::Result<Option<WebshellNotification>> {
        let _guard = self.lock.lock().expect("notification hub lock poisoned");
        let mut persisted = self.load_unlocked()?;
        let now = now_ms();
        let mut updated = None;
        if let Some(notification) = persisted.notifications.iter_mut().find(|notification| {
            notification.source_kind == source_kind
                && notification.source_id.as_deref() == Some(source_id)
        }) {
            "actioned".clone_into(&mut notification.state);
            notification.updated_at_ms = now;
            updated = Some(notification.clone());
        }
        if updated.is_some() {
            self.save_unlocked(&persisted)?;
        }
        Ok(updated)
    }

    fn update_state(
        &self,
        id: &str,
        update: impl FnOnce(&mut WebshellNotification, u64),
    ) -> io::Result<Option<WebshellNotification>> {
        let _guard = self.lock.lock().expect("notification hub lock poisoned");
        let mut persisted = self.load_unlocked()?;
        let now = now_ms();
        let mut updated = None;
        if let Some(notification) = persisted
            .notifications
            .iter_mut()
            .find(|notification| notification.id == id)
        {
            update(notification, now);
            updated = Some(notification.clone());
        }
        if updated.is_some() {
            prune_notifications(&mut persisted.notifications);
            self.save_unlocked(&persisted)?;
        }
        Ok(updated)
    }

    fn load_unlocked(&self) -> io::Result<PersistedNotifications> {
        let Some(bytes) = self
            .database
            .load_kv(KV_NAMESPACE_STATE, KV_KEY_NOTIFICATIONS)?
        else {
            return Ok(PersistedNotifications {
                notifications: Vec::new(),
            });
        };
        if let Ok(persisted) = serde_json::from_slice::<PersistedNotifications>(&bytes) {
            return Ok(persisted);
        }
        let notifications = serde_json::from_slice::<Vec<WebshellNotification>>(&bytes)
            .map_err(|err| io::Error::other(err.to_string()))?;
        Ok(PersistedNotifications { notifications })
    }

    fn save_unlocked(&self, persisted: &PersistedNotifications) -> io::Result<()> {
        let bytes =
            serde_json::to_vec(persisted).map_err(|err| io::Error::other(err.to_string()))?;
        self.database
            .store_kv(KV_NAMESPACE_STATE, KV_KEY_NOTIFICATIONS, &bytes)
    }
}

fn build_notification(input: NewNotification) -> WebshellNotification {
    let now = now_ms();
    WebshellNotification {
        id: Uuid::new_v4().to_string(),
        source_kind: normalize_token(&input.source_kind, "system"),
        source_id: normalize_optional_string(input.source_id),
        kind: normalize_kind(&input.kind),
        severity: normalize_severity(&input.severity),
        presentation_hint: normalize_presentation_hint(&input.presentation_hint),
        title: input.title.trim().to_owned(),
        body: input.body.trim().to_owned(),
        url: normalize_notification_url(input.url),
        actions: input
            .actions
            .into_iter()
            .filter_map(normalize_action)
            .collect(),
        state: "unread".to_owned(),
        created_at_ms: now,
        updated_at_ms: now,
    }
}

pub async fn get_notifications(State(state): State<Arc<AppState>>) -> Response {
    match state.notifications.list_active() {
        Ok(notifications) => Json(NotificationListResponse { notifications }).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read notifications: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_notification_read(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    notification_update_response(state.notifications.mark_read(&id), "read")
}

pub async fn post_notification_dismiss(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    notification_update_response(state.notifications.dismiss(&id), "dismiss")
}

fn notification_update_response(
    result: io::Result<Option<WebshellNotification>>,
    operation: &str,
) -> Response {
    match result {
        Ok(Some(notification)) => Json(notification).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "notification not found").into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to {operation} notification: {err}"),
        )
            .into_response(),
    }
}

pub fn now_ms() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

fn prune_notifications(notifications: &mut Vec<WebshellNotification>) {
    notifications.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| right.id.cmp(&left.id))
    });
    notifications.truncate(MAX_RETAINED_NOTIFICATIONS);
}

fn normalize_action(action: NotificationAction) -> Option<NotificationAction> {
    let id = normalize_token(&action.id, "");
    if id.is_empty() {
        return None;
    }
    let label = action.label.trim();
    if label.is_empty() {
        return None;
    }
    Some(NotificationAction {
        id,
        label: label.to_owned(),
        style: action
            .style
            .as_deref()
            .and_then(|style| match style.trim() {
                "primary" => Some("primary".to_owned()),
                "danger" => Some("danger".to_owned()),
                _ => None,
            }),
        payload: action.payload,
    })
}

fn normalize_kind(value: &str) -> String {
    match value.trim() {
        "interactive" => "interactive".to_owned(),
        "link" => "link".to_owned(),
        _ => "message".to_owned(),
    }
}

fn normalize_severity(value: &str) -> String {
    match value.trim() {
        "success" => "success".to_owned(),
        "warning" => "warning".to_owned(),
        "error" => "error".to_owned(),
        _ => "info".to_owned(),
    }
}

fn normalize_presentation_hint(value: &str) -> String {
    match value.trim() {
        "modal" => "modal".to_owned(),
        "toast" => "toast".to_owned(),
        _ => "center".to_owned(),
    }
}

fn default_presentation_hint() -> String {
    "center".to_owned()
}

fn normalize_notification_url(value: Option<String>) -> Option<String> {
    let value = normalize_optional_string(value)?;
    if value.starts_with('/')
        || value.starts_with("https://")
        || value.starts_with("http://127.0.0.1")
        || value.starts_with("http://localhost")
    {
        Some(value)
    } else {
        None
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    if value.is_empty() { None } else { Some(value) }
}

fn normalize_token(value: &str, fallback: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || *character == '-'
                || *character == '_'
                || *character == '.'
        })
        .collect::<String>();
    if normalized.is_empty() {
        fallback.to_owned()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::{NewNotification, NotificationAction, NotificationHub, normalize_token};
    use crate::database::{AppDatabase, remove_database_file};
    use serde_json::Value;
    use std::sync::Arc;

    #[test]
    fn notification_action_ids_keep_dotted_namespaces() {
        assert_eq!(normalize_token(" pomodoro.again ", ""), "pomodoro.again");
    }

    #[test]
    fn add_preserves_dotted_action_ids() {
        let path = std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-notifications-{}.db",
            std::process::id()
        ));
        let _ = remove_database_file(&path);
        let database = Arc::new(AppDatabase::open(path.clone()).expect("test database"));
        let hub = NotificationHub::new(database);

        let notification = hub
            .add(NewNotification {
                source_kind: "pomodoro".to_owned(),
                source_id: None,
                kind: "interactive".to_owned(),
                severity: "success".to_owned(),
                presentation_hint: "modal".to_owned(),
                title: "Done".to_owned(),
                body: "Complete".to_owned(),
                url: None,
                actions: vec![NotificationAction {
                    id: "pomodoro.again".to_owned(),
                    label: "Start another".to_owned(),
                    style: Some("primary".to_owned()),
                    payload: Value::Null,
                }],
            })
            .expect("notification stored");

        assert_eq!(notification.actions[0].id, "pomodoro.again");
        let _ = remove_database_file(&path);
    }
}
