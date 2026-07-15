# Exited Pane And Remote Tab Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse exited split panes and stop explicitly closed remote workspaces from returning on launch.

**Architecture:** Reconcile authoritative workspace state after process exit, normalize exited panes before rendering, repair Rust agent split topology at snapshot time, and synchronize browser selection persistence from authoritative tab count.

**Tech Stack:** TypeScript, Node test runner, Vite, Rust 2024, Cargo, Git tags.

## Global Constraints

- Keep `src/frontend/src/main.ts` as orchestration only.
- Do not auto-clean retryable remote attach failures.
- Preserve one provider-owned pane when every pane in its tab exited.
- Remove remote tabs when no live panes remain.
- Release version is exactly `0.5.30` with tag `v0.5.30`.

---

### Task 1: Reconcile and normalize exited panes

**Files:**
- Create: `src/frontend/src/exited-pane-cleanup.ts`
- Create: `src/frontend/src/exited-pane-cleanup.test.mjs`
- Modify: `src/frontend/src/main.ts`

**Interfaces:**
- Consumes: `{ selector, paneId }`, an async workspace reload callback, and `WorkspaceState`.
- Produces: `createExitedPaneCleanupController(...).handle(request)` and `normalizeExitedWorkspaceState(workspace, remoteClient)`.

- [x] Write failing tests for queued reconciliation, duplicate suppression, failure retry, layout collapse, remote empty-tab removal, and provider-owned final-pane preservation.
- [x] Run the focused tests and confirm the missing behavior fails.
- [x] Implement per-selector active/pending pane queues and pure workspace normalization using `removePaneFromLayout`.
- [x] Normalize fetched/action state and forward real `process-exit` events after retryable exits return.
- [x] Run the focused tests and TypeScript typecheck successfully.

### Task 2: Synchronize empty-workspace persistence

**Files:**
- Modify: `src/frontend/src/open-workspaces.ts`
- Modify: `src/frontend/src/open-workspaces.test.mjs`
- Modify: `src/frontend/src/workspace-selection.ts`
- Create: `src/frontend/src/workspace-selection.test.mjs`
- Modify: `src/frontend/src/main.ts`

**Interfaces:**
- Produces: `syncOpenSelectorFromWorkspace`, `forgetRememberedWorkspace`, `clearWorkspaceLocation`, and `shouldClearWorkspaceSelection`.

- [x] Write failing tests for authoritative open-selector sync and selected-workspace clearing decisions.
- [x] Implement storage helpers and URL cleanup in their owning modules.
- [x] Synchronize persistence after every applied workspace load/action response.
- [x] Make reconciliation yield to newer requests and let their completed response (or failure recovery) finish pending exited-pane cleanup.
- [x] Run focused tests and TypeScript typecheck successfully.

### Task 3: Repair Rust agent topology

**Files:**
- Modify: `src/agent_workspace.rs`

**Interfaces:**
- Consumes: pane status and existing pane/layout close primitives.
- Produces: agent snapshots without exited split panes while retaining one final pane.

- [x] Add a failing split-pane snapshot regression test.
- [x] Confirm the old snapshot retains both panes.
- [x] Prune exited panes during repair while preserving active-tab identity.
- [x] Run the focused Rust test successfully.

### Task 4: Patch release and ship

**Files:**
- Modify: `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`, `package.yml`, `README.md`, and `README.en.md`.

- [x] Bump all current version sources from `0.5.29` to `0.5.30` without rewriting historical references.
- [x] Run final frontend, Rust, format, Clippy, and production-build verification; local LPK packaging reached the native build and stopped because this host lacks `musl-tools`, which tag CI installs explicitly.
- [ ] Review and commit only the intended diff.
- [ ] Create annotated tag `v0.5.30`.
- [ ] Push `main` and `v0.5.30`, then verify remote refs and CI state.
