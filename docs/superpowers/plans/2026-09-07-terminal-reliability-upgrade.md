# Terminal Reliability Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Upgrade the renderer and improve terminal input, transport, workspace consistency and regression diagnostics, then release the verified change.

**Architecture:** Keep persistent state on the target and browser state in focused controllers. Independent renderer, transport and workspace tasks may proceed concurrently in the isolated checkout with exclusive file ownership; task reviews precede integration. The controller alone owns shared release metadata after task implementation.

**Tech Stack:** Rust/Axum/Tokio/wasmi, TypeScript/Restty 0.3.0/Vite, Node tests, browser automation.

**Spec:** `docs/superpowers/specs/2026-09-07-terminal-reliability-upgrade.md`

## Global Constraints

- Read and follow the root AGENTS.md and the spec. Do not add business logic to main.ts.
- Base: ab5161d. Work in `.worktrees/reliability-upgrade`, branch `codex/reliability-upgrade`.
- No source edits in the Go reference project.
- Restty 0.3.0, exact pin. Provider minimum agent compatibility remains unchanged unless a required behavior is impossible with the previous compatible agent.
- Do not change AGENT_PROTOCOL_VERSION for provider-only improvements or browser wire extensions. Coordinate all agent version constants with Task 1.
- All test artifacts under ignored target/, frontend dist/ or tests-auto artifacts/. No credentials in recorded artifacts.
- Workers must not commit concurrently or spawn agents. Submit an implementation report to the plan workspace; the controller reviews and commits selectively.
- Verification gates: `npm test`, `npm run typecheck`, `npm run build`, `cargo fmt --check`, `cargo test --locked`, WASM validation and selected browser scenarios. Release uses scripts/build-release.sh and tag CI.

### Task 1: Upgrade Restty and headless runtime

**Files:** package.json, package-lock.json, vendor/restty/, scripts/export-restty-wasm.mjs, scripts/build-release.sh (Restty paths only), src/restty_headless.rs, src/agent_protocol.rs (version constant only), src/agent_daemon.rs (version assertions only), .github/workflows/lazycat.yml (vendor path only if required).

**Interfaces:** Preserve current Restty browser APIs. Rust `ResttyHeadlessTerminal::new/write/resize` retains existing contract. Add env.now_ms using a monotonic per-instance origin, matching the WASM import signature; do not expose wall-clock or arbitrary host functions.

- [x] Validate the published npm package 0.3.0 and inspect WASM imports/exports. Record exact SHA and byte length.
- [x] Update npm pin and lockfile in the isolated checkout; replace its node_modules symlink with a local install before modifying dependencies.
- [x] Export the pinned WASM, update Rust/script validation and license paths, remove obsolete active artifact references. Historical design docs may retain their version context.
- [x] Add headless creation/reply/resize/clock regression coverage. Keep memory and fuel bounds. Tests must reject wrong imports/ABI/hash and still cover terminal reply authority.
- [x] Increment AGENT_VERSION from 12 to 13, retaining MIN_SUPPORTED_AGENT_VERSION=11 unless proven unsafe. Do not couple it to app 0.7.29.
- [x] Run `node scripts/export-restty-wasm.mjs`, targeted headless Rust tests, browser typecheck/build. Report actual commands and limits.

### Task 2: Make agent transport cancellation-safe and bounded

**Files:** src/terminal.rs; new focused src/terminal_agent_stream.rs or equivalent; module wiring src/main.rs; tests in owning Rust modules. Do not edit agent version constants.

**Interfaces:** Complete AgentFrame messages are delivered through a bounded receiver. The reader task owns stdout and is explicitly cancelled/joined at attach termination. Every sender operation in agent/persistent paths has a bounded deadline; timeout exits this attach but leaves the target daemon/PTY alive.

- [x] Reproduce partial-header and partial-payload reads interrupted by a competing event, using tokio duplex streams and deterministic coordination.
- [x] Move frame decoding into an independent reader task or cancellation-safe persistent decoder. Do not recreate partial read_exact futures inside select!.
- [x] Route agent and persistent websocket messages through existing bounded send policy. Bound stdin detach/input writes and attach child/stderr cleanup where required by the same lifetime.
- [x] Ensure socket close/error/timeouts release leases and tasks; bound stderr collection. Preserve output/control ordering.
- [x] Verify partial frames, slow/non-reading peer, clean disconnect, child error, duplicate terminal replies and persistent-session survival with focused Rust tests.

### Task 3: Workspace request ownership, incremental apply and passive sync

**Files:** src/frontend/src/workspace-*.ts and tests; selector-request-tracker where necessary; main.ts ONLY replace workspace algorithms with module calls and wire lifecycle. Backend src/workspace.rs/router.rs only if passive read cannot be expressed safely through existing API (coordinate with controller first).

**Interfaces:** Focus requests do not invalidate structural request generations. Structural mutations serialize per normalized selector; passive fetch observes mutation revision and only applies if no mutation began since capture. Each controller exposes idempotent dispose and rejects late results. Main injects get/set tabs, selection, pane mount/disposal and connect callbacks.

