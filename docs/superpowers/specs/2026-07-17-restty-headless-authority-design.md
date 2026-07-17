# Restty 0.2 And Headless Terminal Authority Design

## Status

Approved. The user requested the iOS keyboard fix, Restty 0.2.5 upgrade, adoption of relevant performance/stability/UX improvements, and migration of terminal protocol authority to Restty's headless core even when a refactor is required.

## Objective

Upgrade the browser terminal to Restty 0.2.5, restore reliable iOS software-keyboard activation, and make the persistent Rust terminal owner generate terminal protocol replies exactly once through the same Restty WASM core used by the browser renderer.

The user-visible result is:

- iOS can open the system keyboard from the documented terminal gesture and mobile modifier controls;
- Android touch scrolling and keyboard behavior do not regress;
- desktop terminals use Restty's native search panel and native context-menu renderer with localized, backend-aware actions;
- local LightOS and provider-owned terminals no longer depend on one browser renderer to answer CPR, DA, or related terminal queries;
- reconnect and multi-device replay remain byte-identical and do not duplicate generated terminal replies;
- Restty 0.2 performance, font, touch, wheel, Kitty, and rendering fixes are adopted through supported public APIs.

## Authority Model

```text
browser input -------------------------------> PTY owner
                                                   |
                                                   v
PTY output -> Rust Restty headless WASM -> history / sequence -> attached browsers
                         |
                         +-> drain generated replies -> PTY exactly once

attached browser -> Restty renderer with forwardTerminalReplies=false
```

Authority is selected per pane:

- `server`: the provider or instance-local Rust agent owns the PTY and Restty headless state;
- `client`: an older compatible agent or an external remote-client terminal retains the existing browser-reply behavior.

The capability is additive. Missing values mean `client`, preserving compatibility with existing agents and remote services.

## Tech Stack

- Rust 1.97.1 / edition 2024
- `wasmi` 1.1.0 with default features disabled except `std`
- Cap'n Proto 0.26.2 and Quinn 0.11.11 with `quinn-proto` 0.11.16 for the Cloudflare Quick Tunnel path
- Restty 0.2.5 and its embedded MIT-licensed WASM terminal core
- TypeScript 5.9, Vite 7, Node test runner
- Existing protobuf agent protocol and browser WebSocket byte stream

No Node or Bun runtime is added to the released provider or target instance.

## Commands

- Frontend tests: `npm test`
- Frontend typecheck: `npm run typecheck`
- Frontend production build: `npm run build`
- Rust format: `cargo fmt --check`
- Rust tests: `cargo test --all-targets`
- Rust lint: `cargo clippy --all-targets --all-features -- -D warnings`
- Production release: `bash scripts/build-release.sh`
- Diff hygiene: `git diff --check`
- Dependency audit: `npm audit --omit=dev` and `cargo audit --ignore RUSTSEC-2023-0071` when installed; the exception rationale is recorded below

## Project Structure

- `src/frontend/src/mobile/system-keyboard-focus.ts`: synchronous iOS software-keyboard reactivation; `main.ts` only wires gestures and controls to it.
- `src/frontend/src/terminal-options.ts`: Restty surface/terminal/services composition.
- `src/frontend/src/terminal-dom.ts`: owned DOM lookup for the terminal canvas and IME textarea; no Restty raw-pane escape hatch.
- `src/frontend/src/terminal-fonts/`: stable pane-handle font runtime operations.
- `src/restty_headless.rs`: safe Rust wrapper for the pinned Restty WASM ABI.
- `src/terminal_manager.rs`: provider-owned PTY output authority.
- `src/agent_workspace.rs`: instance-local agent PTY output authority.
- `proto/lazycat/webshell/v1/capability.proto`: additive reply-authority capability.
- `vendor/restty/0.2.5/`: pinned WASM artifact, checksum, and license notice.
- `scripts/export-restty-wasm.mjs`: deterministic extraction and checksum validation for dependency upgrades.

## Code Style

Rust boundary methods return errors and keep WASM details private:

```rust
pub fn write_output(&mut self, bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    self.write(bytes)?;
    self.drain_output()
}
```

TypeScript uses an explicit union rather than booleans:

```ts
export type TerminalReplyAuthority = "client" | "server";
```

`main.ts` may pass this value into focused modules but must not implement authority, font conversion, DOM lookup, or IME rules.

## Interface Contract

The workspace pane representation gains an optional `terminal_reply_authority` value. Accepted values are `client` and `server`; absent, empty, or unknown values normalize to `client`.

