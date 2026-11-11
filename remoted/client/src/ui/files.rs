use super::{
    controls::{action, heading, hint},
    state::Ui,
    transfers,
};
use crate::controller::Command;
use neko_remoted_protocol::messages::Operation;
use nsh_core::prelude::*;

pub fn render(ui: Ui) -> impl IntoElement {
    view()
        .gap_3()
        .child(when(
            move || ui.model.with(|model| !model.file_grant.is_empty()),
            move || {
                view()
                    .gap_3()
                    .child(heading("文件"))
                    .child(hint(move || {
                        ui.model.with(|model| format!("授权目录 /{}", model.path))
                    }))
                    .child(hint("单文件上限 4 GiB；校验通过后才提交保存。"))
                    .child(action(
                        "返回上级目录",
                        false,
                        move || {
                            ui.model
                                .with(|model| model.path.is_empty() || model.path == "/")
                        },
                        move || {
                            let (grant, path) = ui.model.with_untracked(|model| {
                                (
                                    model.file_grant.clone(),
                                    model
                                        .path
                                        .trim_end_matches('/')
                                        .rsplit_once('/')
                                        .map(|(parent, _)| parent.to_owned())
                                        .unwrap_or_default(),
                                )
                            });
                            ui.send(Command::Request(Operation::FileList { grant, path }));
                        },
                    ))
                    .child(action(
                        "刷新目录",
                        false,
                        || false,
                        move || {
                            let (grant, path) = ui.model.with_untracked(|model| {
                                (model.file_grant.clone(), model.path.clone())
                            });
                            ui.send(Command::Request(Operation::FileList { grant, path }));
                        },
                    ))
                    .child(hint(move || {
                        ui.model.with(|model| {
                            if model.writable() {
                                "上传新文件；已有同名文件不会覆盖。"
                            } else {
                                "只读授权：可以浏览和下载，不能上传。"
                            }
                        })
                    }))
                    .child(action(
                        "选择文件上传",
                        false,
                        move || {
                            ui.model.with(|model| {
                                !model.writable()
                                    || model
                                        .transfer
                                        .as_ref()
                                        .is_some_and(|transfer| transfer.cancellable)
                            })
                        },
                        move || {
                            let (grant, directory) = ui.model.with_untracked(|model| {
                                (model.file_grant.clone(), model.path.clone())
                            });
                            ui.send(Command::Upload { grant, directory });
                        },
                    ))
                    .child(when(
                        move || ui.model.with(|model| model.entries.is_empty()),
                        || hint("此目录为空。"),
                    ))
                    .child(when(
                        move || ui.model.with(|model| model.truncated),
                        || hint("目录条目较多，主机只返回了部分结果。"),
                    ))
                    .child(each(
                        move || {
                            ui.model.with(|model| {
                                model
                                    .entries
                                    .iter()
                                    .map(|entry| (entry.name.clone(), entry.directory, entry.size))
                                    .collect::<Vec<_>>()
                            })
                        },
                        |entry| entry.0.clone(),
                        move |entry, _| {
                            view()
                                .gap_1()
                                .child(
                                    text(move || {
                                        entry.with(|entry| {
                                            if entry.1 {
                                                format!("{} /", entry.0)
                                            } else {
                                                format!("{} · {} 字节", entry.0, entry.2)
                                            }
                                        })
                                    })
                                    .text_sm(),
                                )
                                .child(action(
                                    move || {
                                        if entry.get().1 {
                                            "打开目录"
                                        } else {
                                            "下载并校验"
                                        }
                                    },
                                    false,
                                    move || {
                                        ui.model.with(|model| {
                                            model
                                                .transfer
                                                .as_ref()
                                                .is_some_and(|transfer| transfer.cancellable)
                                        }) && !entry.get().1
                                    },
                                    move || {
                                        let (name, directory, _) = entry.get_untracked();
                                        let (grant, path) = ui.model.with_untracked(|model| {
                                            (model.file_grant.clone(), model.path.clone())
                                        });
                                        match transfers::remote_path(&path, &name) {
                                            Ok(path) => ui.send(if directory {
                                                Command::Request(Operation::FileList {
                                                    grant,
                                                    path,
                                                })
                                            } else {
                                                Command::Download { grant, path, name }
                                            }),
                                            Err(error) => ui.error(error.to_string()),
                                        }
                                    },
                                ))
                        },
                    ))
            },
        ))
        .child(when(
            move || ui.model.with(|model| model.transfer.is_some()),
            move || {
                view()
                    .gap_2()
                    .child(hint(move || {
                        ui.model.with(|model| {
                            model
                                .transfer
                                .as_ref()
                                .map(|transfer| {
                                    format!(
                                        "{} · {} / {} 字节 · {}",
                                        transfer.name,
                                        transfer.offset,
                                        transfer.total,
                                        transfer.status
                                    )
                                })
                                .unwrap_or_default()
                        })
                    }))
                    .child(action(
                        "取消传输",
                        false,
                        move || {
                            ui.model.with(|model| {
                                !model
                                    .transfer
                                    .as_ref()
                                    .is_some_and(|transfer| transfer.cancellable)
                            })
                        },
                        move || ui.send(Command::CancelTransfer),
                    ))
            },
        ))
}
