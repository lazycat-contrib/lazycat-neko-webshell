# Terminal MCP Plugin and PTY Backpressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Neko WebShell as a LazyCat MCP provider that safely lists, reads, creates, controls, and closes supported terminal sessions while bounding PTY input/output queues and preserving sequence/replay.

**Architecture:** Add an in-process `terminal-mcp` plugin whose rmcp 2.1 Streamable HTTP endpoint delegates to a backend-neutral terminal control service. WebShell/SSH use the existing session and PTY managers, Herdr uses a typed SockAPI adapter, and a server-side grant manager enforces disabled/read-only/confirmation/automatic policies.

**Tech Stack:** Rust 2024, Axum 0.8, rmcp 2.1 Streamable HTTP, Tokio, portable-pty, Serde/Schemars, TypeScript 5.9, existing ConnectRPC plugin settings, LazyCat LPK v2 resource exports.

## Global Constraints

- Keep `package.yml` at `min_os_version: v1.5.2` or higher.
- Export MCP through `resources/mcp-providers/terminal-control/mcp.yml` and `lzc-build.yml.resource_exports`.
- Keep the MCP plugin disabled by default and preserve static resource discovery while disabled.
- Accept LazyCat platform identity only; do not add external Bearer-token authentication.
- Keep the current monotonic sequence/replay protocol; do not add Grok absolute output offsets.
- Herdr terminal operations must use the existing allowlisted Herdr SockAPI boundary.
- Do not return or log raw terminal input/output, user tickets, SSH passwords, or private keys.
- Cap MCP reads at 256 KiB and 60 seconds; default to 64 KiB.
- Cap PTY input channels at 256 messages, each input message at 16 KiB, coalesced writes at 64 KiB, and output batches at 16 ms or 64 KiB.
- Disconnect slow subscribers and recover with sequence replay.
- Keep frontend Terminal MCP code under `src/frontend/src/plugins/terminal-mcp/`; keep `src/frontend/src/main.ts` to orchestration.
- Do not refactor the AI Chat MCP client in this plan.

---

## File map

### New backend files

- `src/pty_io.rs`: shared bounded PTY writer and 16 ms/64 KiB output batcher.
- `src/plugins/terminal_mcp/mod.rs`: plugin constants, manager construction, and public router/service hooks.
- `src/plugins/terminal_mcp/types.rs`: stable policy, capability, session, output, request, grant, and error types.
- `src/plugins/terminal_mcp/principal.rs`: LazyCat request-header principal extraction.
- `src/plugins/terminal_mcp/grants.rs`: pending approvals, grants, creator ownership, revoke, wait, and cleanup.
- `src/plugins/terminal_mcp/service.rs`: backend-neutral `TerminalControlService` operations.
- `src/plugins/terminal_mcp/herdr_adapter.rs`: typed mapping to allowlisted Herdr SockAPI methods.
- `src/plugins/terminal_mcp/server.rs`: rmcp tool schemas, handlers, dynamic tool listing, and Streamable HTTP service.
- `src/plugins/terminal_mcp/http.rs`: focused approval/grant status endpoints for the Terminal UI.

### New frontend files

- `src/frontend/src/plugins/terminal-mcp/types.ts`: settings, caller rule, request, and grant types.
- `src/frontend/src/plugins/terminal-mcp/policy.ts`: normalization and serialization of plugin metadata.
- `src/frontend/src/plugins/terminal-mcp/policy.test.mjs`: policy tests.
- `src/frontend/src/plugins/terminal-mcp/settings-view.test.mjs`: approval/settings rendering tests.
- `src/frontend/src/plugins/terminal-mcp/api.ts`: pending request/grant fetch and mutation calls.
- `src/frontend/src/plugins/terminal-mcp/controller.ts`: polling, approval, revoke, and state management.
- `src/frontend/src/plugins/terminal-mcp/settings-view.ts`: plugin-specific settings and grant/request UI.
- `src/frontend/src/plugins/terminal-mcp/approval-view.ts`: escaped approval detail rendering.

### Existing files changed

