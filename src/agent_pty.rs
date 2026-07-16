use std::sync::{Mutex, mpsc};
use std::thread;

use anyhow::{Context as _, anyhow};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tracing::{info, warn};

use crate::pty_io::{ChildWait, PtyOutputEvent, PtyWriter, spawn_batched_output_reader};
use crate::tty_init::terminal_session_bootstrap_script;
use crate::validation::validate_size;

#[derive(Clone, Debug)]
pub struct AgentPtyExit {
    pub exit_code: i32,
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub enum AgentPtyEvent {
    Output(Vec<u8>),
    Exit(AgentPtyExit),
    Error(String),
}

pub struct AgentPty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: PtyWriter,
    killer: Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    child_wait: ChildWait,
    shell_pid: Option<u32>,
}

impl AgentPty {
    pub fn spawn(
        pane_id: &str,
        username: &str,
        cols: u16,
        rows: u16,
        event_tx: mpsc::Sender<AgentPtyEvent>,
    ) -> anyhow::Result<Self> {
        validate_size(cols, rows)?;
        info!(pane_id = %pane_id, username = %username.trim(), "spawning agent local pty");

        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-lc");
        command.arg(local_shell_bootstrap_script(username));
        command.cwd("/");
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("LANG", "C.UTF-8");
        command.env("LC_ALL", "C.UTF-8");

        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| "failed to start agent pty shell")?;
        let shell_pid = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let writer = PtyWriter::spawn(writer);
        let child_wait = ChildWait::default();

        spawn_batched_output_reader(reader, {
            let event_tx = event_tx.clone();
            move |event| {
                let event = match event {
                    PtyOutputEvent::Output(data) => AgentPtyEvent::Output(data),
                    PtyOutputEvent::Error(message) => AgentPtyEvent::Error(message),
                };
                event_tx.send(event).is_ok()
            }
        });
        spawn_exit_thread(child, event_tx, child_wait.clone());

        Ok(Self {
            master: Mutex::new(pair.master),
            writer,
            killer: Mutex::new(Some(killer)),
            child_wait,
            shell_pid,
        })
    }

    pub fn write_input(&self, data: Vec<u8>) -> anyhow::Result<()> {
        self.writer.send(data).map_err(anyhow::Error::new)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        validate_size(cols, rows)?;
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow!("agent pty lock poisoned"))?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn is_busy(&self) -> bool {
        let Ok(master) = self.master.lock() else {
            return false;
        };
        has_foreground_process(master.as_ref(), self.shell_pid)
    }

    pub fn close(&self) {
        self.writer.signal_close();
        let Some(mut killer) = self.killer.lock().ok().and_then(|mut killer| killer.take()) else {
            return;
        };
        if let Err(err) = killer.kill() {
            warn!(error = %err, "agent pty child was already closed");
        }
        self.child_wait.wait();
        self.writer.wait();
    }
}

impl Drop for AgentPty {
    fn drop(&mut self) {
        self.close();
    }
}

