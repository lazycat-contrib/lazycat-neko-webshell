use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{
    PTY_INPUT_BATCH_BYTES, PTY_INPUT_CHANNEL_CAPACITY, PTY_INPUT_MESSAGE_BYTES,
    PTY_OUTPUT_BATCH_BYTES, PTY_OUTPUT_BATCH_INTERVAL_MS, PTY_OUTPUT_CHANNEL_CAPACITY,
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PtyInputError {
    #[error("PTY input exceeds the {max_bytes} byte message limit")]
    TooLarge { max_bytes: usize },
    #[error("PTY input queue is full")]
    Backpressure,
    #[error("PTY input writer is closed")]
    Closed,
}

enum PtyWriterCommand {
    Input(Vec<u8>),
    Close,
}

pub struct PtyWriter {
    sender: Mutex<Option<mpsc::SyncSender<PtyWriterCommand>>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl PtyWriter {
    pub fn spawn(writer: Box<dyn Write + Send>) -> Self {
        let (sender, receiver) = mpsc::sync_channel(PTY_INPUT_CHANNEL_CAPACITY);
        let worker = thread::spawn(move || run_writer(writer, receiver));
        Self {
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
        }
    }

    pub fn send(&self, data: Vec<u8>) -> Result<(), PtyInputError> {
        if data.len() > PTY_INPUT_MESSAGE_BYTES {
            return Err(PtyInputError::TooLarge {
                max_bytes: PTY_INPUT_MESSAGE_BYTES,
            });
        }
        let sender = self.sender.lock().map_err(|_| PtyInputError::Closed)?;
        let Some(sender) = sender.as_ref() else {
            return Err(PtyInputError::Closed);
        };
        sender
            .try_send(PtyWriterCommand::Input(data))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => PtyInputError::Backpressure,
                mpsc::TrySendError::Disconnected(_) => PtyInputError::Closed,
            })
    }

    pub fn close(&self) {
        self.signal_close();
        self.wait();
    }

    pub fn signal_close(&self) {
        let sender = self.sender.lock().ok().and_then(|mut sender| sender.take());
        if let Some(sender) = sender {
            let _ = sender.try_send(PtyWriterCommand::Close);
        }
    }

    pub fn wait(&self) {
        let worker = self.worker.lock().ok().and_then(|mut worker| worker.take());
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

impl Drop for PtyWriter {
    fn drop(&mut self) {
        self.close();
    }
}

fn run_writer(mut writer: Box<dyn Write + Send>, receiver: mpsc::Receiver<PtyWriterCommand>) {
    while let Ok(command) = receiver.recv() {
        let PtyWriterCommand::Input(first) = command else {
            break;
        };
        let mut batch = first;
        let mut close_after_write = false;
        while batch.len() < PTY_INPUT_BATCH_BYTES {
            match receiver.try_recv() {
                Ok(PtyWriterCommand::Input(data)) => {
                    if batch.len().saturating_add(data.len()) > PTY_INPUT_BATCH_BYTES {
                        if writer.write_all(&batch).is_err() || writer.flush().is_err() {
                            return;
                        }
                        batch = data;
                    } else {
                        batch.extend_from_slice(&data);
                    }
                }
                Ok(PtyWriterCommand::Close) => {
                    close_after_write = true;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    close_after_write = true;
                    break;
                }
            }
        }
        if writer.write_all(&batch).is_err() || writer.flush().is_err() {
            break;
        }
        if close_after_write {
            break;
        }
    }
}

#[derive(Debug)]
pub enum PtyOutputEvent {
    Output(Vec<u8>),
    Error(String),
}

enum ReaderEvent {
    Output(Vec<u8>),
    Error(String),
    Eof,
}

pub fn spawn_batched_output_reader(
    mut reader: Box<dyn Read + Send>,
    mut emit: impl FnMut(PtyOutputEvent) -> bool + Send + 'static,
) {
    let (sender, receiver) = mpsc::sync_channel(PTY_OUTPUT_CHANNEL_CAPACITY);
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(ReaderEvent::Eof);
                    break;
                }
                Ok(count) => {
                    if sender
                        .send(ReaderEvent::Output(buffer[..count].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(ReaderEvent::Error(error.to_string()));
                    break;
                }
            }
        }
    });
    thread::spawn(move || {
        let mut pending = Vec::with_capacity(PTY_OUTPUT_BATCH_BYTES);
        let mut deadline: Option<Instant> = None;
        loop {
            let event = match deadline {
                Some(deadline) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match receiver.recv_timeout(remaining) {
                        Ok(event) => Some(event),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => Some(ReaderEvent::Eof),
                    }
                }
                None => match receiver.recv() {
                    Ok(event) => Some(event),
                    Err(_) => Some(ReaderEvent::Eof),
                },
            };

            match event {
                Some(ReaderEvent::Output(data)) => {
                    if pending.is_empty() {
                        deadline = Some(
                            Instant::now() + Duration::from_millis(PTY_OUTPUT_BATCH_INTERVAL_MS),
                        );
                    }
                    if !append_output(&mut pending, &data, &mut emit) {
                        break;
                    }
                    if pending.is_empty() {
                        deadline = None;
                    }
                }
                Some(ReaderEvent::Error(error)) => {
                    if !flush_output(&mut pending, &mut emit) {
                        break;
                    }
                    let _ = emit(PtyOutputEvent::Error(error));
                    break;
                }
                Some(ReaderEvent::Eof) => {
                    let _ = flush_output(&mut pending, &mut emit);
                    break;
                }
                None => {
                    if !flush_output(&mut pending, &mut emit) {
                        break;
                    }
                    deadline = None;
                }
            }
        }
    });
}

