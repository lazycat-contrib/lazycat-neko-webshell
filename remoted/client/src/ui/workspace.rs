use super::{
    controls::{action, heading, hint, tab},
    files,
    state::Ui,
    terminal_view,
};
use crate::controller::Command;
use neko_remoted_protocol::messages::Operation;
use nsh_core::prelude::*;

pub fn render(ui: Ui) -> impl IntoElement {
    let tools = signal(true);
    effect(move || {
        if keyboard_height() > px(0.0) {
            tools.set(false);
        }
    });
    view()
        .flex_1()
        .min_h(px(0.0))
        .gap_2()
        .child(
            view()
                .px_4()
                .gap_2()
                .child(action(
                    move || {
                        if tools.get() {
                            "收起资源与文件"
                        } else {
                            "资源与文件"
                        }
                    },
                    false,
                    || false,
                    move || tools.update(|open| *open = !*open),
                ))
                .child(action(
                    "断开连接",
                    false,
                    || false,
                    move || ui.send(Command::Disconnect),
                )),
        )
        .child(when(
            move || tools.get(),
            move || {
                scroll()
                    .test_id("resource-tools")
                    .max_h(move || px((window().height.0 * 0.4).min(360.0)))
                    .child(
                        view()
                            .p_4()
                            .gap_4()
                            .child(heading("已授权资源"))
                            .child(action(
                                "刷新资源",
                                false,
                                || false,
                                move || ui.send(Command::Request(Operation::Resources {})),
                            ))
                            .child(when(
                                move || ui.model.with(|model| model.resources.is_empty()),
                                || hint("主机尚未授权任何资源。请在小橘修改本设备权限后刷新。"),
                            ))
                            .child(each(
                                move || {
                                    ui.model.with(|model| {
                                        model
                                            .resources
                                            .iter()
                                            .map(|resource| {
                                                (
                                                    resource.id.clone(),
                                                    resource.name.clone(),
                                                    resource.backend.clone(),
                                                    resource.terminal,
                                                    resource.herdr,
                                                    resource.files,
                                                )
                                            })
                                            .collect::<Vec<_>>()
                                    })
                                },
                                |resource| resource.0.clone(),
                                move |resource, _| {
                                    view()
                                        .gap_2()
                                        .child(
                                            text(move || {
                                                resource.with(|resource| {
                                                    format!("{} · {}", resource.1, resource.2)
                                                })
                                            })
                                            .text_base(),
                                        )
                                        .child(when(
                                            move || resource.with(|resource| resource.3),
                                            move || {
                                                action(
                                                    "打开普通终端",
                                                    false,
                                                    || false,
                                                    move || {
                                                        ui.send(Command::Request(
                                                            Operation::TerminalAttach {
                                                                grant: resource.get_untracked().0,
                                                                pane: None,
                                                            },
                                                        ))
                                                    },
                                                )
                                            },
                                        ))
                                        .child(when(
                                            move || resource.with(|resource| resource.4),
                                            move || {
                                                action(
                                                    "查看 Herdr 会话与窗格",
                                                    false,
                                                    || false,
                                                    move || {
                                                        ui.send(Command::Request(
                                                            Operation::Herdr {
                                                                grant: resource.get_untracked().0,
                                                                method: "session.snapshot".into(),
                                                                params: serde_json::json!({}),
                                                            },
                                                        ))
                                                    },
                                                )
                                            },
                                        ))
                                        .child(when(
                                            move || resource.with(|resource| resource.5),
                                            move || {
                                                action(
                                                    "浏览授权文件",
                                                    false,
                                                    || false,
                                                    move || {
                                                        ui.send(Command::Request(
                                                            Operation::FileList {
                                                                grant: resource.get_untracked().0,
                                                                path: String::new(),
                                                            },
                                                        ))
                                                    },
                                                )
                                            },
                                        ))
                                },
                            ))
                            .child(when(
                                move || ui.model.with(|model| !model.herdr_grant.is_empty()),
                                move || {
                                    view()
                                        .gap_2()
                                        .child(heading("Herdr 窗格"))
                                        .child(when(
                                            move || {
                                                ui.model.with(|model| model.herdr_panes.is_empty())
                                            },
                                            || hint("会话中没有可打开的窗格。"),
                                        ))
                                        .child(each(
                                            move || {
                                                ui.model.with(|model| model.herdr_panes.clone())
                                            },
                                            |pane| pane.0.clone(),
                                            move |pane, _| {
                                                action(
                                                    move || {
                                                        pane.with(|pane| format!("打开 {}", pane.1))
                                                    },
                                                    false,
                                                    || false,
                                                    move || {
                                                        ui.send(Command::Request(
                                                            Operation::TerminalAttach {
                                                                grant: ui.model.with_untracked(
                                                                    |model| {
                                                                        model.herdr_grant.clone()
                                                                    },
                                                                ),
                                                                pane: Some(pane.get_untracked().0),
                                                            },
                                                        ))
                                                    },
                                                )
                                            },
                                        ))
                                },
                            ))
                            .child(files::render(ui)),
                    )
            },
        ))
        .child(when(
            move || ui.model.with(|model| model.panes.is_empty()),
            || {
                view()
                    .flex_1()
                    .p_4()
                    .child(hint("选择一个已授权资源，打开终端或 Herdr 窗格。"))
            },
        ))
        .child(
            scroll()
                .horizontal()
                .child(view().flex_row().px_4().gap_2().child(each(
                    move || {
                        ui.model.with(|model| {
                            model
                                .panes
                                .iter()
                                .map(|pane| (pane.stream.clone(), pane.name.clone()))
                                .collect::<Vec<_>>()
                        })
                    },
                    |pane| pane.0.clone(),
                    move |pane, _| {
                        tab(
                            move || pane.with(|pane| pane.1.clone()),
                            move || pane.with(|pane| pane.0 == ui.active.get()),
                            move || ui.active.set(pane.get_untracked().0),
                        )
                    },
                ))),
        )
        .child(each(
            move || ui.model.with(|model| model.panes.clone()),
            |pane| pane.stream.clone(),
            move |pane, _| terminal_view::render(ui, pane),
        ))
}
