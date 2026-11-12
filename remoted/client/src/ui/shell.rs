use super::{navigation, sidebar, state::Ui, workspace};
use nsh_base::{SheetEvent, sheet, theme};
use nsh_core::prelude::*;

#[component]
pub(super) fn Body(cx: Scope<NoEvent>) -> impl IntoElement {
    let ui = use_context::<Ui>().expect("App provides the native UI controller context");
    // Only a first-run client starts in setup. Saved devices stay in the session workflow.
    let initialized = signal(false);
    effect(move || {
        if !initialized.get_untracked()
            && ui
                .model
                .with(|m| m.relay.is_some() || !m.bindings.is_empty())
        {
            initialized.set(true);
            ui.navigation
                .settings
                .set(ui.model.with_untracked(|m| m.bindings.is_empty()));
        }
    });
    effect(move || {
        if navigation::wide() {
            ui.navigation.drawer.set(false);
        }
    });
    let was_ready = signal(ui.model.with_untracked(|m| m.ready()));
    effect(move || {
        let ready = ui.model.with(|m| m.ready());
        if ready && !was_ready.get_untracked() {
            ui.navigation.settings.set(false);
        }
        was_ready.set(ready);
    });
    view()
        .flex_1()
        .min_h(px(0.0))
        .flex_row()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .pt(move || cx.insets().top)
        .pb(move || cx.insets().bottom.max(keyboard_height()))
        .pl(move || cx.insets().left)
        .pr(move || cx.insets().right)
        .child(when(navigation::wide, move || {
            view()
                .w(px(280.0))
                .border_r_1()
                .border_color(move || theme().border)
                .child(sidebar::render(ui))
        }))
        .child(workspace::render(ui))
        .child(
            sheet()
                .open(move || ui.navigation.drawer.get())
                .side(Placement::Left)
                .on_open_change(move |event: &SheetEvent| {
                    if let SheetEvent::OpenChange(open, _) = event {
                        ui.navigation.drawer.set(*open);
                    }
                })
                .popup_style(|s| {
                    s.w(move || px((window().width.0 - 48.0).min(320.0)))
                        .bg(move || theme().card)
                })
                .backdrop_style(|s| {
                    s.bg(move || {
                        theme()
                            .color("overlay")
                            .unwrap_or(theme().foreground)
                            .opacity(0.4)
                    })
                })
                .child(sidebar::render(ui)),
        )
}