- `Cargo.toml`, `Cargo.lock`: rmcp 2.1 server dependency.
- `src/config.rs`: PTY and MCP hard limits.
- `src/agent_history.rs`, `src/terminal_manager.rs`: bounded sequence snapshots.
- `src/agent_pty.rs`, `src/terminal_manager.rs`: shared bounded writer, batching, busy state, kill/wait.
- `src/agent_workspace.rs`, `src/agent_daemon.rs`: bounded subscribers and replay-safe attach.
- `src/herdr.rs`: expose a narrow typed authorized SockAPI call boundary.
- `src/workspace.rs`, `src/service.rs`, `src/session_manager.rs`: reusable session lifecycle helpers.
- `src/state.rs`, `src/plugins/mod.rs`, `src/main.rs`, `src/router.rs`: plugin registration and service wiring.
- `src/pomodoro.rs`: dispatch Terminal MCP notification actions before generic action completion.
- `src/frontend/src/plugin-utils.ts`, `src/frontend/src/plugin-views.ts`, `src/frontend/src/main.ts`: focused Terminal MCP settings wiring.
- `src/frontend/src/i18n/messages-en.ts`, `src/frontend/src/i18n/messages-zh-cn.ts`: UI copy.
- `lzc-build.yml`, `resources/mcp-providers/terminal-control/mcp.yml`: LazyCat MCP export.

---

### Task 1: Add bounded sequence snapshots

**Files:**
- Modify: `src/agent_history.rs`
- Modify: `src/terminal_manager.rs`

**Interfaces:**
- Produces: `AgentHistory::snapshot_after_bounded(sequence, max_bytes, max_frames) -> AgentHistorySnapshot`
- Produces: `OutputBuffer::snapshot_after_bounded(sequence, max_bytes, max_frames) -> OutputSnapshot`
- Preserves: existing `snapshot_after(sequence)` callers and monotonic sequence behavior

- [ ] **Step 1: Add failing AgentHistory tests**

Add tests that push sequences `1..=6`, request after sequence `1` with a byte
limit that fits exactly two frames, and assert:

```rust
let snapshot = history.snapshot_after_bounded(1, 6, 8);
assert_eq!(snapshot.frames.iter().map(|f| f.sequence).collect::<Vec<_>>(), vec![2, 3]);
assert_eq!(snapshot.oldest_sequence, Some(1));
assert_eq!(snapshot.last_sequence, 6);
assert!(snapshot.truncated);
```

Add a replay-gap assertion where retained history starts at `3` and the caller
asks after `0`:

```rust
let snapshot = history.snapshot_after_bounded(0, 1024, 8);
assert_eq!(snapshot.oldest_sequence, Some(3));
assert!(snapshot.replay_gap);
```

- [ ] **Step 2: Add failing OutputBuffer tests**

Mirror the bounded byte/frame/truncation/replay-gap assertions against
`OutputBuffer::new(128)` and `push_recorded` in the existing test module.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
cargo test agent_history::tests --locked
cargo test terminal_manager::tests::bounded --locked
```

Expected: compilation fails because the snapshot types and methods do not yet exist.

- [ ] **Step 4: Implement binary-searched bounded snapshots**

Define the snapshot types next to their frame types:

```rust
pub struct AgentHistorySnapshot {
    pub frames: Vec<AgentHistoryFrame>,
    pub oldest_sequence: Option<u64>,
    pub last_sequence: u64,
    pub truncated: bool,
    pub replay_gap: bool,
}
```

and the equivalent `OutputSnapshot`. Locate the first frame with sequence
greater than the requested cursor using `VecDeque::get(mid)` binary search.
Clone frames only until either `max_frames` or `max_bytes` would be exceeded;
always permit one non-empty frame so a caller can advance its cursor.

- [ ] **Step 5: Keep legacy snapshots as wrappers**

Implement existing methods through the bounded path with `usize::MAX` limits:

```rust
pub fn snapshot_after(&self, sequence: u64) -> (Vec<AgentHistoryFrame>, u64) {
    let snapshot = self.snapshot_after_bounded(sequence, usize::MAX, usize::MAX);
    (snapshot.frames, snapshot.last_sequence)
}
```

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```bash
cargo test agent_history::tests --locked
cargo test terminal_manager::tests --locked
```

Expected: all AgentHistory and terminal-manager tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/agent_history.rs src/terminal_manager.rs
git commit -m "perf: bound terminal replay snapshots"
```

### Task 2: Bound PTY input and batch PTY output

