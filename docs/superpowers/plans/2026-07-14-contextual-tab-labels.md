# Contextual Tab Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show local and remote context on the active terminal tab while keeping inactive remote tabs icon-only and the tab strip compact.

**Architecture:** `tab-labels.ts` will own contextual label composition and active/inactive presentation rules. `navigation-views.ts` will support rendering an optional remote icon beside visible text. `main.ts` will only pass current tab state, source name, and terminal detail into those helpers, while desktop and mobile styles define responsive width caps without width animation.

**Tech Stack:** TypeScript, Vite, Node test runner, semantic HTML, responsive CSS.

## Global Constraints

- Inactive remote tabs show one remote-device icon and no visible text.
- Active remote tabs show `remote icon + device name · terminal name`.
- Active local tabs show `instance name · terminal name`.
- Tooltip and accessible text use the contextual label.
- Rename inputs edit only the terminal name, never the contextual source
  prefix.
- Contextual active tabs may grow to 60vw, capped at 520px on desktop and 320px on mobile.
- Do not animate tab width or `max-width`.
- Keep `src/frontend/src/main.ts` orchestration-only.
- Keep mobile-only CSS in `src/frontend/src/mobile/styles.css`.
- Do not change tab lifecycle, terminal transports, version numbers, tags, or publishing state.

---

### Task 1: Add contextual label presentation

**Files:**
- Modify: `src/frontend/src/tab-labels.ts`
- Test: `src/frontend/src/tab-labels.test.mjs`

**Interfaces:**
- Produces: `remoteTabDetail(tab, activePane, fallbackName): string`
- Produces: `tabLabelPresentation(input): { displayName: string; title: string; iconOnly: boolean; named: boolean }`

- [ ] **Step 1: Replace the remote-title-only test with contextual presentation tests**

Add literal assertions for these behaviors:

```js
assert.deepEqual(tabLabelPresentation({
  active: true,
  remote: false,
  pinned: false,
  sourceName: "Neko Webshell",
  terminalName: "Herdr",
  terminalHasText: true,
}), {
  displayName: "Neko Webshell · Herdr",
  title: "Neko Webshell · Herdr",
  iconOnly: false,
  named: true,
});

assert.deepEqual(tabLabelPresentation({
  active: false,
  remote: true,
  pinned: false,
  sourceName: "MacBook Pro",
  terminalName: "Herdr",
  terminalHasText: true,
}), {
  displayName: "Herdr",
  title: "MacBook Pro · Herdr",
  iconOnly: true,
  named: false,
});
```

Also assert that equal source/detail values render once and that remote Herdr
still resolves to the literal `Herdr` detail.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --experimental-strip-types src/frontend/src/tab-labels.test.mjs
```

Expected: FAIL because `tabLabelPresentation` and `remoteTabDetail` are not
exported.

- [ ] **Step 3: Implement the minimal pure helpers**

Implement contextual composition with trimmed values and ` · ` as the only
separator. `tabLabelPresentation` must use the contextual label only for the
active visible label, must set `iconOnly` only for inactive remote tabs, and
must keep pinned/inactive compact naming behavior. Preserve the current remote
detail priority: Herdr program marker, active pane title, custom tab title,
fallback terminal name, then `WebShell`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Node test command and expect all tab-label tests to pass.

- [ ] **Step 5: Commit the label behavior**

```bash
git add src/frontend/src/tab-labels.ts src/frontend/src/tab-labels.test.mjs
git commit -m "fix: add contextual terminal tab labels"
```

### Task 2: Render remote icon with active text

**Files:**
- Modify: `src/frontend/src/navigation-views.ts`
- Test: `src/frontend/src/navigation-views.test.mjs`

**Interfaces:**
- Consumes: existing `TabViewItem.icon` and `TabViewItem.iconOnly`
- Produces: icon-only markup for inactive remote tabs and icon-plus-title
  markup for active remote tabs

- [ ] **Step 1: Add separate inactive and active remote rendering tests**

The inactive test must assert that `monitor-smartphone` is present and
`class="tab-title"` is absent. The active test must pass `iconOnly: false` and
assert both the icon and `<span class="tab-title">MacBook Pro · Herdr</span>`
are present with matching `aria-label`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --experimental-strip-types src/frontend/src/navigation-views.test.mjs
```

Expected: the active remote test fails because the renderer currently ignores
`icon` whenever `iconOnly` is false.

- [ ] **Step 3: Render icon-plus-text and track its structure**

Build the non-renaming, non-pinned label from an optional decorative icon plus
the `.tab-title` text. Extend `tabStructureSignature()` so icon-only and
icon-plus-title structures rerender when active state changes. Update patching
so the Lucide icon can be refreshed in either structure.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Node test command and expect both remote rendering tests to pass.

- [ ] **Step 5: Commit the rendering behavior**

```bash
git add src/frontend/src/navigation-views.ts src/frontend/src/navigation-views.test.mjs
git commit -m "fix: reveal active remote tab context"
```

### Task 3: Wire contextual tab data and responsive sizing

**Files:**
- Modify: `src/frontend/src/main.ts`
- Modify: `src/frontend/src/styles.css`
- Modify: `src/frontend/src/mobile/styles.css`

**Interfaces:**
- Consumes: `tabLabelPresentation()` and `remoteTabDetail()`
- Produces: `TabViewItem` values whose active visible label and accessible
  label match the contextual presentation

- [ ] **Step 1: Wire presentation helpers from `tabViewItems()`**

For each tab, calculate `active`, the existing base terminal display name, the
instance/device name, and the remote detail when applicable. Pass those values
to `tabLabelPresentation()` and spread its four outputs into `TabViewItem`.
Keep the existing remote icon and all tone, pin, rename, and ordering data.

- [ ] **Step 2: Remove width animation and add desktop contextual sizing**

Change `.tab` to transition only `color`. Keep `.tab.icon-only` fixed. Allow
`.tab.active.named` to grow to `min(520px, 60vw)` and allow its `.tab-title` to
use the remaining width after status/icon/close controls. Do not alter vertical
rail width.

- [ ] **Step 3: Add mobile contextual sizing in the mobile stylesheet**

Reduce inactive `.tab.icon-only` to 52px. Let `.tab.named.active` grow to
`min(320px, 60vw)`, and increase the active title's text budget while retaining
the existing 38px right padding for the close button.

- [ ] **Step 4: Run frontend verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: 0 test failures, TypeScript exits 0, and Vite completes a production
build.

- [ ] **Step 5: Commit the integration and styles**

```bash
git add src/frontend/src/main.ts src/frontend/src/styles.css src/frontend/src/mobile/styles.css
git commit -m "fix: improve local and remote tab readability"
```

### Task 4: Review the final diff and original regression

**Files:**
- Review: all files changed by Tasks 1-3

**Interfaces:**
- Verifies: inactive remote icon-only, active remote icon-plus-context, active
  local context, responsive truncation, accessibility, and no width animation

- [ ] **Step 1: Inspect the final diff**

Run:

```bash
git diff main...HEAD --check
git diff main...HEAD -- src/frontend/src/main.ts
```

Expected: no whitespace errors, and `main.ts` contains only presentation input
wiring rather than formatting or CSS logic.

- [ ] **Step 2: Run fresh release-level frontend checks**

Run:

```bash
npm test && npm run typecheck && npm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Verify the design checklist**

Confirm every behavior in
`docs/superpowers/specs/2026-07-14-contextual-tab-labels-design.md`, including
the inactive remote icon-only state, the exact middle-dot separator, the 60vw
caps, close-button space, horizontal scrolling, accessible labels, and the
absence of a `max-width` transition.
