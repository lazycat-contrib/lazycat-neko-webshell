# LightOS Instance Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a newly selected LightOS instance active even when its workspace has no tabs.

**Architecture:** Correct the selector-aware active-tab decision in `workspace-collection.ts`. Keep `main.ts` limited to applying that decision by synchronizing retained tab mounts when no active tab exists.

**Tech Stack:** TypeScript, Node test runner, Vite.

## Global Constraints

- Match the Go implementation's invariant that an explicit instance switch cannot reactivate the previous instance.
- Keep background workspace reconciliation from activating another selector when the selected workspace is intentionally empty.
- Preserve the Rust frontend's multi-selector tab collection.
- Keep reusable selection logic out of `src/frontend/src/main.ts`.
- Do not change backend workspace or session APIs.

---

### Task 1: Prevent old-selector fallback for an empty activated workspace

**Files:**
- Modify: `src/frontend/src/workspace-collection.test.mjs`
- Modify: `src/frontend/src/workspace-collection.ts`
- Modify: `src/frontend/src/workspace-selection.test.mjs`
- Modify: `src/frontend/src/workspace-selection.ts`
- Modify: `src/frontend/src/main.ts`

**Interfaces:**
- Consumes: `activeTabAfterSelectorReconcile(previous, tabs, selector, preferred, activateSelector)`.
- Produces: `undefined` when `activateSelector` is true and the requested selector has no tab.

- [x] **Step 1: Write the failing regression test**

Add a case equivalent to:

```js
assert.equal(
  activeTabAfterSelectorReconcile(
    "arch-tab",
    [tab("arch-tab", "arch-bak@cloud.lazycat.lightos.entry")],
    "debian-bak@cloud.lazycat.lightos.entry",
    undefined,
    true,
  ),
  undefined,
);
```

Also assert that `shouldClearWorkspaceSelection("debian-bak@cloud.lazycat.lightos.entry", "debian-bak@cloud.lazycat.lightos.entry", 0, false)` is `false`, while the existing `client:` case remains `true`.

Add a background reconciliation case with no previous active tab and a preferred tab from another selector; the result must remain `undefined`.

- [x] **Step 2: Confirm the old behavior fails**

Run:

```bash
node --test --experimental-strip-types src/frontend/src/workspace-collection.test.mjs
```

Expected: the new test fails because the function returns `arch-tab`.

- [x] **Step 3: Implement the selector-aware fallback**

For explicit activation, resolve a preferred or requested-selector tab and return `undefined` when the selector has no tab. For background reconciliation, preserve the previous active tab only while it still exists; if no tab is active, keep the result `undefined` so loading another retained selector cannot take over the selection.

When `applyWorkspaceState()` receives no active tab, remove the `active` class and set `aria-hidden="true"` on every retained tab mount before rendering the empty state.

Restrict `shouldClearWorkspaceSelection()` to remote-client selectors so an empty LightOS workspace remains selected.

- [x] **Step 4: Run focused and complete verification**

Run:

```bash
node --test --experimental-strip-types src/frontend/src/workspace-collection.test.mjs
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit successfully with no failed tests or type errors.
