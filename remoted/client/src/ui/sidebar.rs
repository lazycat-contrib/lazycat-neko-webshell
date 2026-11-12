use super::{
    controls::{action, heading, hint, navigation_row},
    navigation::Section,
    resources,
    state::Ui,
};
use crate::controller::Command;
use nsh_base::theme;
use nsh_core::prelude::*;

pub fn render(ui: Ui) -> impl IntoElement {
    view()
        .flex_1()
        .min_h(px(0.0))
        .bg(move || theme().card)
        .child(
            view()
                .p_4()
                .flex_row()
                .items_center()
                .justify_between()
                .child(heading("设备与会话"))
                .child(action(
                    "添加主机",
                    false,
                    || false,
                    move || {
                        if ui.disconnect() {
                            ui.navigation.settings.set(true);
                            ui.navigation.drawer.set(false);
                        }
                    },
                )),
        )
        .child(
            view()
                .px_3()
                .pb_3()
                .flex_row()
                .gap_2()
                .child(super::controls::tab(
                    "Herdr",
                    move || ui.navigation.section.get() == Section::Herdr,
                    move || {
                        ui.navigation.section.set(Section::Herdr);
                        ui.active.set(String::new());
                        ui.navigation.settings.set(false);
                    },
                ))
                .child(super::controls::tab(
                    "终端",
                    move || ui.navigation.section.get() == Section::Terminal,
                    move || {
                        ui.navigation.section.set(Section::Terminal);
                        ui.active.set(String::new());
                        ui.navigation.settings.set(false);
                    },
                )),
        )
        .child(
            scroll().flex_1().min_h(px(0.0)).child(
                view()
                    .px_3()
                    .gap_4()
                    .child(
                        view()
                            .gap_1()
                            .child(hint("已配对主机"))
                            .child(when(
                                move || ui.model.with(|m| m.bindings.is_empty()),
                                || hint("添加一台主机，扫码或输入设备码配对。"),
                            ))
                            .child(each(
                                move || ui.model.with(|m| m.bindings.clone()),
                                |b| (b.relay.origin().to_owned(), b.route.clone()),
                                move |b, index| {
                                    navigation_row(
                                        move || format!("主机 {}", index.get() + 1),
                                        move || {
                                            b.with(|b| {
                                                format!(
                                                    "{} · {}",
                                                    b.relay.origin(),
                                                    &b.host_key[..8.min(b.host_key.len())]
                                                )
                                            })
                                        },
                                        move || {
                                            b.with(|b| {
                                                ui.model
                                                    .with(|m| m.active_binding.as_ref() == Some(b))
                                            })
                                        },
                                        move || {
                                            ui.navigation.settings.set(false);
                                            ui.navigation.files.set(false);
                                            let binding = b.get_untracked();
                                            if !ui.model.with_untracked(|m| {
                                                m.ready()
                                                    && m.active_binding.as_ref() == Some(&binding)
                                            }) {
                                                ui.send(Command::Reconnect(binding));
                                            }
                                            ui.navigation.drawer.set(false);
                                        },
                                    )
                                },
                            )),
                    )
                    .child(when(
                        move || ui.model.with(|m| m.ready()),
                        move || resources::render(ui),
                    ))
                    .child(when(
                        move || ui.model.with(|m| !m.panes.is_empty()),
                        move || {
                            view().gap_1().child(hint("已打开")).child(each(
                                move || {
                                    ui.model.with(|m| {
                                        m.panes
                                            .iter()
                                            .filter(|p| {
                                                matches!(
                                                    (p.kind, ui.navigation.section.get()),
                                                    (
                                                        crate::controller::PaneKind::Herdr,
                                                        Section::Herdr
                                                    ) | (
                                                        crate::controller::PaneKind::Terminal,
                                                        Section::Terminal
                                                    )
                                                )
                                            })
                                            .cloned()
                                            .collect::<Vec<_>>()
                                    })
                                },
                                |p| p.stream.clone(),
                                move |p, _| {
                                    navigation_row(
                                        move || p.with(|p| p.name.clone()),
                                        move || {
                                            p.with(|p| {
                                                if p.read_only {
                                                    "只读"
                                                } else if p.controller {
                                                    "可输入"
                                                } else {
                                                    "点击进入"
                                                }
                                            })
                                        },
                                        move || p.with(|p| p.stream == ui.active.get()),
                                        move || {
                                            ui.active.set(p.get_untracked().stream);
                                            ui.navigation.show_session();
                                        },
                                    )
                                },
                            ))
                        },
                    )),
            ),
        )
        .child(
            view()
                .p_3()
                .border_t_1()
                .border_color(move || theme().border)
                .child(action(
                    "连接设置",
                    false,
                    || false,
                    move || {
                        ui.navigation.settings.set(true);
                        ui.navigation.drawer.set(false);
                    },
                )),
        )
}
