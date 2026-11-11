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
                        if !model
                            .panes
                            .iter()
                            .any(|pane| pane.stream == ui.active.get_untracked())
                        {
                            ui.active.set(
                                model
                                    .panes
                                    .last()
                                    .map(|pane| pane.stream.clone())
                                    .unwrap_or_default(),
                            );
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
                                ui.send(Command::Disconnect);
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
                        ui.send(Command::Disconnect);
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
        Self {
            model: signal_with(model, SignalEquals::Never),
            active: signal(active),
            client: stored(client),
            refs: stored(HashMap::new()),
            pending: stored(HashMap::new()),
        }
    }

    pub fn send(self, command: Command) {
        if let Err(error) = self.client.with(|client| client.send(command)) {
            self.error(error.to_string());
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
