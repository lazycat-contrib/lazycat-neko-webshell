use super::{connection, controls::hint, state::Ui, workspace};
use nsh_base::theme;
use nsh_core::prelude::*;

#[component]
pub(super) fn Body(cx: Scope<NoEvent>) -> impl IntoElement {
    let ui = use_context::<Ui>().expect("App provides the native UI controller context");
    view()
        .flex_1()
        .min_h(px(0.0))
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .pt(move || cx.insets().top)
        .pb(move || cx.insets().bottom.max(keyboard_height()))
        .pl(move || cx.insets().left)
        .pr(move || cx.insets().right)
        .child(
            view()
                .px_4()
                .py_2()
                .gap_2()
                .child(hint(move || {
                    ui.model.with(|model| model.status().to_owned())
                }))
                .child(when(
                    move || ui.model.with(|model| !model.error.is_empty()),
                    move || {
                        text(move || ui.model.with(|model| model.error.clone()))
                            .text_sm()
                            .text_color(move || theme().destructive)
                            .role(AccessibilityRole::Alert)
                    },
                ))
                .child(when(
                    move || ui.model.with(|model| !model.notice.is_empty()),
                    move || hint(move || ui.model.with(|model| model.notice.clone())),
                )),
        )
        .child(when(
            move || !ui.model.with(|model| model.ready()),
            move || connection::render(ui),
        ))
        .child(when(
            move || ui.model.with(|model| model.ready()),
            move || workspace::render(ui),
        ))
}