**Files:**
- Create: `src/pty_io.rs`
- Modify: `src/main.rs`
- Modify: `src/config.rs`
- Modify: `src/agent_pty.rs`
- Modify: `src/terminal_manager.rs`

**Interfaces:**
- Produces: `PtyWriter::spawn(Box<dyn Write + Send>) -> PtyWriter`
- Produces: `PtyWriter::send(Vec<u8>) -> Result<(), PtyInputError>`
- Produces: `spawn_batched_output_reader(reader, on_output, on_error)`
- Produces: `AgentPty::is_busy() -> bool` and `ManagedTerminal::is_busy() -> bool`

- [ ] **Step 1: Add failing shared PTY I/O tests**

Use a test writer backed by `Arc<Mutex<Vec<u8>>>`. Assert that three adjacent
input messages are written in order, an input larger than
`PTY_INPUT_MESSAGE_BYTES` returns `PtyInputError::TooLarge`, and a deliberately
full queue returns `PtyInputError::Backpressure` rather than blocking.

For output batching, feed three small chunks through a cursor/channel test
reader and assert the callback receives one combined chunk. Feed more than
`PTY_OUTPUT_BATCH_BYTES` and assert it flushes without waiting for the 16 ms
deadline.

- [ ] **Step 2: Run the new module tests and confirm RED**

Run:

```bash
cargo test pty_io::tests --locked
```

Expected: compilation fails because `pty_io` is not defined.

- [ ] **Step 3: Add shared limits**

Add to `src/config.rs`:

```rust
pub const PTY_INPUT_CHANNEL_CAPACITY: usize = 256;
pub const PTY_INPUT_MESSAGE_BYTES: usize = 16 * 1024;
pub const PTY_INPUT_BATCH_BYTES: usize = 64 * 1024;
pub const PTY_OUTPUT_CHANNEL_CAPACITY: usize = 64;
pub const PTY_OUTPUT_BATCH_BYTES: usize = 64 * 1024;
pub const PTY_OUTPUT_BATCH_INTERVAL_MS: u64 = 16;
```

- [ ] **Step 4: Implement PtyWriter**

Use `std::sync::mpsc::sync_channel(PTY_INPUT_CHANNEL_CAPACITY)` and
`try_send`. The writer thread receives one chunk, drains immediately available
chunks until 64 KiB, then calls `write_all` and `flush`. `close()` sends a
close command when possible and drops the sender idempotently.

- [ ] **Step 5: Implement the output batcher**

Use one blocking reader thread and one bounded dispatcher channel. The
dispatcher starts a 16 ms deadline after the first chunk, drains available
chunks, flushes at 64 KiB, and flushes pending bytes before reporting EOF or an
error.

- [ ] **Step 6: Replace AgentPty and ManagedTerminal unbounded writers**

Replace the local writer enums and `mpsc::channel` calls with `PtyWriter`.
Map `TooLarge`, `Backpressure`, and `Closed` to explicit `anyhow!` messages
that upper layers can classify. Replace direct reader loops with the shared
batcher so history assigns one sequence per batch.

- [ ] **Step 7: Coordinate child kill and wait**

Store the shell process id before moving the child into the wait thread and
store the wait thread `JoinHandle` in a mutex. `close()` must signal the writer,
kill once through the cloned killer, take and join the wait handle, and remain
safe when called again from `Drop`.

On Unix, compare `master.process_group_leader()` with the stored shell pid in
`is_busy()`. Return `false` on unsupported platforms or missing process ids.

- [ ] **Step 8: Run focused and regression tests**

Run:

```bash
cargo test pty_io::tests --locked
cargo test agent_pty::tests --locked
cargo test terminal_manager::tests --locked
```

Expected: all tests pass; no test blocks waiting for a full input queue.

- [ ] **Step 9: Commit**

```bash
git add src/pty_io.rs src/main.rs src/config.rs src/agent_pty.rs src/terminal_manager.rs
git commit -m "perf: bound and batch PTY I/O"
```

### Task 3: Disconnect slow agent subscribers and replay safely

**Files:**
- Modify: `src/agent_workspace.rs`
- Modify: `src/agent_daemon.rs`

**Interfaces:**
- Produces: `AgentPane::subscribe() -> Receiver<AgentPaneEvent>` backed by a bounded queue
- Preserves: attach replay start/binary/replay complete framing

- [ ] **Step 1: Add failing slow-subscriber tests**

