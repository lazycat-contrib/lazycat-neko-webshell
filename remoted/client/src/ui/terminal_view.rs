use super::{
    controls::{action, hint},
    state::Ui,
    terminal_observer,
    terminal_surface::Surface,
};
use crate::controller::{Command, Pane, PaneKind};
use neko_remoted_protocol::messages::Operation;
use nsh_base::{TerminalEvent, terminal, theme};
use nsh_core::prelude::*;

pub fn render(ui: Ui, pane: ReadSignal<Pane>) -> impl IntoElement {
    let more = signal(false);
    let surface = Surface::new();
    let reference = surface.reference;
    provide_context(surface.factory());
    let size = signal((80_u16, 24_u16));
    let writable = computed(move || ui.model.with(|model| model.writable()));
    let controlling = computed(move || {
        pane.with(|pane| pane.controller && !pane.read_only && pane.exit.is_none())
    });
    effect(move || {
        let visible = pane.with(|p| p.stream == ui.active.get())
            && !ui.navigation.settings.get()
            && !ui.navigation.files.get();
        // Herdr owns pane geometry through its layout. Only an active ordinary
        // terminal may change the remote PTY size; hidden layouts can be 1x1.
        if controlling.get()
            && writable.get()
            && visible
            && pane.with(|p| p.kind == PaneKind::Terminal)
        {
            let (cols, rows) = size.get();
            if cols > 1 && rows > 1 {
                ui.send(Command::Request(Operation::TerminalResize {
                    stream: pane.get_untracked().stream,
                    cols,
                    rows,
                }));
            }
        }
    });
    let stream = pane.get_untracked().stream;
    ui.refs.with(|refs| {
        refs.insert(stream.clone(), surface.clone());
    });
    ui.flush(&stream, &surface);
    let can_input = computed(move || controlling.get() && writable.get());
    let observer = surface.buffer.clone();
    view()
        .flex_1()
        .min_h(px(0.0))
        .gap_2()
        .style_when(
            move || pane.with(|pane| pane.stream != ui.active.get()),
            |style| style.hidden(),
        )
        .child(
            view()
                .px_4()
                .flex_row()
                .items_center()
                .gap_2()
                .child(
                    text(move || {
                        pane.with(|pane| {
                            format!(
                                "{} · {}",
                                pane.name,
                                match pane.exit {
                                    Some(code) => format!("已退出（{code}）"),
                                    None if pane.controller => "已取得控制权".into(),
                                    None => "只读浏览".into(),
                                }
                            )
                        })
                    })
                    .text_sm()
                    .flex_1()
                    .min_w(px(0.0))
                    .number_of_lines(1),
                )
                .child(action(
                    move || {
                        if pane.with(|pane| pane.controller) {
                            "释放控制权"
                        } else {
                            "取得控制权"
                        }
                    },
                    false,
                    move || {
                        !ui.model.with(|model| model.writable())
                            || pane.with(|pane| pane.read_only || pane.exit.is_some())
                    },
                    move || {
                        let pane = pane.get_untracked();
                        ui.send(Command::Request(Operation::TerminalControl {
                            stream: pane.stream,
                            take: !pane.controller,
                        }));
                    },
                ))
                .child(action(
                    "更多",
                    false,
                    || false,
                    move || more.update(|open| *open = !*open),
                )),
        )
        .child(when(
            move || pane.with(|pane| pane.gap),
            || {
                view()
                    .px_4()
                    .child(hint("输出存在缺口；当前画面可能不完整。"))
            },
        ))
        .child(when(
            move || more.get(),
            move || {
                view().px_4().child(action(
                    "关闭此窗格连接",
                    false,
                    || false,
                    move || {
                        ui.send(Command::Request(Operation::TerminalDetach {
                            stream: pane.get_untracked().stream,
                        }))
                    },
                ))
            },
        ))
        .child(
            view()
                .flex_1()
                .min_h(px(0.0))
                .overflow_hidden()
                .bg(move || {
                    theme()
                        .color("terminal-background")
                        .unwrap_or(theme().background)
                })
                .child(
                    when(
                        move || can_input.get(),
                        move || {
                            terminal()
                                .component_ref(&reference)
                                .flex_1()
                                .min_h(px(0.0))
                                .accessibility_label("远程终端；取得控制权后可输入")
                                .bg(move || {
                                    theme()
                                        .color("terminal-background")
                                        .unwrap_or(theme().background)
                                })
                                .text_color(move || {
                                    theme()
                                        .color("terminal-foreground")
                                        .unwrap_or(theme().foreground)
                                })
                                .on_data(move |data: &SharedString| {
                                    if ui.model.with_untracked(|model| model.writable())
                                        && pane.with_untracked(|pane| {
                                            pane.controller
                                                && !pane.read_only
                                                && pane.exit.is_none()
                                        })
                                    {
                                        let herdr =
                                            pane.with_untracked(|p| p.kind == PaneKind::Herdr);
                                        for frame in super::terminal_input::frames(data, herdr) {
                                            if !ui.submit(Command::Request(
                                                Operation::TerminalInput {
                                                    stream: pane.get_untracked().stream,
                                                    data: frame,
                                                },
                                            )) {
                                                break;
                                            }
                                        }
                                    }
                                })
                                .on_resize(move |event: &TerminalEvent| {
                                    let TerminalEvent::Resize(cols, rows) = event else {
                                        return;
                                    };
                                    if *cols > 0 && *rows > 0 {
                                        size.set((
                                            (*cols).clamp(1, 1000) as u16,
                                            (*rows).clamp(1, 1000) as u16,
                                        ));
                                    }
                                })
                        },
                    )
                    .otherwise(move || terminal_observer::render(observer.clone(), size)),
                ),
        )
        .child(super::composer::render(ui, pane))
}
