use std::collections::{HashMap, VecDeque};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use lzc_sdk::proto::common::{EndDevice, ListEndDeviceRequest};
use lzc_sdk::proto::localdevice::{
    NotifyRequest, notification_service_client::NotificationServiceClient,
};
use lzc_sdk::{ApiGateway, ClientCredentials, CredentialPaths, TokenProvider, with_real_uid};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OnceCell, Semaphore};
use tokio::time::timeout;
use tonic::Request;
use tracing::warn;

use crate::state::AppState;

const NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(10);
const NOTIFICATION_RATE_WINDOW: Duration = Duration::from_mins(1);
const NOTIFICATION_DUPLICATE_WINDOW: Duration = Duration::from_secs(3);
const MAX_NOTIFICATIONS_PER_WINDOW: usize = 30;
const MAX_CONCURRENT_NOTIFICATIONS: usize = 4;
const MAX_TITLE_CHARS: usize = 80;
const MAX_BODY_CHARS: usize = 240;

pub struct HerdrNotificationSender {
    runtime: OnceCell<LazycatNotificationRuntime>,
    concurrency: Semaphore,
    deliveries: StdMutex<NotificationDeliveryPolicy>,
}

impl Default for HerdrNotificationSender {
    fn default() -> Self {
        Self {
            runtime: OnceCell::const_new(),
            concurrency: Semaphore::new(MAX_CONCURRENT_NOTIFICATIONS),
            deliveries: StdMutex::new(NotificationDeliveryPolicy::default()),
        }
    }
}

struct LazycatNotificationRuntime {
    credentials: ClientCredentials,
    gateway: ApiGateway,
    providers: Mutex<HashMap<String, CachedDeviceProvider>>,
}

struct CachedDeviceProvider {
    api_url: String,
    provider: TokenProvider,
}

#[derive(Default)]
struct NotificationDeliveryPolicy {
    recent: HashMap<(String, String), VecDeque<NotificationDelivery>>,
}

struct NotificationDelivery {
    at: Instant,
    title: String,
    body: String,
}

enum NotificationDeliveryDecision {
    Deliver,
    Duplicate,
    RateLimited,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HerdrLazycatNotificationRequest {
    title: String,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrLazycatNotificationResponse {
    sent: bool,
}

pub async fn post_herdr_lazycat_notification(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<HerdrLazycatNotificationRequest>,
) -> Result<Json<HerdrLazycatNotificationResponse>, (StatusCode, String)> {
    let user_id = required_header(&headers, "x-hc-user-id")?;
    let device_id = required_header(&headers, "x-hc-device-id")?;
    let title = sanitize_notification_text(&request.title, MAX_TITLE_CHARS).ok_or((
        StatusCode::BAD_REQUEST,
        "notification title is empty".to_owned(),
    ))?;
    let body = sanitize_notification_text(&request.body, MAX_BODY_CHARS).unwrap_or_default();
    match state.herdr_notifications.delivery_decision(
        &user_id,
        &device_id,
        &title,
        &body,
        Instant::now(),
    ) {
        NotificationDeliveryDecision::Duplicate => {
            return Ok(Json(HerdrLazycatNotificationResponse { sent: false }));
        }
        NotificationDeliveryDecision::RateLimited => {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "LazyCat notification rate limit exceeded".to_owned(),
            ));
        }
        NotificationDeliveryDecision::Deliver => {}
    }

    timeout(NOTIFICATION_TIMEOUT, async {
        let _permit = state
            .herdr_notifications
            .concurrency
            .acquire()
            .await
            .context("LazyCat notification sender was closed")?;
        state
            .herdr_notifications
            .deliver_to_current_device(&user_id, &device_id, title, body)
            .await
    })
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            "LazyCat notification delivery timed out".to_owned(),
        )
    })?
    .map_err(|error| {
        warn!(error = %error, "failed to send Herdr LazyCat notification");
        (
            StatusCode::BAD_GATEWAY,
            "failed to send LazyCat notification".to_owned(),
        )
    })?;

    Ok(Json(HerdrLazycatNotificationResponse { sent: true }))
}

