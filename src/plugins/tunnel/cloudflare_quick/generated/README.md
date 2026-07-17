This directory vendors generated Cap'n Proto Rust bindings and the Cloudflare
tunnel CA certificate used by the Cloudflare Quick Tunnel provider.

The schemas and CA certificate are derived from `libcfd` 0.1.1. The checked-in
Rust bindings were regenerated with Cap'n Proto 1.4.0 and `capnpc` 0.26.0 so
the release build does not require an external `capnp` compiler on the target
build machine.
