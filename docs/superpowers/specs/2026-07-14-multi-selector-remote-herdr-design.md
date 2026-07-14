# Multi-selector Tabs and Remote Herdr Design

## Status

Approved. The user accepted the recommended scope on 2026-07-14 and asked for
implementation.

## Goal

Keep local LightOS, SSH, and remote-client terminals open in one shared tab bar
without destroying inactive terminals when the selected device changes. Remote
client tabs render as a single remote-device icon. A remote client may also
open Herdr by launching the installed `herdr` program inside the official
client-terminal PTY.

## Non-goals

- Do not modify the LazyCat `client-terminal` service.
- Do not add a new remote terminal protocol or replace the official workspace
  and WebSocket APIs.
- Do not expose a remote Herdr workspace list, tab list, socket API, or Herdr
  dock controls.
- Do not proxy a remote Herdr Unix socket through RemoteSocks, a hidden terminal
  pane, a TCP helper, or a custom uploaded bridge.
- Do not change the local LightOS Herdr transport, zellij behavior, SSH
  profiles, terminal renderer, or plugin transport rules.
- Do not put workspace reconciliation, ID formatting, or tab presentation
  helpers into `src/frontend/src/main.ts`.

## Current behavior and constraints

The backend already treats each selector as an independent authoritative
workspace. Normal LightOS selectors are owned by the target agent, SSH
selectors are owned by the local provider, and `client:<id>` selectors are
owned by the official remote client-terminal service.

The frontend currently destroys this separation when it applies a workspace:
`applyWorkspaceState` clears `tabs`, clears the terminal stage, and disposes
every pane not present in the latest single-selector response. Selecting a
remote device therefore hides and disconnects the current local terminal.

Raw workspace IDs are not globally unique. The official Go client-terminal
creates `tab-1`, `tab-2`, `pane-1`, and `pane-2` independently inside every
selector workspace. A combined tab bar must therefore never use raw tab or
pane IDs as application-wide identities.

The remote client-terminal contract supports native WebShell workspace actions
and PTY WebSockets. It does not expose arbitrary noninteractive command
execution or Unix socket forwarding. Its PTY is nevertheless sufficient to
run an installed full-screen terminal program such as Herdr.

Local Herdr controls use `lightosctl exec -i` to reach a target-local Unix
socket. That transport is intentionally unavailable for `client:<id>`
selectors. The LazyCat ShellAPI `DialBoxService` direction is PC client to box,
not box to remote PC, and HPortalSys RemoteSocks exposes TCP/UDP rather than a
remote Unix socket. The remote Herdr control surface is therefore outside this
design.

## Selected architecture

The implementation has three independent layers:

1. A selector-aware frontend workspace collection reconciles only the tabs and
   panes belonging to the workspace response being applied.
2. Navigation presentation renders remote tabs as icon-only entries while
   retaining descriptive title and accessibility text.
3. The existing remote WebShell transport may carry a provider-owned
   `program_kind = herdr` marker. The backend creates a normal official remote
   pane and injects a one-time Herdr launch command after remote history replay
   completes.

```text
instance selector
      |
      v
GET selector workspace -----> selector-aware reconciliation
                                      |
                   +------------------+------------------+
                   |                                     |
              local tabs                         remote icon tabs
                                                         |
                                                create remote Herdr
                                                         |
                                                official create_tab
                                                         |
                                                official PTY WebSocket
                                                         |
                                              replay-complete observed
                                                         |
                                                one-time `exec herdr`
```

No new service, cross-process daemon, network listener, SDK protocol, or remote
client dependency is introduced.

## Frontend identity model

`TerminalTab.id` and `TerminalPane.id` become frontend-global IDs. They are
derived from the selector, entity kind, and backend raw ID through a focused
workspace identity helper. They are safe for DOM attributes, maps, active-tab
state, terminal-control ownership, pending socket sets, AI terminal targets,
and event handlers.

