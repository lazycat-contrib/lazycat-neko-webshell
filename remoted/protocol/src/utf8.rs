//! Convert terminal bytes without corrupting a UTF-8 character split across frames.
#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut at = 0;
        while at < self.pending.len() {
            match std::str::from_utf8(&self.pending[at..]) {
                Ok(s) => {
                    out.push_str(s);
                    at = self.pending.len();
                }
                Err(e) => {
                    let valid = at + e.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&self.pending[at..valid]).expect("validated prefix"),
                    );
                    at = valid;
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            at += n;
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..at);
        out
    }
    pub fn finish(&mut self) -> String {
        let s = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        s
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_utf8_boundary() {
        let s = "小橘终端 🐈\x1b[32mhello\x1b[0m";
        for i in 0..=s.len() {
            let mut d = Decoder::default();
            assert_eq!(
                d.push(&s.as_bytes()[..i]) + &d.push(&s.as_bytes()[i..]) + &d.finish(),
                s
            );
        }
    }
    #[test]
    fn invalid_is_replaced_and_pending_bounded() {
        let mut d = Decoder::default();
        assert_eq!(d.push(&[255, b'a', 0xf0]), "�a");
        assert_eq!(d.pending.len(), 1);
        assert_eq!(d.finish(), "�");
    }
}
