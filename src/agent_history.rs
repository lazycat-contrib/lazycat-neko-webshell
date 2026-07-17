use std::collections::VecDeque;

use bytes::Bytes;

use crate::config::{DEFAULT_OUTPUT_FRAME_LIMIT, MAX_OUTPUT_BUFFER_BYTES};
use crate::validation::normalize_output_frame_limit;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentHistoryFrame {
    pub sequence: u64,
    pub data: Bytes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentHistorySnapshot {
    pub frames: Vec<AgentHistoryFrame>,
    pub oldest_sequence: Option<u64>,
    pub last_sequence: u64,
    pub truncated: bool,
    pub replay_gap: bool,
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

    #[cfg(test)]
    pub fn push(&mut self, data: Vec<u8>) -> AgentHistoryFrame {
        self.push_recorded(data, true)
    }

    pub fn push_recorded(&mut self, data: Vec<u8>, record: bool) -> AgentHistoryFrame {
        self.next_sequence = self.next_sequence.saturating_add(1);
        let frame = AgentHistoryFrame {
            sequence: self.next_sequence,
            data: Bytes::from(data),
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

    // Keep the original replay API available for callers that do not need explicit bounds.
    #[allow(dead_code)]
    pub fn snapshot_after(&self, sequence: u64) -> (Vec<AgentHistoryFrame>, u64) {
        let snapshot = self.snapshot_after_bounded(sequence, usize::MAX, usize::MAX);
        (snapshot.frames, snapshot.last_sequence)
    }

    pub fn snapshot_after_bounded(
        &self,
        sequence: u64,
        max_bytes: usize,
        max_frames: usize,
    ) -> AgentHistorySnapshot {
        let oldest_sequence = self.frames.front().map(|frame| frame.sequence);
        let start = first_frame_after(&self.frames, sequence);
        let byte_limit = max_bytes.max(1);
        let frame_limit = max_frames.max(1);
        let mut frames = Vec::new();
        let mut total_bytes = 0usize;
        let mut index = start;
        while index < self.frames.len() && frames.len() < frame_limit {
            let frame = self
                .frames
                .get(index)
                .expect("agent history index should remain in range");
            let next_bytes = total_bytes.saturating_add(frame.data.len());
            if !frames.is_empty() && next_bytes > byte_limit {
                break;
            }
            total_bytes = next_bytes;
            frames.push(frame.clone());
            index += 1;
            if total_bytes >= byte_limit {
                break;
            }
        }
        AgentHistorySnapshot {
            frames,
            oldest_sequence,
            last_sequence: self.next_sequence,
            truncated: index < self.frames.len(),
            replay_gap: oldest_sequence.is_some_and(|oldest| sequence.saturating_add(1) < oldest),
        }
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

fn first_frame_after(frames: &VecDeque<AgentHistoryFrame>, sequence: u64) -> usize {
    let mut left = 0usize;
    let mut right = frames.len();
    while left < right {
        let middle = left + (right - left) / 2;
        if frames
            .get(middle)
            .is_some_and(|frame| frame.sequence <= sequence)
        {
            left = middle + 1;
        } else {
            right = middle;
        }
    }
    left
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
        assert_eq!(frames[0].data.as_ref(), b"\x1b[31mred");
        assert_eq!(frames[1].data, vec![0, 1, 2, b'\n']);
    }

    #[test]
    fn live_output_and_history_share_the_same_payload_allocation() {
        let mut history = AgentHistory::new(128);
        let live = history.push(vec![b'x'; 64 * 1024]);
        let stored = history
            .snapshot_after(0)
            .0
            .pop()
            .expect("stored output frame");

        assert_eq!(live.data.as_ptr(), stored.data.as_ptr());
    }

    #[test]
    fn history_has_an_explicit_byte_budget() {
        let mut history = AgentHistory::new(crate::config::MAX_OUTPUT_FRAME_LIMIT);
        let frame_bytes = MAX_OUTPUT_BUFFER_BYTES / 4;
        for _ in 0..5 {
            history.push(vec![b'x'; frame_bytes]);
        }

        assert_eq!(history.total_bytes, MAX_OUTPUT_BUFFER_BYTES);
        assert_eq!(history.frames.len(), 4);
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
                data: Bytes::from_static(b"two"),
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
        assert_eq!(frames[0].data.as_ref(), b"2\n");
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
                    data: Bytes::from_static(b"before"),
                },
                AgentHistoryFrame {
                    sequence: 3,
                    data: Bytes::from_static(b"after"),
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

    #[test]
    fn bounded_snapshot_stops_at_byte_limit() {
        let mut history = AgentHistory::new(128);
        for data in [b"a".as_slice(), b"bb", b"ccc", b"dddd", b"eeeee", b"ffffff"] {
            history.push(data.to_vec());
        }

        let snapshot = history.snapshot_after_bounded(1, 5, 8);

        assert_eq!(
            snapshot
                .frames
                .iter()
                .map(|frame| frame.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(snapshot.oldest_sequence, Some(1));
        assert_eq!(snapshot.last_sequence, 6);
        assert!(snapshot.truncated);
        assert!(!snapshot.replay_gap);
    }

    #[test]
    fn bounded_snapshot_reports_replay_gap() {
        let mut history = AgentHistory::new(128);
        for index in 0..130 {
            history.push(format!("{index}\n").into_bytes());
        }

        let snapshot = history.snapshot_after_bounded(0, 1024, 8);

        assert_eq!(snapshot.oldest_sequence, Some(3));
        assert!(snapshot.replay_gap);
    }
}
