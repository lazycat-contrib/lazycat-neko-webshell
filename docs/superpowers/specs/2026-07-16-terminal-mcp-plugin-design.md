# Terminal MCP Plugin and PTY Backpressure Design

## Status

Approved for implementation. The user selected an in-process MCP plugin with
backend adapters and delegated the remaining design review as long as the
agreed scope does not change.

## Goal

Publish Neko WebShell as a LazyCat MCP provider so same-user AI applications
can discover terminal sessions, inspect their backend type and output, and
interact with WebShell, SSH, and existing Herdr sessions. The provider must
support both confirmation-based and trusted unattended control, preserve the
current sequence/replay protocol, and remove the unbounded PTY input and slow
subscriber queues that would otherwise make AI-driven terminal sessions an
unbounded memory risk.

Representative workflows are:

- ask an AI to open Codex in a WebShell session and continue the interactive
  conversation;
- let an AI read an existing Herdr pane, answer a confirmation prompt, and
  modify the running task through Herdr SockAPI;
- create an SSH session from an existing profile and let an AI perform remote
  maintenance without exposing stored credentials through MCP.

## Selected architecture

The MCP provider is a built-in plugin inside the existing Rust process. It is
not part of AI Chat and does not simulate the browser WebSocket protocol.

```text
LazyCat MCP consumer
        |
        | Streamable HTTP + platform user identity
        v
     POST /mcp
        |
        +-- MCP transport and tool schemas
        +-- principal and plugin-policy checks
        +-- control grant manager
        +-- TerminalControlService
                 |
                 +-- WebShell/SSH adapter -> SessionManager/ManagedTerminal
                 +-- agent pane adapter  -> AgentWorkspace sequence/replay
                 +-- Herdr adapter       -> Herdr SockAPI
```

`src/plugins/terminal_mcp/` owns the MCP transport, tool definitions,
principal extraction, policy/grant state, backend-neutral service, and backend
adapters. `src/router.rs` only mounts the `/mcp` service and the focused plugin
HTTP endpoints needed by the WebShell approval UI.

The frontend plugin lives under
`src/frontend/src/plugins/terminal-mcp/`. It owns settings presentation,
permission-policy types, approval views, and AI-control indicators.
`src/frontend/src/main.ts` is limited to event binding and calling the focused
plugin controller/view functions.

## LazyCat resource publication

The existing LPK v2 package already requires `min_os_version: v1.5.2`, which
is the minimum version for MCP resource export and `.lzcx` app interconnect.

`lzc-build.yml` will keep the existing `lightos.webshell` export and add:

```yaml
resource_exports:
  - kind: lightos.webshell
    source: ./resources/lightos.webshell
  - kind: mcp-providers
    source: ./resources/mcp-providers
```

The provider descriptor is:

```text
resources/mcp-providers/terminal-control/mcp.yml
```

with:

```yaml
endpoint: /mcp
```

Consumers discover the resource through `import_resources: [{kind:
mcp-providers}]`, declare `lzcapp.user_delegate`, and access:

```text
http://app.community.lazycat.webshell.neko.lzcx/mcp
```

The consumer captures `X-HC-USER-TICKET` from a real LazyCat user request and
sends that ticket to the `.lzcx` endpoint. The LazyCat interconnect validates
the ticket and projects the current user and calling application into the
request headers delivered to the provider.

The provider itself does not need `lzcapp.user_delegate` merely to serve its
own MCP endpoint. The first release intentionally does not add an external
Bearer-token authentication path.

## MCP transport and identity boundary

The server uses `rmcp 2.1` Streamable HTTP in stateless JSON-response mode.
This avoids unnecessary SSE framing for request/response tools while remaining
compatible with LazyCat MCP discovery. The server allows the canonical
`.lzcx` host and keeps request-size and origin/host validation enabled.

Every tool invocation extracts the platform-injected HTTP request parts from
the rmcp request context. It requires a non-empty, bounded
`X-HC-USER-TICKET` together with the platform-projected user id and caller
source. The provider treats the ticket as an opaque proof that the request
used the LazyCat delegated path: it does not parse, persist, log, or copy the
ticket into the principal. A principal contains:

- LazyCat user id;
- calling application/source id;
- optional display name for UI only; and
- a non-secret request correlation id.

