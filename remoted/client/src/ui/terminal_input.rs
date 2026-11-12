//! Bound wire frames without splitting a UTF-8 character or a Herdr paste wrapper.
use neko_remoted_protocol::encode;

const LIMIT: usize = 16 * 1024;
const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

pub fn frames(data: &str, herdr: bool) -> impl Iterator<Item = String> + '_ {
    let paste = herdr
        .then(|| data.strip_prefix(PASTE_START)?.strip_suffix(PASTE_END))
        .flatten();
    let mut remaining = paste.unwrap_or(data);
    let limit = LIMIT
        - if paste.is_some() {
            PASTE_START.len() + PASTE_END.len()
        } else {
            0
        };
    std::iter::from_fn(move || {
        if remaining.is_empty() {
            return None;
        }
        let mut end = remaining.len().min(limit);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, tail) = remaining.split_at(end);
        remaining = tail;
        Some(if paste.is_some() {
            encode(format!("{PASTE_START}{chunk}{PASTE_END}").as_bytes())
        } else {
            encode(chunk.as_bytes())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use neko_remoted_protocol::decode;

    #[test]
    fn large_unicode_input_remains_valid_utf8_in_every_frame() {
        let input = format!("{}猫🙂", "a".repeat(LIMIT - 1));
        let decoded: Vec<_> = frames(&input, true)
            .map(|data| {
                let bytes = decode(&data, LIMIT).unwrap();
                assert!(bytes.len() <= LIMIT);
                String::from_utf8(bytes).unwrap()
            })
            .collect();
        assert_eq!(decoded.concat(), input);
        assert_eq!(decoded.len(), 2);
    }

    #[test]
    fn large_herdr_paste_retains_each_wrapper_and_its_literal_trailing_newline() {
        let body = format!("{}\n", "你好🙂".repeat(4000));
        let input = format!("{PASTE_START}{body}{PASTE_END}");
        let chunks: Vec<_> = frames(&input, true)
            .map(|data| {
                let bytes = decode(&data, LIMIT).unwrap();
                assert!(bytes.len() <= LIMIT);
                let text = String::from_utf8(bytes).unwrap();
                text.strip_prefix(PASTE_START)
                    .unwrap()
                    .strip_suffix(PASTE_END)
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(chunks.concat(), body);
        let ordinary: Vec<_> = frames(&input, false)
            .flat_map(|data| decode(&data, LIMIT).unwrap())
            .collect();
        assert_eq!(ordinary, input.as_bytes());
    }
}
