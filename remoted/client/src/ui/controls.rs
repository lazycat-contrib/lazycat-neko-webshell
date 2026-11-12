use nsh_base::{button, input, theme};
use nsh_core::{platform::Os, prelude::*};

pub fn action(
    label: impl IntoReactive<SharedString>,
    primary: bool,
    disabled: impl Fn() -> bool + 'static,
    run: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .on_press(run)
        .min_h(move || px(if os() == Os::Android { 48.0 } else { 32.0 }))
        .px_4()
        .py_2()
        .items_center()
        .justify_center()
        .rounded(move || theme().radius)
        .bg(move || {
            if primary {
                theme().primary
            } else {
                theme().secondary
            }
        })
        .focus(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .active(|s| s.opacity(0.75))
        .disabled_style(|s| s.opacity(0.45))
        .child(text(label).text_sm().text_color(move || {
            if primary {
                theme().primary_foreground
            } else {
                theme().secondary_foreground
            }
        }))
}
pub fn field(
    value: Signal<String>,
    label: &'static str,
    placeholder: &'static str,
) -> impl IntoElement {
    field_with_edit(value, label, placeholder, || {})
}

pub fn field_with_edit(
    value: Signal<String>,
    label: &'static str,
    placeholder: &'static str,
    on_edit: impl Fn() + 'static,
) -> impl IntoElement {
    view().gap_1().child(text(label).text_sm()).child(
        input()
            .label(label)
            .value(move || value.get())
            .on_change(move |v: &str| {
                value.set(v.into());
                on_edit();
            })
            .placeholder(placeholder)
            .placeholder_color(move || color(theme().muted_foreground))
            .caret_color(move || color(theme().primary))
            .selection_color(move || color(theme().accent))
            .min_h(move || px(if os() == Os::Android { 48.0 } else { 32.0 }))
            .px_3()
            .py_2()
            .border_1()
            .border_color(move || theme().input)
            .rounded(move || theme().radius)
            .bg(move || theme().card)
            .text_color(move || theme().foreground)
            .focus(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
            .w_full(),
    )
}
pub fn hint(value: impl IntoReactive<SharedString>) -> impl IntoElement {
    text(value)
        .text_sm()
        .text_color(move || theme().muted_foreground)
}
pub fn heading(value: &'static str) -> impl IntoElement {
    text(value)
        .text_base()
        .font_weight(FontWeight::SEMIBOLD)
        .role(AccessibilityRole::Header)
}

pub fn tab(
    label: impl IntoReactive<SharedString>,
    selected: impl Fn() -> bool + 'static,
    run: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .selected(selected)
        .on_press(run)
        .min_h(move || px(if os() == Os::Android { 48.0 } else { 32.0 }))
        .px_4()
        .py_2()
        .rounded(move || theme().radius)
        .bg(move || theme().secondary)
        .selected_style(|style| style.bg(move || theme().accent))
        .focus(|style| style.outline(px(2.0)).outline_color(move || theme().ring))
        .hover(|style| style.opacity(0.9))
        .active(|style| style.opacity(0.75))
        .child(
            text(label)
                .text_sm()
                .text_color(move || theme().secondary_foreground),
        )
}

/// A list row, rather than a full-width form action. Shared by devices and sessions.
pub fn navigation_row(
    title: impl IntoReactive<SharedString>,
    detail: impl IntoReactive<SharedString>,
    selected: impl Fn() -> bool + 'static,
    run: impl Fn() + 'static,
) -> impl IntoElement {
    navigation_row_disabled(title, detail, selected, || false, run)
}

pub fn navigation_row_disabled(
    title: impl IntoReactive<SharedString>,
    detail: impl IntoReactive<SharedString>,
    selected: impl Fn() -> bool + 'static,
    disabled: impl Fn() -> bool + 'static,
    run: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .selected(selected)
        .disabled(disabled)
        .disabled_style(|s| s.opacity(0.55))
        .on_press(run)
        .min_h(px(56.0))
        .px_3()
        .py_2()
        .gap_1()
        .rounded(move || theme().radius)
        .bg(move || theme().background.opacity(0.0))
        .selected_style(|s| s.bg(move || theme().accent))
        .hover(|s| s.bg(move || theme().secondary))
        .active(|s| s.opacity(0.75))
        .focus(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .child(
            text(title)
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .number_of_lines(1),
        )
        .child(
            text(detail)
                .text_xs()
                .text_color(move || theme().muted_foreground)
                .number_of_lines(1),
        )
}
