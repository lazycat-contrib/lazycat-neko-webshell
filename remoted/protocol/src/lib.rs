//! Shared, versioned end-to-end protocol. The relay never authorizes application requests.
pub mod code;
pub mod crypto;
pub mod messages;
pub mod utf8;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const VERSION: u8 = 1;
pub const MAX_PLAINTEXT: usize = 61_440;
pub const MAX_CIPHERTEXT: usize = MAX_PLAINTEXT + 16;
pub const MAX_RELAY_MESSAGE: usize = 98_304;
pub const FILE_CHUNK: usize = 32_768;
pub const MAX_PEERS: usize = 16;
pub const MAX_DEVICES: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid relay address: {0}")]
    Address(&'static str),
    #[error("invalid or damaged device code")]
    Code,
    #[error("device code belongs to another relay")]
    RelayMismatch,
    #[error("message exceeds protocol limit")]
    Limit,
    #[error("invalid handshake state")]
    Handshake,
    #[error("encryption or authentication failed")]
    Crypto(#[from] snow::Error),
    #[error("invalid protocol message: {0}")]
    Json(#[from] serde_json::Error),
    #[error("secure random generator unavailable")]
    Random,
}

/// Canonical relay origin; paths, credentials, query and insecure production TLS are rejected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RelayAddress(String);
impl RelayAddress {
    pub fn parse(input: &str) -> Result<Self, Error> {
        let mut u = url::Url::parse(input.trim())
            .map_err(|_| Error::Address("enter an HTTPS or WSS origin"))?;
        if !u.username().is_empty()
            || u.password().is_some()
            || u.query().is_some()
            || u.fragment().is_some()
            || u.path() != "/"
        {
            return Err(Error::Address(
                "use only the origin, without credentials, path or query",
            ));
        }
        let scheme = match u.scheme() {
            "https" | "wss" => "wss",
            _ => return Err(Error::Address("TLS is required")),
        };
        u.set_scheme(scheme)
            .map_err(|_| Error::Address("unsupported scheme"))?;
        if u.host_str().is_none() {
            return Err(Error::Address("host required"));
        }
        Ok(Self(u.as_str().trim_end_matches('/').to_owned()))
    }
    pub fn origin(&self) -> &str {
        &self.0
    }
    pub fn digest(&self) -> String {
        encode(&Sha256::digest(self.0.as_bytes())[..8])
    }
    pub fn socket(&self, role: &str, route: &str) -> Result<String, Error> {
        decode32(route)?;
        if !matches!(role, "host" | "client") {
            return Err(Error::Address("invalid role"));
        }
        Ok(format!("{}/v1/{role}/{route}", self.0))
    }
}
impl TryFrom<String> for RelayAddress {
    type Error = Error;
    fn try_from(s: String) -> Result<Self, Error> {
        Self::parse(&s)
    }
}
impl From<RelayAddress> for String {
    fn from(a: RelayAddress) -> Self {
        a.0
    }
}

pub fn random32() -> Result<[u8; 32], Error> {
    let mut b = [0; 32];
    getrandom::fill(&mut b).map_err(|_| Error::Random)?;
    Ok(b)
}
pub fn encode(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}
pub fn decode(s: &str, max: usize) -> Result<Vec<u8>, Error> {
    if s.len() > max.div_ceil(3) * 4 {
        return Err(Error::Limit);
    }
    let b = URL_SAFE_NO_PAD.decode(s).map_err(|_| Error::Code)?;
    if b.len() > max || encode(&b) != s {
        return Err(Error::Code);
    }
    Ok(b)
}
pub fn decode32(s: &str) -> Result<[u8; 32], Error> {
    decode(s, 32)?.try_into().map_err(|_| Error::Code)
}
pub fn route(secret: &[u8; 32]) -> String {
    encode(&Sha256::digest(secret))
}
pub fn fingerprint(key: &[u8]) -> String {
    encode(&Sha256::digest(key))
}

pub fn pack<T: Serialize>(value: &T) -> Result<Vec<u8>, Error> {
    let b = serde_json::to_vec(value)?;
    if b.len() > MAX_PLAINTEXT {
        return Err(Error::Limit);
    }
    Ok(b)
}
pub fn unpack<T: serde::de::DeserializeOwned>(b: &[u8]) -> Result<T, Error> {
    if b.len() > MAX_PLAINTEXT {
        return Err(Error::Limit);
    }
    Ok(serde_json::from_slice(b)?)
}