Each object also retains the authoritative backend ID:

- `TerminalTab.workspaceTabId`: raw tab ID sent to workspace actions.
- `TerminalPane.workspacePaneId`: raw pane ID sent to workspace actions and
  used for replay identity checks.
- `TerminalPane.sessionId`: existing backend session identity. For remote
  clients it remains the raw pane ID supplied by client-terminal.

Workspace layout nodes are normalized from raw pane IDs to frontend-global pane
IDs when a selector response is restored. Layouts are converted back to raw
pane IDs only at the workspace action boundary. Unknown or mismatched pane IDs
invalidate the layout rather than falling through to another selector.

The identity helper must support migration from existing URL/localStorage raw
tab IDs. A raw remembered tab ID is resolved only inside the selected selector;
new writes store the backend raw ID in the URL and per-selector storage so URLs
remain readable and server-oriented.

## Selector-aware workspace collection

A focused frontend module owns selector reconciliation. Applying workspace `S`
performs the following operation:

1. Retain every tab whose selector is not `S`.
2. Reuse matching `S` panes only when the global pane ID, session ID, transport
   backend, and program kind remain compatible.
3. Restore or create the tabs and panes returned for `S`.
4. Dispose only stale panes that belong to `S`.
5. Preserve the globally active tab when applying a background response unless
   the response explicitly represents a user selection or the active tab was
   removed.
6. Insert the selected selector's tabs together while preserving the ordering
   returned by that selector's workspace authority.

The existing single `selectedSelectorGeneration` guard is replaced or wrapped
by selector-scoped request generations. A request for one selector must not be
discarded merely because the user activates a tab belonging to another
selector, and a stale response for selector `S` must not overwrite a newer
response for the same selector.

`selectedSelector` follows the active tab. Activating a tab updates the URL,
per-selector active-tab memory, instance chrome, session backend list, and local
Herdr state for that tab's selector. Selecting an instance loads and activates
that selector without removing other selectors.

An ordered list of open selectors is stored in localStorage. Startup restores
the URL-selected workspace first, then fetches the other remembered selectors
as background workspaces. Missing, stopped, unauthorized, or removed selectors
are removed from the remembered open list without affecting workspaces that
still load successfully.

The local Herdr state and session-backend state remain active-selector state;
they are refreshed when the active selector changes. Background local Herdr
tabs may use the generic Herdr label until their selector becomes active.

## Remote tab presentation

Tab presentation remains owned by tab/navigation modules.

`TabViewItem` gains an optional icon-only presentation. A tab whose selector is
`client:<id>` renders exactly one remote-device icon and no visible title text,
including when the remote pane runs Herdr. The tab keeps:

- a title containing the device name, backend/program description, and current
  pane title;
- an accessible label with the same information;
- the existing status tone indicator and close action.

Remote tab custom labels and inferred process titles affect the tooltip and
document title but do not add visible text to the tab strip. Remote tabs remain
unpinned because the official remote action contract does not support pinning.

## Remote Herdr model

Remote Herdr is a program launched over the official WebShell transport, not a
new session transport.

The wire/frontend workspace pane model gains an optional `program_kind` whose
only initial value is `herdr`. A remote Herdr pane has:

- `session_backend = webshell`;
- `program_kind = herdr`;
- the normal client-terminal pane/session ID;
- normal remote terminal replay, keepalive, control, resize, and reconnect
  behavior.

This separation prevents remote Herdr panes from entering local-only Herdr
socket actions, Herdr output-sequence persistence, Herdr split behavior, or the
Herdr event bridge.

The remote session-backend response advertises WebShell and Herdr. Herdr is
presented as an optimistic program option because the public client-terminal
contract has no side-effect-free command-availability probe. Launch failure is
reported inside the created terminal and as normal process-exit state.

## Remote program metadata

The provider stores remote program metadata server-side so desktop and mobile
browsers agree and a browser-local cache is not authoritative.

