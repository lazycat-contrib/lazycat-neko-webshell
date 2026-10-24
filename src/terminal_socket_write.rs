use std::time::Duration;

use futures::{Sink, SinkExt as _};

pub(crate) async fn send_batch<Writer, Message>(
    writer: &mut Writer,
    messages: impl IntoIterator<Item = Message>,
    deadline: Duration,
) -> anyhow::Result<()>
where
    Writer: Sink<Message> + Unpin,
    Writer::Error: std::error::Error + Send + Sync + 'static,
{
    let mut messages = messages.into_iter().peekable();
    if messages.peek().is_none() {
        return Ok(());
    }
    tokio::time::timeout(deadline, async {
        for message in messages {
            writer.feed(message).await?;
        }
        writer.flush().await
    })
    .await
    .map_err(|_| anyhow::anyhow!("terminal websocket send timed out"))?
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use futures::Sink;

    #[derive(Default)]
    struct RecordingSink {
        messages: Vec<u8>,
        flushes: usize,
        stalled: bool,
        failed: bool,
    }

    impl Sink<u8> for RecordingSink {
        type Error = std::io::Error;

        fn poll_ready(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(mut self: Pin<&mut Self>, message: u8) -> Result<(), Self::Error> {
            self.messages.push(message);
            Ok(())
        }

        fn poll_flush(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            self.flushes += 1;
            if self.stalled {
                return Poll::Pending;
            }
            if self.failed {
                return Poll::Ready(Err(std::io::Error::other("closed peer")));
            }
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn output_and_sequence_are_ordered_with_one_flush() {
        let mut writer = RecordingSink::default();
        super::send_batch(&mut writer, [1, 2], Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(writer.messages, [1, 2]);
        assert_eq!(writer.flushes, 1);
    }

    #[tokio::test]
    async fn failed_flush_is_not_retried() {
        let mut writer = RecordingSink {
            failed: true,
            ..Default::default()
        };
        let error = super::send_batch(&mut writer, [1, 2], Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("closed peer"));
        assert_eq!(writer.messages, [1, 2]);
        assert_eq!(writer.flushes, 1);
    }

    #[tokio::test]
    async fn stalled_flush_has_a_single_bounded_deadline() {
        let mut writer = RecordingSink {
            stalled: true,
            ..Default::default()
        };
        let pending = super::send_batch(&mut writer, [1, 2], Duration::from_millis(20));
        let result = tokio::time::timeout(Duration::from_millis(200), pending).await;
        assert!(result.is_ok(), "batch send exceeded its deadline");
        assert!(
            result
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
    }

    #[tokio::test]
    async fn real_websocket_keeps_binary_sequence_and_echo_compatible() {
        use futures::{SinkExt as _, StreamExt as _};
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let (mut output, mut input) = socket.split();
            super::send_batch(
                &mut output,
                [
                    Message::Binary(b"terminal-output".to_vec().into()),
                    Message::Text("{\"type\":\"output-sequence\",\"sequence\":1}".into()),
                ],
                Duration::from_secs(2),
            )
            .await
            .unwrap();
            let echo = input.next().await.unwrap().unwrap();
            super::send_batch(&mut output, [echo], Duration::from_secs(2))
                .await
                .unwrap();
        });
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let output = client.next().await.unwrap().unwrap();
        assert_eq!(output.into_data(), b"terminal-output".as_slice());
        let sequence = client.next().await.unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(sequence.to_text().unwrap()).unwrap();
        assert_eq!(value["sequence"], 1);
        client
            .send(Message::Binary(b"input-marker".to_vec().into()))
            .await
            .unwrap();
        assert_eq!(
            client.next().await.unwrap().unwrap().into_data(),
            b"input-marker".as_slice()
        );
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}
