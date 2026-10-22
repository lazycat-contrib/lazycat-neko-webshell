use std::time::{Duration, Instant};

use w1::agents::AgentKind;
use w1::detect::{DetectedState, DetectionInput, StateStabilizer, detect};
use w1::screen::VirtualScreen;

use crate::{BlockedKind, ProgramRecord, ProgramState};

#[derive(Default)]
pub(super) struct Automatic {
    target: Option<Target>,
    screen: Option<VirtualScreen>,
    stabilizer: StateStabilizer,
    last_probe: Option<Instant>,
    process_group: Option<u32>,
    last_evaluate: Option<Instant>,
    last_record: Option<ProgramRecord>,
    pending_output: Vec<u8>,
    cols: u16,
    rows: u16,
}

#[derive(PartialEq, Eq)]
struct Target {
    pid: u32,
    start: u64,
    kind: Option<AgentKind>,
}

impl Automatic {
    pub fn foreground(&mut self, process_group: Option<u32>, cols: u16, rows: u16) -> bool {
        self.cols = cols;
        self.rows = rows;
        let now = Instant::now();
        if self.process_group == process_group
            && self
                .last_probe
                .is_some_and(|at| now.duration_since(at) < Duration::from_millis(300))
        {
            return false;
        }
        self.last_probe = Some(now);
        // Inspection errors retain the observed identity until a readable process
        // replaces it. No commands, environment changes or global /proc scan.
        let Some(next) = process_group.and_then(find_target) else {
            return false;
        };
        let group_changed = self.process_group.is_some() && self.process_group != process_group;
        self.process_group = process_group;
        if self.target.as_ref() == Some(&next) {
            return false;
        }
        let reset = group_changed
            || self.target.as_ref().is_some_and(|target| {
                target.kind.is_some() || (target.pid == next.pid && target.start != next.start)
            });
        if group_changed {
            self.pending_output.clear();
        }
        self.screen = next.kind.map(|_| VirtualScreen::new(cols, rows));
        if let Some(screen) = &mut self.screen {
            screen.feed(command_output_tail(&self.pending_output));
            self.pending_output.clear();
        }
        self.stabilizer = StateStabilizer::default();
        self.last_evaluate = None;
        self.last_record = None;
        self.target = Some(next);
        reset
    }

    pub fn output(&mut self, data: &[u8]) {
        let tail = command_output_tail(data);
        if self.screen.is_some() && tail.len() != data.len() {
            self.screen = Some(VirtualScreen::new(self.cols, self.rows));
            self.stabilizer = StateStabilizer::default();
            self.last_evaluate = None;
            self.last_record = None;
        }
        if let Some(screen) = &mut self.screen {
            screen.feed(tail);
        } else {
            // A wrapper can exec the actual agent just after the first read.
            // Retain a bounded startup tail until its identity becomes readable.
            const LIMIT: usize = 64 * 1024;
            if data.len() >= LIMIT {
                self.pending_output.clear();
                self.pending_output
                    .extend_from_slice(&data[data.len() - LIMIT..]);
            } else {
                let remove = self
                    .pending_output
                    .len()
                    .saturating_add(data.len())
                    .saturating_sub(LIMIT);
                self.pending_output.drain(..remove);
                self.pending_output.extend_from_slice(data);
            }
        }
    }

