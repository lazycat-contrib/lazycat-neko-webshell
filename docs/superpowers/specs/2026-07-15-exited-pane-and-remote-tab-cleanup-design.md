# Exited Pane And Remote Tab Cleanup Design

## Status

Accepted. The user reported the defects, delegated the implementation choice, and requested a patch release with a pushed tag.

## Goal

Remove a split pane after its terminal process exits, and prevent a remote device workspace from being reopened after its final tab was explicitly closed.

## Confirmed causes

- The frontend `process-exit` handler marks a pane as exited but does not invoke the workspace `close_pane` action, so the workspace topology and split layout retain the dead pane.
- Closing a tab updates the workspace but does not remove an empty selector from `lazycat-neko-webshell.openSelectors`; startup later reloads every selector in that list.

## Considered approaches

### A. Frontend lifecycle cleanup with server reconciliation (selected)

On a terminal `process-exit`, automatically close the pane only when it belongs to a split tab. Use a focused controller to deduplicate cleanup and reconcile workspace state after a failed close. Keep a single-pane exited tab visible so users do not lose the final command output unexpectedly.

After an explicit tab close, remove the selector from the persisted open-workspace list only when the returned workspace has no tabs.

This approach works for local agent and remote-client panes through the existing workspace action contract, avoids backend protocol changes, and keeps `main.ts` limited to event wiring.

### B. Prune exited panes while decoding workspace state

Filtering exited panes in local and remote workspace snapshots would repair reloads, but it would not collapse the live split until another state fetch and would leave remote topology unmodified.

### C. Change both terminal backends to delete panes on PTY exit

Backend-owned cleanup is authoritative but requires separate local-agent and remote-terminal implementations. The remote device service is outside this repository, so behavior would remain inconsistent.

## Components

- `src/frontend/src/exited-pane-cleanup.ts`: owns process-exit cleanup deduplication, invokes the supplied close operation, and requests reconciliation on failure.
- `src/frontend/src/main.ts`: supplies workspace action and reload callbacks, then forwards true process-exit events with the current visible pane count.
- `src/frontend/src/open-workspaces.ts`: owns the rule that an explicitly closed empty workspace is removed from persisted open selectors.

## Behavior

1. A retryable remote attach failure remains an error/reconnect case and is not treated as a process exit.
2. A real process exit still updates terminal status and notifies the terminal renderer.
3. If the owning tab has more than one visible pane, cleanup sends `close_pane`; the returned workspace collapses the split using existing layout logic.
4. If cleanup fails, the controller clears its in-flight guard and reloads the workspace so concurrent-client cleanup can converge without leaving stale local state.
5. A single-pane tab remains visible after process exit.
6. After an explicit `close_tab`, an empty returned workspace removes its selector from persisted open workspaces. Non-empty workspaces remain restorable.

## Testing

- Unit-test that exited split panes close once, single-pane exits remain visible, and close failures reconcile and can retry.
- Unit-test that empty workspace close results remove the selector while non-empty results preserve it.
- Run frontend tests, TypeScript typecheck, production build, Rust tests, formatting check, and Clippy.
- Real remote-device acceptance remains required for the physical device path: split a remote terminal, exit one shell, close the final remote tab, restart/reopen the provider, and confirm neither stale surface returns.

## Release

Bump the patch version from `0.5.29` to `0.5.30`, commit the intended changes, create annotated tag `v0.5.30`, then push `main` and the tag after verification.
