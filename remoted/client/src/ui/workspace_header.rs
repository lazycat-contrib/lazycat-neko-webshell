use super::{
    controls::{action, hint},
    state::Ui,
};
use nsh_base::theme;
use nsh_core::prelude::*;
pub fn render(ui: Ui) -> impl IntoElement {
    view()
        .px_4()
        .py_2()
        .gap_2()
        .border_b_1()
        .border_color(move || theme().border)
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(when(
                    move || !super::navigation::wide(),
                    move || {
                        action(
                            "设备",
                            false,
                            || false,
                            move || ui.navigation.drawer.set(true),
                        )
                    },
                ))
                .child(when(
                    move || !ui.active.get().is_empty() && !ui.navigation.settings.get(),
                    move || {
                        action(
                            move || {
                                if super::navigation::wide() {
                                    "所有会话"
                                } else {
                                    "返回"
                                }
                            },
                            false,
                            || false,
                            move || ui.active.set(String::new()),
                        )
                    },
                ))
                .child(
                    view().flex_1().min_w(px(0.0)).child(
                        text(move || {
                            if ui.navigation.settings.get() {
                                return "连接设置".to_owned();
                            }
                            ui.model.with(|m| {
                                m.panes
                                    .iter()
                                    .find(|p| p.stream == ui.active.get())
                                    .map(|p| p.name.clone())
                                    .unwrap_or_else(|| "所有会话".into())
                            })
                        })
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .number_of_lines(1),
                    ),
                )
                .child(when(
                    move || {
                        ui.model
                            .with(|m| m.ready() && m.resources.iter().any(|r| r.files))
                    },
                    move || {
                        action(
                            "文件",
                            false,
                            || false,
                            move || {
                                ui.navigation.settings.set(false);
                                ui.navigation.files.update(|open| *open = !*open);
                            },
                        )
                    },
                )),
        )
        .child(when(
            move || {
                !super::navigation::wide()
                    && !ui.navigation.settings.get()
                    && ui.active.get().is_empty()
            },
            move || {
                view()
                    .flex_row()
                    .gap_2()
                    .child(super::controls::tab(
                        "Herdr",
                        move || ui.navigation.section.get() == super::navigation::Section::Herdr,
                        move || {
                            ui.navigation.section.set(super::navigation::Section::Herdr);
                            ui.active.set(String::new());
                        },
                    ))
                    .child(super::controls::tab(
                        "终端",
                        move || ui.navigation.section.get() == super::navigation::Section::Terminal,
                        move || {
                            ui.navigation
                                .section
                                .set(super::navigation::Section::Terminal);
                            ui.active.set(String::new());
                        },
                    ))
            },
        ))
        .child(hint(move || ui.model.with(|m| m.status().to_owned())))
        .child(when(
            move || ui.model.with(|m| !m.error.is_empty()),
            move || {
                view()
                    .gap_1()
                    .child(
                        text(move || ui.model.with(|m| m.error.clone()))
                            .text_sm()
                            .text_color(move || theme().destructive)
                            .role(AccessibilityRole::Alert),
                    )
                    .child(action(
                        "关闭提示",
                        false,
                        || false,
                        move || ui.model.update(|m| m.error.clear()),
                    ))
            },
        ))
        .child(when(
            move || ui.model.with(|m| !m.notice.is_empty()),
            move || hint(move || ui.model.with(|m| m.notice.clone())),
        ))
}
