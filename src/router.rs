use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header::{CONTENT_SECURITY_POLICY, HeaderName};
use axum::routing::{delete, get, post};
use connectrpc::Router as ConnectRouter;
use serde::Serialize;
use tower_http::trace::TraceLayer;

use crate::action_ws::action_ws;
use crate::assets::{frontend_asset, frontend_font, frontend_icon, index, security_header};
use crate::backgrounds::{background_file, delete_background, upload_background};
use crate::config::{MAX_CLIPBOARD_IMAGE_BYTES, MAX_FONT_BYTES, MAX_TERMINAL_BACKGROUND_BYTES};
use crate::fonts::{delete_font, font_file, list_fonts, upload_font};
use crate::herdr::{
    get_herdr_state, herdr_ws, post_herdr_action, post_herdr_output_sequence, post_herdr_socket,
};
use crate::lightos::{self, AdminInfo};
use crate::notifications::{get_notifications, post_notification_dismiss, post_notification_read};
use crate::pomodoro::{
    get_pomodoro_state, post_notification_action, post_pomodoro_dismiss, post_pomodoro_start,
    post_pomodoro_stop,
};
use crate::preferences::{get_settings, put_settings};
use crate::proto::lazycat::webshell::v1::{CapabilityServiceExt, Instance};
use crate::service::CapabilityServiceImpl;
use crate::session_backend::get_session_backends;
use crate::sounds::{list_sounds, sound_file};
use crate::ssh_backend::{
    delete_ssh_profile, get_ssh_config, get_ssh_key_file, list_profile_instances,
    list_ssh_config_hosts, list_ssh_profiles, put_ssh_config, put_ssh_key_file, test_ssh_profile,
    upsert_ssh_profile,
};
use crate::state::AppState;
use crate::terminal::{terminal_ws, upload_clipboard_image};
use crate::tty_init::{TtyInitMode, lightos_features_enabled, tty_init_mode};
use crate::workspace::{get_workspace, put_workspace_action};

pub fn build_app(state: Arc<AppState>) -> Router {
    let service = Arc::new(CapabilityServiceImpl::new(Arc::clone(&state)));
    let connect = service.register(ConnectRouter::new()).into_axum_router();

    Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/icon.png", get(frontend_icon))
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws/terminal", get(terminal_ws))
        .route("/ws/action", get(action_ws))
        .route("/ws/herdr", get(herdr_ws))
        .route("/assets/{*path}", get(frontend_asset))
        .route("/fonts/{*path}", get(frontend_font))
        .route("/sounds/{*path}", get(sound_file))
        .route("/api/instances", get(list_instances))
        .route("/api/runtime", get(runtime_info))
        .route("/api/sounds", get(list_sounds))
        .route("/api/lightos-admin-info", get(lightos_admin_info))
        .route("/api/ssh-profiles", get(list_ssh_profiles).post(upsert_ssh_profile))
        .route("/api/ssh-config-hosts", get(list_ssh_config_hosts))
        .route("/api/ssh-config", get(get_ssh_config).put(put_ssh_config))
        .route("/api/ssh-key-file", get(get_ssh_key_file).put(put_ssh_key_file))
        .route(
            "/api/ssh-profiles/{id}",
            delete(delete_ssh_profile).put(upsert_ssh_profile),
        )
        .route("/api/ssh-profiles/{id}/test", post(test_ssh_profile))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/session-backends", get(get_session_backends))
        .route("/api/workspace", get(get_workspace).put(put_workspace_action))
        .route("/api/herdr", get(get_herdr_state).post(post_herdr_action))
        .route("/api/herdr/socket", post(post_herdr_socket))
        .route("/api/herdr/output-sequence", post(post_herdr_output_sequence))
        .route("/api/notifications", get(get_notifications))
        .route("/api/notifications/{id}/read", post(post_notification_read))
        .route(
            "/api/notifications/{id}/dismiss",
            post(post_notification_dismiss),
        )
        .route(
            "/api/notifications/{id}/actions/{action_id}",
            post(post_notification_action),
        )
        .route("/api/tasks/pomodoro", get(get_pomodoro_state))
        .route("/api/tasks/pomodoro/start", post(post_pomodoro_start))
        .route("/api/tasks/pomodoro/stop", post(post_pomodoro_stop))
        .route(
            "/api/tasks/pomodoro/dismiss",
            post(post_pomodoro_dismiss),
        )
        .route("/api/clipboard-image", post(upload_clipboard_image))
        .route("/api/fonts", get(list_fonts).post(upload_font))
        .route("/api/fonts/{id}", delete(delete_font))
        .route("/api/fonts/{id}/file", get(font_file))
        .route("/api/terminal-backgrounds", get(|| async { StatusCode::NO_CONTENT }).post(upload_background))
        .route("/api/terminal-backgrounds/{id}", delete(delete_background))
        .route("/api/terminal-backgrounds/{id}/file", get(background_file))
        .with_state(state)
        .merge(connect)
        .layer(axum::extract::DefaultBodyLimit::max(usize::max(
            usize::max(MAX_FONT_BYTES, MAX_TERMINAL_BACKGROUND_BYTES),
            MAX_CLIPBOARD_IMAGE_BYTES,
        )))
        .layer(TraceLayer::new_for_http())
        .layer(security_header(
            HeaderName::from_static("x-content-type-options"),
            "nosniff",
        ))
        .layer(security_header(
            HeaderName::from_static("referrer-policy"),
            "no-referrer",
        ))
        .layer(security_header(
            CONTENT_SECURITY_POLICY,
            "default-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data: blob:; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'self'",
        ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    mode: &'static str,
    lightos_features_enabled: bool,
}

async fn runtime_info() -> Json<RuntimeInfo> {
    let mode = match tty_init_mode() {
        TtyInitMode::Lightos => "lightos",
        TtyInitMode::Generic => "generic",
    };
    Json(RuntimeInfo {
        mode,
        lightos_features_enabled: lightos_features_enabled(),
    })
}

async fn lightos_admin_info() -> Result<Json<AdminInfo>, (StatusCode, String)> {
    if !lightos_features_enabled() {
        return Err((
            StatusCode::NOT_FOUND,
            "LightOS integration is disabled".to_owned(),
        ));
    }
    lightos::admin_info().await.map(Json).map_err(|err| {
        (
            StatusCode::BAD_GATEWAY,
            err.message
                .unwrap_or_else(|| "failed to resolve LightOS admin info".to_owned()),
        )
    })
}

async fn list_instances(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Instance>>, (StatusCode, String)> {
    let mut instances = if lightos_features_enabled() {
        lightos::list_instances().await.map_err(|err| {
            (
                StatusCode::BAD_GATEWAY,
                err.message
                    .unwrap_or_else(|| "failed to list LightOS instances".to_owned()),
            )
        })?
    } else {
        Vec::new()
    };
    let mut ssh_instances = list_profile_instances(&state.database())
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
    instances.append(&mut ssh_instances);
    Ok(Json(instances))
}