fn spawn_exit_thread(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    event_tx: mpsc::Sender<AgentPtyEvent>,
    child_wait: ChildWait,
) {
    thread::spawn(move || {
        let info = match child.wait() {
            Ok(status) => AgentPtyExit {
                exit_code: i32::try_from(status.exit_code()).unwrap_or(i32::MAX),
                message: status.signal().map(ToOwned::to_owned),
            },
            Err(err) => AgentPtyExit {
                exit_code: -1,
                message: Some(err.to_string()),
            },
        };
        child_wait.complete();
        let _ = event_tx.send(AgentPtyEvent::Exit(info));
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

fn local_shell_bootstrap_script(username: &str) -> String {
    let username = username.trim();
    if matches!(username, "" | "root") {
        return current_user_shell_bootstrap_script();
    }
    user_shell_bootstrap_script(username)
}

fn current_user_shell_bootstrap_script() -> String {
    [
        "__webshell_user=\"$(id -un 2>/dev/null || true)\"",
        "__webshell_entry=\"$(getent passwd \"$__webshell_user\" 2>/dev/null || true)\"",
        "__webshell_shell=\"$(printf '%s\\n' \"$__webshell_entry\" | cut -d: -f7)\"",
        "if [ -z \"$__webshell_shell\" ]; then __webshell_shell=\"${SHELL:-/bin/sh}\"; fi",
        "case \"$__webshell_shell\" in */*) ;; *) __webshell_shell=\"$(command -v \"$__webshell_shell\" 2>/dev/null || printf '%s' \"$__webshell_shell\")\";; esac",
        terminal_session_bootstrap_script(),
        "unset __webshell_user __webshell_entry",
        "exec \"$__webshell_shell\"",
    ]
    .join("\n")
}

fn user_shell_bootstrap_script(username: &str) -> String {
    format!(
        r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
user={}
uid=$(id -u "$user" 2>/dev/null) || {{
  echo "webshell user was not found."
  exit 127
}}
gid=$(id -g "$user" 2>/dev/null) || {{
  echo "webshell user was not found."
  exit 127
}}
entry=$(getent passwd "$user" 2>/dev/null) || {{
  echo "webshell user entry was not found."
  exit 127
}}
home=$(printf '%s\n' "$entry" | cut -d: -f6)
shell=$(printf '%s\n' "$entry" | cut -d: -f7)
if [ -z "$home" ]; then home=/; fi
if [ -z "$shell" ]; then shell=/bin/sh; fi
if [ ! -d "$home" ]; then mkdir -p "$home"; fi
if [ "$(stat -c '%u' "$home" 2>/dev/null || true)" != "$uid" ] || [ "$(stat -c '%g' "$home" 2>/dev/null || true)" != "$gid" ]; then
  chown "$uid:$gid" "$home"
fi
xdg_config_home="$home/.config"
if [ ! -d "$xdg_config_home" ]; then mkdir -p "$xdg_config_home" 2>/dev/null || true; fi
if [ -d "$xdg_config_home" ]; then chown "$uid:$gid" "$xdg_config_home" 2>/dev/null || true; fi
xdg_runtime_dir="/run/user/$uid"
if [ ! -d "$xdg_runtime_dir" ]; then xdg_runtime_dir=""; fi
__webshell_shell="$shell"
{}
export XDG_CONFIG_HOME="$xdg_config_home"
if [ -n "$xdg_runtime_dir" ]; then export XDG_RUNTIME_DIR="$xdg_runtime_dir"; else unset XDG_RUNTIME_DIR; fi
if command -v setpriv >/dev/null 2>&1; then
  exec env HOME="$home" USER="$user" LOGNAME="$user" SHELL="$__webshell_shell" XDG_CONFIG_HOME="$xdg_config_home" setpriv --reuid "$uid" --regid "$gid" --init-groups "$__webshell_shell"
fi
if command -v su >/dev/null 2>&1; then
  export HOME="$home" USER="$user" LOGNAME="$user" SHELL="$__webshell_shell"
  exec su -s "$__webshell_shell" "$user"
fi
echo "setpriv or su is required for webshell login session."
exit 127"#,
        shell_script_quote(username),
        terminal_session_bootstrap_script(),
    )
}

fn shell_script_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\"'\"'");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_shell_values() {
        assert_eq!(shell_script_quote("root"), "'root'");
        assert_eq!(shell_script_quote("dev'user"), "'dev'\"'\"'user'");
    }

    #[test]
    fn current_user_bootstrap_sources_catlink() {
        let script = local_shell_bootstrap_script("");

        assert!(script.contains("/run/catlink/shell-env.sh"));
        assert!(script.contains("exec \"$__webshell_shell\""));
    }

    #[test]
    fn named_user_bootstrap_switches_identity() {
        let script = local_shell_bootstrap_script("demo");

        assert!(script.contains("setpriv --reuid"));
        assert!(script.contains("su -s \"$__webshell_shell\""));
        assert!(script.contains("user='demo'"));
    }
}
