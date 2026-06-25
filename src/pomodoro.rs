use std::io;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::{AppDatabase, KV_NAMESPACE_STATE};
use crate::notifications::{NewNotification, NotificationAction, NotificationHub, now_ms};
use crate::state::AppState;

const KV_KEY_POMODORO: &str = "pomodoro";
const DEFAULT_DURATION_MINUTES: u32 = 25;
const DEFAULT_TOTAL_ROUNDS: u32 = 4;
const MIN_DURATION_MINUTES: u32 = 1;
const MAX_DURATION_MINUTES: u32 = 180;
const MIN_TOTAL_ROUNDS: u32 = 1;
const MAX_TOTAL_ROUNDS: u32 = 8;
const MINUTE_MS: u64 = 60_000;

pub const NOTIFICATION_SOURCE_KIND: &str = "pomodoro";
const NOTIFICATION_ACTION_DISMISS: &str = "pomodoro.dismiss";
const NOTIFICATION_ACTION_AGAIN: &str = "pomodoro.again";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroState {
    pub status: String,
    pub duration_minutes: u32,
    pub total_rounds: u32,
    pub current_round: u32,
    pub started_at_ms: u64,
    pub deadline_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPomodoroRequest {
    minutes: u32,
    #[serde(default)]
    rounds: Option<u32>,
    #[serde(default)]
    current_round: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPomodoroState {
    #[serde(default = "default_status")]
    status: String,
    #[serde(default = "default_duration_minutes")]
    duration_minutes: u32,
    #[serde(default = "default_total_rounds")]
    total_rounds: u32,
    #[serde(default)]
    current_round: u32,
    #[serde(default)]
    started_at_ms: u64,
    #[serde(default)]
    deadline_ms: u64,
    #[serde(default)]
    completed_at_ms: Option<u64>,
    #[serde(default)]
    notification_id: Option<String>,
}

#[derive(Clone)]
pub struct PomodoroManager {
    database: Arc<AppDatabase>,
    notifications: Arc<NotificationHub>,
    lock: Arc<Mutex<()>>,
}

impl PomodoroManager {
    pub fn new(database: Arc<AppDatabase>, notifications: Arc<NotificationHub>) -> Self {
        Self {
            database,
            notifications,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn state(&self) -> io::Result<PomodoroState> {
        let _guard = self.lock.lock().expect("pomodoro lock poisoned");
        let mut state = self.load_unlocked()?;
        let changed = self.reconcile_unlocked(&mut state)?;
        if changed {
            self.save_unlocked(&state)?;
        }
        Ok(state.into_public())
    }

    fn start_round(&self, minutes: u32, rounds: u32, round: u32) -> io::Result<PomodoroState> {
        let _guard = self.lock.lock().expect("pomodoro lock poisoned");
        let duration_minutes = normalize_duration_minutes(minutes);
        let total_rounds = normalize_total_rounds(rounds);
        let current_round = round.clamp(1, total_rounds);
        let now = now_ms();
        let state = PersistedPomodoroState {
            status: "running".to_owned(),
            duration_minutes,
            total_rounds,
            current_round,
            started_at_ms: now,
            deadline_ms: now.saturating_add(u64::from(duration_minutes) * MINUTE_MS),
            completed_at_ms: None,
            notification_id: None,
        };
        self.save_unlocked(&state)?;
        Ok(state.into_public())
    }

    pub fn stop(&self) -> io::Result<PomodoroState> {
        let _guard = self.lock.lock().expect("pomodoro lock poisoned");
        let current = self.load_unlocked()?;
        let state = idle_state(current.duration_minutes, current.total_rounds);
        self.save_unlocked(&state)?;
        Ok(state.into_public())
    }

    pub fn dismiss_completed(&self) -> io::Result<PomodoroState> {
        let _guard = self.lock.lock().expect("pomodoro lock poisoned");
        let mut current = self.load_unlocked()?;
        let _ = self.reconcile_unlocked(&mut current)?;
        if let Some(notification_id) = current.notification_id.as_deref() {
            let _ = self.notifications.dismiss(notification_id);
        }
        let state = idle_state(current.duration_minutes, current.total_rounds);
        self.save_unlocked(&state)?;
        Ok(state.into_public())
    }

    pub fn handle_notification_action(
        &self,
        notification_id: &str,
        action_id: &str,
    ) -> io::Result<Option<PomodoroState>> {
        match action_id {
            NOTIFICATION_ACTION_DISMISS => {
                let notification = self.notifications.notification(notification_id)?;
                if !notification_is_pomodoro(&notification, notification_id) {
                    return Ok(None);
                }
                self.notifications.mark_actioned(notification_id)?;
                self.dismiss_completed().map(Some)
            }
            NOTIFICATION_ACTION_AGAIN => {
                let notification = self.notifications.notification(notification_id)?;
                let Some(notification) = notification else {
                    return Ok(None);
                };
                if !notification_is_pomodoro(&Some(notification.clone()), notification_id) {
                    return Ok(None);
                }
                let minutes = notification
                    .actions
                    .iter()
                    .find(|action| action.id == NOTIFICATION_ACTION_AGAIN)
                    .and_then(|action| action.payload.get("minutes"))
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(DEFAULT_DURATION_MINUTES);
                let rounds = notification
                    .actions
                    .iter()
                    .find(|action| action.id == NOTIFICATION_ACTION_AGAIN)
                    .and_then(|action| action.payload.get("rounds"))
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(DEFAULT_TOTAL_ROUNDS);
                let next_round = notification
                    .actions
                    .iter()
                    .find(|action| action.id == NOTIFICATION_ACTION_AGAIN)
                    .and_then(|action| action.payload.get("nextRound"))
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(1);
                self.notifications.mark_actioned(notification_id)?;
                self.start_round(minutes, rounds, next_round).map(Some)
            }
            _ => Ok(None),
        }
    }

    fn reconcile_unlocked(&self, state: &mut PersistedPomodoroState) -> io::Result<bool> {
        normalize_state_in_place(state);
        if state.status != "running" || state.deadline_ms > now_ms() {
            return Ok(false);
        }
        state.status = "completed".to_owned();
        state.completed_at_ms = Some(state.deadline_ms);
        if state.notification_id.is_none() {
            let notification = self.notifications.add(NewNotification {
                source_kind: NOTIFICATION_SOURCE_KIND.to_owned(),
                source_id: Some("default".to_owned()),
                kind: "interactive".to_owned(),
                severity: "success".to_owned(),
                presentation_hint: "modal".to_owned(),
                title: "Pomodoro complete".to_owned(),
                body: "The focus timer is complete.".to_owned(),
                url: None,
                actions: vec![
                    NotificationAction {
                        id: NOTIFICATION_ACTION_DISMISS.to_owned(),
                        label: "Done".to_owned(),
                        style: None,
                        payload: Value::Null,
                    },
                    NotificationAction {
                        id: NOTIFICATION_ACTION_AGAIN.to_owned(),
                        label: "Start another".to_owned(),
                        style: Some("primary".to_owned()),
                        payload: serde_json::json!({
                            "minutes": state.duration_minutes,
                            "rounds": state.total_rounds,
                            "currentRound": state.current_round,
                            "nextRound": next_round(state),
                        }),
                    },
                ],
            })?;
            state.notification_id = Some(notification.id);
        }
        Ok(true)
    }

    fn load_unlocked(&self) -> io::Result<PersistedPomodoroState> {
        let Some(bytes) = self.database.load_kv(KV_NAMESPACE_STATE, KV_KEY_POMODORO)? else {
            return Ok(idle_state(DEFAULT_DURATION_MINUTES, DEFAULT_TOTAL_ROUNDS));
        };
        let mut state = serde_json::from_slice::<PersistedPomodoroState>(&bytes)
            .map_err(|err| io::Error::other(err.to_string()))?;
        normalize_state_in_place(&mut state);
        Ok(state)
    }

    fn save_unlocked(&self, state: &PersistedPomodoroState) -> io::Result<()> {
        let bytes = serde_json::to_vec(state).map_err(|err| io::Error::other(err.to_string()))?;
        self.database
            .store_kv(KV_NAMESPACE_STATE, KV_KEY_POMODORO, &bytes)
    }
}

pub async fn get_pomodoro_state(State(state): State<Arc<AppState>>) -> Response {
    match state.pomodoro.state() {
        Ok(pomodoro) => Json(pomodoro).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read pomodoro state: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_pomodoro_start(
    State(state): State<Arc<AppState>>,
    Json(request): Json<StartPomodoroRequest>,
) -> Response {
    match state.pomodoro.start_round(
        request.minutes,
        request.rounds.unwrap_or(DEFAULT_TOTAL_ROUNDS),
        request.current_round.unwrap_or(1),
    ) {
        Ok(pomodoro) => Json(pomodoro).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to start pomodoro: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_pomodoro_stop(State(state): State<Arc<AppState>>) -> Response {
    match state.pomodoro.stop() {
        Ok(pomodoro) => Json(pomodoro).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to stop pomodoro: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_pomodoro_dismiss(State(state): State<Arc<AppState>>) -> Response {
    match state.pomodoro.dismiss_completed() {
        Ok(pomodoro) => Json(pomodoro).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to dismiss pomodoro: {err}"),
        )
            .into_response(),
    }
}

pub async fn post_notification_action(
    State(state): State<Arc<AppState>>,
    Path((id, action_id)): Path<(String, String)>,
) -> Response {
    let notification = match state.notifications.notification(&id) {
        Ok(Some(notification)) => notification,
        Ok(None) => return (StatusCode::NOT_FOUND, "notification not found").into_response(),
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read notification: {err}"),
            )
                .into_response();
        }
    };
    if !notification
        .actions
        .iter()
        .any(|action| action.id == action_id)
    {
        return (StatusCode::NOT_FOUND, "notification action not found").into_response();
    }
    if notification.source_kind == NOTIFICATION_SOURCE_KIND {
        return match state.pomodoro.handle_notification_action(&id, &action_id) {
            Ok(Some(pomodoro)) => Json(pomodoro).into_response(),
            Ok(None) => (StatusCode::NOT_FOUND, "notification action not found").into_response(),
            Err(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to run notification action: {err}"),
            )
                .into_response(),
        };
    }
    match state.notifications.mark_actioned(&id) {
        Ok(Some(notification)) => Json(notification).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "notification not found").into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to update notification: {err}"),
        )
            .into_response(),
    }
}

impl PersistedPomodoroState {
    fn into_public(self) -> PomodoroState {
        PomodoroState {
            status: self.status,
            duration_minutes: self.duration_minutes,
            total_rounds: self.total_rounds,
            current_round: self.current_round,
            started_at_ms: self.started_at_ms,
            deadline_ms: self.deadline_ms,
            completed_at_ms: self.completed_at_ms,
            notification_id: self.notification_id,
        }
    }
}

fn notification_is_pomodoro(
    notification: &Option<crate::notifications::WebshellNotification>,
    notification_id: &str,
) -> bool {
    notification.as_ref().is_some_and(|notification| {
        notification.id == notification_id && notification.source_kind == NOTIFICATION_SOURCE_KIND
    })
}

fn idle_state(minutes: u32, rounds: u32) -> PersistedPomodoroState {
    PersistedPomodoroState {
        status: "idle".to_owned(),
        duration_minutes: normalize_duration_minutes(minutes),
        total_rounds: normalize_total_rounds(rounds),
        current_round: 0,
        started_at_ms: 0,
        deadline_ms: 0,
        completed_at_ms: None,
        notification_id: None,
    }
}

fn normalize_state_in_place(state: &mut PersistedPomodoroState) {
    state.duration_minutes = normalize_duration_minutes(state.duration_minutes);
    state.total_rounds = normalize_total_rounds(state.total_rounds);
    if state.current_round > state.total_rounds {
        state.current_round = state.total_rounds;
    }
    if state.status != "running" && state.status != "completed" {
        state.status = "idle".to_owned();
    }
    if state.status == "idle" {
        state.current_round = 0;
        state.started_at_ms = 0;
        state.deadline_ms = 0;
        state.completed_at_ms = None;
        state.notification_id = None;
    }
    if state.status == "running" && state.deadline_ms == 0 {
        *state = idle_state(state.duration_minutes, state.total_rounds);
    }
    if state.status != "idle" && state.current_round == 0 {
        state.current_round = 1;
    }
}

fn normalize_duration_minutes(minutes: u32) -> u32 {
    minutes.clamp(MIN_DURATION_MINUTES, MAX_DURATION_MINUTES)
}

fn normalize_total_rounds(rounds: u32) -> u32 {
    rounds.clamp(MIN_TOTAL_ROUNDS, MAX_TOTAL_ROUNDS)
}

fn next_round(state: &PersistedPomodoroState) -> u32 {
    if state.current_round < state.total_rounds {
        state.current_round + 1
    } else {
        1
    }
}

fn default_status() -> String {
    "idle".to_owned()
}

fn default_duration_minutes() -> u32 {
    DEFAULT_DURATION_MINUTES
}

fn default_total_rounds() -> u32 {
    DEFAULT_TOTAL_ROUNDS
}
