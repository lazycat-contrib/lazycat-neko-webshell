# Restty WASM 0.2.6

`restty.wasm` is the MIT-licensed terminal core embedded in the npm package
`restty@0.2.6`. It is used by the Rust provider and lightweight agent to keep
terminal protocol replies authoritative when no browser is attached and to
avoid duplicate replies from multiple browser renderers.

Regenerate and validate it with:

```bash
node scripts/export-restty-wasm.mjs --write
node scripts/export-restty-wasm.mjs
```

The extraction script pins the npm package version, WebAssembly imports,
required ABI exports, WebAssembly v1 magic bytes, byte length, and SHA-256.
