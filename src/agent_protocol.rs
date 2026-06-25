use std::io::{self, Read, Write};

use buffa::{Message, MessageField};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::proto::lazycat::webshell::v1::{
    AgentControl, AgentControlType, AgentFrame, AgentFrameType, AgentRequest, AgentRequestType,
    AgentResize, AgentResponse, AgentWorkspaceAction, AgentWorkspaceState,
};

pub const AGENT_PROTOCOL_VERSION: &str = "lazycat-neko-webshell-agent-v3";
pub const MAX_AGENT_MESSAGE_BYTES: usize = 32 * 1024 * 1024;

pub fn write_agent_message<W, M>(mut writer: W, message: &M) -> io::Result<()>
where
    W: Write,
    M: Message,
{
    let payload = message.encode_to_vec();
    if payload.len() > MAX_AGENT_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("agent message payload too large: {}", payload.len()),
        ));
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(&payload)
}

pub async fn write_agent_message_async<W, M>(writer: &mut W, message: &M) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    M: Message,
{
    let payload = message.encode_to_vec();
    if payload.len() > MAX_AGENT_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("agent message payload too large: {}", payload.len()),
        ));
    }
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&payload).await?;
    writer.flush().await
}

pub fn read_agent_message<R, M>(mut reader: R) -> io::Result<M>
where
    R: Read,
    M: Message,
{
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    if size > MAX_AGENT_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("agent message payload too large: {size}"),
        ));
    }

    let mut payload = vec![0_u8; size];
    if size > 0 {
        reader.read_exact(&mut payload)?;
    }
    M::decode_from_slice(&payload).map_err(proto_io_error)
}

pub async fn read_agent_message_async<R, M>(reader: &mut R) -> io::Result<M>
where
    R: AsyncRead + Unpin,
    M: Message,
{
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header).await?;
    let size = u32::from_be_bytes(header) as usize;
    if size > MAX_AGENT_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("agent message payload too large: {size}"),
        ));
    }

    let mut payload = vec![0_u8; size];
    if size > 0 {
        reader.read_exact(&mut payload).await?;
    }
    M::decode_from_slice(&payload).map_err(proto_io_error)
}

pub fn write_agent_request<W: Write>(writer: W, request: &AgentRequest) -> io::Result<()> {
    write_agent_message(writer, request)
}

pub fn read_agent_request<R: Read>(reader: R) -> io::Result<AgentRequest> {
    read_agent_message(reader)
}

pub fn write_agent_response<W: Write>(writer: W, response: &AgentResponse) -> io::Result<()> {
    write_agent_message(writer, response)
}

pub fn read_agent_response<R: Read>(reader: R) -> io::Result<AgentResponse> {
    read_agent_message(reader)
}

pub fn write_agent_frame<W: Write>(writer: W, frame: &AgentFrame) -> io::Result<()> {
    write_agent_message(writer, frame)
}

pub async fn write_agent_frame_async<W>(writer: &mut W, frame: &AgentFrame) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_agent_message_async(writer, frame).await
}

pub fn read_agent_frame<R: Read>(reader: R) -> io::Result<AgentFrame> {
    read_agent_message(reader)
}

pub async fn read_agent_frame_async<R>(reader: &mut R) -> io::Result<AgentFrame>
where
    R: AsyncRead + Unpin,
{
    read_agent_message_async(reader).await
}

pub fn ping_request(selector: impl Into<String>, username: impl Into<String>) -> AgentRequest {
    base_request(
        AgentRequestType::AGENT_REQUEST_TYPE_PING,
        selector.into(),
        username.into(),
    )
}

pub fn state_request(
    selector: impl Into<String>,
    username: impl Into<String>,
    cols: u16,
    rows: u16,
    output_limit: usize,
) -> AgentRequest {
    let mut request = base_request(
        AgentRequestType::AGENT_REQUEST_TYPE_STATE,
        selector.into(),
        username.into(),
    );
    request.cols = Some(i32::from(cols));
    request.rows = Some(i32::from(rows));
    request.output_limit = Some(clamped_i32(output_limit));
    request
}

