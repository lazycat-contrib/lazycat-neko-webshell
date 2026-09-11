//! Built-in API, independent of the optional file-transfer plugin.
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use connectrpc::{ConnectError, ErrorCode};
use serde::{Deserialize, Serialize};

use crate::service::authorize_file_session;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    session_id: String,
    selector: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteRequest {
    session_id: String,
    selector: String,
    path: String,
}

#[derive(Serialize)]
struct FileResponse {
    name: String,
    path: String,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Query(target): Query<Target>,
    headers: HeaderMap,
    payload: Bytes,
) -> Result<Response, Response> {
    // A non-simple content type prevents cross-origin HTML forms from creating
    // files with ambient credentials. The router does not enable cross-origin CORS.
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        != Some("application/octet-stream")
    {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected application/octet-stream",
        )
            .into_response());
    }
    super::validate_payload(&payload).map_err(error_response)?;
    let session = authorize_file_session(&state, &target.session_id, &target.selector)
        .await
        .map_err(error_response)?;
    let path = super::new_path();
    let script = super::create_script(&path, payload.len()).map_err(error_response)?;
    super::execute(&state, &session, &script, &payload)
        .await
        .map_err(error_response)?;
    Ok(success(path))
}

pub async fn remove(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DeleteRequest>,
) -> Result<Response, Response> {
    let script = super::delete_script(&request.path).map_err(error_response)?;
    let session = authorize_file_session(&state, &request.session_id, &request.selector)
        .await
        .map_err(error_response)?;
    super::execute(&state, &session, &script, &[])
        .await
        .map_err(error_response)?;
    Ok(success(request.path))
}

fn success(path: String) -> Response {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(FileResponse {
            name: path.rsplit('/').next().unwrap_or_default().to_owned(),
            path,
        }),
    )
        .into_response()
}

fn error_response(error: ConnectError) -> Response {
    let status = match error.code {
        ErrorCode::InvalidArgument => StatusCode::BAD_REQUEST,
        ErrorCode::Unauthenticated => StatusCode::UNAUTHORIZED,
        ErrorCode::PermissionDenied => StatusCode::FORBIDDEN,
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::FailedPrecondition => StatusCode::PRECONDITION_FAILED,
        ErrorCode::DeadlineExceeded => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    };
    // Never reflect submitted text, remote output or internal command errors.
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        "secret file operation failed",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SessionRecord;
    use std::collections::HashMap;

    fn state() -> Arc<AppState> {
        let state = AppState::new_for_test(
            std::env::temp_dir().join(format!("secret-http-{}.db", uuid::Uuid::new_v4())),
        );
        // The built-in route must work independently of this registry.
        state.plugins.write().unwrap().clear();
        Arc::new(state)
    }

    #[tokio::test]
    async fn secret_file_http_returns_only_name_and_path() {
        let path = super::super::new_path();
        let response = success(path.clone());
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"name": path.rsplit('/').next().unwrap(), "path": path})
        );
    }

    #[tokio::test]
    async fn secret_file_http_rejects_simple_content_type_and_bad_content() {
        let state = state();
        let target = || {
            Query(Target {
                session_id: "session".into(),
                selector: "target@owner".into(),
            })
        };
        let error = create(
            State(state.clone()),
            target(),
            HeaderMap::new(),
            Bytes::from_static(b"test"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let headers = HeaderMap::from_iter([(
            header::CONTENT_TYPE,
            "application/octet-stream".parse().unwrap(),
        )]);
        for payload in [
            Bytes::new(),
            Bytes::from_static(&[0xff]),
            Bytes::from(vec![b'x'; super::super::MAX_SECRET_BYTES + 1]),
        ] {
            let error = create(State(state.clone()), target(), headers.clone(), payload)
                .await
                .unwrap_err();
            assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn secret_file_http_checks_exact_session_target_without_plugins() {
        let state = state();
        state.sessions.write().unwrap().insert(
            "s".into(),
            SessionRecord {
                id: "s".into(),
                host: "a".into(),
                selector: "a@owner".into(),
                status: "running".into(),
                cols: 80,
                rows: 24,
                command: String::new(),
                args: vec![],
                metadata: HashMap::new(),
            },
        );
        let headers = HeaderMap::from_iter([(
            header::CONTENT_TYPE,
            "application/octet-stream".parse().unwrap(),
        )]);
        let error = create(
            State(state),
            Query(Target {
                session_id: "s".into(),
                selector: "other@owner".into(),
            }),
            headers,
            Bytes::from_static(b"TEST SECRET"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(error.into_body(), 1024).await.unwrap();
        assert_eq!(body.as_ref(), b"secret file operation failed");
    }

    #[tokio::test]
    async fn secret_file_router_enforces_body_limit_without_plugin_registry() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, crate::router::build_app(state()))
                .await
                .unwrap();
        });
        let client = reqwest::Client::new();
        let response = client
            .post(format!(
                "http://{address}/api/secret-files?sessionId=s&selector=target%40owner"
            ))
            .header("content-type", "application/octet-stream")
            .body(vec![b'x'; super::super::MAX_SECRET_BYTES + 1])
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
        server.abort();
        assert_eq!(response.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn secret_file_http_delete_rejects_arbitrary_paths() {
        let error = remove(
            State(state()),
            Json(DeleteRequest {
                session_id: "s".into(),
                selector: "target@owner".into(),
                path: "/etc/passwd".into(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    }
}
