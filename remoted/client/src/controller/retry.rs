//! One bounded reconnect sequence; operations themselves are never replayed.
use std::time::{Duration, Instant};

const DELAYS: [u64; 5] = [1, 2, 4, 8, 16];

#[derive(Default)]
pub(super) struct Retry {
    pub enabled: bool,
    pub attempts: usize,
    pub at: Option<Instant>,
    pub connected_at: Option<Instant>,
}
impl Retry {
    pub fn arm(&mut self) {
        self.enabled = true;
        self.attempts = 0;
        self.at = None;
        self.connected_at = None;
    }
    pub fn stop(&mut self) {
        self.enabled = false;
        self.at = None;
        self.connected_at = None;
    }
    pub fn schedule(&mut self, now: Instant) -> Option<Duration> {
        if !self.enabled {
            return None;
        }
        if self
            .connected_at
            .take()
            .is_some_and(|at| now.saturating_duration_since(at) >= Duration::from_secs(30))
        {
            self.attempts = 0;
        }
        let delay = Duration::from_secs(*DELAYS.get(self.attempts)?);
        self.attempts += 1;
        self.at = Some(now + delay);
        Some(delay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_are_bounded_and_manual_stop_disables_them() {
        let mut retry = Retry::default();
        retry.arm();
        let now = Instant::now();
        let delays = (0..5)
            .map(|_| retry.schedule(now).unwrap().as_secs())
            .collect::<Vec<_>>();
        assert_eq!(delays, [1, 2, 4, 8, 16]);
        assert!(retry.schedule(now).is_none());
        retry.arm();
        retry.stop();
        assert!(retry.schedule(now).is_none());
    }
    #[test]
    fn brief_success_does_not_restart_an_unbounded_flapping_loop() {
        let mut retry = Retry::default();
        retry.arm();
        let now = Instant::now();
        retry.schedule(now).unwrap();
        retry.connected_at = Some(now);
        assert_eq!(
            retry
                .schedule(now + Duration::from_secs(1))
                .unwrap()
                .as_secs(),
            2
        );
        retry.connected_at = Some(now);
        assert_eq!(
            retry
                .schedule(now + Duration::from_secs(30))
                .unwrap()
                .as_secs(),
            1
        );
    }
}
