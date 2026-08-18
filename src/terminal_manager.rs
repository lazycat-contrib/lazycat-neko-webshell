use std::collections::{HashMap, VecDeque};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as AnyhowContext, anyhow};
use bytes::Bytes;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tokio::sync::broadcast;
use tracing::{info, warn};
use uuid::Uuid;

use crate::agent_protocol::AGENT_PROTOCOL_VERSION;
use crate::config::{
    DEFAULT_OUTPUT_FRAME_LIMIT, MAX_OUTPUT_BUFFER_BYTES, PTY_INPUT_CHANNEL_CAPACITY,
    PTY_OUTPUT_BATCH_BYTES,
};
use crate::database::AppDatabase;
use crate::pty_io::{ChildWait, PtyOutputEvent, PtyWriter, spawn_batched_output_reader};
use crate::terminal_reply_authority::TerminalReplyAuthority;
use crate::validation::{normalize_output_frame_limit, validate_size};

// One terminal's live broadcast backlog must not retain more payload than its
// replay history. PTY frames are capped by `PTY_OUTPUT_BATCH_BYTES`.
const EVENT_CAPACITY: usize = MAX_OUTPUT_BUFFER_BYTES / PTY_OUTPUT_BATCH_BYTES;
const MAX_CONNECTION_TERMINAL_BUFFER_BYTES: usize = 2 * 1024 * 1024;
const CONNECTION_EVENT_CAPACITY: usize =
    MAX_CONNECTION_TERMINAL_BUFFER_BYTES / PTY_OUTPUT_BATCH_BYTES;
const CONNECTION_PTY_INPUT_CHANNEL_CAPACITY: usize = 32;
pub(crate) const CONNECTION_TERMINAL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTION_TERMINALS: usize = 64;
const MAX_CONNECTION_TERMINALS_PER_SESSION: usize = 8;

#[derive(Debug, thiserror::Error)]
pub(crate) enum RetryableConnectionTerminalError {
    #[error("connection terminal capacity reached ({MAX_CONNECTION_TERMINALS})")]
    GlobalCapacity,
    #[error(
        "session connection terminal capacity reached ({MAX_CONNECTION_TERMINALS_PER_SESSION})"
    )]
    SessionCapacity,
    #[error("failed to start connection terminal: {0:#}")]
    Spawn(#[source] anyhow::Error),
}

#[derive(Clone, Debug)]
pub struct TerminalSpec {
    pub session_id: String,
    pub host: String,
    pub selector: String,
    pub command: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub output_frame_limit: usize,
}

#[derive(Clone, Debug)]
pub struct OutputFrame {
    pub sequence: u64,
    pub data: Bytes,
}

#[derive(Clone, Debug)]
pub struct OutputSnapshot {
    pub frames: Vec<OutputFrame>,
    pub oldest_sequence: Option<u64>,
    pub last_sequence: u64,
    pub truncated: bool,
    pub replay_gap: bool,
}

