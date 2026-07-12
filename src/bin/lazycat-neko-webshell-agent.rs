#![allow(clippy::all, clippy::pedantic, dead_code)]

#[path = "../agent_daemon.rs"]
mod agent_daemon;
#[path = "../agent_history.rs"]
mod agent_history;
#[path = "../agent_protocol.rs"]
mod agent_protocol;
#[path = "../agent_pty.rs"]
mod agent_pty;
#[path = "../agent_workspace.rs"]
mod agent_workspace;
#[path = "../config.rs"]
mod config;
#[path = "../proto.rs"]
mod proto;
#[path = "../tty_init.rs"]
mod tty_init;
#[path = "../validation.rs"]
mod validation;

fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let agent_args = if args.first().is_some_and(|argument| argument == "agent") {
        &args[1..]
    } else {
        args.as_slice()
    };
    agent_daemon::run_agent_command(agent_args)
}