Create an `AgentPane` test helper with a subscriber capacity of two. Broadcast
three output frames without reading and assert the sender is removed. Subscribe
again, request a snapshot after the last received sequence, and assert all
remaining frames are replayed in sequence order.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
cargo test agent_workspace::tests::slow_subscriber --locked
```

Expected: the unbounded subscriber remains registered and the assertion fails.

- [ ] **Step 3: Use bounded subscriber channels**

Change subscriber storage to `Vec<SyncSender<AgentPaneEvent>>`, create channels
with a capacity of 64, and broadcast with `try_send`. Retain only successful
senders; remove both `Full` and `Disconnected` senders.

- [ ] **Step 4: Fix the attach snapshot/subscribe race**

In `serve_attach_stream`, subscribe before taking the replay snapshot. Save the
snapshot's `last_sequence`, send replay frames, then ignore queued live output
whose sequence is less than or equal to that value. Advance the value after
each successful live write.

- [ ] **Step 5: Bound the detach signal**

Replace the detach channel with `sync_channel(1)` so a disconnected reader
cannot enqueue repeated detach messages.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cargo test agent_workspace::tests --locked
cargo test agent_daemon::tests --locked
```

Expected: slow subscribers disconnect, attach replay tests pass, and existing
wire-frame tests remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/agent_workspace.rs src/agent_daemon.rs
git commit -m "fix: bound terminal subscriber queues"
```

### Task 4: Add Terminal MCP policy, principal, and grant state

**Files:**
- Create: `src/plugins/terminal_mcp/mod.rs`
- Create: `src/plugins/terminal_mcp/types.rs`
- Create: `src/plugins/terminal_mcp/principal.rs`
- Create: `src/plugins/terminal_mcp/grants.rs`
- Modify: `src/plugins/mod.rs`
- Modify: `src/state.rs`
- Modify: `src/service.rs`

**Interfaces:**
- Produces: `TerminalMcpPolicy::from_plugin(&PluginRecord)`
- Produces: `McpPrincipal::from_parts(&http::request::Parts) -> Result<McpPrincipal, TerminalMcpError>`
- Produces: `TerminalMcpManager::{authorize, request_control, wait_for_control, decide, revoke_session, revoke_all}`

- [ ] **Step 1: Add failing principal and policy tests**

Assert that lowercase/normal HTTP header lookup accepts:

```text
x-hc-user-id: lazycat
x-hc-source: cloud.lazycat.app.agent
x-hc-user-name: LazyCat
```

and rejects missing user/source headers. Add policy tests for `confirm`,
`trusted_callers`, `same_user_automatic`, `read_only`, caller deny precedence,
and malformed metadata falling back to `confirm`.

- [ ] **Step 2: Add failing grant lifecycle tests**

Create a request for `(lazycat, agent, session-1, interact)`, assert pending,
approve it, assert subsequent authorization succeeds, revoke the session, and
assert authorization becomes `CONTROL_REVOKED`. Add automatic, read-only,
plugin-disabled, duplicate-pending, timeout, and caller-created-session close
tests.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
cargo test plugins::terminal_mcp:: --locked
```

Expected: compilation fails because the module is not present.

- [ ] **Step 4: Define stable types and errors**

Define enums with Serde snake-case values:

```rust
pub enum TerminalMcpPolicyMode { Confirm, TrustedCallers, SameUserAutomatic, ReadOnly }
pub enum TerminalCapability { Interact, Create, Terminate }
pub enum ControlDecision { Pending, Approved, Denied, Revoked }
```

Define `TerminalMcpError { code: &'static str, message: String }` constructors
for every stable code in the design spec.

- [ ] **Step 5: Implement request principal extraction**

Read the platform headers only from rmcp-injected `http::request::Parts`.
Trim and length-cap user/source/name fields. Never retain `X-HC-USER-TICKET`.

- [ ] **Step 6: Implement manager state**

Store grants, pending requests, caller-created sessions, and per-request
`tokio::sync::watch` senders behind a mutex. Reuse an existing pending request
for the same key. Approval inserts a grant and wakes waiters; denial/revoke and
plugin disable wake waiters with the final decision.

- [ ] **Step 7: Register the built-in plugin**

Add a `terminal-mcp` `PluginRecord` with `enabled: false`, kind `integration`,
scopes `terminal,mcp,automation`, backends `webshell,ssh,herdr`, and metadata:

