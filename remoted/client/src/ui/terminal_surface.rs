use nsh_base::{
    Terminal, TerminalApi, TerminalCursor, TerminalEmulator, TerminalEmulatorEvent,
    TerminalEmulatorFactory, TerminalLine, TerminalModes, TerminalSize, VtEmulator,
};
use nsh_core::prelude::*;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone)]
pub struct Buffer {
    emulator: Rc<RefCell<VtEmulator>>,
    pub revision: Signal<u64>,
    pub size: Signal<TerminalSize>,
}

impl Buffer {
    fn new() -> Self {
        Self {
            emulator: Rc::new(RefCell::new(VtEmulator::new(TerminalSize::default(), 1000))),
            revision: signal(0),
            size: signal(TerminalSize::default()),
        }
    }
    fn feed(&self, data: &[u8]) {
        self.emulator.borrow_mut().feed(data);
        self.revision
            .update(|revision| *revision = revision.wrapping_add(1));
    }
    pub fn resize(&self, size: TerminalSize) {
        if self.size.get_untracked() != size {
            self.emulator.borrow_mut().resize(size);
            self.size.set(size);
            self.revision
                .update(|revision| *revision = revision.wrapping_add(1));
        }
    }
    pub fn line_count(&self) -> usize {
        self.revision.get();
        self.emulator.borrow().line_count()
    }
    pub fn line(&self, index: usize) -> TerminalLine {
        self.revision.get();
        self.emulator.borrow().line(index)
    }
    pub fn cursor(&self) -> Option<TerminalCursor> {
        self.revision.get();
        self.emulator.borrow().cursor()
    }
    #[cfg(test)]
    pub fn modes(&self) -> TerminalModes {
        self.emulator.borrow().modes()
    }
    fn events(&self) -> Vec<TerminalEmulatorEvent> {
        self.emulator
            .borrow_mut()
            .take_events()
            .into_iter()
            .filter(|event| !matches!(event, TerminalEmulatorEvent::Reply(_)))
            .collect()
    }
    #[cfg(test)]
    pub fn text(&self) -> String {
        (0..self.line_count())
            .map(|index| self.line(index).text().trim_end().to_owned())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

struct SharedEmulator {
    buffer: Buffer,
    viewport: TerminalSize,
}
impl TerminalEmulator for SharedEmulator {
    fn feed(&mut self, data: &[u8]) {
        self.buffer.feed(data);
    }
    fn resize(&mut self, size: TerminalSize) {
        self.viewport = size;
        self.buffer.resize(size);
    }
    fn line_count(&self) -> usize {
        self.buffer.line_count().max(self.viewport.rows as usize)
    }
    fn line(&self, index: usize) -> TerminalLine {
        self.buffer.line(index)
    }
    fn cursor(&self) -> Option<TerminalCursor> {
        (self.viewport == self.buffer.size.get_untracked())
            .then(|| self.buffer.cursor())
            .flatten()
    }
    fn modes(&self) -> TerminalModes {
        self.buffer.emulator.borrow().modes()
    }
    fn take_events(&mut self) -> Vec<TerminalEmulatorEvent> {
        self.buffer.events()
    }
}

#[derive(Clone)]
pub struct Surface {
    pub reference: ComponentRef<Terminal>,
    pub buffer: Buffer,
}
impl Surface {
    pub fn new() -> Self {
        Self {
            reference: component_ref::<Terminal>(),
            buffer: Buffer::new(),
        }
    }
    pub fn factory(&self) -> TerminalEmulatorFactory {
        let buffer = self.buffer.clone();
        TerminalEmulatorFactory::new(move |size, _| {
            Box::new(SharedEmulator {
                buffer: buffer.clone(),
                viewport: size,
            })
        })
    }
    pub fn write(&self, text: String) {
        if let Some(api) = self.reference.api::<TerminalApi>() {
            api.write(text);
        } else {
            self.buffer.feed(text.as_bytes());
            self.buffer.events();
        }
    }
    pub fn reset(&self) {
        self.write("\x1bc".into());
    }
}