The field is advisory for browser rendering only. It does not grant terminal-control permission and does not replace existing selector/account authorization or single-controller checks.

The agent protocol remains wire-compatible. Existing agents that omit the field continue to work and keep browser-generated replies enabled.

## Security And Failure Boundaries

- The checked-in WASM artifact must match the recorded SHA-256 and begin with the WebAssembly magic/version bytes.
- The Restty MIT license is copied into the released LPK alongside the embedded binary.
- The extraction script rejects executable template interpolation before decoding Restty's embedded WASM literal.
- The WASM instance imports only `env.log`; log payloads are bounded and must not contain PTY input, credentials, or terminal history.
- Each WASM instance is limited to 16 MiB, one memory/table/instance, and a replenished per-operation fuel budget; headless scrollback is disabled because the Rust owner already stores history.
- Kitty graphics APC payloads are removed only from the reply parser to prevent image allocations; the original bytes still enter history and attached browser renderers.
- WASM writes, reply drains, terminal sizes, and PTY batches are bounded by existing validation and output limits.
- A headless initialization or runtime failure must not silently split authority. New pane creation fails before the child starts, and runtime failures terminate and reap the affected child.
- Non-remote browser attaches must declare `terminal_reply_authority=client|server`; stale or cached clients are rejected with HTTP 426, and agent attaches are checked against the current pane state before streaming.
- Remote-client selectors remain owned by their external terminal service and default to `client`.
- Generated terminal replies bypass user-control ownership but are produced only by the server-owned parser from PTY output; user-supplied frames cannot mark themselves as trusted generated replies.
- RustSec auditing has one explicit upstream exception: `RUSTSEC-2023-0071` is pulled by the latest `lzc-sdk` through `rsa` 0.9.10 and has no fixed stable release. Other previously reported Cap'n Proto, Quinn, ring, and rustls-webpki advisories are removed by this upgrade.

## Testing Strategy

- Unit-test iOS reactivation ordering with an already-focused readonly IME target.
- Unit-test authority normalization and missing-field compatibility.
- Unit-test the Rust WASM wrapper with CPR (`ESC[6n` -> `ESC[1;1R`), UTF-8 writes, resize, bounded output, and disposal.
- Unit-test PTY output ordering: headless parse, generated-reply write, history append, then broadcast.
- Preserve all existing replay, remote-client generated-input, touch keyboard guard, and terminal plugin tests.
- Add a throughput benchmark for a representative ANSI stream and compare raw buffering with headless parsing.
- Build the musl agent and enforce the existing 16 MiB and provider-ratio size gates.
- Real iOS and Android checks remain mandatory because local browser emulation cannot prove software-keyboard behavior.

## Boundaries

- Always: keep raw terminal output and sequence ordering unchanged for browsers; use additive compatibility fields; keep `main.ts` orchestration-only; verify dependency provenance and lockfile changes.
- Ask first: raising the 16 MiB agent limit, changing remote-client authority, changing browser-facing replay frame names, or adding a runtime service.
- Never: run an unverified WASM artifact, trust a client-declared generated-input flag as server authority, expose raw WASM memory across modules, or force-restart compatible existing sessions solely for this migration.

## Success Criteria

1. Restty resolves to 0.2.5 in `package-lock.json`, and frontend code uses the grouped public configuration and new font model.
2. No application code calls Restty `getRawPane()`.
3. iOS keyboard activation performs a writable synchronous focus transition; existing touch scrolling remains guarded.
4. New local/provider panes advertise `server`; old-agent and remote-client panes normalize to `client`.
5. For server-authoritative panes, browser Restty uses `forwardTerminalReplies: false`, and the Rust headless core sends each generated reply to the PTY exactly once.
6. Replay bytes, output sequences, tab/pane state, and external remote-client behavior remain compatible.
7. Frontend/Rust verification passes, the agent stays within release size gates, and measured headless parsing overhead is no more than 25% versus the raw output benchmark.

## Non-goals

- Replacing the persistent Rust workspace/PTY owner with a JavaScript sidecar.
- Sending binary render snapshots to browsers in this change.
- Changing remote-device terminal implementations outside this provider.
- Replacing application-owned backend/session split semantics with Restty-internal panes. Restty renders the native context menu, while the application supplies backend-aware, localized actions.

## Open Questions

None. If the size or performance gate fails, implementation stops at the last independently passing phase and reports the measured blocker.
