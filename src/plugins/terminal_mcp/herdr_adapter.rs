use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde_json::Value;

use crate::herdr::{HerdrTerminalOperation, run_terminal_mcp_operation};
use crate::state::AppState;

use super::types::{TerminalMcpError, TerminalOutputFrame, TerminalReadResult};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HerdrPaneDescriptor {
    pub pane_id: String,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub title: String,
    pub focused: bool,
}

#[derive(Clone)]
pub struct HerdrTerminalAdapter {
    state: Arc<AppState>,
}

impl HerdrTerminalAdapter {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    pub async fn list_panes(
        &self,
        session_id: &str,
    ) -> Result<Vec<HerdrPaneDescriptor>, TerminalMcpError> {
        let response =
            run_terminal_mcp_operation(&self.state, session_id, HerdrTerminalOperation::Snapshot)
                .await
                .map_err(map_herdr_error)?;
        Ok(collection(&response, "panes")
            .into_iter()
            .filter_map(|pane| {
                let pane_id = string_field(pane, "pane_id")?;
                Some(HerdrPaneDescriptor {
                    pane_id,
                    workspace_id: string_field(pane, "workspace_id"),
                    tab_id: string_field(pane, "tab_id"),
                    title: string_field(pane, "terminal_title_stripped")
                        .or_else(|| string_field(pane, "terminal_title"))
                        .or_else(|| string_field(pane, "title"))
                        .unwrap_or_else(|| "Herdr pane".to_owned()),
                    focused: bool_field(pane, "focused"),
                })
            })
            .collect())
    }

    pub async fn read(
        &self,
        session_id: &str,
        pane_id: &str,
        after_sequence: u64,
        wait_ms: u64,
        max_bytes: usize,
    ) -> Result<TerminalReadResult, TerminalMcpError> {
        let mut response = run_terminal_mcp_operation(
            &self.state,
            session_id,
            HerdrTerminalOperation::Read {
                pane_id: pane_id.to_owned(),
            },
        )
        .await
        .map_err(map_herdr_error)?;
        let mut timed_out = false;
        if !response_has_new_output(&response, after_sequence) && wait_ms > 0 {
            let waited = run_terminal_mcp_operation(
                &self.state,
                session_id,
                HerdrTerminalOperation::WaitForOutput {
                    pane_id: pane_id.to_owned(),
                    after_sequence,
                    timeout_ms: wait_ms,
                },
            )
            .await
            .map_err(map_herdr_error)?;
            timed_out = bool_field(result(&waited), "timed_out");
            response = run_terminal_mcp_operation(
                &self.state,
                session_id,
                HerdrTerminalOperation::Read {
                    pane_id: pane_id.to_owned(),
                },
            )
            .await
            .map_err(map_herdr_error)?;
        }
        Ok(normalize_read(
            session_id,
            pane_id,
            after_sequence,
            max_bytes,
            timed_out,
            &response,
        ))
    }

    pub async fn send_text(
        &self,
        session_id: &str,
        pane_id: &str,
        text: String,
    ) -> Result<(), TerminalMcpError> {
        run_terminal_mcp_operation(
            &self.state,
            session_id,
            HerdrTerminalOperation::SendText {
                pane_id: pane_id.to_owned(),
                text,
            },
        )
        .await
        .map(|_| ())
        .map_err(map_herdr_error)
    }

    pub async fn send_keys(
        &self,
        session_id: &str,
        pane_id: &str,
        keys: Vec<String>,
    ) -> Result<(), TerminalMcpError> {
        run_terminal_mcp_operation(
            &self.state,
            session_id,
            HerdrTerminalOperation::SendKeys {
                pane_id: pane_id.to_owned(),
                keys,
            },
        )
        .await
        .map(|_| ())
        .map_err(map_herdr_error)
    }

