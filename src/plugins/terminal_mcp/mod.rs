pub mod grants;
pub mod herdr_adapter;
pub mod http;
pub mod principal;
pub mod server;
pub mod service;
pub mod types;

pub const PLUGIN_ID: &str = "terminal-mcp";

pub use grants::TerminalMcpManager;
