//! Copy for the explicit public Relay draft shortcut.
use nsh_core::platform::Locale;

pub(super) const ORIGIN: &str = "https://neko-relay.czyt.eu.org";

pub(super) fn label(locale: Locale) -> &'static str {
    if locale.language() == "en" {
        "Use public relay"
    } else {
        "使用公共中转"
    }
}

pub(super) fn hint(locale: Locale) -> &'static str {
    if locale.language() == "en" {
        "https://neko-relay.czyt.eu.org · Fills the address only. Connect and pair explicitly."
    } else {
        "https://neko-relay.czyt.eu.org · 仅填入地址，连接和配对仍需手动确认。"
    }
}