#[derive(Clone, Debug)]
pub struct ExitInfo {
    pub exit_code: i32,
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub enum TerminalEvent {
    Output(OutputFrame),
    Exit(ExitInfo),
    Error(String),
}

pub struct TerminalRegistry {
    sessions: RwLock<HashMap<String, Arc<ManagedTerminal>>>,
    connections: RwLock<ConnectionTerminalRegistry>,
}

#[derive(Default)]
struct ConnectionTerminalRegistry {
    sessions: HashMap<String, ConnectionTerminalSession>,
}

#[derive(Default)]
struct ConnectionTerminalSession {
    terminals: HashMap<String, Arc<ManagedTerminal>>,
    retire_when_empty: bool,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            connections: RwLock::new(ConnectionTerminalRegistry::default()),
        }
    }

    pub fn open(
        &self,
        spec: TerminalSpec,
        allow_spawn: bool,
        output: Arc<OutputBuffer>,
        resize_existing: bool,
    ) -> anyhow::Result<Arc<ManagedTerminal>> {
        if let Some(existing) = self.existing(&spec.session_id)? {
            if resize_existing {
                existing.resize(spec.cols, spec.rows)?;
            }
            existing.set_output_frame_limit(spec.output_frame_limit);
            return Ok(existing);
        }

        if !allow_spawn {
            return Err(anyhow!("terminal process is not running"));
        }

        let terminal = Arc::new(ManagedTerminal::spawn(spec, output)?);

        let mut sessions = self
            .sessions
            .write()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        if let Some(existing) = sessions.get(terminal.session_id()) {
            if existing.exit_info().is_some() {
                sessions.remove(terminal.session_id());
            } else {
                if resize_existing {
                    existing.resize(terminal.cols(), terminal.rows())?;
                }
                return Ok(Arc::clone(existing));
            }
        }

        sessions.insert(terminal.session_id().to_owned(), Arc::clone(&terminal));
        Ok(terminal)
    }

    pub fn open_connection(
        &self,
        spec: TerminalSpec,
    ) -> anyhow::Result<(String, Arc<ManagedTerminal>)> {
        let mut connections = self
            .connections
            .write()
            .map_err(|_| anyhow!("connection terminal registry lock poisoned"))?;
        let total = connections
            .sessions
            .values()
            .map(|session| session.terminals.len())
            .sum::<usize>();
        let session_count = connections
            .sessions
            .get(&spec.session_id)
            .map_or(0, |session| session.terminals.len());
        validate_connection_terminal_capacity(total, session_count)?;
        if connections
            .sessions
            .get(&spec.session_id)
            .is_some_and(|session| session.retire_when_empty)
        {
            return Err(anyhow!("connection terminal session is closing"));
        }

        let session_id = spec.session_id.clone();
        let terminal = ManagedTerminal::spawn_connection_scoped(spec)
            .map_err(RetryableConnectionTerminalError::Spawn)?;
        let connection_id = Uuid::new_v4().to_string();
        let session = connections.sessions.entry(session_id).or_default();
        session
            .terminals
            .insert(connection_id.clone(), Arc::clone(&terminal));
        Ok((connection_id, terminal))
    }

    pub fn release_connection(
        &self,
        session_id: &str,
        connection_id: &str,
    ) -> Option<Arc<ManagedTerminal>> {
        let Ok(mut connections) = self.connections.write() else {
            return None;
        };
        let session_connections = connections.sessions.get_mut(session_id)?;
        let terminal = session_connections.terminals.remove(connection_id);
        if terminal.is_some() && session_connections.terminals.is_empty() {
            connections.sessions.remove(session_id);
        }
        terminal
    }

    pub fn contains_connection(&self, session_id: &str, connection_id: &str) -> bool {
        self.connections.read().is_ok_and(|connections| {
            connections
                .sessions
                .get(session_id)
                .is_some_and(|session| session.terminals.contains_key(connection_id))
        })
    }

    pub fn close(self: &Arc<Self>, session_id: &str) {
        let terminal = self
            .sessions
            .write()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id));
        if let Some(terminal) = terminal {
            terminal.close();
        }
        let connection_terminals = self
            .connections
            .write()
            .ok()
            .map_or_else(Vec::new, |mut connections| {
                begin_connection_terminal_close(&mut connections, session_id)
            });
        for (_, terminal) in &connection_terminals {
            terminal.signal_connection_close();
        }
        for (connection_id, terminal) in connection_terminals {
            let registry = Arc::clone(self);
            let close_session_id = session_id.to_owned();
            thread::spawn(move || {
                terminal.close_connection(CONNECTION_TERMINAL_CLOSE_TIMEOUT);
                let released = registry.release_connection(&close_session_id, &connection_id);
                drop(released);
            });
        }
    }

    pub fn forget(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.write() {
            sessions.remove(session_id);
        }
    }

    pub(crate) fn existing(
        &self,
        session_id: &str,
    ) -> anyhow::Result<Option<Arc<ManagedTerminal>>> {
        let sessions = self
            .sessions
            .read()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        let Some(existing) = sessions.get(session_id) else {
            return Ok(None);
        };
        if existing.exit_info().is_some() {
            return Ok(None);
        }
        Ok(Some(Arc::clone(existing)))
    }
}

fn begin_connection_terminal_close(
    connections: &mut ConnectionTerminalRegistry,
    session_id: &str,
) -> Vec<(String, Arc<ManagedTerminal>)> {
    let Some(session) = connections.sessions.get_mut(session_id) else {
        return Vec::new();
    };
    if session.retire_when_empty {
        return Vec::new();
    }
    session.retire_when_empty = true;
    let terminals = session
        .terminals
        .iter()
        .map(|(connection_id, terminal)| (connection_id.clone(), Arc::clone(terminal)))
        .collect::<Vec<_>>();
    if terminals.is_empty() {
        connections.sessions.remove(session_id);
    }
    terminals
}

fn validate_connection_terminal_capacity(
    total: usize,
    session_count: usize,
) -> Result<(), RetryableConnectionTerminalError> {
    if total >= MAX_CONNECTION_TERMINALS {
        return Err(RetryableConnectionTerminalError::GlobalCapacity);
    }
    if session_count >= MAX_CONNECTION_TERMINALS_PER_SESSION {
        return Err(RetryableConnectionTerminalError::SessionCapacity);
    }
    Ok(())
}

pub struct ManagedTerminal {
    session_id: String,
    selector: String,
    cols: u16,
    rows: u16,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Arc<PtyWriter>,
    reply_authority: Arc<TerminalReplyAuthority>,
    event_tx: broadcast::Sender<TerminalEvent>,
    killer: Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    child_wait: ChildWait,
    shell_pid: Option<u32>,
    output: Arc<OutputBuffer>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
    connection_close_lock: Mutex<()>,
}

impl ManagedTerminal {
    pub(crate) fn spawn_connection_scoped(spec: TerminalSpec) -> anyhow::Result<Arc<Self>> {
        let output = Arc::new(OutputBuffer::new_with_byte_limit(
            spec.output_frame_limit,
            MAX_CONNECTION_TERMINAL_BUFFER_BYTES,
        ));
        Ok(Arc::new(Self::spawn_with_capacities(
            spec,
            output,
            CONNECTION_EVENT_CAPACITY,
            CONNECTION_PTY_INPUT_CHANNEL_CAPACITY,
        )?))
    }

    fn spawn(spec: TerminalSpec, output: Arc<OutputBuffer>) -> anyhow::Result<Self> {
        Self::spawn_with_capacities(spec, output, EVENT_CAPACITY, PTY_INPUT_CHANNEL_CAPACITY)
    }