    pub fn input(&mut self, data: &[u8]) {
        if data.iter().any(|byte| matches!(byte, b'\r' | b'\n'))
            || data.windows(4).any(|bytes| bytes == b"\x1b[13")
        {
            self.stabilizer.arm();
        }
        if data.contains(&3) {
            self.stabilizer.force_state(w1::OscState::Idle);
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        if let Some(screen) = &mut self.screen {
            screen.resize(cols, rows);
        }
    }

    pub fn record(&mut self) -> Option<ProgramRecord> {
        let now = Instant::now();
        if self
            .last_evaluate
            .is_some_and(|at| now.duration_since(at) < Duration::from_millis(200))
        {
            return self.last_record.clone();
        }
        self.last_evaluate = Some(now);
        let kind = self.target.as_ref()?.kind?;
        let screen = self.screen.as_mut()?;
        let viewport = screen.viewport_text();
        let mut detection = detect(
            Some(kind),
            DetectionInput {
                screen: &viewport,
                osc_title: screen.osc_title(),
                osc_progress: screen.osc_progress(),
            },
        );
        // Explicit progress beats an inherited shell/CLI idle title. A visible
        // approval or question still wins over progress left by the last turn.
        if detection.state != DetectedState::Blocked
            && (screen.osc_progress().starts_with("4;1;")
                || screen.osc_progress().starts_with("4;3;"))
        {
            detection = detect(
                None,
                DetectionInput {
                    screen: "",
                    osc_title: "",
                    osc_progress: screen.osc_progress(),
                },
            );
        }
        let state = self.stabilizer.update(&detection, Instant::now());
        let record = ProgramRecord {
            id: String::new(),
            state: match state {
                w1::OscState::Idle => ProgramState::Idle,
                w1::OscState::Working => ProgramState::Working,
                w1::OscState::Done => ProgramState::Done,
                w1::OscState::Blocked => ProgramState::Blocked,
                w1::OscState::Error => ProgramState::Error,
            },
            kind: detection
                .blocked_kind
                .map(|kind| match kind {
                    w1::BlockedKind::Permission => BlockedKind::Permission,
                    w1::BlockedKind::Question => BlockedKind::Question,
                    w1::BlockedKind::Auth => BlockedKind::Auth,
                })
                .filter(|_| state == w1::OscState::Blocked),
            progress: screen
                .parsed_osc_progress_percent()
                .filter(|_| matches!(state, w1::OscState::Working | w1::OscState::Blocked)),
            app: Some(kind.app_id().to_owned()),
            title: screen
                .clean_title(kind.app_id(), kind.display_name())
                .filter(|title| {
                    !["bash -c ", "sh -c ", "node ", "python3 ", "python "]
                        .iter()
                        .any(|prefix| title.starts_with(prefix))
                }),
            msg: detection.detail,
        };
        self.last_record = Some(record.clone());
        Some(record)
    }
}

// Shell command-start marks can share a read with the first agent output.
// The bounded startup buffer also handles marks split across PTY reads.
fn command_output_tail(data: &[u8]) -> &[u8] {
    if !data.contains(&0x1b) {
        return data;
    }
    const MARK: &[u8] = b"\x1b]133;C";
    let mut start = 0;
    for (index, _) in data
        .windows(MARK.len())
        .enumerate()
        .filter(|(_, bytes)| *bytes == MARK)
    {
        let body = &data[index + MARK.len()..];
        if !body
            .first()
            .is_some_and(|byte| matches!(byte, b';' | 7 | 0x1b))
        {
            continue;
        }
        let bel = body.iter().position(|byte| *byte == 7).map(|end| end + 1);
        let st = body
            .windows(2)
            .position(|bytes| bytes == b"\x1b\\")
            .map(|end| end + 2);
        if let Some(end) = bel.into_iter().chain(st).min() {
            start = index + MARK.len() + end;
        }
    }
    &data[start..]
}

#[cfg(target_os = "linux")]
fn find_target(group: u32) -> Option<Target> {
    use std::collections::{HashSet, VecDeque};
    use std::fs;

    let root = process(group)?;
    let mut queue = VecDeque::from([group]);
    let mut seen = HashSet::new();
    while let Some(pid) = queue.pop_front() {
        if seen.len() >= 64 {
            break;
        }
        if !seen.insert(pid) {
            continue;
        }
        let Some(candidate) = process(pid) else {
            continue;
        };
        if candidate.group != root.group
            || candidate.session != root.session
            || candidate.tty != root.tty
            || candidate.uid != root.uid
        {
            continue;
        }
        let cmdline = bounded_read(&format!("/proc/{pid}/cmdline"), 64 * 1024)?;
        let argv = cmdline
            .split(|byte| *byte == 0)
            .filter(|arg| !arg.is_empty())
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect::<Vec<_>>();
        let exe = fs::read_link(format!("/proc/{pid}/exe")).ok();
        if let Some(kind) = w1::agents::identify_from_command(&argv, exe.as_deref()) {
            // Revalidate starttime to reject PID reuse during inspection.
            if process(pid).is_some_and(|current| current == candidate) {
                return Some(Target {
                    pid,
                    start: candidate.start,
                    kind: Some(kind),
                });
            }
        }
        let children = bounded_read(&format!("/proc/{pid}/task/{pid}/children"), 4096)?;
        for child in String::from_utf8_lossy(&children)
            .split_whitespace()
            .take(64)
        {
            if let Ok(child) = child.parse() {
                queue.push_back(child);
            }
        }
    }
    // A readable shell/non-agent is a positive observation, so stale records clear.
    if process(group)? != root {
        return None;
    }
    Some(Target {
        pid: group,
        start: root.start,
        kind: None,
    })
}

#[cfg(target_os = "linux")]
#[derive(PartialEq, Eq)]
struct Process {
    parent: u32,
    group: i64,
    session: i64,
    tty: i64,
    start: u64,
    uid: u32,
}

#[cfg(target_os = "linux")]
fn process(pid: u32) -> Option<Process> {
    use std::os::unix::fs::MetadataExt as _;
    let stat = bounded_read(&format!("/proc/{pid}/stat"), 4096)?;
    let stat = std::str::from_utf8(&stat).ok()?;
    let fields = stat
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    Some(Process {
        parent: fields.get(1)?.parse().ok()?,
        group: fields.get(2)?.parse().ok()?,
        session: fields.get(3)?.parse().ok()?,
        tty: fields.get(4)?.parse().ok()?,
        start: fields.get(19)?.parse().ok()?,
        uid: std::fs::metadata(format!("/proc/{pid}")).ok()?.uid(),
    })
}

#[cfg(target_os = "linux")]
pub(super) fn hook_identity(agent: &str, helper_pid: u32, group: u32) -> Option<(u32, u64)> {
    let expected = w1::agents::identify_from_command(&[agent.to_string()], None)?;
    let target = find_target(group)?;
    if target.kind != Some(expected) {
        return None;
    }
    let root = process(target.pid)?;
    if root.tty == 0 {
        return None;
    }
    let mut pid = helper_pid;
    for _ in 0..64 {
        let current = process(pid)?;
        if current.group != root.group
            || current.session != root.session
            || current.tty != root.tty
            || current.uid != root.uid
        {
            return None;
        }
        if pid == target.pid {
            return (current == root && current.start == target.start)
                .then_some((target.pid, target.start));
        }
        if current.parent == pid || current.parent == 0 {
            return None;
        }
        pid = current.parent;
    }
    None
}

#[cfg(not(target_os = "linux"))]
pub(super) fn hook_identity(_agent: &str, _helper_pid: u32, _group: u32) -> Option<(u32, u64)> {
    None
}

#[cfg(target_os = "linux")]
fn bounded_read(path: &str, limit: u64) -> Option<Vec<u8>> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

#[cfg(not(target_os = "linux"))]
fn find_target(_group: u32) -> Option<Target> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_runtime_detection_does_not_match_unrelated_arguments() {
        for argv in [
            vec!["codex"],
            vec!["node", "/opt/node_modules/@openai/codex/bin/codex.js"],
            vec!["npx", "@openai/codex"],
        ] {
            assert_eq!(
                w1::agents::identify_from_command(
                    &argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                    None
                ),
                Some(AgentKind::Codex)
            );
        }
        assert_eq!(
            w1::agents::identify_from_command(&["vim".into(), "codex".into()], None),
            None
        );
        assert_eq!(
            w1::agents::identify_from_command(&["node".into(), "-e".into(), "codex".into()], None),
            None
        );
    }

