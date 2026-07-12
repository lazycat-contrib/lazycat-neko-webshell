# Cross-device Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-authorized remote client terminals to the existing instance switcher without changing normal LightOS/Herdr behavior.

**Architecture:** Extend the internal protobuf instance descriptor, keep official LightOS JSON at the platform edge, and isolate remote discovery, device auth, workspace conversion, and WebSocket relay in focused Rust modules. The frontend only groups typed instances and adapts remote replay UX; `main.ts` remains orchestration-only.

**Tech Stack:** Rust 2024, Axum, reqwest, tokio-tungstenite, rustls, buffa protobuf, TypeScript, Vite.

## Global Constraints

- Preserve all v0.5.20 web/mobile/options fixes.
- Keep `src/frontend/src/main.ts` as composition and event coordination only.
- All frontend UI/UX decisions follow `emil-design-eng`.
- External LightOS APIs remain their official JSON/WebSocket contracts.
- Internal instance and device-auth contracts use protobuf.
- Remote clients support native WebShell only in this release.
- Do not log terminal tickets or device API auth tokens.

---

### Task 1: Typed remote instance discovery

**Files:**
- Modify: `proto/lazycat/webshell/v1/capability.proto`
- Modify: `src/lightos_admin.rs`
- Modify: `src/lightos.rs`
- Modify: `src/ssh_backend.rs`
- Regenerate: `src/frontend/src/gen/lazycat/webshell/v1/capability_pb.ts`

**Interfaces:**
- Produces: additive `InstanceKind`, `Instance.kind`, `Instance.platform`, and `Instance.owner_user_id` fields.
- Produces: `lightos_admin::is_client_selector`, `lightos_admin::parse_client_selector`, and account-scoped client visibility helpers.

- [ ] Add protobuf enum/fields and a client-instance JSON adapter test.
- [ ] Run the focused Rust test and confirm it fails before implementation.
- [ ] Load `/api/webshell/instances` and `/api/client-instances`, merge by selector, preserve platform/type, and sort running items first within type.
- [ ] Mark LightOS and SSH instances with their explicit kinds.
- [ ] Regenerate TypeScript protobuf and run `npm run typecheck`.
- [ ] Commit the typed discovery slice.

### Task 2: Official device API authentication

**Files:**
- Create: `proto/cloud/lazycat/apis/localdevice/permission.proto`
- Create: `src/device_api_auth.rs`
- Modify: `build.rs`
- Modify: `Cargo.toml`
- Modify: `src/main.rs`

**Interfaces:**
- Produces: `device_api_auth::resolve_auth_token(device_api_url: &Url) -> Result<SecretString, DeviceApiAuthError>`.
- Consumes: mounted `/lzcapp/run/certs/box.crt`, `app.crt`, and `app.key`.

- [ ] Add tests for protobuf gRPC framing, token response decoding, subject serial extraction, and redacted errors.
- [ ] Run the focused tests and confirm they fail before implementation.
- [ ] Generate the minimal official protobuf messages with `connectrpc-build`.
- [ ] Implement PKCS#8 Ed25519/RSA signing of the application certificate subject serial number.
- [ ] Implement the mTLS HTTP/2 unary gRPC request with strict size/time limits and no credential logging.
- [ ] Run focused tests and Clippy for the module.
- [ ] Commit the device-auth slice.

### Task 3: Remote workspace HTTP adapter

**Files:**
- Create: `src/client_terminal.rs`
- Modify: `src/workspace.rs`
- Modify: `src/session_backend.rs`
- Modify: `src/main.rs`

**Interfaces:**
- Produces: `client_terminal::get_workspace`, `client_terminal::apply_workspace_action`, and `client_terminal::native_backends`.
- Consumes: account headers, visible client authorization, terminal ticket, and device auth token.

- [ ] Add tests for ticket validation/redaction, target URL construction, remote workspace conversion, outbound action conversion, and invisible-client rejection.
- [ ] Run each focused test red before implementing its behavior.
- [ ] Implement per-request visibility authorization and ticket acquisition.
- [ ] Proxy remote workspace GET/PUT with bounded JSON bodies and map errors to 400/401/403/502/504.
- [ ] Branch before local agent/workspace logic for `client:<id>` selectors.
- [ ] Return only the native WebShell backend for authorized remote clients.
- [ ] Run focused and workspace tests.
- [ ] Commit the workspace adapter slice.

### Task 4: Remote terminal WebSocket relay

**Files:**
- Modify: `src/client_terminal.rs`
- Modify: `src/terminal.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Produces: `client_terminal::prepare_terminal_attach` and `client_terminal::relay_terminal_socket`.
- Preserves: browser binary/text WebSocket message types.

- [ ] Add pure tests for WebSocket URL conversion, ticket redaction, and official replay-control translation.
- [ ] Run focused tests red before implementation.
- [ ] Prepare authorization/ticket/token before browser upgrade.
- [ ] Dial the device terminal WebSocket with the token header and bounded timeouts.
- [ ] Relay both directions, translating only incompatible control-frame names and returning a fatal process-exit on target dial failure.
- [ ] Ensure relay cancellation closes both halves without orphan tasks.
- [ ] Run terminal and full Rust tests.
- [ ] Commit the WebSocket slice.

### Task 5: Grouped instance UI and remote replay UX

**Files:**
- Modify: `src/frontend/src/instance-views.ts`
- Modify: `src/frontend/src/workspace-selection.ts`
- Modify: `src/frontend/src/terminal-protocol.ts`
- Modify: `src/frontend/src/main.ts`
- Modify: `src/frontend/src/styles.css`
- Modify: `src/frontend/src/i18n.ts`
- Create or modify focused `*.test.mjs` files beside the owning modules.

**Interfaces:**
- Produces: typed grouping helpers and `isRemoteClientSelector`.
- Preserves: existing instance-row click contract via `data-selector`.

- [ ] Add tests for LightOS/remote/SSH grouping, labels, offline disabling, and remote replay parsing.
- [ ] Run frontend tests red before implementation.
- [ ] Render compact group headings and remote platform metadata without list-switch animations.
- [ ] Add exact-property press/hover transitions, fine-pointer hover gating, and reduced-motion compatibility.
- [ ] Reset the Restty terminal only when a remote history replay begins.
- [ ] Skip Herdr refresh and LightOS-only SSH affordances for remote selectors through small orchestration guards in `main.ts`.
- [ ] Run frontend tests, typecheck, and production build.
- [ ] Commit the UI slice.

### Task 6: Audit, release, and publish

**Files:**
- Modify version fields only after all verification succeeds.
- Regenerate `src/frontend/dist/` through the documented production build.

**Interfaces:**
- Produces: synchronized release version and annotated git tag.

- [ ] Review the complete diff for auth boundary errors, token/ticket leakage, selector siblings, generated artifact drift, and accidental non-WebShell changes.
- [ ] Run `cargo fmt --check`, full Rust tests, all-target Clippy, frontend tests/typecheck/build, embedded-agent release build, and CLI version smoke tests.
- [ ] Run the musl LPK release and lint commands used by the repository.
- [ ] Inspect the resulting package for one provider executable and the embedded agent payload.
- [ ] Bump Cargo/npm/app metadata to the next patch version and repeat version-sensitive verification.
- [ ] Commit all remaining generated/version changes.
- [ ] Re-read worktree status and HEAD, push `main`, create an annotated `v<version>` tag, push the tag, and verify remote refs.
- [ ] Report real-device acceptance as pending unless it was actually exercised.
