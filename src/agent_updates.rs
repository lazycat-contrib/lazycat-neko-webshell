use axum::Json;
use axum::extract::Query;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::agent_client::updates::{self, AgentUpdateRequest, AgentUpdateStatus};
use crate::{lightos, tty_init, validation};

type HttpError = (StatusCode, Json<UpdateError>);
#[derive(Serialize)]
pub(crate) struct UpdateError {
    code: &'static str,
    message: String,
}
#[derive(Deserialize)]
pub(crate) struct AgentTarget {
    name: String,
}

async fn authorize(selector: &str) -> Result<String, HttpError> {
    if !tty_init::lightos_features_enabled() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(UpdateError {
                code: "unavailable",
                message: "LightOS integration is disabled".into(),
            }),
        ));
    }
    validation::validate_selector(selector).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(UpdateError {
                code: "invalid_target",
                message: "Invalid target".into(),
            }),
        )
    })?;
    lightos::login_user_for_selector(selector, true)
        .await
        .map_err(|_| {
            (
                StatusCode::FORBIDDEN,
                Json(UpdateError {
                    code: "unauthorized",
                    message: "Target is not authorized or running".into(),
                }),
            )
        })
}

fn failure(error: anyhow::Error) -> HttpError {
    let code = match error.to_string().as_str() {
        "target_changed" => "target_changed",
        "provider_older" => "provider_older",
        _ => "update_failed",
    };
    let status = if code == "update_failed" {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::CONFLICT
    };
    tracing::warn!(error = %error, "agent update failed");
    (
        status,
        Json(UpdateError {
            code,
            message: "Could not complete agent update; inspect the target and retry".into(),
        }),
    )
}

pub(crate) async fn get_update(
    Query(target): Query<AgentTarget>,
) -> Result<Json<AgentUpdateStatus>, HttpError> {
    let name = target.name.trim();
    let username = authorize(name).await?;
    updates::inspect(name, &username)
        .await
        .map(Json)
        .map_err(failure)
}

pub(crate) async fn post_update(
    Json(mut request): Json<AgentUpdateRequest>,
) -> Result<Json<AgentUpdateStatus>, HttpError> {
    request.name = request.name.trim().to_owned();
    let username = authorize(&request.name).await?;
    // Complete the bounded transaction even if a browser navigates away mid-request.
    tokio::spawn(updates::update(request, username))
        .await
        .map_err(|error| failure(error.into()))?
        .map(Json)
        .map_err(failure)
}
