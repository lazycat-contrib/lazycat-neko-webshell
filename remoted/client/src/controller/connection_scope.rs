//! Connection intents invalidate queued actions and cancel superseded handshakes.
use crate::storage::Binding;
use anyhow::{Context, Result, ensure};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct ConnectionScope {
    generation: AtomicU64,
    changed: Notify,
    selected: Mutex<Option<Binding>>,
}
impl ConnectionScope {
    pub fn current(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
    pub fn select(&self, binding: Option<Binding>) {
        *self
            .selected
            .lock()
            .expect("selected binding lock poisoned") = binding;
    }
    pub fn is_selected(&self, binding: &Binding) -> bool {
        self.selected
            .lock()
            .expect("selected binding lock poisoned")
            .as_ref()
            == Some(binding)
    }
    pub fn advance(&self) -> Result<u64> {
        let mut current = self.current();
        loop {
            let next = current
                .checked_add(1)
                .context("连接世代已耗尽，请重新启动客户端")?;
            match self.generation.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.changed.notify_waiters();
                    return Ok(next);
                }
                Err(actual) => current = actual,
            }
        }
    }
    pub async fn during<T>(
        &self,
        generation: u64,
        work: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        let superseded = async {
            loop {
                let notified = self.changed.notified();
                // Register before inspecting the counter so a switch cannot be missed.
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.current() != generation {
                    return;
                }
                notified.await;
            }
        };
        tokio::select! {
            biased;
            _ = superseded => anyhow::bail!("连接操作已被新的设备选择取消"),
            result = work => {
                ensure!(self.current() == generation, "连接操作已被新的设备选择取消");
                result
            }
        }
    }
}

impl ConnectionScope {
    /// Background retry must not supersede a newer explicit user intent.
    pub fn advance_if_current(&self, expected: u64) -> Option<u64> {
        let next = expected.checked_add(1)?;
        self.generation
            .compare_exchange(expected, next, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        self.changed.notify_waiters();
        Some(next)
    }
}
