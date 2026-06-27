use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::control_lease::release_actor_session_control;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseActorControlRequest {
    session_id: String,
    actor_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseActorControlResponse {
    released: bool,
}

pub async fn post_release_actor_control(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ReleaseActorControlRequest>,
) -> Result<Json<ReleaseActorControlResponse>, (StatusCode, String)> {
    let released = release_actor_session_control(&state, &request.session_id, &request.actor_id)
        .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;
    Ok(Json(ReleaseActorControlResponse { released }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::extract::State;
    use uuid::Uuid;

    use super::*;
    use crate::config::{DEFAULT_COLS, DEFAULT_ROWS};
    use crate::control_lease::{ControlActor, current_session_control, request_session_control};
    use crate::state::SessionRecord;

    #[tokio::test]
    async fn release_actor_control_endpoint_releases_matching_actor() {
        let state = Arc::new(test_state());
        insert_session(&state, "session-one");
        let actor = ControlActor::new("desktop", "desktop").unwrap();
        request_session_control(&state, "session-one", &actor, "attach").unwrap();

        let Json(response) = post_release_actor_control(
            State(Arc::clone(&state)),
            Json(ReleaseActorControlRequest {
                session_id: "session-one".to_owned(),
                actor_id: "desktop".to_owned(),
            }),
        )
        .await
        .unwrap();

        assert!(response.released);
        assert!(current_session_control(&state, "session-one").is_none());
    }

    fn test_state() -> AppState {
        AppState::new_for_test(std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-terminal-control-{}.db",
            Uuid::new_v4()
        )))
    }

    fn insert_session(state: &AppState, session_id: &str) {
        let session = SessionRecord {
            id: session_id.to_owned(),
            host: "demo".to_owned(),
            selector: "demo@owner".to_owned(),
            status: "running".to_owned(),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            command: "/bin/sh".to_owned(),
            args: Vec::new(),
            control: None,
            metadata: HashMap::new(),
        };
        state
            .sessions
            .write()
            .unwrap()
            .insert(session_id.to_owned(), session);
    }
}
