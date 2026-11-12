use super::terminal_surface::Surface;
use crate::controller::{self, Client, Command, Model, Update};
use nsh_core::prelude::*;
use std::collections::{HashMap, VecDeque};

pub struct Chunk {
    pub text: String,
    pub reset: bool,
}

#[derive(Clone, Copy)]
pub struct Ui {
    pub model: Signal<Model>,
    pub active: Signal<String>,
    pub navigation: super::navigation::Navigation,
    client: Stored<Client>,
    pub refs: Stored<HashMap<String, Surface>>,
    pub pending: Stored<HashMap<String, VecDeque<Chunk>>>,
}

impl Ui {
    pub fn start() -> Self {
        let (client, mut receiver) = controller::start();
        let ui = Self::new(Model::default(), client);
        spawn(async move {
            while let Some(update) = receiver.recv().await {
                match update {
                    Update::Model(model) => {
                        let newly_attached = model.panes.iter().rev().find(|pane| {
                            !ui.model.with_untracked(|previous| {
                                previous.panes.iter().any(|old| old.stream == pane.stream)
                            })
                        });
                        if let Some(pane) = newly_attached {
                            ui.navigation.section.set(match pane.kind {
                                controller::PaneKind::Herdr => super::navigation::Section::Herdr,
                                controller::PaneKind::Terminal => {
                                    super::navigation::Section::Terminal
                                }
                            });
                            ui.active.set(pane.stream.clone());
                            ui.navigation.show_session();
                        } else if !ui.active.get_untracked().is_empty()
                            && !model
                                .panes
                                .iter()
                                .any(|pane| pane.stream == ui.active.get_untracked())
                        {
                            ui.active.set(String::new());
                        }
                        ui.refs.with(|refs| {
                            refs.retain(|stream, _| {
                                model.panes.iter().any(|pane| &pane.stream == stream)
                            })
                        });
                        ui.pending.with(|pending| {
                            pending.retain(|stream, _| {
                                model.panes.iter().any(|pane| &pane.stream == stream)
                            })
                        });
                        ui.model.set(*model);
                    }
                    Update::Output {
                        stream,
                        text,
                        reset,
                    } => {
                        let api = ui.refs.with(|refs| refs.get(&stream).cloned());
                        if let Some(api) = api {
                            ui.flush(&stream, &api);
                            if reset {
                                api.reset();
                            }
                            api.write(text);
                        } else {
                            let exceeded = ui.pending.with(|pending| {
                                let queue = pending.entry(stream).or_default();
                                if reset {
                                    queue.clear();
                                }
                                let count: usize = queue.iter().map(|chunk| chunk.text.len()).sum();
                                if count + text.len() > 1024 * 1024 || queue.len() >= 256 {
                                    return true;
                                }
                                queue.push_back(Chunk { text, reset });
                                false
                            });
                            if exceeded {
                                ui.send(Command::Suspend);
                                ui.error("终端显示缓冲已满，已断开以保留输出顺序".into());
                            }
                        }
                    }
                }
            }
        });
        spawn(async move {
            loop {
                timer(std::time::Duration::from_millis(250)).await;
                for event in crate::platform::drain_events() {
                    if event["lifecycle"] == "destroyed" {
                        ui.send(Command::Suspend);
                    }
                }
            }
        });
        ui
    }

    pub(super) fn new(model: Model, client: Client) -> Self {
        let active = model
            .panes
            .last()
            .map(|pane| pane.stream.clone())
            .unwrap_or_default();
        let navigation =
            super::navigation::Navigation::new(!model.ready() && model.bindings.is_empty());
        if let Some(pane) = model.panes.last() {
            navigation.section.set(match pane.kind {
                controller::PaneKind::Herdr => super::navigation::Section::Herdr,
                controller::PaneKind::Terminal => super::navigation::Section::Terminal,
            });
        }
        Self {
            model: signal_with(model, SignalEquals::Never),
            active: signal(active),
            navigation,
            client: stored(client),
            refs: stored(HashMap::new()),
            pending: stored(HashMap::new()),
        }
    }

    pub fn back(self) {
        if self.navigation.drawer.get_untracked() {
            self.navigation.drawer.set(false);
        } else if self.navigation.files.get_untracked() {
            self.navigation.files.set(false);
        } else if self.navigation.settings.get_untracked() {
            self.navigation.settings.set(false);
        } else {
            self.active.set(String::new());
        }
    }

    pub fn secondary(self) -> bool {
        self.navigation.drawer.get()
            || self.navigation.files.get()
            || self.navigation.settings.get()
            || !self.active.get().is_empty()
    }

    /// Explicit app-level intent, including when a connection transition has
    /// advanced before its next model update reaches the UI.
    pub fn disconnect(self) -> bool {
        match self.client.with(|client| client.send(Command::Disconnect)) {
            Ok(()) => true,
            Err(error) => {
                self.error(error.to_string());
                false
            }
        }
    }

    pub fn send(self, command: Command) {
        self.submit(command);
    }

    pub fn submit(self, command: Command) -> bool {
        match self
            .client
            .with(|client| client.send_for(self.model.with_untracked(|m| m.generation), command))
        {
            Ok(()) => true,
            Err(error) => {
                self.error(error.to_string());
                false
            }
        }
    }

    pub fn error(self, message: String) {
        self.model.update(|model| model.error = message);
    }

    pub fn flush(self, stream: &str, api: &Surface) {
        if let Some(queue) = self.pending.with(|pending| pending.remove(stream)) {
            for chunk in queue {
                if chunk.reset {
                    api.reset();
                }
                api.write(chunk.text);
            }
        }
    }
}