```text
defaultPolicy=confirm
trustedCallers=[]
deniedCallers=[]
```

Add `terminal_mcp: Arc<TerminalMcpManager>` to `AppState`. When
`configure_plugin` disables Terminal MCP, call `revoke_all()` after the plugin
snapshot has been persisted.

- [ ] **Step 8: Run focused tests**

Run:

```bash
cargo test plugins::terminal_mcp:: --locked
cargo test state::tests --locked
```

Expected: all principal, policy, grant, and plugin persistence tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/plugins/terminal_mcp src/plugins/mod.rs src/state.rs src/service.rs
git commit -m "feat: add terminal MCP permission state"
```

### Task 5: Build the backend-neutral terminal control service

**Files:**
- Create: `src/plugins/terminal_mcp/service.rs`
- Create: `src/plugins/terminal_mcp/herdr_adapter.rs`
- Modify: `src/plugins/terminal_mcp/mod.rs`
- Modify: `src/herdr.rs`
- Modify: `src/workspace.rs`
- Modify: `src/session_manager.rs`
- Modify: `src/service.rs`

**Interfaces:**
- Produces: `TerminalControlService::{list_sessions, read, send_text, send_keys, send_input, resize, create_session, close_session}`
- Produces: `HerdrTerminalAdapter::{list_panes, read, send_text, send_keys, send_input, resize}`
- Consumes: `McpPrincipal`, `TerminalMcpManager`, bounded history snapshots

- [ ] **Step 1: Add failing catalog and native read tests**

Build test state with WebShell, SSH, and Herdr `SessionRecord`s. Assert list
results contain the backend, status, dimensions, stable id, and no SSH secret
metadata. Fill an `OutputBuffer`, call `read(after=0, max_bytes=64 KiB)`, and
assert base64 frames and sequence metadata match.

- [ ] **Step 2: Add failing interaction/lifecycle tests**

Use a fake backend adapter to assert that read-only operations bypass control
grants, writes require `interact`, create requires `create`, an AI may close a
session recorded as its own creation, and closing a pre-existing session
requires `terminate`.

- [ ] **Step 3: Add failing Herdr mapping tests**

Use a recording Herdr executor and assert the exact method mapping:

```text
read -> pane.read or pane.wait_for_output
send_text -> pane.send_text
send_keys -> pane.send_keys
send_input -> pane.send_input
resize -> pane.resize
```

Assert a non-Herdr session, wrong selector, unknown pane, or arbitrary method
is rejected before execution.

- [ ] **Step 4: Run focused tests and confirm RED**

Run:

```bash
cargo test plugins::terminal_mcp::service --locked
cargo test plugins::terminal_mcp::herdr_adapter --locked
```

Expected: compilation fails because the service/adapters are missing.

- [ ] **Step 5: Expose narrow reusable lifecycle helpers**

Move the non-HTTP session creation logic currently embedded in
`CapabilityServiceImpl::create_session` into a `pub(crate)` helper that accepts
state, request headers, selector/backend, dimensions, and metadata. Remove the
`#[cfg(test)]` restriction from the legacy workspace session helper and keep
the ConnectRPC handler as a thin mapping layer.

- [ ] **Step 6: Expose authorized Herdr execution**

Keep `run_herdr_request_raw` private. Add a `pub(crate)` wrapper that accepts a
validated session id, pane id, one of the adapter's explicit operation enums,
and parameters, then runs the existing selector/workspace authorization and
allowlisted method implementation.

- [ ] **Step 7: Implement native and Herdr operations**

Native reads use bounded `OutputBuffer` snapshots and event subscriptions.
Native input uses the existing running terminal or agent pane; it does not
spawn a second PTY. SSH creation resolves an enabled stored profile and uses
the existing workspace/session command builder. Herdr calls use only the typed
wrapper from Step 6.

- [ ] **Step 8: Implement event-driven long reads**

Subscribe before snapshot, return immediately if output exists, otherwise
wait up to the validated timeout, then snapshot again. Enforce one outstanding
read per `(user, caller, session, pane)` key through the manager and return
`OPERATION_TIMEOUT` only for backend failures; a normal long-poll expiry
returns `timedOut: true`.

- [ ] **Step 9: Run focused tests**

