//! Optional hook events translated into the existing terminal status protocol.

use serde_json::Value;

pub(crate) const REPORT_ID: &str = "_neko_hook";
pub const MAX_HOOK_BYTES: usize = 64 * 1024;

/// No prompts, commands, paths, session stores or user-provided text are emitted.
pub fn hook_report(agent: &str, payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() > MAX_HOOK_BYTES || !matches!(agent, "claude" | "codex") {
        return None;
    }
    let payload: Value = serde_json::from_slice(payload).ok()?;
    let event = payload.get("hook_event_name")?.as_str()?;
    // Require a real hook envelope, rather than guessing from arbitrary JSON.
    if payload.get("session_id")?.as_str()?.is_empty() {
        return None;
    }
    let state = match (agent, event) {
        (_, "SessionStart") => "idle",
        (_, "UserPromptSubmit" | "PreToolUse") => "working",
        ("codex", "PermissionRequest") => "blocked:kind=permission",
        ("claude", "Notification") => match payload.get("notification_type")?.as_str()? {
            "permission_prompt" => "blocked:kind=permission",
            "elicitation_dialog" | "elicitation_url_dialog" | "agent_needs_input" => {
                "blocked:kind=question"
            }
            // Delayed idle notifications must not overwrite a new turn.
            _ => return None,
        },
        (_, "Stop") => "done",
        ("codex", "Interrupt") => "idle",
        (_, "SessionEnd") => "clear",
        // Tool completion does not mean that a turn has finished. Subagent
        // completion must not finish its parent's turn either.
        _ => return None,
    };
    let app = if agent == "claude" {
        "claude-code"
    } else {
        agent
    };
    Some(format!("\x1b]7501;state={state}:app={app}:id={REPORT_ID}\x07").into_bytes())
}

