use rustls::Certificate;

pub fn cloudflare_ca() -> Certificate {
    Certificate(include_bytes!("cloudflare_ca.der").to_vec())
}

#[allow(
    clippy::all,
    clippy::pedantic,
    dead_code,
    missing_docs,
    unused_imports,
    unused_qualifications
)]
pub mod quic_metadata_protocol_capnp;

pub use quic_metadata_protocol_capnp::*;

#[allow(
    clippy::all,
    clippy::pedantic,
    dead_code,
    missing_docs,
    unused_imports,
    unused_qualifications
)]
pub mod tunnelrpc_capnp;

pub use tunnelrpc_capnp::*;