- [x] Add deterministic deferred-Promise tests for create/split during focus changes, concurrent mutations, GET versus PUT, selector/lifecycle replacement and failure recovery.
- [x] Extract request coordination into a focused workspace module. Preserve caller return/error semantics and local focus priority.
- [x] Extract incremental tab/pane reconciliation from main.ts. Reuse tab objects/mounts and pane runtime when selector, session, backend and reply authority agree; dispose removed/changed panes exactly once. Explicit identity recovery can request full replay.
- [x] Verify unchanged snapshots preserve object/DOM/socket/terminal/pending-input identity; membership changes update only affected layout; remote focus never overrides local focus; changed identity triggers full replacement.
- [x] Add passive synchronization for visible online pages, with bounded interval/coalescing/backoff, generation/revision fencing and prompt focus/visibility refresh. Read without restarting or auto-creating sessions. Reconcile remote names/layout too when available.
- [x] Verify two controllers sharing an authoritative workspace see each other's new/deleted tabs without additional reconnects for unchanged panes, and pause/dispose clears timers/requests.
- [x] Run focused Node tests then typecheck. Document the controller interfaces for the browser regression task.

### Task 4: Herdr application mouse touch lifecycle

**Files:** src/frontend/src/mobile/herdr-pointer-controller.ts and tests (or closest focused owner), terminal mouse/scrollback integration, terminal runtime disposal, main.ts minimal wiring only.

**Interfaces:** Own Herdr touch application interaction only. Use Restty public coordinate/input behavior without private runtime imports or pixel/character guesses. Match every dispatched press with a release; track pointer id, generation, cancel/dispose. Scrolling and selection are distinct from a tap; existing pointer mouse/Shift behavior remains native.

- [x] Reproduce Restty 0.3.0 touch down/up asymmetry in a browser fixture with captured PTY input and an isolated Herdr runtime. Confirm actual sidebar/+ semantics before selecting an adapter.
- [x] Add a focused adapter using existing gesture thresholds. Avoid duplicate events, phantom click after scrolling and locked pressed state following cancel.
- [x] Add tests for tap, native mouse, Shift, drag/scroll, cancel, lost capture, disposal, and double tap keyboard.
- [x] Verify real mouse/touch sequences and sidebar selection/+ behavior in the local browser. Report any inaccessible remote-device scenario separately.

### Task 5: Diagnostics and durable browser regressions

**Files:** src/frontend/src/diagnostics/ focused controller/store/export; existing terminal-performance facade; focused terminal/replay/lifecycle modules and main.ts debug/lifecycle wiring; tests-auto/ scenario runner and docs; package.json test commands (after Task 1).

**Interfaces:** Opt-in bounded timeline keyed by pane/connection generation; record only known event names and allowlisted finite metrics/reasons. Export under existing debug controls, no input/output text, selector paths or credentials. Disabled recording is a cheap no-op and disposal frees callbacks/timers.

- [x] Add trace events for connect requested/open, replay validated/received/applied/ready, gap/overflow, resize and reconnect/error. Separate receive-complete from renderer-ready.
- [x] Make timelines copyable/downloadable from existing debug controls; reuse existing interface styling and localization.
- [x] Build repeatable local browser scenarios with isolated state, bounded waits and deterministic cleanup. The shared runner captures screenshot, structured metrics and errors on failure and redacts sensitive fields.
- [x] Cover Herdr pointer lifecycle, native terminal output/recovery, workspace mutation/focus and two-device passive sync. Keep pure controller tests in the normal Node suite.
- [x] Document local vs real LightOS/device prerequisites and exact commands; do not mark a skipped required scenario as passed.

### Task 6: Measure output flow and select a bounded policy

**Files:** scripts/ or tests-auto/ repeatable benchmark, focused terminal output modules only if supported by results; docs/superpowers/plans/2026-09-07-terminal-output-benchmark.md.

**Interfaces:** Record input latency, outstanding output bytes, replay elapsed and connection count for one and multiple panes. A consumption ACK if needed is negotiated and generation-scoped; clients/servers without support continue existing protocol. No need to multiplex sockets to gain per-pane backpressure.

- [x] Capture baseline on Restty 0.3.0 for small output, 350 KiB replay, continuous output and multiple panes.
- [x] If measured queues/latency warrant, implement bounded per-pane drain and negotiated consumed-cursor ACK with stale/future ACK validation and timeout recovery. Otherwise document measured reasons for retaining the current protocol.
- [x] Compare the same workload after policy changes; retain bounded memory and no input-before-replay-ready invariant.

### Task 7: Integrate, review and release

**Files:** all changed task files, README.md/README.en.md, application version files Cargo.toml/Cargo.lock/package.json/package-lock.json/package.yml, release notes as appropriate.

- [x] Review each task diff for correctness/spec, fix findings, then run whole-change review with a fresh reviewer.
- [x] Run all verification gates and selected browser scenarios. Record exact counts and scope limits.
- [x] Confirm remote main/tag state, bump app 0.7.29 if available, run version consistency and release build. Agent version remains separately governed by Task 1.
- [ ] Commit only owned files. Integrate verified branch into main after ensuring original checkout is still clean. Push main and annotated v0.7.29; never replace an existing tag.
- [ ] Follow tag CI and resolve fixable failures. Report commit, tag, CI and any external validation not performed.