    pub async fn send_input(
        &self,
        session_id: &str,
        pane_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalMcpError> {
        run_terminal_mcp_operation(
            &self.state,
            session_id,
            HerdrTerminalOperation::SendInput {
                pane_id: pane_id.to_owned(),
                data_base64: BASE64_STANDARD.encode(data),
            },
        )
        .await
        .map(|_| ())
        .map_err(map_herdr_error)
    }

    pub async fn resize(
        &self,
        session_id: &str,
        pane_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalMcpError> {
        run_terminal_mcp_operation(
            &self.state,
            session_id,
            HerdrTerminalOperation::Resize {
                pane_id: pane_id.to_owned(),
                cols,
                rows,
            },
        )
        .await
        .map(|_| ())
        .map_err(map_herdr_error)
    }
}

fn normalize_read(
    session_id: &str,
    pane_id: &str,
    after_sequence: u64,
    max_bytes: usize,
    timed_out: bool,
    response: &Value,
) -> TerminalReadResult {
    let value = result(response);
    let sequence = sequence_field(value).unwrap_or_else(|| after_sequence.saturating_add(1));
    let mut data = data_field(value).unwrap_or_default();
    let has_new_output = !data.is_empty() && sequence > after_sequence;
    let truncated = data.len() > max_bytes;
    if truncated {
        data.truncate(max_bytes);
    }
    let frames = has_new_output
        .then(|| TerminalOutputFrame {
            sequence,
            data_base64: BASE64_STANDARD.encode(data),
        })
        .into_iter()
        .collect::<Vec<_>>();
    let next_sequence = frames.last().map_or(after_sequence, |frame| frame.sequence);
    TerminalReadResult {
        session_id: session_id.to_owned(),
        pane_id: Some(pane_id.to_owned()),
        frames,
        next_sequence,
        last_sequence: sequence.max(after_sequence),
        oldest_sequence: has_new_output.then_some(sequence),
        timed_out: timed_out && !has_new_output,
        truncated,
        replay_gap: has_new_output && sequence > after_sequence.saturating_add(1),
        exited: bool_field(value, "exited"),
    }
}

fn response_has_new_output(response: &Value, after_sequence: u64) -> bool {
    let value = result(response);
    data_field(value).is_some_and(|data| !data.is_empty())
        && sequence_field(value).is_none_or(|sequence| sequence > after_sequence)
}

fn result(value: &Value) -> &Value {
    value.get("result").unwrap_or(value)
}

fn collection<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    let value = result(value);
    value
        .get(key)
        .and_then(Value::as_array)
        .or_else(|| {
            value
                .get("session")
                .and_then(|session| session.get(key))
                .and_then(Value::as_array)
        })
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn data_field(value: &Value) -> Option<Vec<u8>> {
    if let Some(encoded) = string_field(value, "data_base64") {
        return BASE64_STANDARD.decode(encoded).ok();
    }
    ["text", "content", "output", "data"]
        .into_iter()
        .find_map(|key| string_field(value, key))
        .or_else(|| {
            value.get("pane").and_then(|pane| {
                ["text", "content", "output", "data"]
                    .into_iter()
                    .find_map(|key| string_field(pane, key))
            })
        })
        .map(String::into_bytes)
}

fn sequence_field(value: &Value) -> Option<u64> {
    ["sequence", "output_sequence", "last_sequence"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_u64))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn map_herdr_error(message: String) -> TerminalMcpError {
    if message.to_ascii_lowercase().contains("pane")
        && message.to_ascii_lowercase().contains("not found")
    {
        TerminalMcpError::pane_not_found()
    } else {
        TerminalMcpError::new("BACKEND_OPERATION_FAILED", message)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn normalizes_bounded_herdr_reads() {
        let read = normalize_read(
            "session-one",
            "pane-one",
            4,
            3,
            false,
            &json!({"result":{"sequence":6,"text":"hello"}}),
        );

        assert_eq!(read.next_sequence, 6);
        assert!(read.replay_gap);
        assert!(read.truncated);
        assert_eq!(read.frames[0].data_base64, BASE64_STANDARD.encode("hel"));
    }
}
