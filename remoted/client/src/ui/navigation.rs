//! Shared navigation state. Transport state stays in the controller.
use nsh_core::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Herdr,
    Terminal,
}

#[derive(Clone, Copy)]
pub struct Navigation {
    pub section: Signal<Section>,
    pub drawer: Signal<bool>,
    pub settings: Signal<bool>,
    pub files: Signal<bool>,
}

impl Navigation {
    pub fn new(setup: bool) -> Self {
        Self {
            section: signal(Section::Herdr),
            drawer: signal(false),
            settings: signal(setup),
            files: signal(false),
        }
    }

    pub fn show_session(self) {
        self.drawer.set(false);
        self.settings.set(false);
        self.files.set(false);
    }
}

pub fn wide() -> bool {
    window().width.0 >= 760.0
}
