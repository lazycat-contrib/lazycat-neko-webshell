use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use buffa::Message;

use crate::agent_protocol::{
    AGENT_PROTOCOL_VERSION, MAX_AGENT_MESSAGE_BYTES, attach_request, binary_frame_with_sequence,
    error_response, ok_response, process_exit_frame, read_agent_frame, read_agent_request,
    read_agent_response, replay_complete_frame, replay_start_frame, state_response,
    write_agent_frame, write_agent_request, write_agent_response,
};
use crate::agent_workspace::{AgentPane, AgentPaneEvent, AgentWorkspace};
use crate::config::{DEFAULT_COLS, DEFAULT_OUTPUT_FRAME_LIMIT, DEFAULT_ROWS, MAX_COLS, MAX_ROWS};
use crate::proto::lazycat::webshell::v1::{
    AgentFrame, AgentFrameType, AgentRequest, AgentRequestType,
};
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};

pub fn run_agent_command(args: &[String]) -> anyhow::Result<()> {
    let Some(command) = args.first().map(String::as_str) else {
        bail!("missing agent command");
    };
    match command {
        "version" => {
            println!("{AGENT_PROTOCOL_VERSION}");
            Ok(())
        }
        "daemon" => run_daemon_command(&args[1..]),
        "request" => run_request_command(&args[1..]),
        "attach" => run_attach_command(&args[1..]),
        _ => bail!("unknown agent command {command:?}"),
    }
}

fn run_daemon_command(args: &[String]) -> anyhow::Result<()> {
    let options = parse_options(args)?;
    let socket = required_option(&options, "socket")?;
    let selector = options.get("selector").cloned().unwrap_or_default();
    let username = options.get("username").cloned().unwrap_or_default();
    run_agent_daemon(&socket, &selector, &username)
}

fn run_request_command(args: &[String]) -> anyhow::Result<()> {
    let options = parse_options(args)?;
    let socket = required_option(&options, "socket")?;
    let request = if let Some(encoded) = options.get("request") {
        let bytes = BASE64_STANDARD
            .decode(encoded)
            .context("invalid base64 agent request")?;
        AgentRequest::decode_from_slice(&bytes).context("invalid protobuf agent request")?
    } else {
        read_agent_request(io::stdin().lock()).context("failed to read agent request from stdin")?
    };

    let mut stream = UnixStream::connect(socket).context("failed to connect agent socket")?;
    write_agent_request(&mut stream, &request).context("failed to write agent request")?;
    let response = read_agent_response(&mut stream).context("failed to read agent response")?;
    write_agent_response(io::stdout().lock(), &response)
        .context("failed to write agent response to stdout")
}

fn run_attach_command(args: &[String]) -> anyhow::Result<()> {
    let options = parse_options(args)?;
    let socket = required_option(&options, "socket")?;
    let selector = required_option(&options, "selector")?;
    let pane_id = options.get("pane").cloned().unwrap_or_default();
    let username = options.get("username").cloned().unwrap_or_default();
    let cols = option_u16(&options, "cols", DEFAULT_COLS, MAX_COLS)?;
    let rows = option_u16(&options, "rows", DEFAULT_ROWS, MAX_ROWS)?;
    let output_limit = option_usize(&options, "output-limit", DEFAULT_OUTPUT_FRAME_LIMIT);
    let replay_after = option_u64(&options, "replay-after", 0);

    let mut stream = UnixStream::connect(socket).context("failed to connect agent socket")?;
    let request = attach_request(
        selector,
        username,
        pane_id,
        cols,
        rows,
        output_limit,
        replay_after,
    );
    write_agent_request(&mut stream, &request).context("failed to write attach request")?;

    let mut socket_to_stdout = stream
        .try_clone()
        .context("failed to clone agent socket reader")?;
    let stdout_thread = thread::spawn(move || {
        copy_agent_message_stream(&mut socket_to_stdout, &mut io::stdout().lock())
    });

    let mut stdin_to_socket = stream;
    let stdin_result = copy_agent_message_stream(&mut io::stdin().lock(), &mut stdin_to_socket);
    let stdout_result = stdout_thread
        .join()
        .map_err(|_| anyhow!("agent attach stdout bridge panicked"))?;
    stdin_result.context("agent attach stdin bridge failed")?;
    stdout_result.context("agent attach stdout bridge failed")
}

