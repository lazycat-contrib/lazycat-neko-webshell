mod composer;
mod connection;
mod controls;
mod file_view;
mod files;
pub(crate) mod herdr;
mod navigation;
mod resources;
mod session_list;
mod shell;
mod sidebar;
mod state;
mod terminal_colors;
mod terminal_input;
mod terminal_observer;
mod terminal_surface;
mod terminal_view;
#[cfg(test)]
mod tests;
pub(crate) mod transfers;
#[cfg(all(test, target_os = "linux"))]
mod visual_tests;
mod workspace;
mod workspace_header;

use nsh_base::{nav_page, nav_stack, theme};
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    #[cfg(not(target_os = "android"))]
    crate::platform::start_services();
    provide_context(crate::terminal::factory());
    let ui = state::Ui::start();
    provide_context(ui);
    nav_stack().flex_1().bg(move || theme().background).child(
        nav_page()
            .title("neoko-terminal")
            .header_visible(false)
            .pop_on_back(move || !ui.secondary())
            .on_back_press(move || ui.back())
            .header(
                view().p_4().child(
                    text("neoko-terminal")
                        .text_xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .role(AccessibilityRole::Header),
                ),
            )
            .child(shell::body()),
    )
}
