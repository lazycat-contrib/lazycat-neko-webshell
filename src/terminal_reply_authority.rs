use std::borrow::Cow;
use std::sync::Mutex;

use anyhow::{Context as _, anyhow};

use crate::config::PTY_INPUT_MESSAGE_BYTES;
use crate::restty_headless::ResttyHeadlessTerminal;
use crate::validation::validate_size;

pub struct TerminalReplyAuthority {
    state: Mutex<ReplyAuthorityState>,
}

struct ReplyAuthorityState {
    terminal: ResttyHeadlessTerminal,
    filter: ReplyOnlyInputFilter,
}

#[derive(Default)]
struct ReplyOnlyInputFilter {
    state: ReplyOnlyFilterState,
    kitty_graphics: Vec<u8>,
    kitty_graphics_overflowed: bool,
}

const MAX_KITTY_QUERY_BYTES: usize = 4096;

#[derive(Default)]
enum ReplyOnlyFilterState {
    #[default]
    Normal,
    Escape,
    ApplicationProgramCommand {
        c1: bool,
    },
    KittyGraphics {
        c1: bool,
        escape: bool,
    },
}

impl TerminalReplyAuthority {
    pub fn new(cols: u16, rows: u16) -> anyhow::Result<Self> {
        Ok(Self {
            state: Mutex::new(ReplyAuthorityState {
                terminal: ResttyHeadlessTerminal::new(cols, rows)?,
                filter: ReplyOnlyInputFilter::default(),
            }),
        })
    }

    pub fn process_output<T>(
        &self,
        data: Vec<u8>,
        mut write_reply: impl FnMut(Vec<u8>) -> anyhow::Result<()>,
        publish_output: impl FnOnce(Vec<u8>) -> T,
    ) -> anyhow::Result<T> {
        let replies = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow!("Restty headless terminal lock poisoned"))?;
            let filtered = state.filter.filter(&data);
            state
                .terminal
                .write_output(&filtered)
                .context("failed to parse PTY output with Restty headless")?
        };
        for chunk in replies.chunks(PTY_INPUT_MESSAGE_BYTES) {
            write_reply(chunk.to_vec()).context("failed to write Restty terminal reply")?;
        }
        Ok(publish_output(data))
    }

    pub fn resize_with(
        &self,
        cols: u16,
        rows: u16,
        resize_pty: impl FnOnce() -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        validate_size(cols, rows)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("Restty headless terminal lock poisoned"))?;
        resize_pty()?;
        state.terminal.resize(cols, rows)
    }
}

impl ReplyOnlyInputFilter {
    fn filter<'a>(&mut self, input: &'a [u8]) -> Cow<'a, [u8]> {
        const ESC: u8 = 0x1b;
        const APC: u8 = 0x9f;
        const ST: u8 = 0x9c;

        if matches!(self.state, ReplyOnlyFilterState::Normal)
            && !input.ends_with(&[ESC])
            && !input.contains(&APC)
            && !input.windows(2).any(|bytes| bytes == b"\x1b_")
        {
            return Cow::Borrowed(input);
        }

        let mut output = Vec::with_capacity(input.len());
        let mut index = 0;
        while index < input.len() {
            let byte = input[index];
            match self.state {
                ReplyOnlyFilterState::Normal => match byte {
                    ESC => self.state = ReplyOnlyFilterState::Escape,
                    APC => {
                        self.state = ReplyOnlyFilterState::ApplicationProgramCommand { c1: true };
                    }
                    _ => output.push(byte),
                },
                ReplyOnlyFilterState::Escape => {
                    if byte == b'_' {
                        self.state = ReplyOnlyFilterState::ApplicationProgramCommand { c1: false };
                    } else {
                        output.push(ESC);
                        self.state = ReplyOnlyFilterState::Normal;
                        continue;
                    }
                }
                ReplyOnlyFilterState::ApplicationProgramCommand { c1 } => {
                    if byte == b'G' {
                        self.kitty_graphics.clear();
                        self.kitty_graphics_overflowed = false;
                        if c1 {
                            self.kitty_graphics.extend_from_slice(&[APC, b'G']);
                        } else {
                            self.kitty_graphics.extend_from_slice(b"\x1b_G");
                        }
                        self.state = ReplyOnlyFilterState::KittyGraphics { c1, escape: false };
                    } else {
                        if c1 {
                            output.push(APC);
                        } else {
                            output.extend_from_slice(b"\x1b_");
                        }
                        self.state = ReplyOnlyFilterState::Normal;
                        continue;
                    }
                }
                ReplyOnlyFilterState::KittyGraphics { c1, escape } => {
                    self.capture_kitty_graphics_byte(byte);
                    if byte == ST || (escape && byte == b'\\') {
                        if !self.kitty_graphics_overflowed
                            && kitty_graphics_is_query(&self.kitty_graphics)
                        {
                            if c1 {
                                output.extend_from_slice(b"\x1b_G");
                                let command = &self.kitty_graphics[2..];
                                let command = command
                                    .strip_suffix(&[ST])
                                    .or_else(|| command.strip_suffix(b"\x1b\\"))
                                    .unwrap_or(command);
                                output.extend_from_slice(command);
                                output.extend_from_slice(b"\x1b\\");
                            } else {
                                output.extend_from_slice(&self.kitty_graphics);
                            }
                        }
                        self.kitty_graphics.clear();
                        self.kitty_graphics_overflowed = false;
                        self.state = ReplyOnlyFilterState::Normal;
                    } else {
                        self.state = ReplyOnlyFilterState::KittyGraphics {
                            c1,
                            escape: byte == ESC,
                        };
                    }
                }
            }
            index += 1;
        }
        Cow::Owned(output)
    }

    fn capture_kitty_graphics_byte(&mut self, byte: u8) {
        if self.kitty_graphics_overflowed {
            return;
        }
        if self.kitty_graphics.len() >= MAX_KITTY_QUERY_BYTES {
            self.kitty_graphics.clear();
            self.kitty_graphics_overflowed = true;
            return;
        }
        self.kitty_graphics.push(byte);
    }
}

