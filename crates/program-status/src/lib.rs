//! Replaceable OSC 7501 adapter. All third-party protocol types stay private.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use w1::osc7501::{ParsedReport, parse_report};
use w1::stream::{Captured, OutputStream};
mod automatic;

pub const MAX_RECORDS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgramState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockedKind {
    Permission,
    Question,
    Auth,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgramRecord {
    pub id: String,
    pub state: ProgramState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<BlockedKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

#[derive(Default)]
pub struct Tracker {
    stream: OutputStream,
    records: BTreeMap<String, ProgramRecord>,
    revision: u64,
    automatic: automatic::Automatic,
    native_seen: bool,
}

impl Tracker {
    /// Inspect live bytes; the caller continues broadcasting the original bytes.
    /// Returned bytes are support replies for the PTY, never user input.
    pub fn observe(&mut self, data: &[u8]) -> Vec<u8> {
        if !self.native_seen {
            self.automatic.output(data);
        }
        if self.stream.at_boundary() && !data.contains(&0x1b) {
            return Vec::new();
        }
        let mut forwarded = Vec::with_capacity(data.len());
        let mut captured = Vec::new();
        let mut replies = Vec::new();
        // RIS ends with `c`. Observe boundaries there so reports before a reset
        // cannot be applied after reports which follow it in the same PTY read.
        for part in data.split_inclusive(|byte| *byte == b'c') {
            self.stream.process(part, &mut forwarded, &mut captured);
            forwarded.clear();
            for event in captured.drain(..) {
                match event {
                    Captured::Probe(terminator) => {
                        replies.extend_from_slice(b"\x1b]7501;?");
                        replies.extend_from_slice(terminator.bytes());
                    }
                    Captured::Report(payload) => self.apply(&payload),
                }
            }
            if self.stream.take_reset() {
                self.native_seen = false;
                if !self.records.is_empty() {
                    self.records.clear();
                    self.revision += 1;
                }
            }
        }
        replies
    }

    /// A replacement table, including an empty table when the last record clears.
    pub fn snapshot_since(&mut self, previous: Option<u64>) -> Option<(u64, Vec<ProgramRecord>)> {
        if !self.native_seen
            && let Some(record) = self.automatic.record()
        {
            self.replace(record);
        }
        (previous != Some(self.revision))
            .then(|| (self.revision, self.records.values().cloned().collect()))
    }

    /// Inspect only this PTY's foreground process group and its bounded child tree.
    pub fn foreground(&mut self, process_group: Option<u32>, cols: u16, rows: u16) {
        if self.automatic.foreground(process_group, cols, rows) {
            if !self.records.is_empty() {
                self.revision += 1;
            }
            self.records.clear();
            self.native_seen = false;
            self.stream = OutputStream::default();
        }
    }

    pub fn input(&mut self, data: &[u8]) {
        self.automatic.input(data);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.automatic.resize(cols, rows);
    }

    fn replace(&mut self, record: ProgramRecord) {
        if self.records.get(&record.id) != Some(&record) {
            self.records.insert(record.id.clone(), record);
            self.revision += 1;
        }
    }

    fn apply(&mut self, payload: &str) {
        let parsed = parse_report(payload);
        if parsed.is_some() && !self.native_seen {
            self.native_seen = true;
            if !self.records.is_empty() {
                self.records.clear();
                self.revision += 1;
            }
        }
        match parsed {
            Some(ParsedReport::Clear { id }) => {
                let before = self.records.len();
                let prefix = format!("{id}/");
                self.records
                    .retain(|key, _| !id.is_empty() && key != &id && !key.starts_with(&prefix));
                if before != self.records.len() {
                    self.revision += 1;
                }
            }
            Some(ParsedReport::Record { id, record }) => {
                let record = ProgramRecord {
                    id: id.clone(),
                    state: match record.state {
                        w1::OscState::Idle => ProgramState::Idle,
                        w1::OscState::Working => ProgramState::Working,
                        w1::OscState::Done => ProgramState::Done,
                        w1::OscState::Blocked => ProgramState::Blocked,
                        w1::OscState::Error => ProgramState::Error,
                    },
                    kind: record.kind.map(|kind| match kind {
                        w1::BlockedKind::Permission => BlockedKind::Permission,
                        w1::BlockedKind::Question => BlockedKind::Question,
                        w1::BlockedKind::Auth => BlockedKind::Auth,
                    }),
                    progress: record.progress,
                    app: record.app,
                    title: record
                        .title
                        .and_then(|text| w1::osc7501::sanitize_single_line(&text, 192)),
                    msg: record
                        .msg
                        .and_then(|text| w1::osc7501::sanitize_single_line(&text, 2048)),
                };
                if self.records.get(&id) == Some(&record)
                    || (!self.records.contains_key(&id) && self.records.len() >= MAX_RECORDS)
                {
                    return;
                }
                self.records.insert(id, record);
                self.revision += 1;
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records(tracker: &mut Tracker) -> Vec<ProgramRecord> {
        tracker.snapshot_since(None).unwrap().1
    }

    #[test]
    fn split_probes_reply_once_with_matching_terminator() {
        for sequence in [b"\x1b]7501;?\x07".as_slice(), b"\x1b]7501;?\x1b\\"] {
            for split in 0..=sequence.len() {
                let mut tracker = Tracker::default();
                let mut replies = tracker.observe(&sequence[..split]);
                replies.extend(tracker.observe(&sequence[split..]));
                assert_eq!(replies, sequence);
                assert!(tracker.observe(b"next output").is_empty());
                assert!(records(&mut tracker).is_empty());
            }
        }
    }

    #[test]
    fn split_reports_decode_metadata_and_deduplicate() {
        let sequence = b"\x1b]7501;state=blocked:kind=permission:progress=42:app=codex:title=5rWL6K+V:msg=QXBwcm92ZQ==:id=agent/sub\x1b\\";
        for split in 0..=sequence.len() {
            let mut tracker = Tracker::default();
            tracker.observe(&sequence[..split]);
            tracker.observe(&sequence[split..]);
            let record = records(&mut tracker).remove(0);
            assert_eq!(record.state, ProgramState::Blocked);
            assert_eq!(record.kind, Some(BlockedKind::Permission));
            assert_eq!(record.progress, Some(42));
            assert_eq!(record.title.as_deref(), Some("测试"));
            assert_eq!(record.msg.as_deref(), Some("Approve"));
            let revision = tracker.snapshot_since(None).unwrap().0;
            tracker.observe(sequence);
            assert!(tracker.snapshot_since(Some(revision)).is_none());
        }
    }

    #[test]
    fn clear_removes_subtree_and_root_clear_removes_all_apps() {
        let mut tracker = Tracker::default();
        tracker.observe(b"\x1b]7501;state=working:id=a\x07\x1b]7501;state=blocked:id=a/b\x07\x1b]7501;state=done:id=ab\x07");
        tracker.observe(b"\x1b]7501;state=clear:id=a\x07");
        assert_eq!(
            records(&mut tracker)
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            ["ab"]
        );
        tracker.observe(b"\x1b]7501;state=clear\x07");
        assert!(records(&mut tracker).is_empty());
    }

    #[test]
    fn malformed_oversize_and_embedded_string_reports_are_ignored() {
        let mut tracker = Tracker::default();
        tracker.observe(b"\x1bP7501;state=working\x1b\\");
        tracker.observe(b"\x1b]7501;state=future\x07\x1b]7501;state=done:title=A\x07");
        let oversized = format!("\x1b]7501;state=working:msg={}\x07", "A".repeat(5000));
        tracker.observe(oversized.as_bytes());
        assert!(records(&mut tracker).is_empty());
        tracker.observe(b"\x1b]7501;state=done\x07");
        assert_eq!(records(&mut tracker).len(), 1);
        tracker.observe(b"\x1bc");
        assert!(records(&mut tracker).is_empty());
    }

    #[test]
    fn reset_order_is_preserved_inside_one_read() {
        let mut tracker = Tracker::default();
        tracker.observe(b"\x1b]7501;state=working\x07\x1bc\x1b]7501;state=done:id=new\x07");
        assert_eq!(records(&mut tracker).len(), 1);
        assert_eq!(records(&mut tracker)[0].id, "new");
    }

    #[test]
    fn table_is_bounded_and_existing_records_can_still_update() {
        let mut tracker = Tracker::default();
        for id in 0..100 {
            tracker.observe(format!("\x1b]7501;state=working:id=p{id}\x07").as_bytes());
        }
        assert_eq!(records(&mut tracker).len(), MAX_RECORDS);
        tracker.observe(b"\x1b]7501;state=done:id=p0\x07");
        assert_eq!(records(&mut tracker)[0].state, ProgramState::Done);
    }
}
