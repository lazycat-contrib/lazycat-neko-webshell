use super::{
    controls::{action, heading, hint},
    files,
    state::Ui,
};
use crate::controller::Command;
use nsh_core::prelude::*;
pub fn render(ui: Ui) -> impl IntoElement {
    scroll().flex_1().child(
        view()
            .p_4()
            .gap_3()
            .child(
                view()
                    .flex_row()
                    .justify_between()
                    .child(heading("文件"))
                    .child(action(
                        "返回会话",
                        false,
                        || false,
                        move || ui.navigation.files.set(false),
                    )),
            )
            .child(when(
                move || ui.model.with(|m| m.file_grant.is_empty()),
                || hint("选择一个获授权目录以浏览和传输文件。"),
            ))
            .child(each(
                move || {
                    ui.model.with(|m| {
                        m.resources
                            .iter()
                            .filter(|r| r.files)
                            .map(|r| (r.id.clone(), r.name.clone()))
                            .collect::<Vec<_>>()
                    })
                },
                |r| r.0.clone(),
                move |r, _| {
                    super::controls::navigation_row(
                        move || r.with(|r| r.1.clone()),
                        "浏览授权文件",
                        move || r.with(|r| ui.model.with(|m| m.file_grant == r.0)),
                        move || {
                            ui.send(Command::Request(
                                neko_remoted_protocol::messages::Operation::FileList {
                                    grant: r.get_untracked().0,
                                    path: String::new(),
                                },
                            ));
                        },
                    )
                },
            ))
            .child(files::render(ui)),
    )
}