fn kitty_graphics_is_query(sequence: &[u8]) -> bool {
    const ESC: u8 = 0x1b;
    const APC: u8 = 0x9f;
    const ST: u8 = 0x9c;

    let body = if sequence.starts_with(b"\x1b_G") {
        &sequence[3..]
    } else if sequence.starts_with(&[APC, b'G']) {
        &sequence[2..]
    } else {
        return false;
    };
    let body = if body.ends_with(&[ESC, b'\\']) {
        &body[..body.len() - 2]
    } else if body.ends_with(&[ST]) {
        &body[..body.len() - 1]
    } else {
        return false;
    };
    let control = body
        .iter()
        .position(|byte| *byte == b';')
        .map_or(body, |separator| &body[..separator]);
    let mut query_action = false;
    for field in control.split(|byte| *byte == b',') {
        if !field.starts_with(b"a=") {
            continue;
        }
        if query_action || field != b"a=q" {
            return false;
        }
        query_action = true;
    }
    query_action
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    enum Event {
        Reply(Vec<u8>),
        Output(Vec<u8>),
    }

    #[test]
    fn writes_generated_replies_before_publishing_output() {
        let authority = TerminalReplyAuthority::new(80, 24).expect("create reply authority");
        let events = RefCell::new(Vec::new());

        authority
            .process_output(
                b"\x1b[6n".to_vec(),
                |reply| {
                    events.borrow_mut().push(Event::Reply(reply));
                    Ok(())
                },
                |output| events.borrow_mut().push(Event::Output(output)),
            )
            .expect("process terminal query");

        assert_eq!(
            events.into_inner(),
            vec![
                Event::Reply(b"\x1b[1;1R".to_vec()),
                Event::Output(b"\x1b[6n".to_vec()),
            ]
        );
    }

    #[test]
    fn does_not_duplicate_replies_on_the_next_output_chunk() {
        let authority = TerminalReplyAuthority::new(80, 24).expect("create reply authority");
        let mut replies = Vec::new();
        authority
            .process_output(
                b"\x1b[6n".to_vec(),
                |reply| {
                    replies.push(reply);
                    Ok(())
                },
                drop,
            )
            .expect("process terminal query");
        authority
            .process_output(
                b"prompt".to_vec(),
                |reply| {
                    replies.push(reply);
                    Ok(())
                },
                drop,
            )
            .expect("process normal output");

        assert_eq!(replies, vec![b"\x1b[1;1R".to_vec()]);
    }

    #[test]
    fn strips_split_kitty_payloads_only_from_the_reply_parser() {
        let authority = TerminalReplyAuthority::new(80, 24).expect("create reply authority");
        let first = b"ab\x1b_Gf=24,s=2000,v=2000,m=1;AAAA".to_vec();
        let second = b"BBBB\x1b\\cd\x1b[6n".to_vec();
        let published = RefCell::new(Vec::new());
        let mut replies = Vec::new();

        authority
            .process_output(
                first.clone(),
                |reply| {
                    replies.push(reply);
                    Ok(())
                },
                |output| published.borrow_mut().push(output),
            )
            .expect("process first Kitty chunk");
        authority
            .process_output(
                second.clone(),
                |reply| {
                    replies.push(reply);
                    Ok(())
                },
                |output| published.borrow_mut().push(output),
            )
            .expect("process second Kitty chunk");

        assert_eq!(replies, vec![b"\x1b[1;5R".to_vec()]);
        assert_eq!(published.into_inner(), vec![first, second]);
    }

    #[test]
    fn answers_kitty_graphics_queries_before_publishing_them() {
        let authority = TerminalReplyAuthority::new(80, 24).expect("create reply authority");
        let query = b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\".to_vec();
        let events = RefCell::new(Vec::new());

        authority
            .process_output(
                query.clone(),
                |reply| {
                    events.borrow_mut().push(Event::Reply(reply));
                    Ok(())
                },
                |output| events.borrow_mut().push(Event::Output(output)),
            )
            .expect("process Kitty graphics query");

        assert_eq!(
            events.into_inner(),
            vec![
                Event::Reply(b"\x1b_Gi=31;OK\x1b\\".to_vec()),
                Event::Output(query),
            ]
        );
    }

    #[test]
    fn answers_split_c1_kitty_graphics_queries_once_complete() {
        let authority = TerminalReplyAuthority::new(80, 24).expect("create reply authority");
        let mut replies = Vec::new();

        authority
            .process_output(
                b"\x9fGi=32,s=1,v=1,a=q,t=d,f=24;AA".to_vec(),
                |reply| {
                    replies.push(reply);
                    Ok(())
                },
                drop,
            )
            .expect("process first Kitty query chunk");
        authority
            .process_output(
                b"AA\x9c".to_vec(),
                |reply| {
                    replies.push(reply);
                    Ok(())
                },
                drop,
            )
            .expect("process second Kitty query chunk");

        assert_eq!(replies, vec![b"\x1b_Gi=32;OK\x1b\\".to_vec()]);
    }

    #[test]
    fn strips_oversized_kitty_queries_from_the_headless_parser() {
        let mut filter = ReplyOnlyInputFilter::default();
        let mut query = b"\x1b_Gi=33,a=q;".to_vec();
        query.extend(std::iter::repeat_n(b'A', MAX_KITTY_QUERY_BYTES));
        query.extend_from_slice(b"\x1b\\");

        assert!(filter.filter(&query).is_empty());
    }

    #[test]
    fn strips_kitty_commands_with_conflicting_actions() {
        let mut filter = ReplyOnlyInputFilter::default();
        let command = b"\x1b_Gi=34,a=q,a=T,f=32,s=1,v=1;AAAA\x1b\\";

        assert!(filter.filter(command).is_empty());
    }

    #[test]
    fn preserves_non_kitty_application_program_commands() {
        let mut filter = ReplyOnlyInputFilter::default();
        let command = b"\x1b_X;metadata\x1b\\";

        assert_eq!(filter.filter(command).as_ref(), command);
    }

    #[test]
    fn borrows_normal_output_without_allocating() {
        let mut filter = ReplyOnlyInputFilter::default();
        let output = b"\x1b[2J\x1b[Hregular terminal output";

        assert!(matches!(filter.filter(output), Cow::Borrowed(_)));
    }

    #[test]
    fn applies_resize_before_future_cursor_reports() {
        let authority = TerminalReplyAuthority::new(2, 2).expect("create reply authority");
        authority
            .resize_with(120, 40, || Ok(()))
            .expect("resize authority");
        let mut reply = Vec::new();
        authority
            .process_output(
                b"abc\x1b[6n".to_vec(),
                |chunk| {
                    reply.extend(chunk);
                    Ok(())
                },
                drop,
            )
            .expect("process resized output");

        assert_eq!(reply, b"\x1b[1;4R");
    }
}