    fn spawn_with_capacities(
        spec: TerminalSpec,
        output: Arc<OutputBuffer>,
        event_capacity: usize,
        input_capacity: usize,
    ) -> anyhow::Result<Self> {
        validate_size(spec.cols, spec.rows)?;
        if spec.command.trim().is_empty() {
            return Err(anyhow!("terminal command must not be empty"));
        }
        output.set_limit(spec.output_frame_limit);
        info!(
            session_id = %spec.session_id,
            host = %spec.host,
            selector = %spec.selector,
            command = %spec.command,
            "spawning terminal session"
        );
        let reply_authority = Arc::new(TerminalReplyAuthority::new(spec.cols, spec.rows)?);
        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let reader = pair.master.try_clone_reader()?;
        let writer = Arc::new(PtyWriter::spawn_with_capacity(
            pair.master.take_writer()?,
            input_capacity,
        ));

        let mut command = CommandBuilder::new(&spec.command);
        for arg in &spec.args {
            command.arg(arg);
        }
        command.env("TERM", "xterm-256color");
        command.env("LANG", "C.UTF-8");

        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("failed to start {}", spec.command))?;
        let shell_pid = child.process_id();
        let killer = child.clone_killer();
        let mut output_failure_killer = child.clone_killer();
        drop(pair.slave);

        let (event_tx, _) = broadcast::channel::<TerminalEvent>(event_capacity);
        let exit = Arc::new(Mutex::new(None));
        let child_wait = ChildWait::default();

        spawn_batched_output_reader(reader, {
            let event_tx = event_tx.clone();
            let output = Arc::clone(&output);
            let writer = Arc::clone(&writer);
            let reply_authority = Arc::clone(&reply_authority);
            move |event| match event {
                PtyOutputEvent::Output(data) => match reply_authority.process_output(
                    data,
                    |reply| writer.send_reply(reply).map_err(anyhow::Error::new),
                    |data| {
                        let frame = output.push(data);
                        let _ = event_tx.send(TerminalEvent::Output(frame));
                        true
                    },
                ) {
                    Ok(keep_reading) => keep_reading,
                    Err(error) => {
                        let _ = event_tx.send(TerminalEvent::Error(format!(
                            "terminal reply authority failed: {error:#}"
                        )));
                        let _ = output_failure_killer.kill();
                        false
                    }
                },
                PtyOutputEvent::Error(message) => {
                    let _ = event_tx.send(TerminalEvent::Error(message));
                    let _ = output_failure_killer.kill();
                    false
                }
            }
        });
        spawn_exit_thread(
            child,
            event_tx.clone(),
            Arc::clone(&exit),
            child_wait.clone(),
        );

