use super::{
    controls::{action, heading, hint},
    state::Ui,
};
use crate::controller::Command;
use nsh_core::prelude::*;
pub fn render(ui: Ui) -> impl IntoElement {
    scroll().flex_1().child(
        view()
            .p_4()
            .gap_4()
            .child(when(
                move || ui.model.with(|m| !m.ready()),
                move || {
                    view()
                        .gap_3()
                        .child(heading("连接你的主机"))
                        .child(hint("从设备侧栏选择已配对主机，或添加新设备。"))
                        .child(action(
                            "选择设备",
                            true,
                            || false,
                            move || ui.navigation.drawer.set(true),
                        ))
                        .child(when(
                            move || ui.model.with(|m| m.active_binding.is_some()),
                            move || {
                                action(
                                    "重新连接",
                                    false,
                                    || false,
                                    move || {
                                        if let Some(binding) =
                                            ui.model.with_untracked(|m| m.active_binding.clone())
                                        {
                                            ui.send(Command::Reconnect(binding));
                                        }
                                    },
                                )
                            },
                        ))
                },
            ))
            .child(when(
                move || ui.model.with(|m| m.ready()) && !super::navigation::wide(),
                move || super::resources::render(ui),
            ))
            .child(when(
                move || super::navigation::wide() && ui.model.with(|m| m.ready()),
                || hint("从左侧选择工作区或终端会话。"),
            ))
            .child(each(
                move || {
                    ui.model.with(|m| {
                        m.panes
                            .iter()
                            .filter(|_| !super::navigation::wide())
                            .filter(|p| {
                                matches!(
                                    (p.kind, ui.navigation.section.get()),
                                    (
                                        crate::controller::PaneKind::Herdr,
                                        super::navigation::Section::Herdr
                                    ) | (
                                        crate::controller::PaneKind::Terminal,
                                        super::navigation::Section::Terminal
                                    )
                                )
                            })
                            .map(|p| (p.stream.clone(), p.name.clone()))
                            .collect::<Vec<_>>()
                    })
                },
                |p| p.0.clone(),
                move |p, _| {
                    super::controls::navigation_row(
                        move || p.with(|p| p.1.clone()),
                        "已打开的会话",
                        || false,
                        move || {
                            ui.active.set(p.get_untracked().0);
                            ui.navigation.show_session();
                        },
                    )
                },
            )),
    )
}
