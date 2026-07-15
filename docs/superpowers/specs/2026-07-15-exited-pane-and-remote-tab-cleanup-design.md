# Exited Pane And Remote Tab Cleanup Design

## Status

Accepted. The user reported the defects, delegated the implementation choice, and requested a patch release with a pushed tag.

## Goal

Remove a split pane after its terminal process exits, and prevent a remote device workspace from being reopened after its final tab was explicitly closed.

## Confirmed causes

- The frontend marks a live `process-exit` pane as exited but does not reload authoritative workspace state. Restored workspace responses also render `status: exited` panes unchanged, so a missed event preserves the dead split node.
- The Rust agent marks exited panes but does not repair split topology when state is requested.
- An empty workspace remains in `openSelectors`, remembered selector/tab storage, and the current URL. Startup can therefore select and reload the remote target again.

## Selected design

On a real `process-exit`, reload authoritative workspace state. A focused controller ignores duplicate events for the same pane while queuing another reconciliation when a different pane exits during an in-flight request.

If a newer workspace request supersedes that reload, the cleanup yields without immediately starting another read. A successful newer action response is applied when an exited pane still needs cleanup. If that action fails while it is still the latest request, it starts one completion-aware reload. This keeps the newer request authoritative without losing cleanup behind `apply: false` activation updates.

All fetched/action workspace responses pass through a pure normalizer. It removes exited panes and collapses their layout. Empty remote tabs disappear because the official remote service owns process cleanup. Provider-owned tabs preserve the active exited pane (or the last pane as fallback) when every pane exited so final output remains inspectable.

The Rust agent repairs exited split panes before returning a snapshot. It removes exited panes only while a sibling remains and preserves active-tab identity.

Every applied workspace response synchronizes persisted presence. Non-empty workspaces remain in `openSelectors`; empty workspaces are removed. If the empty workspace is still selected and no other tab is active, its remembered selector/tab and URL `name`/`tab` parameters are cleared.

## Alternatives rejected

- Sending `close_pane` from every browser races when two panes exit together and duplicates the official remote service's cleanup.
- Filtering only during rendering fixes the picture but leaves Rust agent topology stale.
- Backend-only cleanup does not repair restored responses from older or remote implementations that still report exited panes.

## Components

- `src/frontend/src/exited-pane-cleanup.ts`: queued reconciliation and pure workspace normalization.
- `src/frontend/src/main.ts`: process-exit event wiring and workspace-presence orchestration.
- `src/frontend/src/open-workspaces.ts`: persisted open-selector synchronization.
- `src/frontend/src/workspace-selection.ts`: remembered workspace and URL cleanup.
- `src/agent_workspace.rs`: exited split-pane snapshot repair.

## Testing

- Frontend tests cover queued/deduplicated reconciliation, retry after failure, remote split collapse, remote empty-tab removal, provider-owned final-pane preservation, open-selector synchronization, and selected-workspace memory clearing.
- Rust tests cover snapshot repair of an exited split pane.
- Release verification runs frontend tests, TypeScript typecheck, production build, Rust tests, formatting, Clippy, and the LazyCat package build where host dependencies allow.
- Real remote-device acceptance remains required: split a remote terminal, exit one shell, close the final remote tab, restart/reopen the provider, and confirm neither stale surface returns.

## Release

Bump the patch version from `0.5.29` to `0.5.30`, commit the intended changes, create annotated tag `v0.5.30`, then push `main` and the tag after verification.
