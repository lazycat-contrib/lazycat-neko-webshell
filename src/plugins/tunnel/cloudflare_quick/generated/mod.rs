use rustls23::pki_types::CertificateDer;

pub fn cloudflare_ca() -> CertificateDer<'static> {
    CertificateDer::from(include_bytes!("cloudflare_ca.der").as_slice())
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
