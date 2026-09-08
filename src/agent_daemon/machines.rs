use super::{
    configure_command_identity, find_herdr_executable, herdr_login_user, parse_options,
    required_option,
};
use crate::herdr_machines::{
    MACHINE_SETUP_SECONDS, MAX_MACHINE_OUTPUT, Machine, MachineAction, MachineCatalog,
};
use anyhow::{Context as _, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::{self, BufRead as _, Read};
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

const COMMAND_SECONDS: u64 = 8;
const MAX_INPUT: usize = 16 * 1024;

/// The child owns a session/process group. Clean up SSH helpers on every exit path.
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    #[allow(unsafe_code)]
    fn drop(&mut self) {
        if let Ok(pid) = i32::try_from(self.0) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

fn user_command(login: &str, action: &MachineAction) -> anyhow::Result<Command> {
    user_command_args(
        login,
        action.args()?,
        matches!(action, MachineAction::Test { .. }),
    )
}

fn user_command_args(login: &str, args: Vec<String>, ssh: bool) -> anyhow::Result<Command> {
    let identity = neko_herdr_socket_bridge::login_identity(login)
        .context("Herdr login user was not found")?;
    let executable = if ssh {
        std::path::PathBuf::from("/usr/bin/ssh")
    } else {
        find_herdr_executable(&identity)?
    };
    let mut command = Command::new(executable);
    command
        .args(args)
        .env_clear()
        .env("HOME", &identity.home)
        .env("USER", login)
        .env("LOGNAME", login)
        .env("XDG_CONFIG_HOME", identity.home.join(".config"))
        .env(
            "PATH",
            std::env::join_paths([
                identity.home.join(".local/bin"),
                identity.home.join("bin"),
                "/usr/local/bin".into(),
                "/usr/bin".into(),
                "/bin".into(),
            ])?,
        )
        .env("TERM", "xterm-256color")
        .env("LANG", "C.UTF-8")
        .current_dir(&identity.home);
    configure_command_identity(&mut command, identity.uid, identity.gid);
    Ok(command)
}

pub(super) fn run(args: &[String], interactive: bool, child: bool) -> anyhow::Result<()> {
    let options = parse_options(args)?;
    let login = herdr_login_user(&options);
    let action: MachineAction = serde_json::from_str(&required_option(&options, "request")?)?;
    action.args()?;
    if child {
        ensure!(
            matches!(
                action,
                MachineAction::Add { .. } | MachineAction::Test { .. }
            ),
            "only machine add and connection tests support a terminal"
        );
        return Err(user_command(&login, &action)?.exec().into());
    }
    if interactive {
        ensure!(
            matches!(
                action,
                MachineAction::Add { .. } | MachineAction::Test { .. }
            ),
            "only machine add and connection tests support a terminal"
        );
        return setup(&login, &action);
    }
    ensure!(
        !matches!(
            action,
            MachineAction::Add { .. } | MachineAction::Test { .. }
        ),
        "machine add requires an interactive terminal"
    );
    // Capability is owned by the installed client, not the running server's protocol.
    let help = user_command_args(&login, vec!["machine".into(), "--help".into()], false)?;
    let (ok, output, _) = capture(help)?;
    let supported = ok && machine_help_supported(&String::from_utf8_lossy(&output));
    if !supported {
        ensure!(
            matches!(action, MachineAction::List {}),
            "installed Herdr does not support machine management"
        );
        println!(
            "{}",
            serde_json::to_string(&MachineCatalog {
                supported: false,
                machines: vec![]
            })?
        );
        return Ok(());
    }
    if !matches!(action, MachineAction::List {}) {
        checked_capture(user_command(&login, &action)?)?;
    }
    let output = checked_capture(user_command(&login, &MachineAction::List {})?)?;
    let machines: Vec<Machine> =
        serde_json::from_slice(&output).context("invalid Herdr machine catalog")?;
    ensure!(
        machines.len() <= 64,
        "Herdr machine catalog exceeds 64 profiles"
    );
    println!(
        "{}",
        serde_json::to_string(&MachineCatalog {
            supported: true,
            machines
        })?
    );
    Ok(())
}

fn machine_help_supported(help: &str) -> bool {
    help.contains("herdr machine list")
        || (help.contains("Usage: herdr machine")
            && ["list", "add", "rename", "remove", "enable", "disable"]
                .iter()
                .all(|command| {
                    help.lines()
                        .any(|line| line.split_whitespace().next() == Some(command))
                }))
}

fn checked_capture(command: Command) -> anyhow::Result<Vec<u8>> {
    let (success, stdout, stderr) = capture(command)?;
    ensure!(
        success,
        "Herdr machine command failed: {}",
        String::from_utf8_lossy(if stderr.is_empty() { &stdout } else { &stderr }).trim()
    );
    Ok(stdout)
}

fn capture(command: Command) -> anyhow::Result<(bool, Vec<u8>, Vec<u8>)> {
    capture_with_timeout(command, Duration::from_secs(COMMAND_SECONDS))
}

fn capture_with_timeout(
    mut command: Command,
    command_timeout: Duration,
) -> anyhow::Result<(bool, Vec<u8>, Vec<u8>)> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = command.spawn()?;
    let _group = ProcessGroup(child.id());
    let (tx, rx) = mpsc::sync_channel(16);
    for (stderr, reader) in [
        (
            false,
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
        ),
        (
            true,
            Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
        ),
    ] {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send((stderr, buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    drop(tx);
    let deadline = Instant::now() + command_timeout;
    let mut output = (Vec::new(), Vec::new());
    let result = (|| -> anyhow::Result<bool> {
        let mut status = None;
        let mut streams_closed = false;
        loop {
            ensure!(Instant::now() < deadline, "Herdr machine command timed out");
            if streams_closed {
                if status.is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            } else {
                match rx.recv_timeout(Duration::from_millis(20)) {
                    Ok((stderr, bytes)) => {
                        let target = if stderr { &mut output.1 } else { &mut output.0 };
                        ensure!(
                            target.len() + bytes.len() <= MAX_MACHINE_OUTPUT,
                            "Herdr machine output limit exceeded"
                        );
                        target.extend(bytes);
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => streams_closed = true,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
            if status.is_none() {
                status = child.try_wait()?;
            }
        }
        Ok(status.unwrap().success())
    })();
    drop(_group);
    let _ = child.wait();
    Ok((result?, output.0, output.1))
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}
enum SetupEvent {
    Input(Input),
    Output(Vec<u8>),
    OutputClosed,
    Closed,
    Error(String),
}

fn setup(login: &str, action: &MachineAction) -> anyhow::Result<()> {
    let pair = NativePtySystem::default().openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(std::env::current_exe()?);
    command.env_clear();
    command.args([
        "agent",
        "herdr-machine-child",
        "--login-user",
        login,
        "--request",
        &serde_json::to_string(action)?,
    ]);
    let mut child = pair.slave.spawn_command(command)?;
    let _group = ProcessGroup(child.process_id().context("missing setup process id")?);
    drop(pair.slave);
    let writer = crate::pty_io::PtyWriter::spawn(pair.master.take_writer()?);
    let mut reader = pair.master.try_clone_reader()?;
    let (tx, rx) = mpsc::sync_channel(16);
    let cancelled = Arc::new(AtomicBool::new(false));
    let input_cancelled = cancelled.clone();
    let input_tx = tx.clone();
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut line = Vec::new();
            match input
                .by_ref()
                .take((MAX_INPUT + 1) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(0) | Err(_) => {
                    input_cancelled.store(true, Ordering::Release);
                    let _ = input_tx.send(SetupEvent::Closed);
                    break;
                }
                Ok(n) if n > MAX_INPUT => {
                    input_cancelled.store(true, Ordering::Release);
                    let _ = input_tx.send(SetupEvent::Error("setup input limit exceeded".into()));
                    break;
                }
                Ok(_) => match serde_json::from_slice(&line) {
                    Ok(message) => {
                        if input_tx.send(SetupEvent::Input(message)).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        input_cancelled.store(true, Ordering::Release);
                        let _ = input_tx.send(SetupEvent::Error("invalid setup input".into()));
                        break;
                    }
                },
            }
        }
    });
    thread::spawn(move || {
        let mut bytes = [0; 4096];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(SetupEvent::OutputClosed);
                    break;
                }
                Ok(n) => {
                    if tx.send(SetupEvent::Output(bytes[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let deadline = Instant::now()
        + Duration::from_secs(if matches!(action, MachineAction::Test { .. }) {
            60
        } else {
            MACHINE_SETUP_SECONDS
        });
    let output = NonblockingOutput::new(libc::STDOUT_FILENO)?;
    let mut output_closed = false;
    let mut total = 0;
    let result = (|| -> anyhow::Result<u32> {
        loop {
            ensure!(Instant::now() < deadline, "SSH operation timed out");
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(SetupEvent::Output(bytes)) => {
                    total += bytes.len();
                    ensure!(
                        total <= MAX_MACHINE_OUTPUT,
                        "machine setup output limit exceeded"
                    );
                    output.send(
                        &serde_json::json!({"type":"output", "data": BASE64.encode(bytes)}),
                        deadline,
                        &cancelled,
                    )?;
                }
                Ok(SetupEvent::Input(Input::Input { data })) => {
                    writer.send(data.into_bytes())?;
                }
                Ok(SetupEvent::Input(Input::Resize { cols, rows })) => {
                    crate::validation::validate_size(cols, rows)?;
                    pair.master.resize(PtySize {
                        cols,
                        rows,
                        pixel_width: 0,
                        pixel_height: 0,
                    })?;
                }
                Ok(SetupEvent::OutputClosed) => output_closed = true,
                Ok(SetupEvent::Closed) => bail!("machine setup cancelled"),
                Ok(SetupEvent::Error(message)) => bail!(message),
                Err(mpsc::RecvTimeoutError::Disconnected) => bail!("machine setup disconnected"),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Some(status) = child.try_wait()? {
                if output_closed {
                    return Ok(status.exit_code());
                }
            }
        }
    })();
    drop(_group);
    let _ = child.wait();
    let exit_deadline = Instant::now() + Duration::from_secs(2);
    match result {
        Ok(code) => output.send(
            &serde_json::json!({"type":"exit", "code":code}),
            exit_deadline,
            &cancelled,
        ),
        Err(error) => output.send(
            &serde_json::json!({"type":"exit", "code":1, "message":error.to_string()}),
            exit_deadline,
            &cancelled,
        ),
    }
}

/// Writes cannot outlive the operation deadline, even if lightosctl stops reading.
struct NonblockingOutput {
    fd: i32,
    flags: i32,
}
impl NonblockingOutput {
    #[allow(unsafe_code)]
    fn new(fd: i32) -> io::Result<Self> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { fd, flags })
    }
    fn send(
        &self,
        value: &serde_json::Value,
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> anyhow::Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.write(&bytes, deadline, cancelled)
    }
    #[allow(unsafe_code)]
    fn write(
        &self,
        mut bytes: &[u8],
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> anyhow::Result<()> {
        while !bytes.is_empty() {
            ensure!(
                !cancelled.load(Ordering::Acquire),
                "machine setup cancelled"
            );
            ensure!(Instant::now() < deadline, "machine setup output timed out");
            let written = unsafe { libc::write(self.fd, bytes.as_ptr().cast(), bytes.len()) };
            if written > 0 {
                bytes = &bytes[written as usize..];
                continue;
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if error.kind() != io::ErrorKind::WouldBlock {
                return Err(error.into());
            }
            thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}
impl Drop for NonblockingOutput {
    #[allow(unsafe_code)]
    fn drop(&mut self) {
        unsafe {
            libc::fcntl(self.fd, libc::F_SETFL, self.flags);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd as _;

    #[test]
    fn machine_capability_accepts_clap_and_legacy_help() {
        assert!(machine_help_supported(
            "Usage: herdr machine [COMMAND]\n  list List machines\n  add Add\n  rename Rename\n  remove Remove\n  enable Enable\n  disable Disable"
        ));
        assert!(machine_help_supported(
            "Usage:\n herdr machine list [--json]"
        ));
        assert!(!machine_help_supported(
            "Usage: herdr [COMMAND]\n  list\n  add\n  rename\n  remove\n  enable\n  disable"
        ));
    }

    #[test]
    fn machine_capture_preserves_exit_and_stderr() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf catalog; printf failure >&2; exit 7"]);
        let (ok, stdout, stderr) = capture(command).unwrap();
        assert!(!ok);
        assert_eq!(stdout, b"catalog");
        assert_eq!(stderr, b"failure");
    }

    #[test]
    fn machine_capture_deadline_covers_descendant_owned_pipes() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & exit 0"]);
        let start = Instant::now();
        let error = capture_with_timeout(command, Duration::from_millis(100)).unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn machine_capture_rejects_output_flood() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "head -c 2097152 /dev/zero"]);
        let error = capture(command).unwrap_err();
        assert!(error.to_string().contains("output limit"));
    }

    #[test]
    fn setup_output_respects_deadline_and_cancellation_under_backpressure() {
        let (writer, _unread) = std::os::unix::net::UnixStream::pair().unwrap();
        let output = NonblockingOutput::new(writer.as_raw_fd()).unwrap();
        let cancelled = AtomicBool::new(false);
        let start = Instant::now();
        let error = output
            .write(
                &vec![0; 2 * MAX_MACHINE_OUTPUT],
                start + Duration::from_millis(50),
                &cancelled,
            )
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(1));
        cancelled.store(true, Ordering::Release);
        assert!(
            output
                .write(b"x", Instant::now() + Duration::from_secs(1), &cancelled)
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
    }
}
