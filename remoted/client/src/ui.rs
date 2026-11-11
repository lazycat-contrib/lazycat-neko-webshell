mod connection;
mod controls;
mod files;
pub(crate) mod herdr;
mod shell;
mod state;
mod terminal_colors;
mod terminal_observer;
mod terminal_surface;
mod terminal_view;
#[cfg(test)]
mod tests;
pub(crate) mod transfers;
mod workspace;

use nsh_base::{nav_page, nav_stack, theme};
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    #[cfg(not(target_os = "android"))]
    crate::platform::start_services();
    provide_context(crate::terminal::factory());
    provide_context(state::Ui::start());
    nav_stack().flex_1().bg(move || theme().background).child(
        nav_page()
            .title("小橘远程")
            .header(
                view().p_4().child(
                    text("小橘远程")
                        .text_xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .role(AccessibilityRole::Header),
                ),
            )
            .child(shell::body()),
    )
}