Run:

```bash
cargo test plugins::terminal_mcp::service --locked
cargo test plugins::terminal_mcp::herdr_adapter --locked
cargo test service::tests --locked
cargo test workspace::tests --locked
```

Expected: catalog, output, grant enforcement, lifecycle, and Herdr mapping
tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/plugins/terminal_mcp src/herdr.rs src/workspace.rs src/session_manager.rs src/service.rs
git commit -m "feat: add terminal control backend adapters"
```

### Task 6: Mount the rmcp Streamable HTTP provider

**Files:**
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Create: `src/plugins/terminal_mcp/server.rs`
- Modify: `src/plugins/terminal_mcp/mod.rs`
- Modify: `src/router.rs`

**Interfaces:**
- Produces: `terminal_mcp::streamable_http_service(state) -> impl tower_service::Service<_>`
- Produces MCP tools named `terminal_list_sessions`, `terminal_read`, `terminal_request_control`, `terminal_wait_for_control`, `terminal_send_text`, `terminal_send_keys`, `terminal_send_input`, `terminal_resize`, `terminal_revoke_control`, `terminal_create_session`, and `terminal_close_session`

- [ ] **Step 1: Add rmcp 2.1 server dependency**

Add:

```toml
rmcp = { version = "=2.1.0", default-features = false, features = ["base64", "macros", "server", "transport-streamable-http-server"] }
```

Run `cargo check` once to resolve exactly rmcp 2.1.0 into `Cargo.lock`, then run
`cargo check --locked` to verify the committed lockfile is sufficient.

- [ ] **Step 2: Add failing router-level MCP tests**

Through `build_app(test_state)`, send an MCP `initialize` request and assert
server name `lazycat-neko-webshell-terminal`. With the plugin disabled, send
`tools/list` and assert an empty array. Enable the plugin, include
`x-hc-user-id` and `x-hc-source`, and assert the full prefixed tool list.
Call `terminal_list_sessions` without identity and assert a structured
`UNAUTHENTICATED_CALLER` tool error.

- [ ] **Step 3: Run the MCP tests and confirm RED**

Run:

```bash
cargo test plugins::terminal_mcp::server --locked
```

Expected: tests fail because the rmcp server and `/mcp` route are absent.

- [ ] **Step 4: Define typed tool schemas**

Use `serde::Deserialize` and `rmcp::schemars::JsonSchema` request structs.
Every string, byte payload, sequence, dimension, timeout, and limit is
validated before reaching `TerminalControlService`. Return structured JSON as
both MCP structured content and a concise text summary where rmcp requires a
content block.

- [ ] **Step 5: Implement dynamic list/call behavior**

Use a `ToolRouter<TerminalMcpServer>` for normal dispatch. Override
`list_tools` so a disabled plugin returns an empty list. Before dispatching
`call_tool`, extract `http::request::Parts` from `RequestContext.extensions`,
build `McpPrincipal`, verify plugin state, and map `TerminalMcpError` into an
MCP tool error result without exposing internal details.

- [ ] **Step 6: Configure stateless JSON Streamable HTTP**

Create `StreamableHttpService` with:

```rust
StreamableHttpServerConfig::default()
    .with_stateful_mode(false)
    .with_json_response(true)
    .with_sse_keep_alive(None)
    .with_allowed_hosts(["app.community.lazycat.webshell.neko.lzcx"])
```

Tests may add `localhost` explicitly. Mount it with
`Router::nest_service("/mcp", service)` before applying shared trace/security
layers.

- [ ] **Step 7: Run MCP router tests**

Run:

```bash
cargo test plugins::terminal_mcp::server --locked
```

Expected: initialize, disabled/enabled tools/list, identity rejection, and a
representative list/read call pass.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock src/plugins/terminal_mcp/server.rs src/plugins/terminal_mcp/mod.rs src/router.rs
git commit -m "feat: expose terminal MCP endpoint"
```

### Task 7: Add approval HTTP actions and notifications

**Files:**
- Create: `src/plugins/terminal_mcp/http.rs`
- Modify: `src/plugins/terminal_mcp/mod.rs`
- Modify: `src/router.rs`
- Modify: `src/pomodoro.rs`
- Modify: `src/notifications.rs`

