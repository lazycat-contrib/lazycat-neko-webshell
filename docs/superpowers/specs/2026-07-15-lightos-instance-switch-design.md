# LightOS Instance Switch Design

## Status

Accepted. The user reported that selecting another running LightOS instance leaves the previous instance active and explicitly requested behavior aligned with the Go reference implementation.

## Root cause

When the selected LightOS instance has no workspace tabs, `activeTabAfterSelectorReconcile()` falls back to the previous active tab even though `activateSelector` is true. `applyWorkspaceState()` then activates that old tab, and `followActiveTabSelector()` writes the old selector back into application state. The click therefore appears to do nothing.

The Go implementation avoids this by clearing the old tabs before refreshing the new instance workspace.

## Selected design

Preserve the Rust frontend's multi-selector tab model, but adopt the Go switch semantic: an explicit instance switch must never reactivate a tab from another selector.

When an explicitly activated workspace has no tabs, `activeTabAfterSelectorReconcile()` returns no active tab. `applyWorkspaceState()` keeps the requested selector, marks every retained tab mount inactive, and renders the empty workspace state. The user can then create a tab in the newly selected instance. Background workspace reconciliation continues preserving the current active tab.

Empty-workspace selection cleanup remains limited to `client:` remote-device workspaces. An empty LightOS workspace is a valid selected target and must keep its remembered selector and URL.

Background workspace reconciliation must also preserve an intentionally empty active selection. If no tab is active, loading a retained workspace for another selector must leave `activeTabId` unset instead of activating that background selector.

## Alternatives rejected

- Clearing every tab before a switch exactly like Go would discard the Rust frontend's intentionally retained LightOS, remote-device, and SSH tab views.
- Temporarily clearing `activeTabId` only in the click handler would leave popstate and other explicit workspace activation paths with the same bug.

## Testing

- Add a pure regression test proving an explicitly activated empty workspace does not fall back to the previous selector's tab.
- Add a regression test proving an empty LightOS workspace does not trigger remote-device selection cleanup.
- Keep the existing background-reconciliation test proving non-active workspace refreshes preserve the current tab.
- Add a regression test proving background reconciliation cannot activate another selector when the selected LightOS workspace has no active tab.
- Run the focused workspace collection test, the full frontend suite, TypeScript typecheck, and the production build.
