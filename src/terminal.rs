use std::sync::Arc;

use anyhow::anyhow;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::warn;
use uuid::Uuid;

use crate::config::{DEFAULT_COLS, DEFAULT_ROWS};
use crate::lightos;
use crate::state::{
    AppState, bool_flag, default_session_command, host_from_selector, mark_session_status,
};
use crate::terminal_manager::{ManagedTerminal, TerminalEvent, TerminalSpec};
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    session_id: Option<String>,
    name: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    restart: Option<String>,
    replay: Option<String>,
    after: Option<u64>,
    output_limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    RestartPolicy { enabled: bool },
    OutputBuffer { limit: usize },
    Close,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum TerminalServerMessage<'a> {
    Ready {
        session_id: &'a str,
        selector: &'a str,
        cols: u16,
        rows: u16,
    },
    Error {
        message: String,
    },
    ProcessExit {
        exit_code: i32,
        message: Option<String>,
    },
    OutputSequence {
        sequence: u64,
    },
    ReplayComplete {
        last_sequence: u64,
    },
}

struct TerminalAttachTarget {
    spec: TerminalSpec,
    allow_spawn: bool,
    replay: bool,
    replay_after: u64,
}

pub async fn terminal_ws(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "invalid websocket origin").into_response();
    }

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_terminal_socket(socket, state, query).await {
            warn!(error = %err, "terminal websocket ended with error");
        }
    })
}

