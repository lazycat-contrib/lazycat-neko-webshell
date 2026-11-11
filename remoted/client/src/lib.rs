//! Native application UI. Networking and platform services have independent owners.
pub mod network;
mod controller;
mod storage;
pub mod platform;
mod terminal;
mod ui;
use nsh_core::prelude::*;
pub use ui::App;
pub fn root()->nsh_core::element::Root{nsh_core::element::Root::of::<App>().tokens(nsh_base::tokens_of(Some(include_str!("ui/theme.json"))).expect("valid application tokens"))}
#[native_module("neko-remoted/native")]
fn native(registry:&mut Registry){registry.register::<App>();}