impl HerdrNotificationSender {
    fn delivery_decision(
        &self,
        user_id: &str,
        device_id: &str,
        title: &str,
        body: &str,
        now: Instant,
    ) -> NotificationDeliveryDecision {
        let mut deliveries = self
            .deliveries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        deliveries.decision(user_id, device_id, title, body, now)
    }

    async fn deliver_to_current_device(
        &self,
        user_id: &str,
        device_id: &str,
        title: String,
        body: String,
    ) -> anyhow::Result<()> {
        let runtime = self.runtime().await?;
        let mut list_request = Request::new(ListEndDeviceRequest {
            uid: user_id.to_owned(),
        });
        with_real_uid(&mut list_request, user_id)
            .context("failed to attach LazyCat user context")?;
        let devices = runtime
            .gateway
            .devices()
            .list_end_devices(list_request)
            .await
            .context("failed to list LazyCat user devices")?
            .into_inner()
            .devices;
        let api_url = current_device_api_url(&devices, device_id)?.to_owned();
        let provider = runtime.device_provider(device_id, &api_url).await?;

        let mut notifications = NotificationServiceClient::new(provider.authenticated_service());
        let result = notifications
            .notify(NotifyRequest {
                title,
                body,
                deeplink_url: None,
            })
            .await
            .context("current LazyCat device rejected the notification");
        if result.is_err() {
            runtime
                .invalidate_device_provider(device_id, &api_url)
                .await;
        }
        result.map(|_| ())
    }

    async fn runtime(&self) -> anyhow::Result<&LazycatNotificationRuntime> {
        self.runtime
            .get_or_try_init(|| async {
                let credentials = ClientCredentials::load(CredentialPaths::runtime())
                    .await
                    .context("failed to load LazyCat application credentials")?;
                let gateway = ApiGateway::connect_with(credentials.clone())
                    .await
                    .context("failed to connect LazyCat API gateway")?;
                Ok(LazycatNotificationRuntime {
                    credentials,
                    gateway,
                    providers: Mutex::new(HashMap::new()),
                })
            })
            .await
    }
}

impl LazycatNotificationRuntime {
    async fn device_provider(
        &self,
        device_id: &str,
        api_url: &str,
    ) -> anyhow::Result<TokenProvider> {
        if let Some(provider) = self
            .providers
            .lock()
            .await
            .get(device_id)
            .and_then(|cached| (cached.api_url == api_url).then(|| cached.provider.clone()))
        {
            return Ok(provider);
        }
        let provider = TokenProvider::connect(api_url, self.credentials.clone())
            .await
            .context("failed to connect current LazyCat device")?;
        self.providers.lock().await.insert(
            device_id.to_owned(),
            CachedDeviceProvider {
                api_url: api_url.to_owned(),
                provider: provider.clone(),
            },
        );
        Ok(provider)
    }

    async fn invalidate_device_provider(&self, device_id: &str, api_url: &str) {
        let mut providers = self.providers.lock().await;
        if providers
            .get(device_id)
            .is_some_and(|cached| cached.api_url == api_url)
        {
            providers.remove(device_id);
        }
    }
}

impl NotificationDeliveryPolicy {
    fn decision(
        &mut self,
        user_id: &str,
        device_id: &str,
        title: &str,
        body: &str,
        now: Instant,
    ) -> NotificationDeliveryDecision {
        self.recent.retain(|_, deliveries| {
            deliveries.back().is_some_and(|delivery| {
                now.saturating_duration_since(delivery.at) < NOTIFICATION_RATE_WINDOW
            })
        });
        let deliveries = self
            .recent
            .entry((user_id.to_owned(), device_id.to_owned()))
            .or_default();
        while deliveries.front().is_some_and(|delivery| {
            now.saturating_duration_since(delivery.at) >= NOTIFICATION_RATE_WINDOW
        }) {
            deliveries.pop_front();
        }
        if deliveries.iter().rev().any(|delivery| {
            now.saturating_duration_since(delivery.at) < NOTIFICATION_DUPLICATE_WINDOW
                && delivery.title == title
                && delivery.body == body
        }) {
            return NotificationDeliveryDecision::Duplicate;
        }
        if deliveries.len() >= MAX_NOTIFICATIONS_PER_WINDOW {
            return NotificationDeliveryDecision::RateLimited;
        }
        deliveries.push_back(NotificationDelivery {
            at: now,
            title: title.to_owned(),
            body: body.to_owned(),
        });
        NotificationDeliveryDecision::Deliver
    }
}