**Interfaces:**
- Produces: `GET /api/plugins/terminal-mcp/control-state`
- Produces: `POST /api/plugins/terminal-mcp/requests/{id}/approve`
- Produces: `POST /api/plugins/terminal-mcp/requests/{id}/deny`
- Produces: `POST /api/plugins/terminal-mcp/grants/{id}/revoke`

- [ ] **Step 1: Add failing manager HTTP tests**

Create a pending request and assert control-state returns it without terminal
data. Approve it and assert the matching grant appears. Deny another request,
revoke the grant, disable the plugin, and assert all state is cleared.

- [ ] **Step 2: Add failing notification dispatch test**

Create a `terminal-mcp` notification with action
`terminal-mcp.approve`. POST the existing notification action route and assert
the manager request becomes approved before the notification is marked
actioned.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
cargo test plugins::terminal_mcp::http --locked
cargo test pomodoro::tests::terminal_mcp_notification --locked
```

Expected: the focused routes and action dispatch do not exist.

- [ ] **Step 4: Add focused HTTP handlers**

Handlers validate ids and decisions, mutate only the Terminal MCP manager, and
return typed request/grant summaries. They never accept user/caller/session ids
from the body as authorization facts.

- [ ] **Step 5: Create interactive approval notifications**

On first pending request, add one notification with source kind
`terminal-mcp`, presentation hint `modal`, escaped plain-text caller/session
details, and approve/deny actions carrying only the request id. Reused pending
requests do not create duplicate notifications.

- [ ] **Step 6: Dispatch notification actions**

Extend the existing action route to recognize `source_kind == "terminal-mcp"`
and delegate to the manager before the generic `mark_actioned` fallback.

- [ ] **Step 7: Run focused tests**

Run:

```bash
cargo test plugins::terminal_mcp::http --locked
cargo test notifications::tests --locked
cargo test pomodoro::tests --locked
```

Expected: request decisions, grant revoke, disable cleanup, and notification
dispatch pass.

- [ ] **Step 8: Commit**

```bash
git add src/plugins/terminal_mcp/http.rs src/plugins/terminal_mcp/mod.rs src/router.rs src/pomodoro.rs src/notifications.rs
git commit -m "feat: add terminal MCP approvals"
```

### Task 8: Add focused Terminal MCP frontend settings

**Files:**
- Create: `src/frontend/src/plugins/terminal-mcp/types.ts`
- Create: `src/frontend/src/plugins/terminal-mcp/policy.ts`
- Create: `src/frontend/src/plugins/terminal-mcp/policy.test.mjs`
- Create: `src/frontend/src/plugins/terminal-mcp/settings-view.test.mjs`
- Create: `src/frontend/src/plugins/terminal-mcp/api.ts`
- Create: `src/frontend/src/plugins/terminal-mcp/controller.ts`
- Create: `src/frontend/src/plugins/terminal-mcp/settings-view.ts`
- Create: `src/frontend/src/plugins/terminal-mcp/approval-view.ts`
- Modify: `src/frontend/src/plugin-utils.ts`
- Modify: `src/frontend/src/plugin-views.ts`
- Modify: `src/frontend/src/main.ts`
- Modify: `src/frontend/src/i18n/messages-en.ts`
- Modify: `src/frontend/src/i18n/messages-zh-cn.ts`

**Interfaces:**
- Produces: `normalizeTerminalMcpPolicy(metadata)` and `serializeTerminalMcpPolicy(policy)`
- Produces: `createTerminalMcpController(options)`
- Produces: `renderTerminalMcpSettingsView(state)`

- [ ] **Step 1: Add failing policy tests**

Cover all four policies, malformed JSON arrays, duplicate caller ids,
whitespace trimming, deny precedence, and round-trip metadata serialization.

- [ ] **Step 2: Add failing view tests**

Render a pending request whose reason contains `<script>` and assert the view
contains escaped text, the caller/backend/session labels, and approve/deny
buttons. Render active grants and assert revoke buttons and the no-confirmation
warning are present.

- [ ] **Step 3: Run focused frontend tests and confirm RED**

Run:

```bash
node --test --experimental-strip-types \
  src/frontend/src/plugins/terminal-mcp/policy.test.mjs \
  src/frontend/src/plugins/terminal-mcp/settings-view.test.mjs
