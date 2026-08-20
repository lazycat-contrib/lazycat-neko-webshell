use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use buffa::Message;
use serde::{Deserialize, Serialize};

use crate::agent_protocol::{
    AGENT_PROTOCOL_VERSION, AGENT_VERSION, MAX_AGENT_MESSAGE_BYTES, MIN_SUPPORTED_AGENT_VERSION,
    attach_request, binary_frame_with_sequence, error_response, ok_response, process_exit_frame,
    read_agent_frame, read_agent_request, read_agent_response, replay_complete_frame,
    replay_start_frame, state_response, write_agent_frame, write_agent_request,
    write_agent_response,
};
use crate::agent_workspace::{AgentPane, AgentPaneEvent, AgentWorkspace};
use crate::config::{
    DEFAULT_COLS, DEFAULT_OUTPUT_FRAME_LIMIT, DEFAULT_ROWS, INITIAL_REPLAY_TAIL_MAX_BYTES,
    INITIAL_REPLAY_TAIL_MAX_FRAMES, MAX_COLS, MAX_ROWS,
};
use crate::proto::lazycat::webshell::v1::{
    AgentControlType, AgentFrame, AgentFrameType, AgentRequest, AgentRequestType,
};
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};

// v0.5.35 compares these legacy fields before payload SHA. Keep version-aware
// agents directionally newer so an older provider cannot replace them.
const LEGACY_PROVIDER_COMPAT_VERSION: &str = "9999.0.0";
const LEGACY_PROVIDER_COMPAT_GENERATION: u64 = u64::MAX;

fn running_agent_payload_manifest() -> Option<String> {
    std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(payload_manifest_from_executable)
}

fn payload_manifest_from_executable(path: &Path) -> Option<String> {
    let directory = path.parent()?.file_name()?.to_str()?;
    let digest = directory.strip_prefix("sha256-")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    Some(format!("sha256:{digest}"))
}

pub fn run_agent_command(args: &[String]) -> anyhow::Result<()> {
    let Some(command) = args.first().map(String::as_str) else {
        bail!("missing agent command");
    };
    match command {
        "version" => {
            println!("{AGENT_PROTOCOL_VERSION}");
            Ok(())
        }
        "agent-version" => {
            println!("{AGENT_VERSION}");
            Ok(())
        }
        "minimum-supported-version" => {
            println!("{MIN_SUPPORTED_AGENT_VERSION}");
            Ok(())
        }
        "daemon" => run_daemon_command(&args[1..]),
        "request" => run_request_command(&args[1..]),
        "attach" => run_attach_command(&args[1..]),
        "herdr-socket-bridge" => run_herdr_socket_bridge_command(&args[1..]),
        "herdr-runtime" => run_herdr_runtime_command(&args[1..]),
        _ => bail!("unknown agent command {command:?}"),
    }
}

