use crate::config::{DEFAULT_COLS, DEFAULT_OUTPUT_FRAME_LIMIT, DEFAULT_ROWS};
use crate::lightos;
use crate::ssh_backend;
use crate::state::{AppState, METADATA_LOGIN_USER, SessionRecord, host_from_selector};
use crate::tty_init::lightos_features_enabled;
use crate::validation::validate_selector;
use connectrpc::ConnectError;
use std::collections::HashMap;

pub(crate) async fn resolve(
    state: &AppState,
    session_id: &str,
    metadata: &HashMap<String, String>,
) -> Result<SessionRecord, ConnectError> {
    let existing = state
        .sessions
        .read()
        .map_err(|_| ConnectError::internal("session store lock poisoned"))?
        .get(session_id)
        .cloned();
    if let Some(session) = existing {
        if metadata
            .get("selector")
            .is_some_and(|selector| selector.trim() != session.selector)
        {
            return Err(ConnectError::permission_denied("session target mismatch"));
        }
        return Ok(session);
    }
    agent_session_record_from_metadata(session_id, metadata).await
}

pub(crate) async fn agent_session_record_from_metadata(
    session_id: &str,
    metadata: &HashMap<String, String>,
) -> Result<SessionRecord, ConnectError> {
    let selector = metadata
        .get("selector")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ConnectError::not_found("session not found"))?;
    if ssh_backend::is_ssh_selector(selector) {
        return Err(ConnectError::not_found("session not found"));
    }
    validate_selector(selector)?;
    if !lightos_features_enabled() {
        return Err(ConnectError::not_found("LightOS integration is disabled"));
    }
    let login_user = lightos::login_user_for_selector(selector, true).await?;
    Ok(agent_fallback_session_record(
        session_id,
        selector,
        &login_user,
    ))
}

pub(crate) fn agent_fallback_session_record(
    session_id: &str,
    selector: &str,
    login_user: &str,
) -> SessionRecord {
    let host = host_from_selector(selector);
    let mut metadata = HashMap::from([
        ("host".to_owned(), host.clone()),
        ("restartable".to_owned(), "false".to_owned()),
        ("sessionBackend".to_owned(), "webshell".to_owned()),
        (
            "outputBufferLimit".to_owned(),
            DEFAULT_OUTPUT_FRAME_LIMIT.to_string(),
        ),
    ]);
    let login_user = login_user.trim();
    if !login_user.is_empty() {
        metadata.insert(METADATA_LOGIN_USER.to_owned(), login_user.to_owned());
    }
    SessionRecord {
        id: session_id.to_owned(),
        host,
        selector: selector.to_owned(),
        status: "running".to_owned(),
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        command: "/bin/sh".to_owned(),
        args: Vec::new(),
        metadata,
    }
}

/// Resolve an existing or target-local session and authorize its exact target.
/// Built-in file operations share terminal authorization, not plugin lifecycle.
pub async fn authorize_file_session(
    state: &AppState,
    session_id: &str,
    selector: &str,
) -> Result<SessionRecord, ConnectError> {
    if session_id.is_empty() || session_id.len() > 512 || selector.len() > 512 {
        return Err(ConnectError::invalid_argument("invalid session target"));
    }
    validate_selector(selector)?;
    let existing = state
        .sessions
        .read()
        .map_err(|_| ConnectError::internal("session store lock poisoned"))?
        .get(session_id)
        .cloned();
    let session = match existing {
        Some(session) => session,
        None => {
            agent_session_record_from_metadata(
                session_id,
                &HashMap::from([("selector".to_owned(), selector.to_owned())]),
            )
            .await?
        }
    };
    if session.selector != selector {
        return Err(ConnectError::permission_denied("session target mismatch"));
    }
    authorize_session_target(state, &session, true).await?;
    Ok(session)
}

pub(crate) async fn authorize_session_target(
    state: &AppState,
    session: &SessionRecord,
    require_running: bool,
) -> Result<(), ConnectError> {
    if ssh_backend::is_ssh_selector(&session.selector) {
        ssh_backend::load_enabled_profile(&state.database(), &session.selector)?;
        return Ok(());
    }
    authorize_lightos_session_target(session, require_running).await
}

pub(crate) async fn authorize_lightos_session_target(
    session: &SessionRecord,
    require_running: bool,
) -> Result<(), ConnectError> {
    if !lightos_features_enabled() {
        return Err(ConnectError::not_found("LightOS integration is disabled"));
    }
    lightos::authorize_selector(&session.selector, require_running).await
}