pub fn action_request(
    selector: impl Into<String>,
    username: impl Into<String>,
    cols: u16,
    rows: u16,
    output_limit: usize,
    action: AgentWorkspaceAction,
) -> AgentRequest {
    let mut request = state_request(selector, username, cols, rows, output_limit);
    request.r#type = Some(AgentRequestType::AGENT_REQUEST_TYPE_ACTION.into());
    request.action = MessageField::some(action);
    request
}

pub fn attach_request(
    selector: impl Into<String>,
    username: impl Into<String>,
    pane_id: impl Into<String>,
    cols: u16,
    rows: u16,
    output_limit: usize,
    replay_after: u64,
) -> AgentRequest {
    let mut request = state_request(selector, username, cols, rows, output_limit);
    request.r#type = Some(AgentRequestType::AGENT_REQUEST_TYPE_ATTACH.into());
    request.pane_id = Some(pane_id.into());
    request.replay_after = Some(clamped_i64(replay_after));
    request
}

pub fn close_session_request(
    selector: impl Into<String>,
    username: impl Into<String>,
    session_id: impl Into<String>,
    cols: u16,
    rows: u16,
    output_limit: usize,
) -> AgentRequest {
    let mut request = state_request(selector, username, cols, rows, output_limit);
    request.r#type = Some(AgentRequestType::AGENT_REQUEST_TYPE_CLOSE_SESSION.into());
    request.session_id = Some(session_id.into());
    request
}

pub fn ok_response() -> AgentResponse {
    AgentResponse {
        ok: Some(true),
        version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
        ..Default::default()
    }
}

pub fn state_response(state: AgentWorkspaceState) -> AgentResponse {
    AgentResponse {
        ok: Some(true),
        version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
        state: MessageField::some(state),
        ..Default::default()
    }
}

pub fn error_response(message: impl Into<String>) -> AgentResponse {
    AgentResponse {
        ok: Some(false),
        version: Some(AGENT_PROTOCOL_VERSION.to_owned()),
        error: Some(message.into()),
        ..Default::default()
    }
}

#[cfg(test)]
fn binary_frame(payload: impl Into<Vec<u8>>) -> AgentFrame {
    payload_frame(AgentFrameType::AGENT_FRAME_TYPE_BINARY, payload.into())
}

pub fn binary_frame_with_sequence(payload: impl Into<Vec<u8>>, sequence: u64) -> AgentFrame {
    let mut frame = payload_frame(AgentFrameType::AGENT_FRAME_TYPE_BINARY, payload.into());
    frame.sequence = Some(clamped_i64(sequence));
    frame
}

pub fn input_frame(payload: impl Into<Vec<u8>>) -> AgentFrame {
    payload_frame(AgentFrameType::AGENT_FRAME_TYPE_INPUT, payload.into())
}

pub fn resize_frame(cols: u16, rows: u16) -> AgentFrame {
    AgentFrame {
        r#type: Some(AgentFrameType::AGENT_FRAME_TYPE_RESIZE.into()),
        resize: MessageField::some(AgentResize {
            cols: Some(i32::from(cols)),
            rows: Some(i32::from(rows)),
            ..Default::default()
        }),
        ..Default::default()
    }
}

pub fn detach_frame() -> AgentFrame {
    AgentFrame {
        r#type: Some(AgentFrameType::AGENT_FRAME_TYPE_DETACH.into()),
        ..Default::default()
    }
}

pub fn replay_start_frame(
    session_id: impl Into<String>,
    selector: impl Into<String>,
    pane_id: impl Into<String>,
    replay_after: u64,
) -> AgentFrame {
    control_frame(AgentControl {
        r#type: Some(AgentControlType::AGENT_CONTROL_TYPE_REPLAY_START.into()),
        session_id: Some(session_id.into()),
        selector: Some(selector.into()),
        pane_id: Some(pane_id.into()),
        replay_after: Some(clamped_i64(replay_after)),
        ..Default::default()
    })
}