const MAX_HERDR_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
pub(crate) const HERDR_STATUS_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const HERDR_HANDOFF_COMMAND_TIMEOUT: Duration = Duration::from_secs(55);
const HERDR_RUNTIME_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct HerdrCliStatus {
    #[serde(default = "herdr_runtime_schema_version")]
    schema_version: u32,
    client: HerdrCliClientStatus,
    server: HerdrCliServerStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct HerdrCliClientStatus {
    version: String,
    protocol: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct HerdrCliServerStatus {
    running: bool,
    version: Option<String>,
    protocol: Option<u32>,
    capabilities: Option<HerdrCliServerCapabilities>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct HerdrCliServerCapabilities {
    live_handoff: bool,
}

fn herdr_runtime_schema_version() -> u32 {
    HERDR_RUNTIME_SCHEMA_VERSION
}

fn run_herdr_runtime_command(args: &[String]) -> anyhow::Result<()> {
    let options = parse_options(args)?;
    let login_user = herdr_login_user(&options);
    let action = options.get("action").map_or("status", String::as_str);
    let identity = neko_herdr_socket_bridge::login_identity(&login_user)
        .context("Herdr login user was not found")?;
    let executable = find_herdr_executable(&identity)?;
    match action {
        "status" => print_herdr_status(&login_user, &identity, &executable),
        "handoff" => handoff_herdr_runtime(&login_user, &identity, &executable),
        _ => bail!("unsupported Herdr runtime action {action:?}"),
    }
}

fn herdr_login_user(options: &HashMap<String, String>) -> String {
    options
        .get("login-user")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("root")
        .to_owned()
}

fn print_herdr_status(
    login_user: &str,
    identity: &neko_herdr_socket_bridge::LoginIdentity,
    executable: &Path,
) -> anyhow::Result<()> {
    let status = read_herdr_status(login_user, identity, executable)?;
    serde_json::to_writer(io::stdout().lock(), &status)
        .context("failed to write Herdr runtime status")
}

fn handoff_herdr_runtime(
    login_user: &str,
    identity: &neko_herdr_socket_bridge::LoginIdentity,
    executable: &Path,
) -> anyhow::Result<()> {
    let status = read_herdr_status(login_user, identity, executable)?;
    validate_herdr_handoff(&status)?;
    let confirmed_status = read_herdr_status(login_user, identity, executable)?;
    if confirmed_status.client != status.client || confirmed_status.server != status.server {
        bail!(
            "Herdr runtime changed while preparing live handoff; inspect it again before retrying"
        );
    }
    let executable_arg = executable.to_string_lossy().into_owned();
    let protocol_arg = confirmed_status.client.protocol.to_string();
    run_herdr_command(
        login_user,
        identity,
        executable,
        &[
            "server",
            "live-handoff",
            "--import-exe",
            &executable_arg,
            "--expected-protocol",
            &protocol_arg,
            "--expected-version",
            &confirmed_status.client.version,
        ],
        HERDR_HANDOFF_COMMAND_TIMEOUT,
    )?;
    let next_status = committed_herdr_handoff_status(confirmed_status);
    serde_json::to_writer(io::stdout().lock(), &next_status)
        .context("failed to write Herdr runtime status")
}

fn committed_herdr_handoff_status(mut status: HerdrCliStatus) -> HerdrCliStatus {
    status.server.running = true;
    status.server.version = Some(status.client.version.clone());
    status.server.protocol = Some(status.client.protocol);
    status
}

fn validate_herdr_handoff(status: &HerdrCliStatus) -> anyhow::Result<u32> {
    let server_protocol = status
        .server
        .protocol
        .filter(|_| status.server.running)
        .context("Herdr server is not running")?;
    if status.client.protocol <= server_protocol {
        bail!(
            "Herdr live handoff requires a newer client: client protocol {}, server protocol {}",
            status.client.protocol,
            server_protocol
        );
    }
    if !status
        .server
        .capabilities
        .as_ref()
        .is_some_and(|capabilities| capabilities.live_handoff)
    {
        bail!("running Herdr server does not support live handoff");
    }
    Ok(server_protocol)
}

fn read_herdr_status(
    login_user: &str,
    identity: &neko_herdr_socket_bridge::LoginIdentity,
    executable: &Path,
) -> anyhow::Result<HerdrCliStatus> {
    let output = run_herdr_command(
        login_user,
        identity,
        executable,
        &["status", "--json"],
        HERDR_STATUS_COMMAND_TIMEOUT,
    )?;
    let mut status: HerdrCliStatus =
        serde_json::from_slice(&output).context("invalid Herdr runtime status")?;
    status.schema_version = HERDR_RUNTIME_SCHEMA_VERSION;
    Ok(status)
}

fn run_herdr_command(
    login_user: &str,
    identity: &neko_herdr_socket_bridge::LoginIdentity,
    executable: &Path,
    args: &[&str],
    command_timeout: Duration,
) -> anyhow::Result<Vec<u8>> {
    let mut command = Command::new(executable);
    let command_path = std::env::join_paths([
        identity.home.join(".local/bin"),
        identity.home.join("bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ])
    .context("failed to construct Herdr command PATH")?;
    command
        .args(args)
        .env_clear()
        .env("HOME", &identity.home)
        .env("USER", login_user)
        .env("LOGNAME", login_user)
        .env("XDG_CONFIG_HOME", identity.home.join(".config"))
        .env("PATH", command_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_command_identity(&mut command, identity.uid, identity.gid);
    if let Ok(socket) =
        neko_herdr_socket_bridge::find_herdr_socket(neko_herdr_socket_bridge::SocketSearch {
            explicit: None,
            login_user,
        })
    {
        command.env("HERDR_SOCKET_PATH", socket);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to run {}", executable.display()))?;
    let stdout = child
        .stdout
        .take()
        .context("failed to capture Herdr stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("failed to capture Herdr stderr")?;
    let stdout_thread = thread::spawn(move || read_bounded_output(stdout));
    let stderr_thread = thread::spawn(move || read_bounded_output(stderr));
    let deadline = Instant::now() + command_timeout;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .context("failed to inspect Herdr command")?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            bail!(
                "Herdr command timed out after {} seconds",
                command_timeout.as_secs()
            );
        }
        thread::sleep(Duration::from_millis(20));
    };
    let (stdout, stdout_truncated) = join_bounded_output(stdout_thread, "stdout")?;
    let (stderr, stderr_truncated) = join_bounded_output(stderr_thread, "stderr")?;
    if stdout_truncated || stderr_truncated {
        bail!("Herdr command output exceeds {MAX_HERDR_COMMAND_OUTPUT_BYTES} bytes");
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(if stderr.is_empty() { &stdout } else { &stderr });
        bail!("Herdr command failed: {}", detail.trim());
    }
    Ok(stdout)
}

#[allow(unsafe_code)]
fn configure_command_identity(command: &mut Command, uid: u32, gid: u32) {
    let same_user = unsafe { libc::geteuid() == uid };
    let same_group = unsafe { libc::getegid() == gid };
    if same_user && same_group {
        return;
    }
    // Only async-signal-safe libc identity calls run between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setgroups(0, std::ptr::null()) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::setresgid(gid, gid, gid) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::setresuid(uid, uid, uid) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

fn read_bounded_output(mut reader: impl Read) -> io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    reader
        .by_ref()
        .take((MAX_HERDR_COMMAND_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut output)?;
    let truncated = output.len() > MAX_HERDR_COMMAND_OUTPUT_BYTES;
    output.truncate(MAX_HERDR_COMMAND_OUTPUT_BYTES);
    Ok((output, truncated))
}

fn join_bounded_output(
    thread: thread::JoinHandle<io::Result<(Vec<u8>, bool)>>,
    stream: &str,
) -> anyhow::Result<(Vec<u8>, bool)> {
    thread
        .join()
        .map_err(|_| anyhow!("Herdr {stream} reader panicked"))?
        .with_context(|| format!("failed to read Herdr {stream}"))
}

fn find_herdr_executable(
    identity: &neko_herdr_socket_bridge::LoginIdentity,
) -> anyhow::Result<PathBuf> {
    let mut candidates = vec![
        identity.home.join(".local/bin/herdr"),
        identity.home.join("bin/herdr"),
    ];
    candidates.extend(
        ["/usr/local/bin/herdr", "/usr/bin/herdr", "/bin/herdr"]
            .into_iter()
            .map(PathBuf::from),
    );
    candidates
        .into_iter()
        .find(|path| {
            std::fs::metadata(path).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
        .context("Herdr executable was not found")
}

fn run_herdr_socket_bridge_command(args: &[String]) -> anyhow::Result<()> {
    let options = parse_options(args)?;
    let explicit = options.get("socket").map(Path::new);
    let login_user = options.get("login-user").map_or("", String::as_str);
    let mode = options.get("mode").map_or("stream", String::as_str);
    if explicit.is_none() && login_user.trim().is_empty() {
        bail!("--socket or --login-user is required");
    }
    let socket =
        neko_herdr_socket_bridge::find_herdr_socket(neko_herdr_socket_bridge::SocketSearch {
            explicit,
            login_user,
        })
        .context("failed to locate Herdr socket")?;
    match mode {
        "request" => neko_herdr_socket_bridge::request_stdio(&socket),
        "stream" => neko_herdr_socket_bridge::bridge_stdio(&socket),
        _ => bail!("unsupported Herdr socket bridge mode {mode:?}"),
    }
    .with_context(|| format!("failed to bridge Herdr socket at {}", socket.display()))
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
        payload_manifest: running_agent_payload_manifest(),
        agent_version: AGENT_VERSION,
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
    payload_manifest: Option<String>,
    agent_version: u64,
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
            Some(AgentRequestType::AGENT_REQUEST_TYPE_CLOSE_SESSION) => {
                let response = self.close_session(&request).unwrap_or_else(error_response);
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
        let mut response = ok_response();
        response.payload_manifest.clone_from(&self.payload_manifest);
        response.payload_version = Some(LEGACY_PROVIDER_COMPAT_VERSION.to_owned());
        response.payload_generation = Some(LEGACY_PROVIDER_COMPAT_GENERATION);
        response.agent_version = Some(self.agent_version);
        Ok(response)
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

    fn close_session(
        &self,
        request: &AgentRequest,
    ) -> Result<crate::proto::lazycat::webshell::v1::AgentResponse, String> {
        let workspace = self
            .workspace_for_request(request)
            .map_err(|err| err.to_string())?;
        let (cols, rows) = request_size(request).map_err(|err| err.to_string())?;
        let output_limit = request_output_limit(request);
        let session_id = request
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "session_id is required".to_owned())?;
        workspace
            .close_session(session_id, cols, rows, output_limit)
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
        serve_attach_stream(&mut stream, &pane, request_replay_after(request))
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
    pane: &Arc<AgentPane>,
    replay_after: u64,
) -> anyhow::Result<()> {
    let event_rx = pane.subscribe();
    let snapshot = if replay_after == 0 {
        pane.snapshot_tail_after_bounded(
            replay_after,
            INITIAL_REPLAY_TAIL_MAX_BYTES,
            INITIAL_REPLAY_TAIL_MAX_FRAMES,
        )
    } else {
        pane.snapshot_after_bounded(replay_after, usize::MAX, usize::MAX)
    };
    let frames = snapshot.frames;
    let mut last_sequence = snapshot.last_sequence;

    // Start reading browser input before writing replay output. The replay and
    // live output remain ordered on this stream, while commands can reach the
    // running PTY without waiting for a slow history transfer to finish.
    let (detach_tx, detach_rx) = mpsc::sync_channel::<()>(1);
    let mut reader = stream
        .try_clone()
        .context("failed to clone attach stream")?;
    let input_pane = Arc::clone(pane);
    thread::spawn(move || {
        read_attach_input_loop(&mut reader, &input_pane);
        let _ = detach_tx.send(());
    });

    write_agent_frame(
        &mut *stream,
        &replay_start_frame(pane.session_id(), pane.selector(), pane.id(), replay_after),
    )?;
    for frame in frames {
        write_agent_frame(
            &mut *stream,
            &binary_frame_with_sequence(frame.data.to_vec(), frame.sequence),
        )?;
    }
    write_agent_frame(
        &mut *stream,
        &replay_complete_frame(pane.session_id(), pane.selector(), pane.id(), last_sequence),
    )?;
    stream.flush()?;

    loop {
        if detach_rx.try_recv().is_ok() {
            break;
        }
        match event_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(AgentPaneEvent::Output(frame)) => {
                if !accept_live_sequence(&mut last_sequence, frame.sequence) {
                    continue;
                }
                write_agent_frame(
                    &mut *stream,
                    &binary_frame_with_sequence(frame.data.to_vec(), frame.sequence),
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

fn accept_live_sequence(last_sequence: &mut u64, sequence: u64) -> bool {
    if sequence <= *last_sequence {
        return false;
    }
    *last_sequence = sequence;
    true
}

fn read_attach_input_loop(stream: &mut UnixStream, pane: &AgentPane) {
    while let Ok(frame) = read_agent_frame(&mut *stream) {
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
            Some(AgentFrameType::AGENT_FRAME_TYPE_TEXT) if frame.control.is_set() => {
                handle_attach_control_frame(frame, pane);
            }
            _ => {}
        }
    }
}

fn handle_attach_control_frame(frame: AgentFrame, pane: &AgentPane) {
    let Some(control) = frame.control.into_option() else {
        return;
    };
    if matches!(
        control.r#type.as_ref().and_then(buffa::EnumValue::as_known),
        Some(AgentControlType::AGENT_CONTROL_TYPE_HISTORY_RECORDING)
    ) {
        pane.set_history_recording(control.history_recording.unwrap_or(true));
    }
}

fn request_type(request: &AgentRequest) -> Option<AgentRequestType> {
    request.r#type.as_ref().and_then(buffa::EnumValue::as_known)
}

fn frame_type(frame: &AgentFrame) -> Option<AgentFrameType> {
    frame.r#type.as_ref().and_then(buffa::EnumValue::as_known)
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
    fn empty_herdr_login_user_uses_the_target_root_identity() {
        let options = HashMap::from([("login-user".to_owned(), "  ".to_owned())]);

        assert_eq!(herdr_login_user(&options), "root");
    }

    #[test]
    fn ping_identifies_the_exact_running_agent_payload() {
        let daemon = AgentDaemon {
            selector: "demo@owner".to_owned(),
            username: "alice".to_owned(),
            payload_manifest: Some("sha256:running".to_owned()),
            agent_version: 1,
            workspace: Mutex::new(None),
        };
        let request = crate::agent_protocol::ping_request("demo@owner", "alice");

        let response = daemon.ping(&request).expect("agent ping");

        assert_eq!(response.payload_manifest.as_deref(), Some("sha256:running"));
        assert_eq!(response.agent_version, Some(1));
        assert_eq!(
            response.payload_version.as_deref(),
            Some(LEGACY_PROVIDER_COMPAT_VERSION)
        );
        assert_eq!(
            response.payload_generation,
            Some(LEGACY_PROVIDER_COMPAT_GENERATION)
        );
    }

    #[test]
    fn agent_compatibility_window_is_valid() {
        assert_eq!(AGENT_VERSION, 9);
        assert_eq!(MIN_SUPPORTED_AGENT_VERSION, 8);
    }

    #[test]
    fn herdr_handoff_validation_never_allows_a_downgrade() {
        let status = |client_protocol, server_protocol, live_handoff| HerdrCliStatus {
            schema_version: HERDR_RUNTIME_SCHEMA_VERSION,
            client: HerdrCliClientStatus {
                version: "0.8.0".to_owned(),
                protocol: client_protocol,
            },
            server: HerdrCliServerStatus {
                running: true,
                version: Some("0.7.0".to_owned()),
                protocol: Some(server_protocol),
                capabilities: Some(HerdrCliServerCapabilities { live_handoff }),
            },
        };

        assert_eq!(validate_herdr_handoff(&status(20, 19, true)).unwrap(), 19);
        for blocked in [
            status(19, 20, true),
            status(20, 20, true),
            status(20, 19, false),
        ] {
            assert!(validate_herdr_handoff(&blocked).is_err());
        }
    }

    #[test]
    fn committed_herdr_handoff_uses_the_confirmed_client_runtime() {
        let status = HerdrCliStatus {
            schema_version: HERDR_RUNTIME_SCHEMA_VERSION,
            client: HerdrCliClientStatus {
                version: "0.8.0".to_owned(),
                protocol: 20,
            },
            server: HerdrCliServerStatus {
                running: true,
                version: Some("0.7.0".to_owned()),
                protocol: Some(19),
                capabilities: Some(HerdrCliServerCapabilities { live_handoff: true }),
            },
        };

        let committed = committed_herdr_handoff_status(status);

        assert!(committed.server.running);
        assert_eq!(committed.server.version.as_deref(), Some("0.8.0"));
        assert_eq!(committed.server.protocol, Some(20));
    }

    #[test]
    fn herdr_command_output_capture_is_bounded() {
        let input = vec![b'x'; MAX_HERDR_COMMAND_OUTPUT_BYTES + 32];
        let (output, truncated) = read_bounded_output(input.as_slice()).unwrap();

        assert_eq!(output.len(), MAX_HERDR_COMMAND_OUTPUT_BYTES);
        assert!(truncated);
    }

    #[test]
    fn payload_identity_comes_from_the_content_addressed_executable_path() {
        let digest = "29ec22b637a9085a01ec8948a61ab19070e683928fb8e24ff70270896c76374a";
        let path = Path::new("/usr/local/lib/lazycat-neko-webshell/agents")
            .join(format!("sha256-{digest}"))
            .join("lazycat-neko-webshell-agent");

        assert_eq!(
            payload_manifest_from_executable(&path).as_deref(),
            Some(format!("sha256:{digest}").as_str())
        );
        assert!(payload_manifest_from_executable(Path::new("/usr/local/bin/agent")).is_none());
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

    #[test]
    fn skips_live_frames_already_covered_by_replay_snapshot() {
        let mut last_sequence = 4;

        assert!(!accept_live_sequence(&mut last_sequence, 3));
        assert!(!accept_live_sequence(&mut last_sequence, 4));
        assert!(accept_live_sequence(&mut last_sequence, 5));
        assert_eq!(last_sequence, 5);
    }
}
