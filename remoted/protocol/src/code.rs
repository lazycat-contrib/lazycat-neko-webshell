use crate::{Error, RelayAddress, decode32, encode, random32};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Short-lived secret: deliberately does not implement Debug or Serialize.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct DeviceCode {
    route: String,
    psk: [u8; 32],
    relay_digest: String,
}
impl DeviceCode {
    pub fn generate(route: &str, relay: &RelayAddress) -> Result<Self, Error> {
        decode32(route)?;
        Ok(Self {
            route: route.to_owned(),
            psk: random32()?,
            relay_digest: relay.digest(),
        })
    }
    pub fn route(&self) -> &str {
        &self.route
    }
    pub fn psk(&self) -> &[u8; 32] {
        &self.psk
    }
    pub fn display(&self) -> String {
        let body = format!(
            "NR1.{}.{}.{}",
            self.route,
            encode(&self.psk),
            self.relay_digest
        );
        format!("{body}.{}", encode(&Sha256::digest(body.as_bytes())[..5]))
    }
    pub fn parse(input: &str, relay: &RelayAddress) -> Result<Self, Error> {
        if input.len() > 256 {
            return Err(Error::Code);
        }
        let s: String = input.chars().filter(|c| !c.is_ascii_whitespace()).collect();
        let p: Vec<_> = s.split('.').collect();
        if p.len() != 5 || p[0] != "NR1" {
            return Err(Error::Code);
        }
        let body = p[..4].join(".");
        if p[4] != encode(&Sha256::digest(body.as_bytes())[..5]) {
            return Err(Error::Code);
        }
        if p[3] != relay.digest() {
            return Err(Error::RelayMismatch);
        }
        decode32(p[1])?;
        Ok(Self {
            route: p[1].into(),
            psk: decode32(p[2])?,
            relay_digest: p[3].into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_binding_and_corruption() {
        let relay = RelayAddress::parse("https://relay.example/").unwrap();
        let route = crate::route(&random32().unwrap());
        let c = DeviceCode::generate(&route, &relay).unwrap();
        let text = c.display();
        assert_eq!(DeviceCode::parse(&text, &relay).unwrap().psk(), c.psk());
        assert!(matches!(
            DeviceCode::parse(
                &text,
                &RelayAddress::parse("https://other.example").unwrap()
            ),
            Err(Error::RelayMismatch)
        ));
        assert!(DeviceCode::parse(&(text + "x"), &relay).is_err());
        assert!(DeviceCode::parse("NR1.bad", &relay).is_err());
    }
    #[test]
    fn rejects_unsafe_addresses() {
        for s in [
            "http://relay.example",
            "wss://u:p@relay.example",
            "https://relay.example/path",
            "https://relay.example/?token=secret",
            "https://relay.example/#code",
        ] {
            assert!(RelayAddress::parse(s).is_err(), "{s}");
        }
        assert_eq!(
            RelayAddress::parse("https://RELAY.example:443/").unwrap(),
            RelayAddress::parse("wss://relay.example").unwrap()
        );
    }
}