fn run_agent_daemon(socket: &str, selector: &str, username: &str) -> anyhow::Result<()> {
    let socket = socket.trim();
    if socket.is_empty() {
        bail!("agent socket path is required");
    }
    if let Some(parent) = Path::new(socket).parent() {
        fs::create_dir_all(parent).context("failed to create agent socket directory")?;
    }
    let _ = fs::remove_file(socket);
    let listener = UnixListener::bind(socket).context("failed to listen on agent unix socket")?;
    fs::set_permissions(socket, std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .context("failed to chmod agent socket")?;

    let daemon = Arc::new(AgentDaemon {
        selector: selector.trim().to_owned(),
        username: username.trim().to_owned(),
        workspace: Mutex::new(None),
    });
    for connection in listener.incoming() {
        let daemon = Arc::clone(&daemon);
        match connection {
            Ok(stream) => {
                thread::spawn(move || {
                    let _ = daemon.handle_connection(stream);
                });
            }
            Err(err) => return Err(err).context("failed to accept agent socket connection"),
        }
    }
    Ok(())
}

struct AgentDaemon {
    selector: String,
    username: String,
    workspace: Mutex<Option<Arc<AgentWorkspace>>>,
}

impl AgentDaemon {
    fn handle_connection(&self, mut stream: UnixStream) -> anyhow::Result<()> {
        let request = match read_agent_request(&mut stream) {
            Ok(request) => request,
            Err(err) => {
                write_agent_response(&mut stream, &error_response(err.to_string()))?;
                return Err(err).context("failed to read agent request");
            }
        };

        match request_type(&request) {
            Some(AgentRequestType::AGENT_REQUEST_TYPE_PING) => {
                let response = self.ping(&request).unwrap_or_else(error_response);
                write_agent_response(stream, &response)?;
            }
            Some(AgentRequestType::AGENT_REQUEST_TYPE_STATE) => {
                let response = self.state(&request).unwrap_or_else(error_response);
                write_agent_response(stream, &response)?;
            }
            Some(AgentRequestType::AGENT_REQUEST_TYPE_ACTION) => {
                let response = self.action(&request).unwrap_or_else(error_response);
                write_agent_response(stream, &response)?;
            }
            Some(AgentRequestType::AGENT_REQUEST_TYPE_ATTACH) => {
                self.attach(stream, &request)?;
            }
            Some(AgentRequestType::AGENT_REQUEST_TYPE_UNSPECIFIED) | None => {
                write_agent_response(stream, &error_response("unknown agent request type"))?;
            }
        }
        Ok(())
    }

    fn ping(
        &self,
        request: &AgentRequest,
    ) -> Result<crate::proto::lazycat::webshell::v1::AgentResponse, String> {
        self.request_selector(request)
            .map_err(|err| err.to_string())?;
        Ok(ok_response())
    }

    fn state(
        &self,
        request: &AgentRequest,
    ) -> Result<crate::proto::lazycat::webshell::v1::AgentResponse, String> {
        let workspace = self
            .workspace_for_request(request)
            .map_err(|err| err.to_string())?;
        let (cols, rows) = request_size(request).map_err(|err| err.to_string())?;
        let output_limit = request_output_limit(request);
        workspace
            .snapshot_state(cols, rows, output_limit)
            .map(state_response)
            .map_err(|err| err.to_string())
    }

    fn action(
        &self,
        request: &AgentRequest,
    ) -> Result<crate::proto::lazycat::webshell::v1::AgentResponse, String> {
        let workspace = self
            .workspace_for_request(request)
            .map_err(|err| err.to_string())?;
        let (cols, rows) = request_size(request).map_err(|err| err.to_string())?;
        let output_limit = request_output_limit(request);
        let action = request
            .action
            .as_option()
            .ok_or_else(|| "workspace action is required".to_owned())?;
        workspace
            .apply_action(action, cols, rows, output_limit)
            .map(state_response)
            .map_err(|err| err.to_string())
    }

    fn attach(&self, mut stream: UnixStream, request: &AgentRequest) -> anyhow::Result<()> {
        let workspace = self.workspace_for_request(request)?;
        let (cols, rows) = request_size(request)?;
        let output_limit = request_output_limit(request);
        workspace.ensure_state(cols, rows, output_limit)?;
        let pane = match request
            .pane_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            Some(pane_id) => workspace.pane(pane_id)?,
            None => workspace.active_pane()?,
        };
        pane.resize(cols, rows)?;
        pane.set_output_limit(output_limit);
        serve_attach_stream(&mut stream, pane, request_replay_after(request))
    }

    fn workspace_for_request(&self, request: &AgentRequest) -> anyhow::Result<Arc<AgentWorkspace>> {
        let selector = self.request_selector(request)?;
        let username = request
            .username
            .as_deref()
            .map(str::trim)
            .filter(|username| !username.is_empty())
            .unwrap_or(self.username.as_str())
            .to_owned();
        let mut slot = self
            .workspace
            .lock()
            .map_err(|_| anyhow!("agent workspace slot lock poisoned"))?;
        if slot.is_none() {
            *slot = Some(Arc::new(AgentWorkspace::new(selector, username)));
        }
        slot.as_ref()
            .cloned()
            .ok_or_else(|| anyhow!("agent workspace is unavailable"))
    }

    fn request_selector(&self, request: &AgentRequest) -> anyhow::Result<String> {
        let selector = request
            .selector
            .as_deref()
            .map(str::trim)
            .filter(|selector| !selector.is_empty())
            .unwrap_or(self.selector.as_str());
        if selector.is_empty() {
            bail!("selector is required");
        }
        validate_selector(selector).map_err(|err| {
            anyhow!(
                "{}",
                err.message
                    .unwrap_or_else(|| "invalid LightOS selector".to_owned())
            )
        })?;
        if !self.selector.is_empty() && selector != self.selector {
            bail!("selector does not match agent scope");
        }
        Ok(selector.to_owned())
    }
}