fn append_output(
    pending: &mut Vec<u8>,
    mut data: &[u8],
    emit: &mut impl FnMut(PtyOutputEvent) -> bool,
) -> bool {
    while !data.is_empty() {
        let available = PTY_OUTPUT_BATCH_BYTES.saturating_sub(pending.len());
        let count = available.min(data.len());
        pending.extend_from_slice(&data[..count]);
        data = &data[count..];
        if pending.len() == PTY_OUTPUT_BATCH_BYTES && !flush_output(pending, emit) {
            return false;
        }
    }
    true
}

fn flush_output(pending: &mut Vec<u8>, emit: &mut impl FnMut(PtyOutputEvent) -> bool) -> bool {
    if pending.is_empty() {
        return true;
    }
    let output = std::mem::replace(pending, Vec::with_capacity(PTY_OUTPUT_BATCH_BYTES));
    emit(PtyOutputEvent::Output(output))
}

#[derive(Clone, Default)]
pub struct ChildWait {
    inner: Arc<(Mutex<bool>, Condvar)>,
}

impl ChildWait {
    pub fn complete(&self) {
        let (lock, condition) = &*self.inner;
        if let Ok(mut completed) = lock.lock() {
            *completed = true;
            condition.notify_all();
        }
    }

    pub fn wait(&self) {
        let (lock, condition) = &*self.inner;
        let Ok(mut completed) = lock.lock() else {
            return;
        };
        while !*completed {
            let Ok(next) = condition.wait(completed) else {
                return;
            };
            completed = next;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};
    use std::sync::{Arc, Condvar, Mutex, mpsc};

    use super::{PtyInputError, PtyOutputEvent, PtyWriter, spawn_batched_output_reader};
    use crate::config::{
        PTY_INPUT_CHANNEL_CAPACITY, PTY_INPUT_MESSAGE_BYTES, PTY_OUTPUT_BATCH_BYTES,
    };

    #[derive(Clone, Default)]
    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct BlockingWriter {
        started: Arc<(Mutex<bool>, Condvar)>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let (started, started_condition) = &*self.started;
            *started.lock().unwrap() = true;
            started_condition.notify_all();
            let (release, release_condition) = &*self.release;
            let mut released = release.lock().unwrap();
            while !*released {
                released = release_condition.wait(released).unwrap();
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn bounded_writer_preserves_input_order() {
        let output = RecordingWriter::default();
        let bytes = Arc::clone(&output.0);
        let writer = PtyWriter::spawn(Box::new(output));

        writer.send(b"one".to_vec()).unwrap();
        writer.send(b"two".to_vec()).unwrap();
        writer.send(b"three".to_vec()).unwrap();
        writer.close();

        assert_eq!(&*bytes.lock().unwrap(), b"onetwothree");
    }

    #[test]
    fn bounded_writer_rejects_oversized_input() {
        let writer = PtyWriter::spawn(Box::new(RecordingWriter::default()));

        let error = writer
            .send(vec![0; PTY_INPUT_MESSAGE_BYTES + 1])
            .unwrap_err();

        assert!(matches!(error, PtyInputError::TooLarge { .. }));
        writer.close();
    }

    #[test]
    fn bounded_writer_reports_backpressure() {
        let started = Arc::new((Mutex::new(false), Condvar::new()));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let writer = PtyWriter::spawn(Box::new(BlockingWriter {
            started: Arc::clone(&started),
            release: Arc::clone(&release),
        }));
        writer.send(vec![b'x']).unwrap();
        let (started_lock, started_condition) = &*started;
        let mut did_start = started_lock.lock().unwrap();
        while !*did_start {
            did_start = started_condition.wait(did_start).unwrap();
        }
        drop(did_start);

        for _ in 0..PTY_INPUT_CHANNEL_CAPACITY {
            writer.send(vec![b'x']).unwrap();
        }
        assert_eq!(writer.send(vec![b'x']), Err(PtyInputError::Backpressure));

        let (release_lock, release_condition) = &*release;
        *release_lock.lock().unwrap() = true;
        release_condition.notify_all();
        writer.close();
    }

    #[test]
    fn output_reader_batches_adjacent_chunks() {
        let (tx, rx) = mpsc::channel();
        spawn_batched_output_reader(
            Box::new(Cursor::new(b"hello world".to_vec())),
            move |event| tx.send(event).is_ok(),
        );

        match rx.recv().unwrap() {
            PtyOutputEvent::Output(bytes) => assert_eq!(bytes, b"hello world"),
            PtyOutputEvent::Error(error) => panic!("unexpected output error: {error}"),
        }
        assert!(rx.recv().is_err());
    }

    #[test]
    fn output_reader_flushes_at_batch_byte_limit() {
        let (tx, rx) = mpsc::channel();
        spawn_batched_output_reader(
            Box::new(Cursor::new(vec![b'x'; PTY_OUTPUT_BATCH_BYTES + 3])),
            move |event| tx.send(event).is_ok(),
        );

        match rx.recv().unwrap() {
            PtyOutputEvent::Output(bytes) => assert_eq!(bytes.len(), PTY_OUTPUT_BATCH_BYTES),
            PtyOutputEvent::Error(error) => panic!("unexpected output error: {error}"),
        }
        match rx.recv().unwrap() {
            PtyOutputEvent::Output(bytes) => assert_eq!(bytes, b"xxx"),
            PtyOutputEvent::Error(error) => panic!("unexpected output error: {error}"),
        }
        assert!(rx.recv().is_err());
    }
}
