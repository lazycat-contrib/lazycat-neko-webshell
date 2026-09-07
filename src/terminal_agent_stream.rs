use std::io;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::agent_protocol::{read_agent_frame_async, write_agent_frame_async};
use crate::proto::lazycat::webshell::v1::AgentFrame;

pub(crate) const AGENT_ATTACH_IO_TIMEOUT: Duration = Duration::from_secs(2);
pub(crate) const AGENT_ATTACH_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
pub(crate) const AGENT_ATTACH_STDERR_LIMIT: usize = 64 * 1024;
const AGENT_FRAME_CHANNEL_CAPACITY: usize = 32;

pub(crate) struct AgentFrameReader {
    receiver: mpsc::Receiver<io::Result<AgentFrame>>,
    task: JoinHandle<()>,
}

impl AgentFrameReader {
    pub(crate) fn spawn<R>(mut reader: R) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        let (sender, receiver) = mpsc::channel(AGENT_FRAME_CHANNEL_CAPACITY);
        let task = tokio::spawn(async move {
            loop {
                let result = read_agent_frame_async(&mut reader).await;
                let finished = result.is_err();
                if sender.send(result).await.is_err() || finished {
                    break;
                }
            }
        });
        Self { receiver, task }
    }

    pub(crate) async fn recv(&mut self) -> Option<io::Result<AgentFrame>> {
        self.receiver.recv().await
    }

    pub(crate) async fn shutdown(mut self) {
        self.receiver.close();
        self.task.abort();
        let _ = self.task.await;
    }
}

pub(crate) async fn write_agent_frame_bounded<W>(
    writer: &mut W,
    frame: &AgentFrame,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_agent_frame_with_timeout(writer, frame, AGENT_ATTACH_IO_TIMEOUT).await
}

async fn write_agent_frame_with_timeout<W>(
    writer: &mut W,
    frame: &AgentFrame,
    deadline: Duration,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    timeout(deadline, write_agent_frame_async(writer, frame))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "agent attach write timed out"))?
}

pub(crate) async fn read_bounded_text<R>(mut reader: R, limit: usize) -> io::Result<String>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let retained = count.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&chunk[..retained]);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncWriteExt, duplex};
    use tokio::sync::oneshot;

    use super::{AgentFrameReader, write_agent_frame_with_timeout};
    use crate::agent_protocol::{binary_frame_with_sequence, write_agent_frame};

    fn encoded_frame(payload: &[u8], sequence: u64) -> Vec<u8> {
        let mut encoded = Vec::new();
        write_agent_frame(
            &mut encoded,
            &binary_frame_with_sequence(payload.to_vec(), sequence),
        )
        .expect("encode frame");
        encoded
    }

    #[tokio::test]
    async fn partial_header_survives_a_competing_event() {
        let encoded = encoded_frame(b"first", 1);
        let (mut writer, reader) = duplex(64);
        let mut frames = AgentFrameReader::spawn(reader);
        let (event_tx, event_rx) = oneshot::channel();

        writer.write_all(&encoded[..2]).await.unwrap();
        event_tx.send(()).unwrap();
        tokio::select! {
            result = frames.recv() => panic!("incomplete frame delivered: {result:?}"),
            result = event_rx => result.unwrap(),
        }
        writer.write_all(&encoded[2..]).await.unwrap();

        let frame = frames.recv().await.unwrap().unwrap();
        assert_eq!(frame.payload.as_deref(), Some(b"first".as_slice()));
        assert_eq!(frame.sequence, Some(1));
        frames.shutdown().await;
    }

    #[tokio::test]
    async fn partial_payload_survives_a_competing_event_and_preserves_order() {
        let first = encoded_frame(b"first", 1);
        let second = encoded_frame(b"second", 2);
        let split = first.len() - 2;
        let (mut writer, reader) = duplex(128);
        let mut frames = AgentFrameReader::spawn(reader);
        let (event_tx, event_rx) = oneshot::channel();

        writer.write_all(&first[..split]).await.unwrap();
        event_tx.send(()).unwrap();
        tokio::select! {
            result = frames.recv() => panic!("incomplete frame delivered: {result:?}"),
            result = event_rx => result.unwrap(),
        }
        writer.write_all(&first[split..]).await.unwrap();
        writer.write_all(&second).await.unwrap();

        let first = frames.recv().await.unwrap().unwrap();
        let second = frames.recv().await.unwrap().unwrap();
        assert_eq!(first.payload.as_deref(), Some(b"first".as_slice()));
        assert_eq!(second.payload.as_deref(), Some(b"second".as_slice()));
        frames.shutdown().await;
    }

    #[tokio::test]
    async fn blocked_agent_input_write_times_out() {
        let (mut writer, _reader) = duplex(1);
        let frame = binary_frame_with_sequence(vec![0; 64], 1);

        let error = write_agent_frame_with_timeout(&mut writer, &frame, Duration::from_millis(20))
            .await
            .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn clean_disconnect_reports_eof_and_reader_shutdown_is_bounded() {
        let (writer, reader) = duplex(8);
        let mut frames = AgentFrameReader::spawn(reader);
        drop(writer);

        let error = frames.recv().await.unwrap().unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
        tokio::time::timeout(Duration::from_millis(100), frames.shutdown())
            .await
            .expect("reader shutdown timed out");
    }

    #[tokio::test]
    async fn stderr_collection_is_bounded() {
        let (mut writer, reader) = duplex(32);
        let write_task = tokio::spawn(async move {
            writer.write_all(&[b'x'; 32]).await.unwrap();
        });

        let text = super::read_bounded_text(reader, 8).await.unwrap();
        write_task.await.unwrap();
        assert_eq!(text, "xxxxxxxx");
    }
}
