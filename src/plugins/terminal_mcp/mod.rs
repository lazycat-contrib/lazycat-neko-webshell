pub mod grants;
pub mod herdr_adapter;
pub mod principal;
pub mod service;
pub mod types;

pub const PLUGIN_ID: &str = "terminal-mcp";

pub use grants::TerminalMcpManager;
pub use service::TerminalControlService;