The metadata key is `(selector, workspace_pane_id)` and records:

- program kind (`herdr`);
- bootstrap state (`pending` or `sent`);
- update timestamp for diagnostics and bounded cleanup.

The data is stored through the existing SQLite-backed `app_kv` facility under
a dedicated key. It contains no ticket, device token, command output, user
input, or other credential material.

Every successful remote workspace GET/action reconciles stored entries for that
selector against the returned pane IDs. Entries for panes confirmed absent are
deleted. An unavailable remote client does not delete metadata because absence
was not observed authoritatively.

Closing a mapped tab or pane performs the normal official action first, then
removes metadata after the returned workspace confirms removal.

## Remote Herdr creation and bootstrap

When a `client:<id>` create-tab action requests Herdr:

1. Re-authorize the visible client and obtain the normal terminal ticket.
2. Send the official native `create_tab` action.
3. Identify the new active tab and active pane from the returned workspace.
4. Store `(selector, pane_id) -> { program_kind: herdr, bootstrap: pending }`.
5. Rename the official remote tab to `Herdr` through the existing rename action
   so other official client-terminal views receive a useful label.
6. Return the converted workspace with `session_backend = webshell` and
   `program_kind = herdr`.

The terminal relay observes the official remote history-replay completion
frame. For a pending Herdr pane it sends one normal terminal input message with
a portable shell command equivalent to:

```sh
if command -v herdr >/dev/null 2>&1; then
  exec herdr
elif [ -x "$HOME/.local/bin/herdr" ]; then
  exec "$HOME/.local/bin/herdr"
else
  printf '%s\n' 'Herdr is not installed on this remote device.'
  exit 127
fi
```

The bootstrap is never sent before replay completes, because early input is
locked or queued by both provider implementations. A successful WebSocket send
updates the persisted metadata to `sent` and starts a connection-local launch
attempt. If the same connection immediately returns the explicit
terminal-control rejection before any terminal output from the attempt, the
metadata is reverted to `pending`. Reconnects and browser reloads otherwise do
not resend a `sent` bootstrap, so terminal input is never injected into an
already-running Herdr UI.

When another client owns input, the pane reports the existing terminal-control
error and retries only on a later fresh attach that obtains write control. It
does not loop while the same rejected connection remains open.

## Module boundaries

Frontend responsibilities:

- `workspace-identity.ts` owns global IDs and raw/global layout conversion.
- `workspace-collection.ts` owns selector reconciliation, selector ordering,
  active-tab fallback, and stale-pane selection.
- `open-workspaces.ts` owns localStorage persistence for open selector order.
- `tab-labels.ts` owns remote tooltip/display semantics.
- `navigation-views.ts` owns icon-only tab markup and patching.
- `remote-client-terminal.ts` owns remote program presentation and replay-side
  policy helpers.
- `main.ts` only wires loading, reconciliation callbacks, activation, and UI
  refreshes.

Backend responsibilities:

- `client_terminal.rs` keeps the official remote workspace/terminal adapter,
  recognizes Herdr create requests, and attaches remote program metadata during
  conversion.
- A focused `remote_program.rs` module owns persistence, reconciliation,
  bootstrap state transitions, and the launch command.
- `session_backend.rs` advertises the optimistic remote Herdr program option.
- `database.rs` remains the generic SQLite/KV implementation; program policy
  does not live there.
- `terminal.rs` continues routing remote client connections but does not gain
  Herdr-specific launch logic.

No plugin-specific UI is added to `main.ts`, `plugin-views.ts`, or broad shared
view files.

## Error handling

- A remote selector that is no longer visible remains `403`.
- Ticket, device authentication, and remote service failures keep their current
  redacted `502`/`504` behavior.
- A remote workspace identity mismatch aborts only that selector response.
- An invalid global/raw layout mapping falls back to a single valid pane layout
  for that tab and never references a pane from another selector.
