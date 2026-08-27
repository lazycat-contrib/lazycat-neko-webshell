# Terminal Reliability Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Borrow the highest-value reliability patterns from the latest microserver WebShell without copying its Go-specific structure or duplicating capabilities already provided by Restty.

**Architecture:** Keep Rust modules authoritative: release checks in scripts/CI, provider revision state in a focused frontend module, replay identity/gap handling at the agent protocol boundary, and connection capacity in a dedicated scheduler. Restty remains the terminal renderer and IME owner; only stable public APIs are consumed.

**Tech Stack:** Rust 2024, TypeScript, Vite, Restty 0.2.6, Node test runner, GitHub Actions.

**Spec:** Comparative audit of `/home/czyt/code/go/lazycat-microserver-webshell` at `03ae675` and the current Rust provider.

## Global Constraints

- Restty `0.2.6` is the official latest release; do not change the dependency without a newer published version or an explicitly pinned commit.
- Keep `src/frontend/src/main.ts` as an orchestration layer; reusable state machines belong in focused modules.
- Preserve WebShell selector, account, workspace, tab, and pane identity boundaries.
- Do not render replay intermediate frames as user-visible output.
- Do not bump `AGENT_VERSION` or `MIN_SUPPORTED_AGENT_VERSION` for frontend-only or CI-only changes.
- All changes require `npm test`, `npm run typecheck`, `npm run build`, and `cargo check --locked` before handoff.

### Task 1: Establish release verification and version consistency

**Files:**
- Modify: `.github/workflows/lazycat.yml`
- Modify: `scripts/build-release.sh`
- Modify: `README.md`
- Modify: `README.en.md`
- Test: add a focused shell or Rust test beside the release guard

- [ ] Make frontend tests, Rust tests, formatting, and Clippy check prerequisites explicit in PR and tag workflows.
- [ ] Add one release guard asserting `Cargo.toml`, `package.json`, `package-lock.json`, and `package.yml` versions agree.
- [ ] Remove manually duplicated README version strings or generate them from canonical metadata.

### Task 2: Add provider revision detection

**Files:**
- Modify: `src/frontend/src/runtime.ts`
- Create: `src/frontend/src/provider-revision-controller.ts`
- Modify: `src/frontend/src/main.ts` only for controller wiring
- Test: `src/frontend/src/provider-revision-controller.test.mjs`

- [ ] Define a no-store revision response and a controller that remembers the initial revision.
- [ ] Recheck on reconnect, visibility regain, and recovery; stale revisions lock terminal input and show a reload action.
- [ ] Add generation tests for unchanged, changed, cancelled, and stale responses.

### Task 3: Make replay generations and gaps explicit

**Files:**
- Modify: `proto/lazycat/webshell/v1/capability.proto`
- Modify: `src/agent_protocol.rs`
- Modify: `src/agent_history.rs`
- Modify: `src/agent_daemon.rs`
- Modify: `src/terminal.rs`
- Modify: `src/frontend/src/terminal-protocol.ts`
- Modify: `src/frontend/src/terminal-replay-controller.ts`
- Modify: `src/frontend/src/main.ts` only for orchestration
- Test: existing agent/history/terminal replay tests plus focused regression cases

- [ ] Return explicit history generation, oldest cursor, replay mode, and replay-gap state from attach.
- [ ] Reset the renderer only for snapshots or gaps; accept deltas only when identity and cursor continuity are proven.
- [ ] Convert stale workspace/pane identity into a refresh-required path instead of reconnecting the same stale pane forever.

### Task 4: Add a global pane connection scheduler

**Files:**
- Create: `src/frontend/src/pane-connection-scheduler.ts`
- Test: `src/frontend/src/pane-connection-scheduler.test.mjs`
- Modify: `src/frontend/src/main.ts` only to route connect/reconnect calls
- Modify: `src/frontend/src/pane-connection-lifecycle.ts` as needed

- [ ] Model bounded leases, priority, generation fencing, and replay-ready handoff.
- [ ] Prioritize active pane, visible tab, recent interaction, then background panes.
- [ ] Preserve pending input, reconnect backoff, and current pane lifecycle semantics while parking lower-priority panes.

### Task 5: Evaluate multiplexing, cache, and mobile product follow-ups

**Files:**
- No source changes until a design spike is approved.
- Read: reference `terminal_queue.go`, `terminal_cache_v2.js`, `terminal_long_screenshot.js`, fullscreen touch adapters.

- [ ] Measure current pane counts, reconnect bursts, and replay/render cost before choosing multiplexing.
- [ ] Prototype a generation-keyed local cache only after replay identity is stable and privacy/eviction rules are documented.
- [ ] Extend the existing mobile overview for live previews and lifecycle actions before considering durable Cache API previews.
- [ ] Add a user-facing Auto/Mobile/Desktop override and fullscreen-TUI touch arbitration only after the current generic gesture path is characterized on real devices.