    #[test]
    fn detected_agent_uses_w1_screen_rules_and_progress() {
        let mut auto = Automatic {
            target: Some(Target {
                pid: 1,
                start: 1,
                kind: Some(AgentKind::Codex),
            }),
            screen: Some(VirtualScreen::new(80, 24)),
            ..Default::default()
        };
        auto.input(b"fix it\r");
        auto.output(b"> old shell prompt\r\n\x1b]133;C\x1b\\\x1b]0;bash -c 'exec codex' /\x1b\\\x1b]9;4;1;37\x07");
        let record = auto.record().unwrap();
        assert_eq!(record.app.as_deref(), Some("codex"));
        assert_eq!(record.state, ProgramState::Working);
        assert_eq!(record.progress, Some(37));
        auto.output(b"\x1b]0;Action Required - codex\x07\r\nAllow command?\r\nPress enter to confirm or esc to cancel");
        auto.last_evaluate = None;
        let record = auto.record().unwrap();
        assert_eq!(record.state, ProgramState::Blocked);
        assert_eq!(record.kind, Some(BlockedKind::Permission));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn follows_foreground_wrapper_children_without_scanning_other_groups() {
        use std::process::{Command, Stdio};
        let mut wrapper = Command::new("bash")
            .args(["-c", "bash -c 'exec -a codex sleep 5' & child=$!; read line; kill $child 2>/dev/null; wait"])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let target = loop {
            let target = find_target(wrapper.id());
            if target
                .as_ref()
                .is_some_and(|target| target.kind == Some(AgentKind::Codex))
                || Instant::now() >= deadline
            {
                break target;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        drop(wrapper.stdin.take());
        let _ = wrapper.wait();
        let target = target.unwrap();
        assert_eq!(target.kind, Some(AgentKind::Codex));
        assert_ne!(target.pid, wrapper.id());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn real_process_identity_isolated_from_other_terminals_and_native_reports_win() {
        use std::process::Command;
        let mut agent = Command::new("bash")
            .args(["-c", "exec -a codex sleep 5"])
            .spawn()
            .unwrap();
        let mut other = Command::new("sleep").arg("5").spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let detected = loop {
            let target = find_target(agent.id());
            if target
                .as_ref()
                .is_some_and(|target| target.kind == Some(AgentKind::Codex))
                || Instant::now() >= deadline
            {
                break target;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let mut first = crate::Tracker::default();
        first.foreground(Some(agent.id()), 80, 24);
        let detected_records = first.snapshot_since(None).unwrap().1;
        let mut second = crate::Tracker::default();
        second.foreground(Some(other.id()), 80, 24);
        let other_records = second.snapshot_since(None).unwrap().1;
        second.observe(
            &crate::hook_report("codex", br#"{"session_id":"s","hook_event_name":"Stop"}"#)
                .unwrap(),
        );
        assert_eq!(
            second.snapshot_since(None).unwrap().1[0].state,
            ProgramState::Done
        );
        second.foreground(Some(agent.id()), 80, 24);
        assert_ne!(
            second.snapshot_since(None).unwrap().1[0].state,
            ProgramState::Done
        );
        first.observe(b"\x1b]7501;state=blocked:app=claude-code:kind=question\x07");
        let native = first.snapshot_since(None).unwrap().1;
        first.observe(b"\x1b]7501;state=clear\x07");
        let cleared = first.snapshot_since(None).unwrap().1;
        first.observe(b"\x1b]7501;state=blocked");
        first.foreground(Some(other.id()), 80, 24);
        first.observe(b"\x07");
        let switched = first.snapshot_since(None).unwrap().1;
        let _ = agent.kill();
        let _ = agent.wait();
        let _ = other.kill();
        let _ = other.wait();
        assert_eq!(detected.unwrap().kind, Some(AgentKind::Codex));
        assert_eq!(detected_records[0].app.as_deref(), Some("codex"));
        assert!(other_records.is_empty());
        assert_eq!(native.len(), 1);
        assert_eq!(native[0].app.as_deref(), Some("claude-code"));
        assert!(cleared.is_empty());
        assert!(switched.is_empty());
    }
}
