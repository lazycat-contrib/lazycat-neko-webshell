use crate::{Error, MAX_CIPHERTEXT, MAX_PLAINTEXT, RelayAddress, decode32};
use snow::{Builder, HandshakeState, TransportState};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct Identity {
    private: [u8; 32],
    public: [u8; 32],
}
impl Identity {
    pub fn generate() -> Result<Self, Error> {
        let k = Builder::new("Noise_IK_25519_ChaChaPoly_BLAKE2s".parse()?).generate_keypair()?;
        Ok(Self {
            private: k.private.try_into().map_err(|_| Error::Handshake)?,
            public: k.public.try_into().map_err(|_| Error::Handshake)?,
        })
    }
    /// Restore only from the platform's protected credential store.
    pub fn restore(private: [u8; 32], public: [u8; 32]) -> Self {
        Self { private, public }
    }
    pub fn public(&self) -> &[u8; 32] {
        &self.public
    }
    pub fn protected_export(&self) -> (&[u8; 32], &[u8; 32]) {
        (&self.private, &self.public)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Pair,
    Connect,
}
impl Mode {
    fn suite(self) -> &'static str {
        match self {
            Self::Pair => "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s",
            Self::Connect => "Noise_IK_25519_ChaChaPoly_BLAKE2s",
        }
    }
}

/// Handshake messages have no application payload. Approval is a separate state machine.
pub struct Handshake(HandshakeState);
impl Handshake {
    pub fn new(
        id: &Identity,
        relay: &RelayAddress,
        route: &str,
        mode: Mode,
        initiator: bool,
        psk: Option<&[u8; 32]>,
        remote: Option<&[u8; 32]>,
    ) -> Result<Self, Error> {
        decode32(route)?;
        let prologue =
            serde_json::to_vec(&("neko-remoted", crate::VERSION, mode, route, relay.digest()))?;
        let mut b = Builder::new(mode.suite().parse()?)
            .local_private_key(&id.private)?
            .prologue(&prologue)?;
        match mode {
            Mode::Pair => {
                b = b.psk(3, psk.ok_or(Error::Handshake)?)?;
                if remote.is_some() {
                    return Err(Error::Handshake);
                }
            }
            Mode::Connect => {
                if psk.is_some() {
                    return Err(Error::Handshake);
                }
                if initiator {
                    b = b.remote_public_key(remote.ok_or(Error::Handshake)?)?;
                }
            }
        }
        Ok(Self(if initiator {
            b.build_initiator()?
        } else {
            b.build_responder()?
        }))
    }
    pub fn write(&mut self) -> Result<Vec<u8>, Error> {
        let mut b = vec![0; 256];
        let n = self.0.write_message(&[], &mut b)?;
        b.truncate(n);
        Ok(b)
    }
    pub fn read(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if bytes.len() > 256 {
            return Err(Error::Limit);
        }
        let mut empty = [0; 256];
        if self.0.read_message(bytes, &mut empty)? != 0 {
            return Err(Error::Handshake);
        }
        Ok(())
    }
    pub fn finished(&self) -> bool {
        self.0.is_handshake_finished()
    }
    pub fn into_channel(self) -> Result<(Channel, [u8; 32]), Error> {
        if !self.finished() {
            return Err(Error::Handshake);
        }
        let remote = self
            .0
            .get_remote_static()
            .ok_or(Error::Handshake)?
            .try_into()
            .map_err(|_| Error::Handshake)?;
        Ok((Channel(Some(self.0.into_transport_mode()?)), remote))
    }
}
pub struct Channel(Option<TransportState>);
impl Channel {
    /// Permanently invalidate both directions after a transport failure.
    pub fn close(&mut self) {
        self.0 = None;
    }
    pub fn encrypt(&mut self, plain: &[u8]) -> Result<Vec<u8>, Error> {
        if plain.len() > MAX_PLAINTEXT {
            return Err(Error::Limit);
        }
        let mut b = vec![0; plain.len() + 16];
        let mut state = self.0.take().ok_or(Error::Handshake)?;
        let n = state.write_message(plain, &mut b)?;
        self.0 = Some(state);
        b.truncate(n);
        Ok(b)
    }
    pub fn decrypt(&mut self, cipher: &[u8]) -> Result<Vec<u8>, Error> {
        // Take the state before validation: any malformed or unauthenticated record
        // permanently closes this channel, including the transmit direction.
        let mut state = self.0.take().ok_or(Error::Handshake)?;
        if cipher.len() > MAX_CIPHERTEXT || cipher.len() < 16 {
            return Err(Error::Limit);
        }
        let mut b = vec![0; cipher.len()];
        let n = state.read_message(cipher, &mut b)?;
        b.truncate(n);
        self.0 = Some(state);
        Ok(b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn paired(mode: Mode, wrong_psk: bool) -> Result<(Channel, Channel), Error> {
        let a = Identity::generate()?;
        let b = Identity::generate()?;
        let relay = RelayAddress::parse("https://relay.example")?;
        let route = crate::route(&crate::random32()?);
        let psk = crate::random32()?;
        let wrong = crate::random32()?;
        let pair = mode == Mode::Pair;
        let mut x = Handshake::new(
            &a,
            &relay,
            &route,
            mode,
            true,
            pair.then_some(&psk),
            (!pair).then_some(b.public()),
        )?;
        let mut y = Handshake::new(
            &b,
            &relay,
            &route,
            mode,
            false,
            pair.then_some(if wrong_psk { &wrong } else { &psk }),
            None,
        )?;
        y.read(&x.write()?)?;
        x.read(&y.write()?)?;
        if pair {
            y.read(&x.write()?)?;
        }
        let (x, key_b) = x.into_channel()?;
        let (y, key_a) = y.into_channel()?;
        assert_eq!(&key_b, b.public());
        assert_eq!(&key_a, a.public());
        Ok((x, y))
    }
    #[test]
    fn both_modes_interoperate_and_reject_replay() {
        for mode in [Mode::Pair, Mode::Connect] {
            let (mut a, mut b) = paired(mode, false).unwrap();
            let cipher = a.encrypt(b"terminal bytes").unwrap();
            assert_eq!(b.decrypt(&cipher).unwrap(), b"terminal bytes");
            let reply = b.encrypt(b"file ACK").unwrap();
            assert_eq!(a.decrypt(&reply).unwrap(), b"file ACK");
            assert!(b.decrypt(&cipher).is_err());
            assert!(b.encrypt(b"must stay closed").is_err());
            assert!(b.decrypt(&a.encrypt(b"next record").unwrap()).is_err());
        }
    }
    #[test]
    fn wrong_psk_and_tampering_fail_closed() {
        assert!(paired(Mode::Pair, true).is_err());
        let (mut a, mut b) = paired(Mode::Connect, false).unwrap();
        let mut cipher = a.encrypt(b"command").unwrap();
        cipher[0] ^= 1;
        assert!(b.decrypt(&cipher).is_err());
    }
    #[test]
    fn wrong_host_key_is_rejected() {
        let a = Identity::generate().unwrap();
        let b = Identity::generate().unwrap();
        let wrong = Identity::generate().unwrap();
        let relay = RelayAddress::parse("https://relay.example").unwrap();
        let route = crate::route(&crate::random32().unwrap());
        let mut x = Handshake::new(
            &a,
            &relay,
            &route,
            Mode::Connect,
            true,
            None,
            Some(wrong.public()),
        )
        .unwrap();
        let mut y = Handshake::new(&b, &relay, &route, Mode::Connect, false, None, None).unwrap();
        assert!(y.read(&x.write().unwrap()).is_err());
    }
}