```

Expected: module imports fail because the plugin frontend does not exist.

- [ ] **Step 4: Implement policy types and normalization**

Keep metadata keys identical to the backend:

```text
defaultPolicy
trustedCallers
deniedCallers
```

Serialize caller lists as sorted JSON arrays and never write unknown policy
strings.

- [ ] **Step 5: Implement API and controller**

The controller fetches control state while the plugin is enabled and settings
are visible, approves/denies/revokes through the focused endpoints, and asks
the existing plugin configurator to persist policy metadata. Disabling the
plugin stops polling and clears local pending/grant state.

- [ ] **Step 6: Implement focused settings and approval views**

Render policy selection, trusted/denied caller inputs, pending requests,
active grants, and the static-resource-discovery explanation. Use existing
escaping and command-button patterns. Keep all Terminal MCP-specific markup in
the plugin directory.

- [ ] **Step 7: Wire the plugin with thin composition changes**

Add a Terminal MCP id/icon/labels in `plugin-utils.ts`. Add one branch in
`plugin-views.ts` that delegates to `renderTerminalMcpSettingsView`. In
`main.ts`, construct the controller, route data attributes to controller
methods, and pass view state; do not add policy parsing or markup helpers.

- [ ] **Step 8: Run focused tests, typecheck, and build**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all frontend tests pass, TypeScript reports no errors, and Vite
produces the production bundle.

- [ ] **Step 9: Commit**

```bash
git add src/frontend/src/plugins/terminal-mcp src/frontend/src/plugin-utils.ts src/frontend/src/plugin-views.ts src/frontend/src/main.ts src/frontend/src/i18n/messages-en.ts src/frontend/src/i18n/messages-zh-cn.ts
git commit -m "feat: add terminal MCP settings UI"
```

### Task 9: Export the LazyCat MCP resource and verify end to end

**Files:**
- Create: `resources/mcp-providers/terminal-control/mcp.yml`
- Modify: `lzc-build.yml`
- Test: `src/plugins/terminal_mcp/server.rs`

**Interfaces:**
- Produces: LazyCat MCP provider id `terminal-control`
- Produces: endpoint `/mcp`

- [ ] **Step 1: Add the resource descriptor**

Create exactly:

```yaml
endpoint: /mcp
```

- [ ] **Step 2: Extend resource exports**

Keep the existing LightOS WebShell export and add:

```yaml
  - kind: mcp-providers
    source: ./resources/mcp-providers
```

- [ ] **Step 3: Add a resource-layout regression test**

Read `lzc-build.yml` and the provider descriptor in a Rust test. Assert the
build config contains both resource kinds, the descriptor endpoint is exactly
`/mcp`, and `package.yml` still declares `min_os_version: v1.5.2` or newer.

- [ ] **Step 4: Run full Rust verification**

Run:

```bash
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

Expected: formatting, all tests, and Clippy pass without warnings.

- [ ] **Step 5: Run full frontend verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all frontend tests pass and the production bundle builds.

- [ ] **Step 6: Run package and diff checks**

Run:

```bash
git diff --check
lzc-cli project release -o /tmp/lazycat-neko-webshell-terminal-mcp.lpk
lzc-cli lpk info /tmp/lazycat-neko-webshell-terminal-mcp.lpk
```

Expected: no whitespace errors; the LPK builds and contains
`resources/mcp-providers/terminal-control/mcp.yml`. If `lzc-cli` is unavailable
or the host lacks release dependencies, record the exact command failure and
still inspect the staged resource files directly.

- [ ] **Step 7: Perform an MCP smoke test**

Start the server in its test configuration and send `initialize`, `tools/list`,
`terminal_list_sessions`, and a denied write without a grant. Assert the
provider identifies itself, tools are visible only when enabled, same-user
identity is required, and the denied write returns
`CONTROL_APPROVAL_REQUIRED` rather than reaching the PTY.

- [ ] **Step 8: Commit**

```bash
git add resources/mcp-providers/terminal-control/mcp.yml lzc-build.yml src/plugins/terminal_mcp/server.rs
git commit -m "feat: publish terminal MCP resource"
```

- [ ] **Step 9: Review the final diff**

Run:

```bash
git status --short
git log --oneline -10
git diff bf18d68..HEAD --stat
```

Expected: only Terminal MCP, PTY hardening, focused frontend wiring, docs, and
LazyCat resource files are present; no release version/tag/publish action has
been performed.
