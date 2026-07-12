# Embedded Lightweight WebShell Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full-provider target installation with an embedded 1-purpose agent binary while preserving the existing v4 protobuf and command contract.

**Architecture:** Compile a second Rust binary from the existing agent daemon, history, PTY, workspace, config, proto, and validation modules. Embed its release bytes into the provider through generated build output; install those bytes through the existing manifest/atomic replacement path and bound the complete stdin transfer plus child wait.

**Tech Stack:** Rust 2024, Tokio, Buffa protobuf, portable-pty, Cargo build script, musl release build.

## Global Constraints

- The LPK publishes only the provider executable.
- The lightweight agent remains protocol `lazycat-neko-webshell-agent-v4`.
- Compatible running v4 agents remain reusable to preserve live sessions.
- The provider must never use `std::env::current_exe()` as the release payload.
- The complete target transfer must share one timeout and kill the child on timeout.

### Task 1: Build the dedicated agent CLI

- [ ] Add `src/bin/lazycat-neko-webshell-agent.rs` using only the agent dependency closure.
- [ ] Support both `agent version` and `version` invocation shapes.
- [ ] Verify stdout is exactly the current v4 protocol string.

### Task 2: Embed and install the lightweight payload

- [ ] Generate `embedded_agent.rs` from `NEKO_WEBSHELL_AGENT_BINARY` in `build.rs`.
- [ ] Load embedded bytes in release and a sibling dedicated agent in debug.
- [ ] Add a regression test proving the debug payload path differs from the provider path.
- [ ] Build agent first, then provider with the agent path in `scripts/build-release.sh`.
- [ ] Reject empty or provider-sized agent artifacts.

### Task 3: Bound the complete transfer

- [ ] Add a test whose child does not read an 8 MiB stdin payload.
- [ ] Confirm the old helper blocks outside its wait timeout.
- [ ] Wrap spawn, stdin write, close, and wait in one timeout with `kill_on_drop(true)`.
- [ ] Confirm the regression test completes in under one second.

### Task 4: Verify

- [ ] Run focused agent-client tests and agent CLI smoke tests.
- [ ] Run Clippy for the dedicated agent target.
- [ ] Build release agent and embedded provider; record both byte sizes.
- [ ] Run the full repository verification and inspect the final LPK content.