        Ok(Self {
            session_id: spec.session_id,
            selector: spec.selector,
            cols: spec.cols,
            rows: spec.rows,
            master: Mutex::new(pair.master),
            writer,
            reply_authority,
            event_tx,
            killer: Mutex::new(Some(killer)),
            child_wait,
            shell_pid,
            output,
            exit,
            connection_close_lock: Mutex::new(()),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn selector(&self) -> &str {
        &self.selector
    }

    fn cols(&self) -> u16 {
        self.cols
    }

    fn rows(&self) -> u16 {
        self.rows
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TerminalEvent> {
        self.event_tx.subscribe()
    }

    pub fn output_buffer(&self) -> Arc<OutputBuffer> {
        Arc::clone(&self.output)
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.exit.lock().ok().and_then(|exit| exit.clone())
    }

    pub fn write_input(&self, data: Vec<u8>) -> anyhow::Result<()> {
        self.writer.send(data).map_err(anyhow::Error::new)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        validate_size(cols, rows)?;
        self.reply_authority.resize_with(cols, rows, || {
            let master = self
                .master
                .lock()
                .map_err(|_| anyhow!("pty lock poisoned"))?;
            master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
        })
    }

    pub fn set_output_frame_limit(&self, limit: usize) {
        self.output.set_limit(limit);
    }

    pub fn set_history_recording(&self, enabled: bool) {
        self.output.set_recording(enabled);
    }

    pub fn is_busy(&self) -> bool {
        let Ok(master) = self.master.lock() else {
            return false;
        };
        has_foreground_process(master.as_ref(), self.shell_pid)
    }

    pub(crate) fn close(&self) {
        self.writer.signal_close();
        let Some(mut child_killer) = self.killer.lock().ok().and_then(|mut killer| killer.take())
        else {
            return;
        };
        if let Err(err) = child_killer.kill() {
            warn!(error = %err, "terminal child was already closed");
        }
        self.child_wait.wait();
        self.writer.wait();
    }

    pub(crate) fn close_connection(&self, timeout: Duration) -> bool {
        let _close_guard = self
            .connection_close_lock
            .lock()
            .expect("connection terminal close lock poisoned");
        self.signal_connection_close();
        let closed_within_deadline = self.wait_for_connection_close(timeout);
        if !closed_within_deadline {
            self.child_wait.wait();
            self.writer.wait();
        }
        closed_within_deadline
    }

    pub(crate) fn signal_connection_close(&self) {
        self.writer.signal_close();
        if let Some(mut child_killer) = self.killer.lock().ok().and_then(|mut killer| killer.take())
            && let Err(err) = child_killer.kill()
        {
            warn!(error = %err, "connection terminal child was already closed");
        }
    }

    fn wait_for_connection_close(&self, timeout: Duration) -> bool {
        let started = Instant::now();
        let child_closed = self.child_wait.wait_timeout(timeout);
        let remaining = timeout.saturating_sub(started.elapsed());
        let writer_closed = self.writer.wait_timeout(remaining);
        if !child_closed || !writer_closed {
            warn!(
                session_id = %self.session_id,
                child_closed,
                writer_closed,
                "connection terminal cleanup reached its deadline"
            );
        }
        child_closed && writer_closed
    }
}

impl Drop for ManagedTerminal {
    fn drop(&mut self) {
        self.close();
    }
}

fn spawn_exit_thread(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    event_tx: broadcast::Sender<TerminalEvent>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
    child_wait: ChildWait,
) {
    thread::spawn(move || {
        let result = child.wait();
        let info = match result {
            Ok(status) => ExitInfo {
                exit_code: i32::try_from(status.exit_code()).unwrap_or(i32::MAX),
                message: status.signal().map(ToOwned::to_owned),
            },
            Err(err) => ExitInfo {
                exit_code: -1,
                message: Some(err.to_string()),
            },
        };
        if let Ok(mut exit) = exit.lock() {
            *exit = Some(info.clone());
        }
        child_wait.complete();
        let _ = event_tx.send(TerminalEvent::Exit(info));
    });
}

#[cfg(unix)]
fn has_foreground_process(master: &dyn MasterPty, shell_pid: Option<u32>) -> bool {
    let Some(foreground_pgid) = master.process_group_leader() else {
        return false;
    };
    shell_pid.is_some_and(|shell_pid| i64::from(foreground_pgid) != i64::from(shell_pid))
}

#[cfg(not(unix))]
fn has_foreground_process(_master: &dyn MasterPty, _shell_pid: Option<u32>) -> bool {
    false
}

pub struct OutputBuffer {
    inner: Mutex<OutputBufferInner>,
    history_lock: Mutex<()>,
    store: Option<OutputHistoryStore>,
    history_closed: AtomicBool,
    recording: AtomicBool,
}

struct OutputBufferInner {
    frames: VecDeque<OutputFrame>,
    total_bytes: usize,
    total_lines: usize,
    next_sequence: u64,
    max_lines: usize,
    max_bytes: usize,
}

impl OutputBuffer {
    pub fn new(max_frames: usize) -> Self {
        Self::new_with_byte_limit(max_frames, MAX_OUTPUT_BUFFER_BYTES)
    }

    fn new_with_byte_limit(max_frames: usize, max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(OutputBufferInner {
                frames: VecDeque::new(),
                total_bytes: 0,
                total_lines: 0,
                next_sequence: 0,
                max_lines: normalize_output_frame_limit(Some(max_frames)),
                max_bytes: max_bytes.max(PTY_OUTPUT_BATCH_BYTES),
            }),
            history_lock: Mutex::new(()),
            store: None,
            history_closed: AtomicBool::new(false),
            recording: AtomicBool::new(true),
        }
    }

    pub fn persistent(max_frames: usize, session_id: String, database: Arc<AppDatabase>) -> Self {
        let store = OutputHistoryStore {
            session_id,
            database,
        };
        let max_frames = normalize_output_frame_limit(Some(max_frames));
        let loaded = match store.load() {
            Ok(loaded) => loaded,
            Err(err) => {
                warn!(error = %err, session_id = %store.session_id, "failed to load terminal output history");
                let _ = store.remove();
                LoadedHistory::default()
            }
        };
        let mut inner = OutputBufferInner {
            frames: loaded.frames,
            total_bytes: loaded.total_bytes,
            total_lines: loaded.total_lines,
            next_sequence: loaded.next_sequence,
            max_lines: max_frames,
            max_bytes: MAX_OUTPUT_BUFFER_BYTES,
        };
        prune_output_buffer(&mut inner);
        let output = Self {
            inner: Mutex::new(inner),
            history_lock: Mutex::new(()),
            store: Some(store),
            history_closed: AtomicBool::new(false),
            recording: AtomicBool::new(true),
        };
        output.compact_history();
        output
    }

    fn push(&self, data: Vec<u8>) -> OutputFrame {
        self.push_recorded(data, self.recording.load(Ordering::Relaxed))
    }

    fn push_recorded(&self, data: Vec<u8>, record: bool) -> OutputFrame {
        let _history_guard = self
            .history_lock
            .lock()
            .expect("terminal output history lock poisoned");
        let (frame, first_retained_sequence) = {
            let mut inner = self.inner.lock().expect("terminal output buffer poisoned");
            inner.next_sequence = inner.next_sequence.saturating_add(1);
            let frame = OutputFrame {
                sequence: inner.next_sequence,
                data: Bytes::from(data),
            };
            let first_retained_sequence = if record {
                inner.total_bytes = inner.total_bytes.saturating_add(frame.data.len());
                inner.total_lines = inner
                    .total_lines
                    .saturating_add(output_history_line_count(&frame.data));
                inner.frames.push_back(frame.clone());
                prune_output_buffer(&mut inner);
                inner
                    .frames
                    .front()
                    .map_or(frame.sequence, |frame| frame.sequence)
            } else {
                frame.sequence
            };
            (frame, first_retained_sequence)
        };
        if record {
            self.append_history(&frame, first_retained_sequence);
        }
        frame
    }

    pub fn set_recording(&self, enabled: bool) {
        self.recording.store(enabled, Ordering::Relaxed);
    }

    pub fn disable_transient_history(&self) {
        if self.store.is_some() {
            return;
        }
        self.recording.store(false, Ordering::Relaxed);
        let _history_guard = self
            .history_lock
            .lock()
            .expect("terminal output history lock poisoned");
        let mut inner = self.inner.lock().expect("terminal output buffer poisoned");
        inner.frames.clear();
        inner.total_bytes = 0;
        inner.total_lines = 0;
    }

    pub fn set_limit(&self, max_frames: usize) {
        let mut inner = self.inner.lock().expect("terminal output buffer poisoned");
        inner.max_lines = normalize_output_frame_limit(Some(max_frames));
        prune_output_buffer(&mut inner);
        drop(inner);
        self.compact_history();
    }

    // Keep the tuple API for focused history tests and callers that do not
    // need replay-gap metadata.
    #[allow(dead_code)]
    pub fn snapshot_after(&self, sequence: u64) -> (Vec<OutputFrame>, u64) {
        let snapshot = self.snapshot_after_bounded(sequence, usize::MAX, usize::MAX);
        (snapshot.frames, snapshot.last_sequence)
    }

    pub fn snapshot_after_bounded(
        &self,
        sequence: u64,
        max_bytes: usize,
        max_frames: usize,
    ) -> OutputSnapshot {
        let inner = self.inner.lock().expect("terminal output buffer poisoned");
        let oldest_sequence = inner.frames.front().map(|frame| frame.sequence);
        let start = first_output_frame_after(&inner.frames, sequence);
        let byte_limit = max_bytes.max(1);
        let frame_limit = max_frames.max(1);
        let mut frames = Vec::new();
        let mut total_bytes = 0usize;
        let mut index = start;
        while index < inner.frames.len() && frames.len() < frame_limit {
            let frame = inner
                .frames
                .get(index)
                .expect("terminal output index should remain in range");
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
        OutputSnapshot {
            frames,
            oldest_sequence,
            last_sequence: inner.next_sequence,
            truncated: index < inner.frames.len(),
            replay_gap: oldest_sequence.is_some_and(|oldest| sequence.saturating_add(1) < oldest),
        }
    }

    fn append_history(&self, frame: &OutputFrame, first_retained_sequence: u64) {
        if self.history_closed.load(Ordering::Relaxed) {
            return;
        }
        let Some(store) = &self.store else {
            return;
        };
        if let Err(err) = store.append(frame, first_retained_sequence) {
            warn!(error = %err, session_id = %store.session_id, "failed to append terminal output history");
        }
    }

    fn compact_history(&self) {
        if self.store.is_none() || self.history_closed.load(Ordering::Relaxed) {
            return;
        }
        let _history_guard = self
            .history_lock
            .lock()
            .expect("terminal output history lock poisoned");
        self.compact_history_locked();
    }

    fn compact_history_locked(&self) {
        if self.history_closed.load(Ordering::Relaxed) {
            return;
        }
        let Some(store) = &self.store else {
            return;
        };
        let frames = {
            let inner = self.inner.lock().expect("terminal output buffer poisoned");
            inner.frames.iter().cloned().collect::<Vec<_>>()
        };
        if let Err(err) = store.compact(&frames) {
            warn!(error = %err, session_id = %store.session_id, "failed to compact terminal output history");
        }
    }

    pub fn detach_history(&self) {
        self.history_closed.store(true, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub fn delete_history(&self) {
        self.history_closed.store(true, Ordering::Relaxed);
        let _history_guard = self
            .history_lock
            .lock()
            .expect("terminal output history lock poisoned");
        if let Some(store) = &self.store
            && let Err(err) = store.remove()
        {
            warn!(error = %err, session_id = %store.session_id, "failed to remove terminal output history");
        }
    }
}

fn first_output_frame_after(frames: &VecDeque<OutputFrame>, sequence: u64) -> usize {
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

impl Default for OutputBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_OUTPUT_FRAME_LIMIT)
    }
}

fn prune_output_buffer(inner: &mut OutputBufferInner) {
    while inner.frames.len() > inner.max_lines
        || inner.total_lines > inner.max_lines
        || inner.total_bytes > inner.max_bytes
    {
        let Some(removed) = inner.frames.pop_front() else {
            break;
        };
        inner.total_bytes = inner.total_bytes.saturating_sub(removed.data.len());
        inner.total_lines = inner
            .total_lines
            .saturating_sub(output_history_line_count(&removed.data));
    }
}

fn output_history_line_count(data: &[u8]) -> usize {
    data.iter().filter(|byte| matches!(byte, b'\n')).count()
}

#[derive(Clone)]
struct OutputHistoryStore {
    session_id: String,
    database: Arc<AppDatabase>,
}

#[derive(Default)]
struct LoadedHistory {
    frames: VecDeque<OutputFrame>,
    total_bytes: usize,
    total_lines: usize,
    next_sequence: u64,
}

impl OutputHistoryStore {
    fn load(&self) -> io::Result<LoadedHistory> {
        let version = self
            .database
            .load_output_history_protocol_version(&self.session_id)?;
        if version.as_deref() != Some(AGENT_PROTOCOL_VERSION) {
            let _ = self.database.delete_output_history(&self.session_id);
            let _ = self.database.delete_herdr_output_sequence(&self.session_id);
            return Ok(LoadedHistory::default());
        }
        let frames = self.database.load_output_history(&self.session_id)?;
        let mut loaded = LoadedHistory::default();
        for frame in frames {
            loaded.next_sequence = loaded.next_sequence.max(frame.sequence);
            loaded.total_bytes = loaded.total_bytes.saturating_add(frame.data.len());
            loaded.total_lines = loaded
                .total_lines
                .saturating_add(output_history_line_count(&frame.data));
            loaded.frames.push_back(frame);
        }
        Ok(loaded)
    }

    fn append(&self, frame: &OutputFrame, first_retained_sequence: u64) -> io::Result<()> {
        self.database.append_output_frame(
            &self.session_id,
            frame,
            first_retained_sequence,
            AGENT_PROTOCOL_VERSION,
        )
    }

    fn compact(&self, frames: &[OutputFrame]) -> io::Result<()> {
        self.database
            .replace_output_history(&self.session_id, frames, AGENT_PROTOCOL_VERSION)
    }

    fn remove(&self) -> io::Result<()> {
        self.database.delete_output_history(&self.session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CONNECTION_EVENT_CAPACITY, CONNECTION_PTY_INPUT_CHANNEL_CAPACITY, EVENT_CAPACITY,
        MAX_CONNECTION_TERMINAL_BUFFER_BYTES, MAX_CONNECTION_TERMINALS,
        MAX_CONNECTION_TERMINALS_PER_SESSION, ManagedTerminal, OutputBuffer,
        RetryableConnectionTerminalError, TerminalRegistry, TerminalSpec,
        begin_connection_terminal_close, validate_connection_terminal_capacity,
    };
    use crate::config::{
        MAX_OUTPUT_BUFFER_BYTES, MAX_OUTPUT_FRAME_LIMIT, PTY_INPUT_MESSAGE_BYTES,
        PTY_OUTPUT_BATCH_BYTES,
    };
    use crate::database::AppDatabase;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn snapshots_output_after_sequence() {
        let output = OutputBuffer::default();
        let first = output.push(b"one".to_vec());
        let second = output.push(b"two".to_vec());

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);

        let (frames, last_sequence) = output.snapshot_after(1);

        assert_eq!(last_sequence, 2);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].sequence, 2);
        assert_eq!(frames[0].data.as_ref(), b"two");
    }

    #[test]
    fn live_output_and_history_share_the_same_payload_allocation() {
        let output = OutputBuffer::default();
        let live = output.push(vec![b'x'; 64 * 1024]);
        let stored = output
            .snapshot_after(0)
            .0
            .pop()
            .expect("stored output frame");

        assert_eq!(live.data.as_ptr(), stored.data.as_ptr());
    }

    #[test]
    fn output_history_and_live_backlog_have_explicit_byte_budgets() {
        assert_eq!(
            EVENT_CAPACITY * PTY_OUTPUT_BATCH_BYTES,
            MAX_OUTPUT_BUFFER_BYTES
        );

        let output = OutputBuffer::new(MAX_OUTPUT_FRAME_LIMIT);
        let frame_bytes = MAX_OUTPUT_BUFFER_BYTES / 4;
        for _ in 0..5 {
            output.push(vec![b'x'; frame_bytes]);
        }
        let inner = output.inner.lock().expect("terminal output buffer");

        assert_eq!(inner.total_bytes, MAX_OUTPUT_BUFFER_BYTES);
        assert_eq!(inner.frames.len(), 4);
    }

    #[test]
    fn connection_terminal_history_and_backlog_use_a_smaller_budget() {
        assert_eq!(
            CONNECTION_EVENT_CAPACITY * PTY_OUTPUT_BATCH_BYTES,
            MAX_CONNECTION_TERMINAL_BUFFER_BYTES
        );

        let output = OutputBuffer::new_with_byte_limit(
            MAX_OUTPUT_FRAME_LIMIT,
            MAX_CONNECTION_TERMINAL_BUFFER_BYTES,
        );
        for _ in 0..3 {
            output.push(vec![b'x'; MAX_CONNECTION_TERMINAL_BUFFER_BYTES / 2]);
        }
        let inner = output.inner.lock().expect("terminal output buffer");

        assert_eq!(inner.total_bytes, MAX_CONNECTION_TERMINAL_BUFFER_BYTES);
        assert_eq!(inner.frames.len(), 2);
        assert_eq!(
            CONNECTION_PTY_INPUT_CHANNEL_CAPACITY * PTY_INPUT_MESSAGE_BYTES,
            512 * 1024
        );
    }

    #[test]
    fn snapshot_reports_real_last_sequence_when_after_is_stale() {
        let output = OutputBuffer::default();
        output.push(b"one".to_vec());

        let (frames, last_sequence) = output.snapshot_after(99);

        assert!(frames.is_empty());
        assert_eq!(last_sequence, 1);
    }

    #[test]
    fn prunes_output_by_frame_limit() {
        let output = OutputBuffer::new(128);
        for index in 0..130 {
            output.push(vec![index]);
        }

        let (frames, last_sequence) = output.snapshot_after(0);

        assert_eq!(last_sequence, 130);
        assert_eq!(frames.len(), 128);
        assert_eq!(frames[0].sequence, 3);
        assert_eq!(frames[0].data, vec![2]);
    }

    #[test]
    fn prunes_output_by_line_limit() {
        let output = OutputBuffer::new(128);
        for index in 0..130 {
            output.push(format!("{index}\n").into_bytes());
        }

        let (frames, last_sequence) = output.snapshot_after(0);

        assert_eq!(last_sequence, 130);
        assert_eq!(frames.len(), 128);
        assert_eq!(frames[0].sequence, 3);
        assert_eq!(frames[0].data.as_ref(), b"2\n");
    }

    #[test]
    fn unrecorded_output_advances_sequence_without_replay_data() {
        let output = OutputBuffer::new(128);
        output.push(b"before".to_vec());
        output.set_recording(false);
        let live = output.push(b"binary".to_vec());
        output.set_recording(true);
        output.push(b"after".to_vec());

        assert_eq!(live.sequence, 2);
        let (frames, last_sequence) = output.snapshot_after(0);

        assert_eq!(last_sequence, 3);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].sequence, 1);
        assert_eq!(frames[0].data.as_ref(), b"before");
        assert_eq!(frames[1].sequence, 3);
        assert_eq!(frames[1].data.as_ref(), b"after");
    }

    #[test]
    fn snapshot_reports_unrecorded_tail_sequence() {
        let output = OutputBuffer::new(128);
        output.push(b"before".to_vec());
        output.set_recording(false);
        output.push(b"binary".to_vec());

        let (frames, last_sequence) = output.snapshot_after(0);

        assert_eq!(last_sequence, 2);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].sequence, 1);
    }

    #[test]
    fn bounded_snapshot_stops_at_byte_limit() {
        let output = OutputBuffer::new(128);
        for data in [b"a".as_slice(), b"bb", b"ccc", b"dddd", b"eeeee", b"ffffff"] {
            output.push(data.to_vec());
        }

        let snapshot = output.snapshot_after_bounded(1, 5, 8);

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
        let output = OutputBuffer::new(128);
        for index in 0..130 {
            output.push(format!("{index}\n").into_bytes());
        }

        let snapshot = output.snapshot_after_bounded(0, 1024, 8);

        assert_eq!(snapshot.oldest_sequence, Some(3));
        assert!(snapshot.replay_gap);
    }

    #[test]
    fn managed_terminal_close_kills_waits_and_is_idempotent() {
        let terminal = ManagedTerminal::spawn(
            TerminalSpec {
                session_id: "close-test".to_owned(),
                host: "localhost".to_owned(),
                selector: "local@test".to_owned(),
                command: "/bin/sh".to_owned(),
                args: vec!["-lc".to_owned(), "exec sleep 30".to_owned()],
                cols: 80,
                rows: 24,
                output_frame_limit: 128,
            },
            Arc::new(OutputBuffer::new(128)),
        )
        .unwrap();

        terminal.close();
        terminal.close();

        assert!(terminal.exit_info().is_some());
    }

    #[test]
    fn transient_terminals_never_reuse_output_history() {
        let spec = TerminalSpec {
            session_id: "transient-test".to_owned(),
            host: "localhost".to_owned(),
            selector: "local@test".to_owned(),
            command: "/bin/sh".to_owned(),
            args: vec!["-lc".to_owned(), "exec sleep 30".to_owned()],
            cols: 80,
            rows: 24,
            output_frame_limit: 128,
        };

        let first = ManagedTerminal::spawn_connection_scoped(spec.clone()).unwrap();
        first
            .output_buffer()
            .push(b"old incremental frame".to_vec());
        let second = ManagedTerminal::spawn_connection_scoped(spec).unwrap();

        assert!(!Arc::ptr_eq(&first, &second));
        assert!(second.output_buffer().snapshot_after(0).0.is_empty());
        first.close();
        second.close();
    }

    #[test]
    fn connection_terminals_are_tracked_and_released_independently() {
        let registry = TerminalRegistry::new();
        let spec = TerminalSpec {
            session_id: "connection-test".to_owned(),
            host: "localhost".to_owned(),
            selector: "local@test".to_owned(),
            command: "/bin/sh".to_owned(),
            args: vec!["-lc".to_owned(), "exec sleep 30".to_owned()],
            cols: 80,
            rows: 24,
            output_frame_limit: 128,
        };

        let (first_id, first) = registry.open_connection(spec.clone()).unwrap();
        let (second_id, second) = registry.open_connection(spec).unwrap();
        first.output_buffer().push(b"first".to_vec());

        assert!(!Arc::ptr_eq(&first, &second));
        assert!(second.output_buffer().snapshot_after(0).0.is_empty());

        let first_release = registry.release_connection("connection-test", &first_id);
        first_release.unwrap().close();
        assert!(
            registry
                .connections
                .read()
                .unwrap()
                .sessions
                .contains_key("connection-test")
        );
        let second_release = registry.release_connection("connection-test", &second_id);
        second_release.unwrap().close();
        assert!(
            !registry
                .connections
                .read()
                .unwrap()
                .sessions
                .contains_key("connection-test")
        );
    }

    #[test]
    fn repeated_session_close_starts_only_one_cleanup_batch() {
        let registry = TerminalRegistry::new();
        let spec = TerminalSpec {
            session_id: "idempotent-close-test".to_owned(),
            host: "localhost".to_owned(),
            selector: "local@test".to_owned(),
            command: "/bin/sh".to_owned(),
            args: vec!["-lc".to_owned(), "exec sleep 30".to_owned()],
            cols: 80,
            rows: 24,
            output_frame_limit: 128,
        };
        registry.open_connection(spec).unwrap();

        let first_batch = {
            let mut connections = registry.connections.write().unwrap();
            let first = begin_connection_terminal_close(&mut connections, "idempotent-close-test");
            let second = begin_connection_terminal_close(&mut connections, "idempotent-close-test");
            assert_eq!(first.len(), 1);
            assert!(second.is_empty());
            first
        };

        for (connection_id, terminal) in first_batch {
            terminal.close_connection(Duration::from_secs(1));
            registry.release_connection("idempotent-close-test", &connection_id);
        }
    }

    #[test]
    fn releasing_the_last_connection_removes_its_empty_bucket() {
        let registry = TerminalRegistry::new();
        let spec = TerminalSpec {
            session_id: "generation-test".to_owned(),
            host: "localhost".to_owned(),
            selector: "local@test".to_owned(),
            command: "/bin/sh".to_owned(),
            args: vec!["-lc".to_owned(), "exec sleep 30".to_owned()],
            cols: 80,
            rows: 24,
            output_frame_limit: 128,
        };

        let (first_id, first) = registry.open_connection(spec.clone()).unwrap();
        let released = registry.release_connection("generation-test", &first_id);
        assert!(
            !registry
                .connections
                .read()
                .unwrap()
                .sessions
                .contains_key("generation-test")
        );
        let (second_id, second) = registry.open_connection(spec).unwrap();

        released.unwrap().close();
        let second_release = registry.release_connection("generation-test", &second_id);
        assert!(
            !registry
                .connections
                .read()
                .unwrap()
                .sessions
                .contains_key("generation-test")
        );
        second_release.unwrap().close();
        drop(first);
        drop(second);
    }

    #[test]
    fn closing_a_session_signals_connection_terminals_without_serial_waits() {
        let registry = Arc::new(TerminalRegistry::new());
        let spec = TerminalSpec {
            session_id: "close-connections-test".to_owned(),
            host: "localhost".to_owned(),
            selector: "local@test".to_owned(),
            command: "/bin/sh".to_owned(),
            args: vec!["-lc".to_owned(), "exec sleep 30".to_owned()],
            cols: 80,
            rows: 24,
            output_frame_limit: 128,
        };
        let terminals = (0..MAX_CONNECTION_TERMINALS_PER_SESSION)
            .map(|_| registry.open_connection(spec.clone()).unwrap().1)
            .collect::<Vec<_>>();

        let started = Instant::now();
        registry.close("close-connections-test");

        assert!(started.elapsed() < Duration::from_secs(1));
        let deadline = Instant::now() + Duration::from_secs(5);
        while (terminals
            .iter()
            .any(|terminal| terminal.exit_info().is_none())
            || registry
                .connections
                .read()
                .unwrap()
                .sessions
                .contains_key("close-connections-test"))
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            terminals
                .iter()
                .all(|terminal| terminal.exit_info().is_some())
        );
        assert!(
            !registry
                .connections
                .read()
                .unwrap()
                .sessions
                .contains_key("close-connections-test")
        );
    }

    #[test]
    fn connection_terminal_capacity_is_bounded() {
        assert!(validate_connection_terminal_capacity(0, 0).is_ok());
        assert!(matches!(
            validate_connection_terminal_capacity(MAX_CONNECTION_TERMINALS, 0),
            Err(RetryableConnectionTerminalError::GlobalCapacity)
        ));
        assert!(matches!(
            validate_connection_terminal_capacity(0, MAX_CONNECTION_TERMINALS_PER_SESSION),
            Err(RetryableConnectionTerminalError::SessionCapacity)
        ));
    }

    #[test]
    fn connection_terminal_spawn_failures_remain_retryable() {
        let registry = TerminalRegistry::new();
        let result = registry.open_connection(TerminalSpec {
            session_id: "retryable-spawn-test".to_owned(),
            host: "localhost".to_owned(),
            selector: "local@test".to_owned(),
            command: String::new(),
            args: Vec::new(),
            cols: 80,
            rows: 24,
            output_frame_limit: 128,
        });
        let Err(error) = result else {
            panic!("empty terminal command should fail");
        };

        assert!(
            error
                .downcast_ref::<RetryableConnectionTerminalError>()
                .is_some()
        );
    }

    #[test]
    fn persistent_output_round_trips_history() {
        let database = temp_database();
        let output = OutputBuffer::persistent(128, "session-one".to_owned(), Arc::clone(&database));

        output.push(b"one".to_vec());
        output.push(b"two".to_vec());

        let reloaded = OutputBuffer::persistent(128, "session-one".to_owned(), database);
        let (frames, last_sequence) = reloaded.snapshot_after(0);

        assert_eq!(last_sequence, 2);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].sequence, 1);
        assert_eq!(frames[0].data.as_ref(), b"one");
        assert_eq!(frames[1].sequence, 2);
        assert_eq!(frames[1].data.as_ref(), b"two");

        let third = reloaded.push(b"three".to_vec());
        assert_eq!(third.sequence, 3);
    }

    #[test]
    fn persistent_output_prunes_history_on_load() {
        let database = temp_database();
        let output = OutputBuffer::persistent(128, "session-one".to_owned(), Arc::clone(&database));
        for index in 0..130 {
            output.push(vec![index]);
        }

        let reloaded = OutputBuffer::persistent(128, "session-one".to_owned(), database);
        let (frames, last_sequence) = reloaded.snapshot_after(0);

        assert_eq!(last_sequence, 130);
        assert_eq!(frames.len(), 128);
        assert_eq!(frames[0].sequence, 3);
        assert_eq!(frames[0].data, vec![2]);
    }

    #[test]
    fn persistent_output_drops_history_from_old_protocol() {
        let database = temp_database();
        database
            .store_herdr_output_sequence("session-one", 99)
            .unwrap();
        database
            .append_output_frame(
                "session-one",
                &crate::terminal_manager::OutputFrame {
                    sequence: 1,
                    data: bytes::Bytes::from_static(b"old"),
                },
                1,
                "lazycat-neko-webshell-agent-v0",
            )
            .unwrap();

        let output = OutputBuffer::persistent(128, "session-one".to_owned(), Arc::clone(&database));
        let (frames, last_sequence) = output.snapshot_after(0);

        assert!(frames.is_empty());
        assert_eq!(last_sequence, 0);
        assert!(
            database
                .load_output_history("session-one")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            database.load_herdr_output_sequence("session-one").unwrap(),
            None
        );
    }

    fn temp_database() -> Arc<AppDatabase> {
        Arc::new(
            AppDatabase::open(std::env::temp_dir().join(format!(
                "lazycat-neko-webshell-output-history-{}.db",
                uuid::Uuid::new_v4()
            )))
            .unwrap(),
        )
    }
}