fn serve_attach_stream(
    stream: &mut UnixStream,
    pane: Arc<AgentPane>,
    replay_after: u64,
) -> anyhow::Result<()> {
    let (frames, last_sequence) = pane.snapshot_after(replay_after);
    write_agent_frame(
        &mut *stream,
        &replay_start_frame(pane.session_id(), pane.selector(), pane.id(), replay_after),
    )?;
    for frame in frames {
        write_agent_frame(
            &mut *stream,
            &binary_frame_with_sequence(frame.data, frame.sequence),
        )?;
    }
    write_agent_frame(
        &mut *stream,
        &replay_complete_frame(pane.session_id(), pane.selector(), pane.id(), last_sequence),
    )?;
    stream.flush()?;

    let event_rx = pane.subscribe();
    let (detach_tx, detach_rx) = mpsc::channel::<()>();
    let mut reader = stream
        .try_clone()
        .context("failed to clone attach stream")?;
    let input_pane = Arc::clone(&pane);
    thread::spawn(move || {
        read_attach_input_loop(&mut reader, &input_pane);
        let _ = detach_tx.send(());
    });

    loop {
        if detach_rx.try_recv().is_ok() {
            break;
        }
        match event_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(AgentPaneEvent::Output(frame)) => {
                write_agent_frame(
                    &mut *stream,
                    &binary_frame_with_sequence(frame.data, frame.sequence),
                )?;
                stream.flush()?;
            }
            Ok(AgentPaneEvent::Exit(exit)) => {
                write_agent_frame(
                    &mut *stream,
                    &process_exit_frame(exit.exit_code, exit.message),
                )?;
                stream.flush()?;
                break;
            }
            Ok(AgentPaneEvent::Error(message)) => {
                write_agent_frame(&mut *stream, &process_exit_frame(-1, Some(message)))?;
                stream.flush()?;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

fn read_attach_input_loop(stream: &mut UnixStream, pane: &AgentPane) {
    loop {
        let frame = match read_agent_frame(&mut *stream) {
            Ok(frame) => frame,
            Err(_) => break,
        };
        match frame_type(&frame) {
            Some(AgentFrameType::AGENT_FRAME_TYPE_INPUT) => {
                let _ = pane.write_input(frame.payload.unwrap_or_default());
            }
            Some(AgentFrameType::AGENT_FRAME_TYPE_RESIZE) => {
                let cols = frame
                    .resize
                    .cols
                    .and_then(|value| u16::try_from(value).ok());
                let rows = frame
                    .resize
                    .rows
                    .and_then(|value| u16::try_from(value).ok());
                if let (Some(cols), Some(rows)) = (cols, rows) {
                    let _ = pane.resize(cols, rows);
                }
            }
            Some(AgentFrameType::AGENT_FRAME_TYPE_DETACH) => break,
            _ => {}
        }
    }
}

fn request_type(request: &AgentRequest) -> Option<AgentRequestType> {
    request.r#type.as_ref().and_then(|kind| kind.as_known())
}

fn frame_type(frame: &AgentFrame) -> Option<AgentFrameType> {
    frame.r#type.as_ref().and_then(|kind| kind.as_known())
}

fn request_size(request: &AgentRequest) -> anyhow::Result<(u16, u16)> {
    let cols = request_dimension(request.cols, DEFAULT_COLS, MAX_COLS, "cols")?;
    let rows = request_dimension(request.rows, DEFAULT_ROWS, MAX_ROWS, "rows")?;
    validate_size(cols, rows)?;
    Ok((cols, rows))
}

fn request_dimension(
    value: Option<i32>,
    default_value: u16,
    max_value: u16,
    name: &str,
) -> anyhow::Result<u16> {
    let value = value.unwrap_or(i32::from(default_value));
    if value <= 0 || value > i32::from(max_value) {
        bail!("{name} must be between 1 and {max_value}");
    }
    u16::try_from(value).map_err(|_| anyhow!("{name} is out of range"))
}

fn request_output_limit(request: &AgentRequest) -> usize {
    normalize_output_frame_limit(request.output_limit.and_then(|value| {
        if value <= 0 {
            None
        } else {
            usize::try_from(value).ok()
        }
    }))
}

fn request_replay_after(request: &AgentRequest) -> u64 {
    request
        .replay_after
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0)
}

fn parse_options(args: &[String]) -> anyhow::Result<HashMap<String, String>> {
    let mut options = HashMap::new();
    let mut index = 0;
    while index < args.len() {
        let raw_key = &args[index];
        let key = raw_key
            .strip_prefix("--")
            .ok_or_else(|| anyhow!("expected --key, got {raw_key:?}"))?;
        let Some(value) = args.get(index + 1) else {
            bail!("missing value for --{key}");
        };
        options.insert(key.to_owned(), value.clone());
        index += 2;
    }
    Ok(options)
}

fn required_option(options: &HashMap<String, String>, name: &str) -> anyhow::Result<String> {
    options
        .get(name)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("--{name} is required"))
}

fn option_u16(
    options: &HashMap<String, String>,
    name: &str,
    default_value: u16,
    max_value: u16,
) -> anyhow::Result<u16> {
    let value = options
        .get(name)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default_value);
    if value == 0 || value > max_value {
        bail!("--{name} must be between 1 and {max_value}");
    }
    Ok(value)
}

