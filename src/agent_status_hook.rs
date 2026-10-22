//! Best-effort, opt-in hook bridge. It never writes to hook stdout/stderr.

use std::fs::{File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::fd::AsRawFd as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::time::{Duration, Instant};

use neko_program_status::{MAX_HOOK_BYTES, hook_identity, hook_report};

const INPUT_BUDGET: Duration = Duration::from_millis(100);

pub fn run(args: &[String]) {
    // No config changes, capability probes, session-file reads or fallback TTYs.
    if std::env::var_os("NEKO_WEBSHELL_AGENT_STATUS").as_deref() != Some(std::ffi::OsStr::new("1"))
        || args.len() != 1
        || !matches!(args[0].as_str(), "claude" | "codex")
    {
        return;
    }
    let _ = report(&args[0]);
}

fn report(agent: &str) -> Option<()> {
    let mut tty = OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY | libc::O_CLOEXEC)
        .open("/dev/tty")
        .ok()?;
    let foreground = foreground_group(&tty)?;
    let helper_pid = std::process::id();
    let identity = hook_identity(agent, helper_pid, foreground)?;
    // Opening this descriptor does not change the Agent's stdin flags.
    let input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open("/proc/self/fd/0")
        .ok()?;
    let payload = read_payload(input)?;
    let bytes = hook_report(agent, &payload)?;
    if foreground_group(&tty) != Some(foreground)
        || hook_identity(agent, helper_pid, foreground) != Some(identity)
    {
        return None;
    }
    // One small, nonblocking write. Never enqueue work or wait for terminal I/O.
    if let Ok(written) = tty.write(&bytes)
        && written != bytes.len()
        && written != 0
    {
        // End a partially accepted OSC instead of leaving the parser in it.
        let _ = tty.write(b"\x07");
    }
    Some(())
}

#[allow(unsafe_code)]
fn foreground_group(tty: &File) -> Option<u32> {
    // SAFETY: tty owns a live descriptor; tcgetpgrp only queries that descriptor.
    let group = unsafe { libc::tcgetpgrp(tty.as_raw_fd()) };
    u32::try_from(group).ok().filter(|group| *group != 0)
}

#[allow(unsafe_code)]
fn read_payload(mut input: File) -> Option<Vec<u8>> {
    let deadline = Instant::now() + INPUT_BUDGET;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8192];
    let mut oversized = false;
    loop {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        let mut poll = libc::pollfd {
            fd: input.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll points to one initialized pollfd; the descriptor stays alive.
        let ready = unsafe { libc::poll(&raw mut poll, 1, remaining.as_millis().max(1) as i32) };
        if ready <= 0 {
            return None;
        }
        match input.read(&mut chunk) {
            Ok(0) => return (!oversized).then_some(bytes),
            Ok(count) => {
                if !oversized && bytes.len() + count <= MAX_HOOK_BYTES {
                    bytes.extend_from_slice(&chunk[..count]);
                } else {
                    // Drain within the same budget, with bounded memory, so a
                    // normal oversized hook payload need not hit a broken pipe.
                    oversized = true;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;

    #[test]
    fn pipe_input_is_bounded_and_does_not_wait_forever_for_eof() {
        let (_writer, reader) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        let started = Instant::now();
        assert!(read_payload(File::from(OwnedFd::from(reader))).is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn accepts_closed_input_and_drains_oversized_input_without_retaining_it() {
        for size in [32, MAX_HOOK_BYTES + 1] {
            let (mut writer, reader) = UnixStream::pair().unwrap();
            reader.set_nonblocking(true).unwrap();
            let thread = std::thread::spawn(move || writer.write_all(&vec![b'x'; size]).unwrap());
            let payload = read_payload(File::from(OwnedFd::from(reader)));
            thread.join().unwrap();
            assert_eq!(
                payload.map(|p| p.len()),
                (size <= MAX_HOOK_BYTES).then_some(size)
            );
        }
    }
}