pub fn replay_complete_frame(
    session_id: impl Into<String>,
    selector: impl Into<String>,
    pane_id: impl Into<String>,
    last_sequence: u64,
) -> AgentFrame {
    control_frame(AgentControl {
        r#type: Some(AgentControlType::AGENT_CONTROL_TYPE_REPLAY_COMPLETE.into()),
        session_id: Some(session_id.into()),
        selector: Some(selector.into()),
        pane_id: Some(pane_id.into()),
        last_sequence: Some(clamped_i64(last_sequence)),
        ..Default::default()
    })
}

pub fn process_exit_frame(exit_code: i32, message: Option<String>) -> AgentFrame {
    control_frame(AgentControl {
        r#type: Some(AgentControlType::AGENT_CONTROL_TYPE_PROCESS_EXIT.into()),
        exit_code: Some(exit_code),
        message,
        ..Default::default()
    })
}

fn control_frame(control: AgentControl) -> AgentFrame {
    AgentFrame {
        r#type: Some(AgentFrameType::AGENT_FRAME_TYPE_TEXT.into()),
        control: MessageField::some(control),
        ..Default::default()
    }
}

fn payload_frame(kind: AgentFrameType, payload: Vec<u8>) -> AgentFrame {
    AgentFrame {
        r#type: Some(kind.into()),
        payload: Some(payload),
        ..Default::default()
    }
}

fn base_request(kind: AgentRequestType, selector: String, username: String) -> AgentRequest {
    AgentRequest {
        r#type: Some(kind.into()),
        selector: Some(selector),
        username: Some(username),
        ..Default::default()
    }
}

fn clamped_i32(value: usize) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

fn clamped_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn proto_io_error(err: buffa::DecodeError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protobuf_frame_round_trips_binary_payload() {
        let mut buffer = Vec::new();
        write_agent_frame(&mut buffer, &binary_frame(b"hello".to_vec())).unwrap();

        let frame = read_agent_frame(buffer.as_slice()).unwrap();

        assert_eq!(
            frame.r#type.and_then(|kind| kind.as_known()),
            Some(AgentFrameType::AGENT_FRAME_TYPE_BINARY)
        );
        assert_eq!(frame.payload.as_deref(), Some(b"hello".as_slice()));
    }

    #[test]
    fn protobuf_response_round_trips_workspace_state() {
        let state = AgentWorkspaceState {
            selector: Some("app@owner".to_owned()),
            active_tab_id: Some("tab-1".to_owned()),
            ..Default::default()
        };
        let mut buffer = Vec::new();
        write_agent_response(&mut buffer, &state_response(state)).unwrap();

        let response = read_agent_response(buffer.as_slice()).unwrap();

        assert_eq!(response.ok, Some(true));
        assert_eq!(response.version.as_deref(), Some(AGENT_PROTOCOL_VERSION));
        assert_eq!(response.state.selector.as_deref(), Some("app@owner"));
        assert_eq!(response.state.active_tab_id.as_deref(), Some("tab-1"));
    }

    #[test]
    fn close_session_request_carries_session_identity() {
        let request = close_session_request("app@owner", "alice", "session-1", 120, 32, 256);

        assert_eq!(
            request.r#type.and_then(|kind| kind.as_known()),
            Some(AgentRequestType::AGENT_REQUEST_TYPE_CLOSE_SESSION)
        );
        assert_eq!(request.selector.as_deref(), Some("app@owner"));
        assert_eq!(request.username.as_deref(), Some("alice"));
        assert_eq!(request.session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn rejects_oversized_payload_before_allocating() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&((MAX_AGENT_MESSAGE_BYTES as u32) + 1).to_be_bytes());

        let err = read_agent_frame(buffer.as_slice()).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
