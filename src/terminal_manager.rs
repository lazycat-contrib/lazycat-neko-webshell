use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use anyhow::{Context as AnyhowContext, anyhow};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::config::{DEFAULT_OUTPUT_FRAME_LIMIT, MAX_OUTPUT_BUFFER_BYTES};
use crate::database::AppDatabase;
use crate::validation::{normalize_output_frame_limit, validate_size};

const EVENT_CAPACITY: usize = 1024;

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
    pub data: Vec<u8>,
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
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub fn open(
        &self,
        spec: TerminalSpec,
        allow_spawn: bool,
        output: Arc<OutputBuffer>,
    ) -> anyhow::Result<Arc<ManagedTerminal>> {
        if let Some(existing) = self.existing(&spec.session_id)? {
            existing.resize(spec.cols, spec.rows)?;
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
                existing.resize(terminal.cols(), terminal.rows())?;
                return Ok(Arc::clone(existing));
            }
        }

        sessions.insert(terminal.session_id().to_owned(), Arc::clone(&terminal));
        Ok(terminal)
    }

    pub fn close(&self, session_id: &str) {
        let terminal = self
            .sessions
            .write()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id));
        if let Some(terminal) = terminal {
            terminal.close();
        }
    }

    pub fn forget(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.write() {
            sessions.remove(session_id);
        }
    }

    fn existing(&self, session_id: &str) -> anyhow::Result<Option<Arc<ManagedTerminal>>> {
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

pub struct ManagedTerminal {
    session_id: String,
    selector: String,
    cols: u16,
    rows: u16,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer_tx: std::sync::mpsc::Sender<WriterCommand>,
    event_tx: broadcast::Sender<TerminalEvent>,
    killer: Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    output: Arc<OutputBuffer>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
}

impl ManagedTerminal {
    fn spawn(spec: TerminalSpec, output: Arc<OutputBuffer>) -> anyhow::Result<Self> {
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
        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

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
        let killer = child.clone_killer();
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (writer_tx, writer_rx) = std::sync::mpsc::channel::<WriterCommand>();
        let (event_tx, _) = broadcast::channel::<TerminalEvent>(EVENT_CAPACITY);
        let exit = Arc::new(Mutex::new(None));

        spawn_output_thread(reader, event_tx.clone(), Arc::clone(&output));
        spawn_writer_thread(writer, writer_rx);
        spawn_exit_thread(child, event_tx.clone(), Arc::clone(&exit));

        Ok(Self {
            session_id: spec.session_id,
            selector: spec.selector,
            cols: spec.cols,
            rows: spec.rows,
            master: Mutex::new(pair.master),
            writer_tx,
            event_tx,
            killer: Mutex::new(Some(killer)),
            output,
            exit,
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

    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.exit.lock().ok().and_then(|exit| exit.clone())
    }

    pub fn write_input(&self, data: Vec<u8>) -> anyhow::Result<()> {
        self.writer_tx
            .send(WriterCommand::Input(data))
            .map_err(|_| anyhow!("terminal input writer is closed"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        validate_size(cols, rows)?;
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow!("pty lock poisoned"))?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn set_output_frame_limit(&self, limit: usize) {
        self.output.set_limit(limit);
    }

    fn close(&self) {
        let _ = self.writer_tx.send(WriterCommand::Close);
        let Some(mut child_killer) = self.killer.lock().ok().and_then(|mut killer| killer.take())
        else {
            return;
        };
        if let Err(err) = child_killer.kill() {
            warn!(error = %err, "terminal child was already closed");
        }
    }
}

impl Drop for ManagedTerminal {
    fn drop(&mut self) {
        self.close();
    }
}

enum WriterCommand {
    Input(Vec<u8>),
    Close,
}

fn spawn_output_thread(
    mut reader: Box<dyn Read + Send>,
    event_tx: broadcast::Sender<TerminalEvent>,
    output: Arc<OutputBuffer>,
) {
    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let frame = output.push(buf[..n].to_vec());
                    let _ = event_tx.send(TerminalEvent::Output(frame));
                }
                Err(err) => {
                    let _ = event_tx.send(TerminalEvent::Error(err.to_string()));
                    break;
                }
            }
        }
    });
}