/// Bind a helper to its own foreground Agent, with a revalidatable start identity.
/// An inaccessible, detached, background or unrelated process is a quiet no-op.
pub fn hook_identity(agent: &str, helper_pid: u32, group: u32) -> Option<(u32, u64)> {
    super::automatic::hook_identity(agent, helper_pid, group)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlockedKind, ProgramState, Tracker};

    fn emit(tracker: &mut Tracker, agent: &str, event: &str, extra: Value) {
        let mut payload = serde_json::json!({"session_id": "test", "hook_event_name": event});
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        if let Some(bytes) = hook_report(agent, &serde_json::to_vec(&payload).unwrap()) {
            assert!(tracker.observe(&bytes).is_empty());
        }
    }

    #[test]
    fn turn_sequence_and_duplicate_reports_use_existing_replacement_tables() {
        let mut tracker = Tracker::default();
        for (event, state) in [
            ("SessionStart", ProgramState::Idle),
            ("UserPromptSubmit", ProgramState::Working),
            ("PermissionRequest", ProgramState::Blocked),
            ("PreToolUse", ProgramState::Working),
            ("Stop", ProgramState::Done),
            ("Interrupt", ProgramState::Idle),
        ] {
            emit(&mut tracker, "codex", event, serde_json::json!({}));
            let (revision, records) = tracker.snapshot_since(None).unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].state, state);
            assert_eq!(records[0].id, "");
            emit(&mut tracker, "codex", event, serde_json::json!({}));
            assert!(tracker.snapshot_since(Some(revision)).is_none());
            for ignored in ["PostToolUse", "SubagentStop", "Unknown"] {
                emit(&mut tracker, "codex", ignored, serde_json::json!({}));
                assert!(tracker.snapshot_since(Some(revision)).is_none());
            }
        }
        emit(&mut tracker, "codex", "SessionEnd", serde_json::json!({}));
        assert!(tracker.snapshot_since(None).unwrap().1.is_empty());
    }

    #[test]
    fn native_reports_win_before_and_after_hook_events_including_clear() {
        for hook_first in [true, false] {
            let mut tracker = Tracker::default();
            if hook_first {
                emit(&mut tracker, "codex", "Stop", serde_json::json!({}));
            }
            tracker.observe(b"\x1b]7501;state=blocked:kind=auth:app=native\x07");
            let (revision, records) = tracker.snapshot_since(None).unwrap();
            assert_eq!(records[0].kind, Some(BlockedKind::Auth));
            emit(
                &mut tracker,
                "codex",
                "UserPromptSubmit",
                serde_json::json!({}),
            );
            emit(&mut tracker, "codex", "SessionEnd", serde_json::json!({}));
            assert!(tracker.snapshot_since(Some(revision)).is_none());
            tracker.observe(b"\x1b]7501;state=clear\x07");
            emit(&mut tracker, "codex", "Stop", serde_json::json!({}));
            assert!(tracker.snapshot_since(None).unwrap().1.is_empty());
        }
    }

    #[test]
    fn claude_notifications_are_typed_and_never_forward_private_text() {
        let mut tracker = Tracker::default();
        emit(
            &mut tracker,
            "claude",
            "Notification",
            serde_json::json!({
                "notification_type": "permission_prompt", "message": "secret\u{1b}]52;...",
                "tool_input": {"command": "secret command"}
            }),
        );
        let (revision, records) = tracker.snapshot_since(None).unwrap();
        assert_eq!(records[0].app.as_deref(), Some("claude-code"));
        assert_eq!(records[0].kind, Some(BlockedKind::Permission));
        assert!(records[0].msg.is_none());
        assert!(records[0].title.is_none());
        emit(
            &mut tracker,
            "claude",
            "Notification",
            serde_json::json!({"notification_type": "idle_prompt"}),
        );
        assert!(tracker.snapshot_since(Some(revision)).is_none());
        emit(
            &mut tracker,
            "claude",
            "Notification",
            serde_json::json!({"notification_type": "elicitation_dialog"}),
        );
        assert_eq!(
            tracker.snapshot_since(None).unwrap().1[0].kind,
            Some(BlockedKind::Question)
        );
        tracker.observe(b"\x1bc");
        assert!(tracker.snapshot_since(None).unwrap().1.is_empty());
    }

    #[test]
    fn invalid_or_oversized_envelopes_are_ignored() {
        for payload in [
            b"not json".as_slice(),
            b"[]",
            b"{}",
            br#"{"hook_event_name":"Stop","session_id":5}"#,
        ] {
            assert!(hook_report("codex", payload).is_none());
        }
        assert!(hook_report("codex", &vec![b' '; MAX_HOOK_BYTES + 1]).is_none());
        assert!(
            hook_report("unknown", br#"{"hook_event_name":"Stop","session_id":"s"}"#).is_none()
        );
    }

    #[test]
    fn interrupt_clears_hook_state_but_does_not_clear_native_state() {
        let mut tracker = Tracker::default();
        emit(
            &mut tracker,
            "codex",
            "PermissionRequest",
            serde_json::json!({}),
        );
        tracker.input(b"\x03");
        assert!(tracker.snapshot_since(None).unwrap().1.is_empty());
        tracker.observe(b"\x1b]7501;state=working:app=native\x07");
        let (revision, _) = tracker.snapshot_since(None).unwrap();
        tracker.input(b"\x03");
        assert!(tracker.snapshot_since(Some(revision)).is_none());
    }

    #[test]
    fn responding_to_permission_returns_to_inference_before_tool_completion() {
        let mut tracker = Tracker::default();
        emit(&mut tracker, "codex", "PreToolUse", serde_json::json!({}));
        emit(
            &mut tracker,
            "codex",
            "PermissionRequest",
            serde_json::json!({}),
        );
        assert_eq!(
            tracker.snapshot_since(None).unwrap().1[0].state,
            ProgramState::Blocked
        );
        tracker.input(b"\r");
        assert!(!tracker.hook_active);
        emit(&mut tracker, "codex", "PostToolUse", serde_json::json!({}));
        assert!(!tracker.hook_active);
        emit(&mut tracker, "codex", "Stop", serde_json::json!({}));
        assert_eq!(
            tracker.snapshot_since(None).unwrap().1[0].state,
            ProgramState::Done
        );
        emit(&mut tracker, "codex", "PostToolUse", serde_json::json!({}));
        assert_eq!(
            tracker.snapshot_since(None).unwrap().1[0].state,
            ProgramState::Done
        );
    }
}
