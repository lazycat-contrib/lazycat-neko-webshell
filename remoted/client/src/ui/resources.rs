//! Authorized targets and Herdr sessions, presented as a navigable list.
use super::{
    controls::{action, hint, navigation_row_disabled},
    navigation::Section,
    state::Ui,
};
use crate::controller::Command;
use neko_remoted_protocol::messages::Operation;
use nsh_core::prelude::*;

#[derive(Clone, PartialEq)]
struct Target {
    id: String,
    name: String,
    herdr: bool,
    terminal: bool,
}

pub fn render(ui: Ui) -> impl IntoElement {
    view()
        .gap_2()
        .child(
            view()
                .flex_row()
                .items_center()
                .justify_between()
                .child(
                    text(move || {
                        if ui.navigation.section.get() == Section::Herdr {
                            "Herdr 工作区"
                        } else {
                            "终端会话"
                        }
                    })
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD),
                )
                .child(action(
                    "刷新会话",
                    false,
                    move || ui.model.with(|m| m.opening),
                    move || {
                        ui.send(Command::Request(Operation::Resources {}));
                        let grant = ui.model.with_untracked(|m| m.herdr_grant.clone());
                        if ui.navigation.section.get_untracked() == Section::Herdr
                            && !grant.is_empty()
                        {
                            ui.send(Command::Request(Operation::Herdr {
                                grant,
                                method: "session.snapshot".into(),
                                params: serde_json::json!({}),
                            }));
                        }
                    },
                )),
        )
        .child(when(
            move || {
                ui.model.with(|m| {
                    !m.resources
                        .iter()
                        .any(|r| match ui.navigation.section.get() {
                            Section::Herdr => r.herdr,
                            Section::Terminal => r.terminal && !r.herdr,
                        })
                })
            },
            move || {
                hint(move || {
                    if ui.navigation.section.get() == Section::Herdr {
                        "没有获授权的 Herdr 工作区。请在主机端授权已有 Herdr 会话。"
                    } else {
                        "没有获授权的普通终端。请在主机端授权已有终端会话。"
                    }
                })
            },
        ))
        .child(when(
            move || ui.model.with(|m| m.opening),
            || hint("正在打开会话…"),
        ))
        .child(each(
            move || {
                ui.model.with(|m| {
                    m.resources
                        .iter()
                        .filter(|r| match ui.navigation.section.get() {
                            Section::Herdr => r.herdr,
                            Section::Terminal => r.terminal && !r.herdr,
                        })
                        .map(|r| Target {
                            id: r.id.clone(),
                            name: r.name.clone(),
                            herdr: r.herdr,
                            terminal: r.terminal,
                        })
                        .collect::<Vec<_>>()
                })
            },
            |r| r.id.clone(),
            move |r, _| {
                view()
                    .gap_1()
                    .child(navigation_row_disabled(
                        move || r.with(|r| r.name.clone()),
                        move || {
                            r.with(|r| {
                                if r.herdr {
                                    "Herdr · 查看会话"
                                } else {
                                    "普通终端"
                                }
                            })
                        },
                        move || r.with(|r| ui.model.with(|m| m.herdr_grant == r.id)),
                        move || ui.model.with(|m| m.opening),
                        move || {
                            let r = r.get_untracked();
                            if r.herdr {
                                ui.send(Command::Request(Operation::Herdr {
                                    grant: r.id,
                                    method: "session.snapshot".into(),
                                    params: serde_json::json!({}),
                                }));
                            } else if r.terminal {
                                ui.send(Command::Request(Operation::TerminalAttach {
                                    grant: r.id,
                                    pane: None,
                                }));
                                ui.navigation.show_session();
                            }
                        },
                    ))
                    .child(when(
                        move || {
                            r.with(|r| r.herdr && r.id == ui.model.with(|m| m.herdr_grant.clone()))
                        },
                        move || {
                            view()
                                .pl_3()
                                .gap_1()
                                .child(each(
                                    move || ui.model.with(|m| m.herdr_panes.clone()),
                                    |p| p.0.clone(),
                                    move |p, _| {
                                        navigation_row_disabled(
                                            move || p.with(|p| p.1.clone()),
                                            "Herdr 会话",
                                            || false,
                                            move || ui.model.with(|m| m.opening),
                                            move || {
                                                ui.send(Command::Request(
                                                    Operation::TerminalAttach {
                                                        grant: r.get_untracked().id,
                                                        pane: Some(p.get_untracked().0),
                                                    },
                                                ));
                                                ui.navigation.show_session();
                                            },
                                        )
                                    },
                                ))
                                .child(when(
                                    move || ui.model.with(|m| m.herdr_panes.is_empty()),
                                    || hint("此资源当前没有可打开的窗格。"),
                                ))
                        },
                    ))
            },
        ))
}
