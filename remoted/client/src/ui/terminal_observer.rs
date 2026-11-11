use super::{terminal_colors::colors, terminal_surface::Buffer};
use nsh_base::{TerminalRun, TerminalSize, theme};
use nsh_core::prelude::*;
use unicode_width::UnicodeWidthChar;

pub fn render(buffer: Buffer, size: Signal<(u16, u16)>) -> impl IntoElement {
    let family = move || {
        theme()
            .font_mono
            .clone()
            .unwrap_or_else(|| "monospace".into())
    };
    let cell_width = computed(move || {
        let family = family();
        let css = if matches!(family.as_ref(), "monospace" | "ui-monospace") {
            format!("13px {family}")
        } else {
            format!("13px \"{}\"", family.replace('"', ""))
        };
        measure_text(&css, "0000000000") / 10.0
    });
    let count = buffer.clone();
    let rows = buffer.clone();
    virtual_list(
        move || count.line_count(),
        move |position| row(rows.clone(), position, cell_width),
    )
    .test_id("terminal-observer")
    .label("远程终端输出（只读，可选择和复制）")
    .alignment(ListAlignment::Bottom)
    .estimated_item_size(px(18.0))
    .selectable(true)
    .flex_1()
    .min_h(px(0.0))
    .overflow_hidden()
    .font_family(family)
    .text_size(px(13.0))
    .text_color(move || theme().foreground)
    .on_layout(move |bounds: &Bounds<Points>| {
        let width = cell_width.get_untracked().0;
        if width > 0.0 && bounds.size.width.0 > 0.0 && bounds.size.height.0 > 0.0 {
            let cols = (bounds.size.width.0 / width).floor().clamp(1.0, 1000.0) as u16;
            let rows = (bounds.size.height.0 / 18.0).floor().clamp(1.0, 1000.0) as u16;
            buffer.resize(TerminalSize::new(cols, rows));
            size.set((cols, rows));
        }
    })
}

fn row(buffer: Buffer, position: Position, width: Memo<Points>) -> impl IntoElement {
    let lines = buffer.clone();
    let line = computed(move || lines.line(position.index()));
    let backgrounds = line;
    let cursor = computed(move || {
        let cursor = buffer.cursor()?;
        let first = buffer
            .line_count()
            .saturating_sub(buffer.size.get().rows as usize);
        (position.index() == first + cursor.row as usize).then_some(cursor.col)
    });
    view()
        .h(px(18.0))
        .justify_center()
        .child(dynamic(move || {
            let mut column = 0;
            let mut fills = Vec::new();
            for run in backgrounds.get().runs {
                let cells: usize = run
                    .text
                    .chars()
                    .map(|character| character.width().unwrap_or(0))
                    .sum();
                if let (_, Some(background)) = colors(run.style) {
                    fills.push(
                        view()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left(Length::from(width.get() * column as f32))
                            .w(Length::from(width.get() * cells as f32))
                            .bg(background)
                            .into_element(),
                    );
                }
                column += cells;
            }
            view()
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .right_0()
                .pointer_events(PointerEvents::None)
                .children(fills)
        }))
        .child(dynamic(move || {
            text("").select_text().children(
                line.get()
                    .runs
                    .into_iter()
                    .map(run_view)
                    .collect::<Vec<_>>(),
            )
        }))
        .child(when(
            move || cursor.get().is_some(),
            move || {
                view()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(move || Length::from(width.get() * cursor.get().unwrap_or(0) as f32))
                    .w(move || Length::from(width.get()))
                    .bg(move || theme().foreground)
                    .opacity(0.25)
                    .pointer_events(PointerEvents::None)
            },
        ))
}

fn run_view(run: TerminalRun) -> AnyElement {
    let style = run.style;
    let mut span = text(run.text);
    if let (Some(foreground), _) = colors(style) {
        span = span.text_color(foreground);
    }
    if style.bold {
        span = span.font_weight(FontWeight::BOLD);
    }
    if style.italic {
        span = span.italic();
    }
    if style.underline {
        span = span.underline();
    }
    if style.strikethrough {
        span = span.line_through();
    }
    if style.dim || style.hidden {
        span = span.opacity(if style.hidden { 0.0 } else { 0.6 });
    }
    span.into_element()
}