fn spawn_writer_thread(
    mut writer: Box<dyn Write + Send>,
    writer_rx: std::sync::mpsc::Receiver<WriterCommand>,
) {
    thread::spawn(move || {
        for command in writer_rx {
            match command {
                WriterCommand::Input(data) => {
                    if let Err(err) = writer.write_all(&data) {
                        warn!(error = %err, "failed to write terminal input");
                        break;
                    }
                    if let Err(err) = writer.flush() {
                        warn!(error = %err, "failed to flush terminal input");
                        break;
                    }
                }
                WriterCommand::Close => break,
            }
        }
    });
}

fn spawn_exit_thread(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    event_tx: broadcast::Sender<TerminalEvent>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
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
        let _ = event_tx.send(TerminalEvent::Exit(info));
    });
}

pub struct OutputBuffer {
    inner: Mutex<OutputBufferInner>,
    history_lock: Mutex<()>,
    store: Option<OutputHistoryStore>,
    history_closed: AtomicBool,
}

struct OutputBufferInner {
    frames: VecDeque<OutputFrame>,
    total_bytes: usize,
    total_lines: usize,
    next_sequence: u64,
    max_lines: usize,
}

impl OutputBuffer {
    pub fn new(max_frames: usize) -> Self {
        Self {
            inner: Mutex::new(OutputBufferInner {
                frames: VecDeque::new(),
                total_bytes: 0,
                total_lines: 0,
                next_sequence: 0,
                max_lines: normalize_output_frame_limit(Some(max_frames)),
            }),
            history_lock: Mutex::new(()),
            store: None,
            history_closed: AtomicBool::new(false),
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
        };
        prune_output_buffer(&mut inner);
        let output = Self {
            inner: Mutex::new(inner),
            history_lock: Mutex::new(()),
            store: Some(store),
            history_closed: AtomicBool::new(false),
        };
        output.compact_history();
        output
    }

    fn push(&self, data: Vec<u8>) -> OutputFrame {
        let _history_guard = self
            .history_lock
            .lock()
            .expect("terminal output history lock poisoned");
        let (frame, first_retained_sequence) = {
            let mut inner = self.inner.lock().expect("terminal output buffer poisoned");
            inner.total_bytes = inner.total_bytes.saturating_add(data.len());
            inner.next_sequence = inner.next_sequence.saturating_add(1);
            let frame = OutputFrame {
                sequence: inner.next_sequence,
                data,
            };
            inner.total_lines = inner
                .total_lines
                .saturating_add(output_history_line_count(&frame.data));
            inner.frames.push_back(frame.clone());
            prune_output_buffer(&mut inner);
            let first_retained_sequence = inner
                .frames
                .front()
                .map_or(frame.sequence, |frame| frame.sequence);
            (frame, first_retained_sequence)
        };
        self.append_history(&frame, first_retained_sequence);
        frame
    }

    pub fn set_limit(&self, max_frames: usize) {
        let mut inner = self.inner.lock().expect("terminal output buffer poisoned");
        inner.max_lines = normalize_output_frame_limit(Some(max_frames));
        prune_output_buffer(&mut inner);
        drop(inner);
        self.compact_history();
    }

    pub fn snapshot_after(&self, sequence: u64) -> (Vec<OutputFrame>, u64) {
        let inner = self.inner.lock().expect("terminal output buffer poisoned");
        (
            inner
                .frames
                .iter()
                .filter(|frame| frame.sequence > sequence)
                .cloned()
                .collect(),
            inner
                .frames
                .back()
                .map_or(sequence, |frame| frame.sequence.max(sequence)),
        )
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

impl Default for OutputBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_OUTPUT_FRAME_LIMIT)
    }
}

fn prune_output_buffer(inner: &mut OutputBufferInner) {
    while inner.frames.len() > inner.max_lines
        || inner.total_lines > inner.max_lines
        || inner.total_bytes > MAX_OUTPUT_BUFFER_BYTES
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
        self.database
            .append_output_frame(&self.session_id, frame, first_retained_sequence)
    }

    fn compact(&self, frames: &[OutputFrame]) -> io::Result<()> {
        self.database
            .replace_output_history(&self.session_id, frames)
    }

    fn remove(&self) -> io::Result<()> {
        self.database.delete_output_history(&self.session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::OutputBuffer;
    use crate::database::AppDatabase;
    use std::sync::Arc;

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
        assert_eq!(frames[0].data, b"two");
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
        assert_eq!(frames[0].data, b"2\n");
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
        assert_eq!(frames[0].data, b"one");
        assert_eq!(frames[1].sequence, 2);
        assert_eq!(frames[1].data, b"two");

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
