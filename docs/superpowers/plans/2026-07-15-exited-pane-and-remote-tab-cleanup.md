# Exited Pane And Remote Tab Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse split panes after their terminal exits and stop explicitly closed remote workspaces from being restored on the next launch.

**Architecture:** Put process-exit cleanup coordination in a focused frontend controller and keep `main.ts` as the event wiring layer. Keep open-workspace persistence rules in `open-workspaces.ts`, using the workspace action response as the source of truth.

**Tech Stack:** TypeScript, Node test runner, Vite, Rust 2024, Cargo, Git tags.

## Global Constraints

- Do not add reusable pane lifecycle or persistence logic to `src/frontend/src/main.ts`.
- Preserve single-pane exited tabs so final output remains inspectable.
- Do not auto-close retryable remote attach failures.
- Use the existing `close_pane`, `close_tab`, and workspace reload contracts.
- Release version is exactly `0.5.30` with tag `v0.5.30`.

---

### Task 1: Exited split-pane cleanup controller

**Files:**
- Create: `src/frontend/src/exited-pane-cleanup.ts`
- Create: `src/frontend/src/exited-pane-cleanup.test.mjs`

**Interfaces:**
- Consumes: `{ selector, tabId, paneId, visiblePaneCount }` plus injected async `closePane` and `reconcile` callbacks.
- Produces: `createExitedPaneCleanupController(...).handle(request): Promise<boolean>`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover three invariants: one-pane tabs do not close, duplicate concurrent exit events close once, and a failed close reconciles then allows a retry.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `node --test --experimental-strip-types src/frontend/src/exited-pane-cleanup.test.mjs`

Expected: FAIL because `exited-pane-cleanup.ts` does not exist.

- [ ] **Step 3: Implement the focused controller**

Use an in-flight key derived from selector/tab/pane. Return `false` for `visiblePaneCount <= 1` or an in-flight duplicate. On close failure, await `reconcile(selector)` and clear the key in `finally`.

- [ ] **Step 4: Run the focused test and confirm success**

Run: `node --test --experimental-strip-types src/frontend/src/exited-pane-cleanup.test.mjs`

Expected: all lifecycle tests pass.

### Task 2: Wire exit cleanup and empty-workspace persistence

**Files:**
- Modify: `src/frontend/src/main.ts`
- Modify: `src/frontend/src/open-workspaces.ts`
- Modify: `src/frontend/src/open-workspaces.test.mjs`

**Interfaces:**
- Consumes: the controller from Task 1 and the existing `runWorkspaceAction`, `loadWorkspace`, `visiblePanes`, and `WorkspaceState` contracts.
- Produces: `forgetOpenSelectorWhenWorkspaceEmpty(selector, tabCount, storage?): boolean`.

- [ ] **Step 1: Add a failing persistence regression test**

Assert that a zero-tab close result removes its selector and a non-empty close result leaves it stored.

- [ ] **Step 2: Run the focused persistence test and confirm failure**

Run: `node --test --experimental-strip-types src/frontend/src/open-workspaces.test.mjs`

Expected: FAIL because the empty-workspace helper does not exist.

- [ ] **Step 3: Implement the persistence helper**

Keep storage access inside `open-workspaces.ts`. Return `false` when `tabCount > 0`; otherwise call `forgetOpenSelector` and return `true`.

- [ ] **Step 4: Wire `main.ts`**

Instantiate the cleanup controller with a `close_pane` workspace action and a workspace reload fallback. Forward only the real `process-exit` branch after retryable remote exits have returned. Capture the workspace returned by `close_tab` and invoke the empty-workspace helper.

- [ ] **Step 5: Run both focused frontend tests**

Run: `node --test --experimental-strip-types src/frontend/src/exited-pane-cleanup.test.mjs src/frontend/src/open-workspaces.test.mjs`

Expected: all tests pass.

### Task 3: Patch release and ship

**Files:**
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `package.json`
- Modify any other tracked version source found by `rg -n '0\\.5\\.29|v0\\.5\\.29'` when it represents the current package version.

**Interfaces:**
- Consumes: verified source tree from Tasks 1 and 2.
- Produces: commit(s) on `main` and annotated tag `v0.5.30` pushed to `origin`.

- [ ] **Step 1: Bump all package version sources to 0.5.30**

Use targeted edits only; do not rewrite historical documentation or previous tag references.

- [ ] **Step 2: Run complete verification**

Run: `npm test`, `npm run typecheck`, `npm run build`, `cargo test --all-targets`, `cargo fmt --all -- --check`, and `cargo clippy --all-targets -- -D warnings`.

Expected: every command exits 0 with no failed tests or lint errors.

- [ ] **Step 3: Review the final diff and release metadata**

Run: `git diff --check`, `git diff --stat`, `git diff`, `git status --short --branch -uall`, and version/tag consistency searches.

Expected: only the two bug fixes, tests, approved docs, and version files are present.

- [ ] **Step 4: Commit the intended files**

Create a focused bug-fix commit and a release/version commit if the diff naturally separates; otherwise use one release commit. Do not stage unrelated files.

- [ ] **Step 5: Tag and push**

Create annotated tag `v0.5.30`, push `main`, push the tag, then re-read local and remote refs.

Expected: `origin/main` points at the release commit and `refs/tags/v0.5.30` resolves to the same commit.
