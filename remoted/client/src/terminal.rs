//! Rendering is never a second PTY reply authority, including during replay.
use nsh_base::{TerminalEmulator,TerminalEmulatorEvent,TerminalEmulatorFactory,TerminalSize,TerminalLine,TerminalCursor,TerminalModes,VtEmulator};
struct Observer(VtEmulator);
impl TerminalEmulator for Observer {
    fn feed(&mut self,b:&[u8]){self.0.feed(b)}
    fn resize(&mut self,s:TerminalSize){self.0.resize(s)}
    fn line_count(&self)->usize{self.0.line_count()}
    fn line(&self,i:usize)->TerminalLine{self.0.line(i)}
    fn cursor(&self)->Option<TerminalCursor>{self.0.cursor()}
    fn modes(&self)->TerminalModes{self.0.modes()}
    fn take_events(&mut self)->Vec<TerminalEmulatorEvent>{self.0.take_events().into_iter().filter(|e|!matches!(e,TerminalEmulatorEvent::Reply(_))).collect()}
}
pub fn factory()->TerminalEmulatorFactory{TerminalEmulatorFactory::new(|size,scrollback|Box::new(Observer(VtEmulator::new(size,scrollback))))}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn renderer_never_replies_to_queries_including_replay(){let mut v=Observer(VtEmulator::new(TerminalSize::new(80,24),100));v.feed(b"\x1b[5n\x1b[6n\x1b[c\x1b]0;title\x07");let e=v.take_events();assert!(!e.iter().any(|e|matches!(e,TerminalEmulatorEvent::Reply(_))));assert!(e.iter().any(|e|matches!(e,TerminalEmulatorEvent::Title(t)if t=="title")));}
}