The ticket, user id, and caller source are all required for tool calls. A
request that supplies identity headers without a ticket is rejected as an
unauthenticated caller. Raw user tickets, bearer-like headers, terminal input,
SSH passwords, and private keys are never logged or returned. Session
visibility continues to use the project's existing selector and workspace
authorization rules; MCP does not introduce a broader listing path.

Terminal UI approval endpoints are a separate browser-only boundary. Any
request carrying either `X-HC-USER-TICKET` or `X-HC-SOURCE` is treated as a
delegated application request and cannot approve, deny, or revoke its own MCP
grant through the UI API.

Because the application is multi-instance, most user isolation is also
provided by the LazyCat instance boundary. Server-side ownership checks remain
mandatory so a malformed or forged session id cannot cross selectors,
workspaces, panes, or backend types.

## Plugin switch and permission policy

`terminal-mcp` is a built-in plugin that is disabled by default. The static
MCP resource remains discoverable when the runtime plugin is disabled, because
LPK resource export is a build-time capability. Runtime behavior is:

- `initialize` remains valid;
- `tools/list` returns no terminal tools while disabled; and
- cached `tools/call` requests return `TERMINAL_MCP_DISABLED`.

Disabling the plugin immediately denies new calls, revokes active grants,
denies pending requests, and wakes any waiting approval calls.

The plugin stores a default control policy and optional caller-specific rules
in persisted plugin metadata. Supported policies are:

- `confirm`: list/read are allowed; the first write for a session requires
  Terminal-side approval;
- `trusted_callers`: configured LazyCat caller application ids receive
  automatic control while other callers use confirmation;
- `same_user_automatic`: any authenticated same-user caller receives
  automatic control;
- `read_only`: list/read are allowed and every control or lifecycle operation
  is denied.

The default is `confirm`. A caller-specific deny rule takes precedence over
automatic modes. Users can revoke a caller or a session grant at any time.

## Terminal-side approval flow

Approval is enforced by Neko WebShell, not delegated to the AI client.

1. The AI lists or reads a session.
2. A write/lifecycle tool without a grant creates or reuses a pending control
   request keyed by user, caller, session, and capability.
3. The tool returns the structured code `CONTROL_APPROVAL_REQUIRED` with a
   request id.
4. Neko WebShell creates an interactive notification containing the caller,
   session/backend, requested capability, and escaped reason text.
5. The user approves or denies from the Terminal UI. The AI may call
   `terminal_wait_for_control` to wait for the result.
6. An approved grant is stored server-side and subsequent calls are checked
   against it; no transferable grant token is returned to the AI.

The grant key is `(user_id, caller_app_id, session_id)`. Grants end when the
session/pane closes, the user revokes them, the caller rule changes, or the MCP
plugin is disabled. The terminal UI shows which caller currently controls a
session and exposes an immediate revoke action.

Automatic modes use the same server-side grant checks and visible control
indicator; they only skip the pending-confirmation step. An AI may close a
session it created without another confirmation. Closing a pre-existing
session remains a distinct `terminate` capability so the default confirmation
policy cannot accidentally kill a user's running Codex, SSH, or maintenance
task.

## MCP tool contract

Tool names use the `terminal_` prefix and typed JSON schemas. Errors always
use stable machine-readable codes plus a concise human-readable message.

### Discovery and output

- `terminal_list_sessions`
  - filters by optional backend and status;
  - returns stable session id, backend (`webshell`, `ssh`, or `herdr`), title,
    selector/target summary, dimensions, status, creator source when known,
    and current control state;
  - Herdr sessions include existing workspace/tab/pane ids and presentation
    labels without leaking arbitrary metadata tokens.
- `terminal_read`
  - input: session id, optional Herdr pane id, `afterSequence`, `waitMs`, and
    `maxBytes`;
  - output: ordered raw-byte frames encoded as base64, next/last/oldest retained
    sequence, timeout/truncation flags, and exit state;
  - default response limit is 64 KiB, hard maximum is 256 KiB, and `waitMs` is
    capped at 60 seconds.

`terminal_read` is an event-driven long poll, not a timed polling loop. The
caller may keep at most one outstanding read per caller/session/pane key. The
browser terminal continues using its existing WebSocket transport; MCP is not
a replacement high-frame-rate renderer.

