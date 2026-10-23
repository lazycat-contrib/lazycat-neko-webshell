pub mod grants;
pub mod principal;
mod runtime;
pub mod types;
pub use runtime::register;
pub const PLUGIN_ID: &str = "terminal-mcp";
pub use grants::TerminalMcpManager;
