//! A reliable IME path for phones, also available beside the desktop terminal.
//! Text is sent to the real attached PTY; it is never rendered as a fabricated reply.
use super::{
    controls::{action, hint},
    state::Ui,
};
use crate::controller::{Command, Pane};
use neko_remoted_protocol::{self as protocol, messages::Operation};
use nsh_base::{input, theme};
use nsh_core::prelude::*;

pub fn render(ui: Ui, pane: ReadSignal<Pane>) -> impl IntoElement {
    let draft = signal(String::new());
    let allowed = move || {
        ui.model.with(|m| m.writable())
            && pane.with(|p| p.controller && !p.read_only && p.exit.is_none())
    };
    let submit = move || {
        if !allowed() || draft.get_untracked().is_empty() {
            return;
        }
        let text = draft.get_untracked();
        if text.len() > 16 * 1024 - 1 {
            ui.error("一次输入最多 16 KiB，请缩短后发送。".into());
            return;
        }
        let data = format!("{text}\r");
        if ui.submit(Command::Request(Operation::TerminalInput {
            stream: pane.get_untracked().stream,
            data: protocol::encode(data.as_bytes()),
        })) {
            draft.set(String::new());
        }
    };
    view()
        .px_3()
        .py_2()
        .gap_2()
        .border_t_1()
        .border_color(move || theme().border)
        .child(when(
            move || !allowed(),
            move || {
                hint(move || {
                    if !ui.model.with(|m| m.ready()) {
                        "连接已断开，输入不会发送。"
                    } else if ui.model.with(|m| !m.writable()) || pane.with(|p| p.read_only) {
                        "此会话为只读授权。"
                    } else if pane.with(|p| p.exit.is_some()) {
                        "会话已退出。"
                    } else {
                        "取得控制权后即可输入。"
                    }
                })
            },
        ))
        .child(
            view()
                .flex_row()
                .gap_2()
                .items_end()
                .child(
                    input()
                        .label("会话输入")
                        .placeholder("输入内容，发送到当前会话…")
                        .value(move || draft.get())
                        .on_change(move |value: &str| draft.set(value.into()))
                        .on_submit(move |_: &str| submit())
                        .readonly(move || !allowed())
                        .flex_1()
                        .min_w(px(0.0))
                        .min_h(px(44.0))
                        .px_3()
                        .py_2()
                        .bg(move || theme().card)
                        .text_color(move || theme().foreground)
                        .placeholder_color(move || color(theme().muted_foreground))
                        .caret_color(move || color(theme().primary))
                        .selection_color(move || color(theme().accent))
                        .border_1()
                        .border_color(move || theme().input)
                        .rounded(move || theme().radius)
                        .focus(|s| s.outline(px(2.0)).outline_color(move || theme().ring)),
                )
                .child(action(
                    "发送",
                    true,
                    move || !allowed() || draft.get().is_empty(),
                    submit,
                )),
        )
        .child(when(allowed, move || {
            view()
                .flex_row()
                .gap_2()
                .child(action(
                    "中断 Ctrl+C",
                    false,
                    || false,
                    move || {
                        if allowed() {
                            ui.send(Command::Request(Operation::TerminalInput {
                                stream: pane.get_untracked().stream,
                                data: protocol::encode(&[3]),
                            }));
                        }
                    },
                ))
                .child(action(
                    "Esc",
                    false,
                    || false,
                    move || {
                        if allowed() {
                            ui.send(Command::Request(Operation::TerminalInput {
                                stream: pane.get_untracked().stream,
                                data: protocol::encode(&[27]),
                            }));
                        }
                    },
                ))
        }))
}