### Interaction

- `terminal_request_control`: creates or reports the current control request;
- `terminal_wait_for_control`: waits for approval/denial with a bounded timeout;
- `terminal_send_text`: sends bounded UTF-8 text and optionally appends Enter;
- `terminal_send_keys`: sends allowlisted terminal key/chord names such as
  Enter, Escape, arrows, Tab, Ctrl-C, and Ctrl-D;
- `terminal_send_input`: sends bounded base64 bytes for terminal protocols that
  cannot be represented as text or named keys;
- `terminal_resize`: validates and applies rows/columns;
- `terminal_revoke_control`: lets a caller release its own grant.

### Lifecycle

- `terminal_create_session`: creates WebShell or SSH sessions. SSH creation
  references an existing profile id or config host and never returns stored
  credentials. Herdr workspace/pane creation is excluded from the first
  release.
- `terminal_close_session`: closes a WebShell/SSH session subject to the
  `terminate` policy. Herdr pane/session close is excluded until the supported
  SockAPI contract and product semantics are explicitly extended.

## Backend adapters

### WebShell and SSH

The native adapter uses `SessionManager`, `ManagedTerminal`, and existing
workspace/session mutation paths. It must not create a second PTY for an
already-running session. SSH sessions use the existing profile/config-host
resolution and command construction so MCP cannot bypass credential storage
rules.

Native output is read from the existing bounded history with the current
monotonic sequence values. Interaction writes to the existing PTY input path.

### Agent-managed WebShell panes

Agent panes keep the current agent protocol, `AgentHistory`, and attach replay
frames. The MCP adapter reads the same history and subscribes to the same pane
events. No absolute byte-offset protocol is introduced.

### Herdr

The Herdr adapter exposes a narrow typed wrapper around the existing private
request implementation. It first verifies that the session is a Herdr
session, belongs to the selected instance/workspace, and refers to an existing
pane. It then maps:

- listing/snapshot to `session.snapshot` and `pane.list/get`;
- reading to `pane.read` and `pane.wait_for_output`;
- text/keys/raw input to `pane.send_text`, `pane.send_keys`, and
  `pane.send_input`;
- resize to `pane.resize`.

The wrapper keeps the current method allowlist, request-size cap, timeout, and
LightOS selector authorization. MCP cannot submit arbitrary Herdr method
names.

## Sequence reads and replay performance

The existing history limits remain authoritative: at most 20,000 retained
frames and 16 MiB per session, with lower per-session limits allowed.

`snapshot_after()` will gain a bounded variant that locates the first sequence
greater than `afterSequence` without cloning the complete retained history,
then stops at the requested byte/frame limit. It reports the oldest retained
sequence so callers can detect a replay gap. A read subscribes before taking
its snapshot, then rechecks after notification, avoiding the snapshot/subscribe
race.

The 16 ms PTY output batcher reduces sequence-frame count and transport
overhead. It also flushes immediately at 64 KiB, on exit/error, and before the
batcher stops, so sustained output cannot grow the pending batch without a
bound.

## PTY backpressure and lifecycle hardening

The project will adopt the useful Grok Shell PTY patterns while retaining the
Neko sequence/replay contract.

- Replace unbounded input channels with capacity-256 bounded channels.
- Cap one input item at 16 KiB and one coalesced writer batch at 64 KiB.
- Merge immediately available consecutive input before `write_all` and
  `flush`.
- Batch output for up to 16 ms or 64 KiB before assigning a sequence frame.
- Replace agent pane subscriber queues with bounded queues. A full subscriber
  is disconnected; it reconnects with its last sequence and replays history.
- Bound the PTY-reader-to-dispatcher queue so the internal output path cannot
  grow indefinitely either.
- Preserve the shell process id and use the PTY foreground process group on
  Unix to report whether a foreground command is active. Unsupported
  platforms return an unknown/false state without blocking control.
- Close by signalling the writer, killing the child once, and coordinating
  with the existing child wait thread so reaping completes. Close is
  idempotent.

Queue-full input is never silently dropped. The operation returns
`TERMINAL_INPUT_BACKPRESSURE`, allowing the MCP or WebSocket caller to retry.
Slow output subscribers are intentionally disconnected because replay makes
that safer than retaining unbounded per-client memory.

## Error semantics

