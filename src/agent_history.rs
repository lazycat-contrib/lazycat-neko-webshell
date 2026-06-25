use std::collections::VecDeque;

use crate::config::{DEFAULT_OUTPUT_FRAME_LIMIT, MAX_OUTPUT_BUFFER_BYTES};
use crate::validation::normalize_output_frame_limit;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentHistoryFrame {
    pub sequence: u64,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct AgentHistory {
    frames: VecDeque<AgentHistoryFrame>,
    next_sequence: u64,
    total_bytes: usize,
    total_lines: usize,
    max_lines: usize,
}

impl AgentHistory {
    pub fn new(max_lines: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            next_sequence: 0,
            total_bytes: 0,
            total_lines: 0,
            max_lines: normalize_output_frame_limit(Some(max_lines)),
        }
    }

    pub fn push(&mut self, data: Vec<u8>) -> AgentHistoryFrame {
        self.push_recorded(data, true)
    }

    pub fn push_recorded(&mut self, data: Vec<u8>, record: bool) -> AgentHistoryFrame {
        self.next_sequence = self.next_sequence.saturating_add(1);
        let frame = AgentHistoryFrame {
            sequence: self.next_sequence,
            data,
        };
        if record {
            self.total_bytes = self.total_bytes.saturating_add(frame.data.len());
            self.total_lines = self.total_lines.saturating_add(line_count(&frame.data));
            self.frames.push_back(frame.clone());
            self.prune();
        }
        frame
    }

    pub fn set_limit(&mut self, max_lines: usize) {
        self.max_lines = normalize_output_frame_limit(Some(max_lines));
        self.prune();
    }

    pub fn snapshot_after(&self, sequence: u64) -> (Vec<AgentHistoryFrame>, u64) {
        (
            self.frames
                .iter()
                .filter(|frame| frame.sequence > sequence)
                .cloned()
                .collect(),
            self.frames
                .back()
                .map_or(self.next_sequence, |_| self.next_sequence),
        )
    }

    fn prune(&mut self) {
        while self.frames.len() > self.max_lines
            || self.total_lines > self.max_lines
            || self.total_bytes > MAX_OUTPUT_BUFFER_BYTES
        {
            let Some(frame) = self.frames.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(frame.data.len());
            self.total_lines = self.total_lines.saturating_sub(line_count(&frame.data));
        }
    }
}

impl Default for AgentHistory {
    fn default() -> Self {
        Self::new(DEFAULT_OUTPUT_FRAME_LIMIT)
    }
}

fn line_count(data: &[u8]) -> usize {
    data.iter().filter(|byte| matches!(byte, b'\n')).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_raw_bytes_with_monotonic_sequence() {
        let mut history = AgentHistory::new(128);

        let first = history.push(b"\x1b[31mred".to_vec());
        let second = history.push(vec![0, 1, 2, b'\n']);

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        let (frames, last_sequence) = history.snapshot_after(0);
        assert_eq!(last_sequence, 2);
        assert_eq!(frames[0].data, b"\x1b[31mred");
        assert_eq!(frames[1].data, vec![0, 1, 2, b'\n']);
    }

    #[test]
    fn snapshots_only_frames_after_sequence() {
        let mut history = AgentHistory::new(128);
        history.push(b"one".to_vec());
        history.push(b"two".to_vec());

        let (frames, last_sequence) = history.snapshot_after(1);

        assert_eq!(last_sequence, 2);
        assert_eq!(
            frames,
            vec![AgentHistoryFrame {
                sequence: 2,
                data: b"two".to_vec(),
            }]
        );
    }

    #[test]
    fn snapshot_reports_real_last_sequence_when_after_is_stale() {
        let mut history = AgentHistory::new(128);
        history.push(b"one".to_vec());

        let (frames, last_sequence) = history.snapshot_after(99);

        assert!(frames.is_empty());
        assert_eq!(last_sequence, 1);
    }

    #[test]
    fn prunes_by_frame_and_line_limit() {
        let mut history = AgentHistory::new(128);
        for index in 0..130 {
            history.push(format!("{index}\n").into_bytes());
        }

        let (frames, last_sequence) = history.snapshot_after(0);

        assert_eq!(last_sequence, 130);
        assert_eq!(frames.len(), 128);
        assert_eq!(frames[0].sequence, 3);
        assert_eq!(frames[0].data, b"2\n");
    }

    #[test]
    fn unrecorded_frames_advance_sequence_without_replay_data() {
        let mut history = AgentHistory::new(128);
        history.push(b"before".to_vec());
        let live = history.push_recorded(b"binary".to_vec(), false);
        history.push(b"after".to_vec());

        assert_eq!(live.sequence, 2);
        let (frames, last_sequence) = history.snapshot_after(0);

        assert_eq!(last_sequence, 3);
        assert_eq!(
            frames,
            vec![
                AgentHistoryFrame {
                    sequence: 1,
                    data: b"before".to_vec(),
                },
                AgentHistoryFrame {
                    sequence: 3,
                    data: b"after".to_vec(),
                },
            ]
        );
    }

    #[test]
    fn snapshot_reports_skipped_tail_sequence() {
        let mut history = AgentHistory::new(128);
        history.push(b"before".to_vec());
        history.push_recorded(b"binary".to_vec(), false);

        let (frames, last_sequence) = history.snapshot_after(0);

        assert_eq!(last_sequence, 2);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].sequence, 1);
    }
}
