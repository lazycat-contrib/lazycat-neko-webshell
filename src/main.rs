#![allow(refining_impl_trait)]

use std::net::SocketAddr;
use std::sync::Arc;

use tracing::info;

mod action_ws;
mod agent_client;
mod agent_daemon;
mod agent_history;
mod agent_protocol;
mod agent_pty;
mod agent_workspace;
mod ai_chat;
mod assets;
mod backgrounds;
mod client_terminal;
mod config;
mod database;
mod embedded_frontend;
mod fonts;
mod herdr;
mod http_body;
mod lightos;
mod lightos_admin;
mod notifications;
mod plugins;
mod pomodoro;
mod preferences;
mod proto;
mod pty_io;
mod remote_program;
mod restty_headless;
mod router;
mod service;
mod session_backend;
mod session_manager;
mod sounds;
mod ssh_backend;
mod ssh_config;
mod state;
mod terminal;
mod terminal_control;
mod terminal_manager;
mod terminal_reply_authority;
mod tty_init;
mod validation;
mod voice_input;
mod workspace;

use crate::router::build_app;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).is_some_and(|arg| arg == "agent") {
        return agent_daemon::run_agent_command(&args[2..]);
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lazycat_neko_webshell=info,tower_http=info".into()),
        )
        .init();

    let state = Arc::new(AppState::new()?);
    let app = build_app(state);

    let addr: SocketAddr = "127.0.0.1:8080".parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}
