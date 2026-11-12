//! Composition only. Hidden session surfaces remain mounted across secondary routes.
use super::{
    connection, controls::action, file_view, session_list, state::Ui, terminal_view,
    workspace_header,
};
use crate::controller::Command;
use nsh_core::prelude::*;

pub fn render(ui: Ui) -> impl IntoElement {
    view()
        .flex_1()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .child(workspace_header::render(ui))
        .child(
            view()
                .flex_1()
                .min_h(px(0.0))
                .style_when(move || !ui.navigation.settings.get(), |s| s.hidden())
                .child(
                    view()
                        .px_4()
                        .py_2()
                        .flex_row()
                        .gap_2()
                        .child(action(
                            "返回会话",
                            false,
                            || false,
                            move || ui.navigation.settings.set(false),
                        ))
                        .child(when(
                            move || ui.model.with(|m| m.ready()),
                            move || {
                                action(
                                    "断开连接",
                                    false,
                                    || false,
                                    move || ui.send(Command::Disconnect),
                                )
                            },
                        )),
                )
                .child(connection::render(ui)),
        )
        .child(when(
            move || !ui.navigation.settings.get() && ui.navigation.files.get(),
            move || file_view::render(ui),
        ))
        .child(
            view()
                .flex_1()
                .min_h(px(0.0))
                .style_when(
                    move || ui.navigation.settings.get() || ui.navigation.files.get(),
                    |s| s.hidden(),
                )
                .child(when(
                    move || ui.active.with(|active| active.is_empty()),
                    move || session_list::render(ui),
                ))
                .child(each(
                    move || ui.model.with(|m| m.panes.clone()),
                    |p| p.stream.clone(),
                    move |p, _| terminal_view::render(ui, p),
                )),
        )
}
