use nsh_base::{TerminalColor, TerminalStyle, theme};
use nsh_core::prelude::*;

const ANSI: [u32; 16] = [
    0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666,
    0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

fn resolve(value: TerminalColor) -> AdaptiveColor {
    let rgb = match value {
        TerminalColor::Rgb(red, green, blue) => {
            (red as u32) << 16 | (green as u32) << 8 | blue as u32
        }
        TerminalColor::Indexed(index) => match index {
            0..=15 => ANSI[index as usize],
            16..=231 => {
                let index = index - 16;
                let level = |value: u8| {
                    if value == 0 {
                        0
                    } else {
                        55 + value as u32 * 40
                    }
                };
                level(index / 36) << 16 | level(index / 6 % 6) << 8 | level(index % 6)
            }
            _ => {
                let level = 8 + (index - 232) as u32 * 10;
                level << 16 | level << 8 | level
            }
        },
    };
    AdaptiveColor::from(nsh_core::color::Hsla::from(nsh_core::color::rgb(rgb)))
}

pub fn colors(style: TerminalStyle) -> (Option<AdaptiveColor>, Option<AdaptiveColor>) {
    let foreground = style.fg.map(resolve);
    let background = style.bg.map(resolve);
    if style.inverse {
        (
            Some(background.unwrap_or(theme().background)),
            Some(foreground.unwrap_or(theme().foreground)),
        )
    } else {
        (foreground, background)
    }
}