Stable errors include:

- `TERMINAL_MCP_DISABLED`
- `UNAUTHENTICATED_CALLER`
- `CALLER_NOT_AUTHORIZED`
- `SESSION_NOT_FOUND`
- `BACKEND_NOT_SUPPORTED`
- `PANE_NOT_FOUND`
- `CONTROL_APPROVAL_REQUIRED`
- `CONTROL_DENIED`
- `CONTROL_REVOKED`
- `TERMINAL_INPUT_BACKPRESSURE`
- `REPLAY_GAP`
- `INVALID_SEQUENCE`
- `INVALID_INPUT`
- `OPERATION_TIMEOUT`
- `TERMINAL_EXITED`

Expected operational failures are returned as MCP tool errors rather than
transport failures. Internal errors are logged with correlation ids, not raw
terminal data, and return a generic message.

## Frontend behavior

The Terminal MCP settings view contains:

- the existing plugin enable switch;
- control-policy selection;
- trusted/denied caller application ids;
- current grants and pending requests;
- revoke actions; and
- an explanation that resource discovery remains visible while disabled.

Approval requests use the existing notification presentation system with
Terminal MCP-specific actions. The notification action dispatcher delegates
Terminal MCP actions to the plugin manager rather than marking them actioned
without applying the grant.

Session/tab presentation shows a compact AI-control indicator only while a
grant is active. No MCP settings or approval implementation is added directly
to `main.ts` or the broad `plugin-views.ts` module; those files only route data
and events to the focused plugin modules.

## Audit and sensitive data rules

Audit events record timestamp, user, caller application id, session id,
backend, capability, decision, and byte count where relevant. They do not
record raw input, terminal output, SSH passwords, private-key contents, user
tickets, or bearer-like headers.

AI-provided reason strings are untrusted text. They are length-capped, stored
only with the pending request, and rendered with normal HTML escaping.

## Verification

Focused Rust tests cover:

- dynamic empty tool lists and denied calls while the plugin is disabled;
- principal extraction and missing/forged identity rejection;
- rejection of projected identity headers when the internal user ticket is
  missing or oversized;
- rejection of delegated approval requests identified by either the ticket or
  caller-source header;
- policy precedence, trusted callers, automatic mode, read-only mode,
  approval, denial, revocation, and session-close cleanup;
- session/backend listing and ownership filtering;
- bounded sequence reads, timeout, truncation, replay gaps, and the
  subscribe-before-snapshot race;
- Herdr method mapping and rejection of non-allowlisted methods;
- WebShell/SSH creation and close policy without credential disclosure;
- bounded input coalescing and backpressure;
- 16 ms/64 KiB output flushing;
- slow subscriber disconnection followed by sequence replay;
- foreground process detection where supported; and
- idempotent kill-and-wait lifecycle behavior.

Frontend tests cover settings serialization, policy rendering, escaped
approval reasons, approve/deny/revoke actions, and the active-control
indicator without growing `main.ts` with plugin-specific helpers.

Integration verification performs an MCP `initialize`, `tools/list`, and
representative `tools/call` requests through the Axum router using LazyCat
identity headers. It verifies the exported `mcp.yml`, LPK resource layout,
Rust formatting/tests, frontend tests/type checking/build, and whitespace.

## Delivery order

1. Harden PTY queues, batching, bounded replay reads, and child lifecycle.
2. Add the backend-neutral terminal control service and adapters.
3. Add policy/grant/approval state and notification dispatch.
4. Mount the rmcp Streamable HTTP provider and tool contracts.
5. Add the focused frontend settings and approval UI.
6. Export the LazyCat MCP resource and run full verification.

This order prevents the MCP provider from introducing new slow consumers
before the terminal data path has bounded backpressure.

## Non-goals

- Do not migrate to Grok's absolute output-offset protocol or add a second
  backend terminal emulator.
- Do not replace the browser terminal WebSocket with MCP.
- Do not expose an unauthenticated/public Bearer-token MCP endpoint.
- Do not return SSH secrets or accept arbitrary private-key content through
  MCP.
- Do not create or close Herdr workspaces, tabs, or panes in the first release.
- Do not refactor the AI Chat MCP client as part of this provider feature.
- Do not add terminal/plugin-specific implementation to frontend `main.ts`.