fn required_header(
    headers: &HeaderMap,
    name: &'static str,
) -> Result<String, (StatusCode, String)> {
    let value = headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("missing LazyCat request header: {name}"),
            )
        })?;
    Ok(value.to_owned())
}

fn current_device_api_url<'a>(
    devices: &'a [EndDevice],
    device_id: &str,
) -> anyhow::Result<&'a str> {
    let device = devices
        .iter()
        .find(|device| device.unique_deivce_id == device_id)
        .ok_or_else(|| anyhow!("current LazyCat device was not found"))?;
    if !device.is_online {
        bail!("current LazyCat device is offline");
    }
    let api_url = device.device_api_url.trim();
    if api_url.is_empty() {
        bail!("current LazyCat device API is unavailable");
    }
    Ok(api_url)
}

fn sanitize_notification_text(value: &str, max_chars: usize) -> Option<String> {
    let mut sanitized = String::new();
    let mut previous_space = false;
    for ch in value.chars() {
        let ch = match ch {
            '\n' | '\r' | '\t' => ' ',
            ch if ch.is_control() => continue,
            ch => ch,
        };
        if ch.is_whitespace() {
            if previous_space {
                continue;
            }
            previous_space = true;
            sanitized.push(' ');
        } else {
            previous_space = false;
            sanitized.push(ch);
        }
        if sanitized.chars().count() >= max_chars {
            break;
        }
    }
    let sanitized = sanitized.trim();
    (!sanitized.is_empty()).then(|| sanitized.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, online: bool, api_url: &str) -> EndDevice {
        EndDevice {
            unique_deivce_id: id.to_owned(),
            is_online: online,
            device_api_url: api_url.to_owned(),
            ..EndDevice::default()
        }
    }

    #[test]
    fn resolves_only_the_online_current_device() {
        let devices = vec![
            device("other", true, "https://other.example"),
            device("current", true, "https://current.example"),
        ];
        assert_eq!(
            current_device_api_url(&devices, "current").unwrap(),
            "https://current.example"
        );
        assert!(current_device_api_url(&devices, "missing").is_err());
        assert!(
            current_device_api_url(&[device("current", false, "https://x")], "current").is_err()
        );
    }

    #[test]
    fn sanitizes_and_bounds_notification_text() {
        assert_eq!(
            sanitize_notification_text("  task\n\t finished  ", 80).as_deref(),
            Some("task finished")
        );
        assert_eq!(sanitize_notification_text("\u{1b}\n", 80), None);
        assert_eq!(
            sanitize_notification_text("123456", 4).as_deref(),
            Some("1234")
        );
    }

    #[test]
    fn suppresses_duplicates_and_bounds_notification_rate() {
        let mut policy = NotificationDeliveryPolicy::default();
        let now = Instant::now();
        assert!(matches!(
            policy.decision("user", "device", "done", "workspace", now),
            NotificationDeliveryDecision::Deliver
        ));
        assert!(matches!(
            policy.decision("user", "device", "done", "workspace", now),
            NotificationDeliveryDecision::Duplicate
        ));

        let later = now + NOTIFICATION_DUPLICATE_WINDOW;
        for index in 1..MAX_NOTIFICATIONS_PER_WINDOW {
            assert!(matches!(
                policy.decision(
                    "user",
                    "device",
                    &format!("event {index}"),
                    "workspace",
                    later,
                ),
                NotificationDeliveryDecision::Deliver
            ));
        }
        assert!(matches!(
            policy.decision("user", "device", "one more", "workspace", later),
            NotificationDeliveryDecision::RateLimited
        ));
        assert!(matches!(
            policy.decision("user", "other-device", "one more", "workspace", later),
            NotificationDeliveryDecision::Deliver
        ));
    }
}