fn option_usize(options: &HashMap<String, String>, name: &str, default_value: usize) -> usize {
    options
        .get(name)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default_value)
}

fn option_u64(options: &HashMap<String, String>, name: &str, default_value: u64) -> u64 {
    options
        .get(name)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default_value)
}

fn copy_agent_message_stream<R, W>(reader: &mut R, writer: &mut W) -> io::Result<()>
where
    R: Read,
    W: Write,
{
    loop {
        let message = match read_raw_agent_message(reader) {
            Ok(message) => message,
            Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(err) => return Err(err),
        };
        if let Err(err) = writer.write_all(&message) {
            if err.kind() == io::ErrorKind::BrokenPipe {
                break;
            }
            return Err(err);
        }
        writer.flush()?;
    }
    Ok(())
}

fn read_raw_agent_message<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    if size > MAX_AGENT_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("agent message payload too large: {size}"),
        ));
    }
    let mut message = Vec::with_capacity(4 + size);
    message.extend_from_slice(&header);
    message.resize(4 + size, 0);
    if size > 0 {
        reader.read_exact(&mut message[4..])?;
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_command_options() {
        let options = parse_options(&[
            "--socket".to_owned(),
            "/tmp/a.sock".to_owned(),
            "--cols".to_owned(),
            "120".to_owned(),
        ])
        .unwrap();

        assert_eq!(required_option(&options, "socket").unwrap(), "/tmp/a.sock");
        assert_eq!(option_u16(&options, "cols", 80, 500).unwrap(), 120);
    }

    #[test]
    fn copies_raw_length_prefixed_messages_without_decoding() {
        let frame = binary_frame_with_sequence(b"hello".to_vec(), 1);
        let mut input = Vec::new();
        write_agent_frame(&mut input, &frame).unwrap();
        let mut output = Vec::new();

        copy_agent_message_stream(&mut input.as_slice(), &mut output).unwrap();

        let decoded = read_agent_frame(output.as_slice()).unwrap();
        assert_eq!(decoded.payload.as_deref(), Some(b"hello".as_slice()));
    }
}