async fn handle_terminal_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    query: TerminalQuery,
) -> anyhow::Result<()> {
    let target = resolve_terminal_target(&state, &query).await?;
    let ready_cols = target.spec.cols;
    let ready_rows = target.spec.rows;
    let terminal = state.terminals.open(target.spec, target.allow_spawn)?;
    mark_session_status(&state, terminal.session_id(), "running");

    let (mut sender, mut receiver) = socket.split();
    send_control(
        &mut sender,
        &TerminalServerMessage::Ready {
            session_id: terminal.session_id(),
            selector: terminal.selector(),
            cols: ready_cols,
            rows: ready_rows,
        },
    )
    .await?;

    if target.replay {
        let (frames, last_sequence) = terminal.replay_snapshot_after(target.replay_after);
        for frame in frames {
            if !send_output_frame(&mut sender, frame).await? {
                return Ok(());
            }
        }
        send_control(
            &mut sender,
            &TerminalServerMessage::ReplayComplete { last_sequence },
        )
        .await?;
    }

    let mut event_rx = terminal.subscribe();
    loop {
        tokio::select! {
            event = event_rx.recv() => {
                match event {
                    Ok(TerminalEvent::Output(frame)) => {
                        if !send_output_frame(&mut sender, frame).await? {
                            break;
                        }
                    }
                    Ok(TerminalEvent::Exit(info)) => {
                        mark_session_status(&state, terminal.session_id(), "exited");
                        state.terminals.forget(terminal.session_id());
                        send_control(
                            &mut sender,
                            &TerminalServerMessage::ProcessExit {
                                exit_code: info.exit_code,
                                message: info.message,
                            },
                        )
                        .await?;
                        break;
                    }
                    Ok(TerminalEvent::Error(message)) => {
                        send_control(&mut sender, &TerminalServerMessage::Error { message }).await?;
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        send_control(
                            &mut sender,
                            &TerminalServerMessage::Error {
                                message: "terminal output backlog exceeded; reconnecting".to_owned(),
                            },
                        )
                        .await?;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            Some(message) = receiver.next() => {
                match message? {
                    Message::Binary(data) => {
                        terminal.write_input(data.to_vec())?;
                    }
                    Message::Text(text) => {
                        if !handle_terminal_control_message(&state, &text, &terminal)? {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        let _ = sender.send(Message::Pong(payload)).await;
                    }
                    Message::Pong(_) => {}
                }
            }
            else => break,
        }
    }

    Ok(())
}

fn handle_terminal_control_message(
    state: &AppState,
    text: &str,
    terminal: &ManagedTerminal,
) -> anyhow::Result<bool> {
    if let Some(rest) = text.strip_prefix("input:") {
        terminal.write_input(rest.as_bytes().to_vec())?;
        return Ok(true);
    }

    if let Some(rest) = text.strip_prefix("resize:") {
        let (cols, rows) = parse_resize_payload(rest)?;
        terminal.resize(cols, rows)?;
        return Ok(true);
    }

    match serde_json::from_str::<TerminalClientMessage>(text) {
        Ok(TerminalClientMessage::Input { data }) => {
            terminal.write_input(data.into_bytes())?;
            Ok(true)
        }
        Ok(TerminalClientMessage::Resize { cols, rows }) => {
            terminal.resize(cols, rows)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::RestartPolicy { enabled }) => {
            set_session_restartable(state, terminal.session_id(), enabled)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::OutputBuffer { limit }) => {
            terminal.set_output_frame_limit(limit);
            set_session_output_buffer_limit(state, terminal.session_id(), limit)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::Close) => Ok(false),
        Err(_) => {
            warn!(message = ?text, "ignored non-control websocket text frame");
            Ok(true)
        }
    }
}

fn parse_resize_payload(rest: &str) -> anyhow::Result<(u16, u16)> {
    let (cols, rows) = rest
        .split_once(',')
        .ok_or_else(|| anyhow!("resize message must be resize:<cols>,<rows>"))?;
    let cols = cols.trim().parse::<u16>()?;
    let rows = rows.trim().parse::<u16>()?;
    validate_size(cols, rows)?;
    Ok((cols, rows))
}

async fn send_control(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    message: &TerminalServerMessage<'_>,
) -> anyhow::Result<()> {
    let text = serde_json::to_string(message)?;
    sender.send(Message::Text(text.into())).await?;
    Ok(())
}

async fn send_output_frame(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    frame: crate::terminal_manager::OutputFrame,
) -> anyhow::Result<bool> {
    if sender
        .send(Message::Binary(frame.data.into()))
        .await
        .is_err()
    {
        return Ok(false);
    }
    send_control(
        sender,
        &TerminalServerMessage::OutputSequence {
            sequence: frame.sequence,
        },
    )
    .await?;
    Ok(true)
}

async fn resolve_terminal_target(
    state: &AppState,
    query: &TerminalQuery,
) -> anyhow::Result<TerminalAttachTarget> {
    let restart = parse_query_bool(query.restart.as_deref(), "restart")?;
    let replay = parse_query_bool(query.replay.as_deref(), "replay")?.unwrap_or(true);
    let replay_after = query.after.unwrap_or(0);
    if let Some(session_id) = query
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let mut snapshot = None;
        let (spec, status) = {
            let mut sessions = state
                .sessions
                .write()
                .map_err(|_| anyhow!("session store lock poisoned"))?;
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("unknown session id"))?;
            let cols = query.cols.unwrap_or(session.cols);
            let rows = query.rows.unwrap_or(session.rows);
            validate_size(cols, rows)?;
            if let Some(restartable) = restart {
                session.set_restartable(restartable);
            }
            let spec = session.terminal_spec(cols, rows);
            let mut spec = spec;
            if let Some(output_limit) = query.output_limit {
                spec.output_frame_limit = normalize_output_frame_limit(Some(output_limit));
                session.metadata.insert(
                    "outputBufferLimit".to_owned(),
                    spec.output_frame_limit.to_string(),
                );
            }
            let status = session.status.clone();
            if restart.is_some() || query.output_limit.is_some() {
                snapshot = Some(sessions.clone());
            }
            (spec, status)
        };
        if let Some(snapshot) = snapshot {
            state.persist_sessions_snapshot(&snapshot)?;
        }
        let allow_spawn = restart.unwrap_or(false) || status == "running";
        authorize_terminal_selector(&spec.selector, allow_spawn).await?;
        return Ok(TerminalAttachTarget {
            spec,
            allow_spawn,
            replay,
            replay_after,
        });
    }

    let selector = query
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("name or session_id is required"))?;
    validate_selector(selector).map_err(|err| anyhow!(err.message.unwrap_or_default()))?;
    let cols = query.cols.unwrap_or(DEFAULT_COLS);
    let rows = query.rows.unwrap_or(DEFAULT_ROWS);
    validate_size(cols, rows)?;
    let host = host_from_selector(selector);
    authorize_terminal_selector(selector, true).await?;
    let (command, args) = default_session_command(selector);
    Ok(TerminalAttachTarget {
        spec: TerminalSpec {
            session_id: Uuid::new_v4().to_string(),
            host,
            selector: selector.to_owned(),
            command,
            args,
            cols,
            rows,
            output_frame_limit: normalize_output_frame_limit(query.output_limit),
        },
        allow_spawn: true,
        replay,
        replay_after,
    })
}

fn set_session_output_buffer_limit(
    state: &AppState,
    session_id: &str,
    limit: usize,
) -> anyhow::Result<()> {
    let limit = normalize_output_frame_limit(Some(limit));
    let snapshot = {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session id"))?;
        session
            .metadata
            .insert("outputBufferLimit".to_owned(), limit.to_string());
        sessions.clone()
    };
    state.persist_sessions_snapshot(&snapshot)?;
    Ok(())
}

async fn authorize_terminal_selector(selector: &str, require_running: bool) -> anyhow::Result<()> {
    lightos::authorize_selector(selector, require_running)
        .await
        .map_err(|err| {
            anyhow!(
                err.message
                    .unwrap_or_else(|| "selector is not authorized".to_owned())
            )
        })
}

fn set_session_restartable(
    state: &AppState,
    session_id: &str,
    restartable: bool,
) -> anyhow::Result<()> {
    let snapshot = {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session id"))?;
        session.set_restartable(restartable);
        sessions.clone()
    };
    state.persist_sessions_snapshot(&snapshot)?;
    Ok(())
}

fn parse_query_bool(value: Option<&str>, name: &str) -> anyhow::Result<Option<bool>> {
    value
        .map(|value| bool_flag(value).ok_or_else(|| anyhow!("{name} must be a boolean")))
        .transpose()
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };
    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    origin
        .parse::<Uri>()
        .ok()
        .and_then(|uri| uri.authority().map(|authority| authority.as_str() == host))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use axum::http::header::{HOST, ORIGIN};
    use axum::http::{HeaderMap, HeaderValue};

    use super::origin_allowed;

    #[test]
    fn validates_origin_host_match() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("example.test"));
        headers.insert(ORIGIN, HeaderValue::from_static("https://example.test"));
        assert!(origin_allowed(&headers));

        headers.insert(ORIGIN, HeaderValue::from_static("https://other.test"));
        assert!(!origin_allowed(&headers));
    }
}