- Herdr missing on the remote device exits the new pane with an explicit
  terminal message.
- A remote device going offline leaves other selector tabs attached and usable.
- A failed background workspace restore removes only that selector from the
  browser's open-selector list.
- Remote bootstrap state is not cleared on a transient network error.
- Metadata persistence failure prevents automatic Herdr bootstrap and reports a
  server error; it does not launch an untracked program that could be injected
  again after restart.

## Testing

Pure frontend tests must cover:

- two selectors both containing `tab-1` and `pane-1` produce distinct global
  identities;
- raw/global layout conversion is reversible and rejects cross-selector IDs;
- reconciling selector B keeps selector A tabs, mounts, sockets, active state,
  and pane objects;
- stale panes are disposed only within the reconciled selector;
- background responses do not steal active-tab selection;
- activating a tab changes the selected selector and stores the raw tab ID;
- open selector ordering round-trips through localStorage and drops failed
  selectors;
- remote tabs render one remote icon with no visible text and retain accessible
  title content;
- remote Herdr panes remain WebShell transport panes and never satisfy local
  `isHerdrTab` behavior.

Rust tests must cover:

- remote WebShell actions keep existing wire compatibility;
- remote Herdr is accepted only for create-tab and is translated to the native
  official create action;
- the created pane receives persisted Herdr program metadata;
- workspace conversion attaches program metadata by selector and raw pane ID;
- metadata reconciliation removes only authoritatively missing panes;
- bootstrap is emitted once after replay complete, not before replay and not
  after the state is `sent`;
- controller rejection leaves bootstrap pending without a busy retry loop;
- remote Herdr terminal connections still use backend `webshell`;
- tickets, device tokens, and bootstrap state never appear in diagnostics.

Repository verification remains:

```bash
npm test
npm run typecheck
npm run build
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
scripts/build-release.sh
lzc-cli project release
```

Real-device acceptance must cover desktop and mobile:

1. Open a local LightOS terminal, then a remote client terminal; both remain in
   the same tab strip and continue receiving output.
2. Switch repeatedly between local and remote tabs; URL, instance status, new
   tab backend list, keyboard input, and resize follow the active tab.
3. Open two remote clients whose official workspaces both contain `tab-1` and
   `pane-1`; actions affect only the intended client.
4. Confirm every remote tab is icon-only on desktop and mobile.
5. Create remote Herdr, verify it starts once, then refresh and reconnect
   without injecting the launch command into the running UI.
6. Open the same remote Herdr tab from desktop and mobile and verify both attach
   to the same authoritative remote pane.
7. Verify a device without Herdr produces the explicit terminal error while
   local and other remote tabs remain usable.
8. Take terminal control from another client and confirm bootstrap waits for a
   later writable attach rather than repeatedly sending input.

## Rollout and rollback

The work is split into independently useful, mergeable phases:

1. Global workspace identity and multi-selector reconciliation, with existing
   single-selector behavior preserved by tests.
2. Remote icon-only tab presentation and open-selector restoration.
3. Remote Herdr program metadata, create flow, and one-time bootstrap.

If phase 3 shows a real-device incompatibility, remote Herdr can be removed by
stopping advertisement of the remote Herdr option while retaining phases 1 and
2. Existing official remote WebShell panes and local Herdr sessions remain
valid. Stored remote program metadata is non-destructive and can be ignored or
deleted without touching remote terminal state.

## Premise collapse

The remote Herdr launch assumes the official remote PTY starts a POSIX shell
that can resolve `herdr` or `$HOME/.local/bin/herdr`. The current official
client-terminal implementation itself uses `/bin/sh`, and the user's remote
device already has Herdr, so this premise is currently satisfied. If a future
client-terminal platform does not provide that shell contract, multi-selector
tabs and remote icons remain valid, while remote Herdr must be hidden for that
platform until the official service exposes a program-launch capability.
