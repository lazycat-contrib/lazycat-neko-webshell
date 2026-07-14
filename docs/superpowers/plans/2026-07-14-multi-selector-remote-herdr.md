# Multi-selector Remote Herdr Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep local and remote selector workspaces open in one tab bar, render remote tabs as a single remote-device icon, and launch remote Herdr through the official client-terminal PTY without modifying the LazyCat client.

**Architecture:** Frontend-global tab and pane IDs combine selector plus raw backend identity, while raw IDs remain available at every workspace and replay boundary. Selector reconciliation replaces only one selector's tabs and restores remembered selectors in the background. Remote Herdr remains a WebShell transport with persisted `program_kind = herdr`; the backend injects one launch command after official remote history replay completes.

**Tech Stack:** Rust 2024, Axum, Tokio, rusqlite/app_kv, TypeScript, Vite, Node test runner, ConnectRPC/protobuf, official client-terminal HTTP/WebSocket contract.

## Global Constraints

- Do not modify the LazyCat `client-terminal` service, Herdr, `lzc-sdk`, or the official remote workspace schema.
- Do not add a TCP helper, hidden remote pane, RemoteSocks Unix bridge, uploaded remote binary, or new network listener.
- Remote Herdr uses `session_backend = webshell` plus `program_kind = herdr`.
- Remote tabs show one remote-device icon and no visible text; tooltip and accessible label remain descriptive.
- `src/frontend/src/main.ts` remains orchestration-only; identity, reconciliation, persistence, and presentation logic belong in focused modules.
- Every selector and pane crossing a backend boundary uses the raw workspace ID, never the frontend-global ID.
- The existing device ticket and auth-token redaction rules remain unchanged.
- Each task ends in a passing focused test and a separate commit.

---

### Task 1: Add frontend-global workspace identities

**Files:**
- Create: `src/frontend/src/workspace-identity.ts`
- Create: `src/frontend/src/workspace-identity.test.mjs`
- Modify: `src/frontend/src/types.ts`

**Interfaces:**
- Produces: `workspaceEntityId(selector, kind, rawId): string`
- Produces: `workspaceLayoutToView(selector, layout): SplitNode | undefined`
- Produces: `workspaceLayoutToRaw(selector, layout): SplitNode | undefined`
- Adds: `TerminalTab.workspaceTabId: string`
- Adds: `TerminalPane.workspacePaneId: string`
- Adds: `WorkspacePaneState.program_kind?: "herdr"`
- Adds: `TerminalPane.programKind?: "herdr"`

- [ ] **Step 1: Write identity and layout tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceEntityId,
  workspaceLayoutToRaw,
  workspaceLayoutToView,
} from "./workspace-identity.ts";

test("namespaces identical remote workspace IDs by selector", () => {
  assert.notEqual(
    workspaceEntityId("client:first", "tab", "tab-1"),
    workspaceEntityId("client:second", "tab", "tab-1"),
  );
  assert.notEqual(
    workspaceEntityId("client:first", "pane", "pane-1"),
    workspaceEntityId("client:second", "pane", "pane-1"),
  );
});

test("round-trips pane IDs inside split layouts", () => {
  const raw = {
    type: "split",
    axis: "columns",
    children: [
      { type: "pane", paneId: "pane-1" },
      { type: "pane", paneId: "pane-2" },
    ],
  };
  const view = workspaceLayoutToView("client:first", raw);
  assert.deepEqual(workspaceLayoutToRaw("client:first", view), raw);
  assert.equal(workspaceLayoutToRaw("client:second", view), undefined);
});
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run: `node --test --experimental-strip-types src/frontend/src/workspace-identity.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `workspace-identity.ts`.

- [ ] **Step 3: Add raw identity fields to frontend types**

```ts
export type RemoteProgramKind = "herdr";

export type WorkspacePaneState = {
  id: string;
  session_id: string;
  status: string;
  session_backend?: SessionBackendId;
  program_kind?: RemoteProgramKind;
  herdr_output_sequence?: number;
  cols: number;
  rows: number;
};

// Insert immediately after TerminalPane.id:
workspacePaneId: string;
programKind?: RemoteProgramKind;

// Insert immediately after TerminalTab.id:
workspaceTabId: string;
```

- [ ] **Step 4: Implement selector-safe IDs and layout conversion**

```ts
import type { SplitNode } from "./types";
import { normalizeSelector } from "./workspace-selection";

type WorkspaceEntityKind = "tab" | "pane";
const PREFIX = "workspace";

export function workspaceEntityId(
  selector: string,
  kind: WorkspaceEntityKind,
  rawId: string,
): string {
  const encodedSelector = encodeURIComponent(normalizeSelector(selector));
  const encodedRawId = encodeURIComponent(String(rawId ?? "").trim());
  return `${PREFIX}:${kind}:${encodedSelector}:${encodedRawId}`;
}

export function workspaceLayoutToView(
  selector: string,
  layout: SplitNode | undefined,
): SplitNode | undefined {
  return mapLayout(selector, layout, "pane", true);
}

export function workspaceLayoutToRaw(
  selector: string,
  layout: SplitNode | undefined,
): SplitNode | undefined {
  return mapLayout(selector, layout, "pane", false);
}

function mapLayout(
  selector: string,
  layout: SplitNode | undefined,
  kind: WorkspaceEntityKind,
  toView: boolean,
): SplitNode | undefined {
  if (!layout) return undefined;
  if (layout.type === "pane") {
    if (toView) {
      return { type: "pane", paneId: workspaceEntityId(selector, kind, layout.paneId) };
    }
    const raw = rawWorkspaceEntityId(selector, kind, layout.paneId);
    return raw ? { type: "pane", paneId: raw } : undefined;
  }
  const children = layout.children
    .map((child) => mapLayout(selector, child, kind, toView))
    .filter((child): child is SplitNode => Boolean(child));
  return children.length === layout.children.length && children.length > 0
    ? { type: "split", axis: layout.axis, children }
    : undefined;
}

function rawWorkspaceEntityId(
  selector: string,
  kind: WorkspaceEntityKind,
  value: string,
): string | undefined {
  const prefix = `${PREFIX}:${kind}:${encodeURIComponent(normalizeSelector(selector))}:`;
  if (!value.startsWith(prefix)) return undefined;
  const raw = decodeURIComponent(value.slice(prefix.length));
  return raw || undefined;
}
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --test --experimental-strip-types src/frontend/src/workspace-identity.test.mjs && npm run typecheck`

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/types.ts src/frontend/src/workspace-identity.ts src/frontend/src/workspace-identity.test.mjs
git commit -m "refactor: namespace workspace entity identities"
```

### Task 2: Add selector collection, request tracking, and open-selector persistence

**Files:**
- Create: `src/frontend/src/workspace-collection.ts`
- Create: `src/frontend/src/workspace-collection.test.mjs`
- Create: `src/frontend/src/selector-request-tracker.ts`
- Create: `src/frontend/src/selector-request-tracker.test.mjs`
- Create: `src/frontend/src/open-workspaces.ts`
- Create: `src/frontend/src/open-workspaces.test.mjs`

**Interfaces:**
- Produces: `replaceSelectorTabs(tabs, selector, replacements, insertAfterId): TerminalTab[]`
- Produces: `activeTabAfterSelectorReconcile(previous, tabs, selector, preferred, activateSelector): string | undefined`
- Produces: `createSelectorRequestTracker()` with `begin` and `isCurrent`
- Produces: `readOpenSelectors`, `rememberOpenSelector`, and `forgetOpenSelector`

- [ ] **Step 1: Write failing pure-state tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTabAfterSelectorReconcile,
  replaceSelectorTabs,
} from "./workspace-collection.ts";

const tab = (id, selector) => ({ id, selector });

test("replaces one selector without removing sibling selectors", () => {
  const result = replaceSelectorTabs(
    [tab("local-1", "app@box"), tab("remote-old", "client:pc")],
    "client:pc",
    [tab("remote-new", "client:pc")],
    "local-1",
  );
  assert.deepEqual(result.map((item) => item.id), ["local-1", "remote-new"]);
});

test("background reconciliation preserves the active tab", () => {
  assert.equal(
    activeTabAfterSelectorReconcile(
      "local-1",
      [tab("local-1", "app@box"), tab("remote-1", "client:pc")],
      "client:pc",
      "remote-1",
      false,
    ),
    "local-1",
  );
});
```

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createSelectorRequestTracker } from "./selector-request-tracker.ts";

test("invalidates stale requests only within the same selector", () => {
  const tracker = createSelectorRequestTracker();
  const firstA = tracker.begin("app@box");
  const firstB = tracker.begin("client:pc");
  const secondA = tracker.begin("app@box");
  assert.equal(tracker.isCurrent("app@box", firstA), false);
  assert.equal(tracker.isCurrent("app@box", secondA), true);
  assert.equal(tracker.isCurrent("client:pc", firstB), true);
});
```

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetOpenSelector,
  readOpenSelectors,
  rememberOpenSelector,
} from "./open-workspaces.ts";

test("stores normalized selectors once and preserves open order", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  rememberOpenSelector(" app@box ", storage);
  rememberOpenSelector("client:pc", storage);
  rememberOpenSelector("app@box", storage);
  assert.deepEqual(readOpenSelectors(storage), ["app@box", "client:pc"]);
  forgetOpenSelector("app@box", storage);
  assert.deepEqual(readOpenSelectors(storage), ["client:pc"]);
});
```

- [ ] **Step 2: Run the new tests and confirm missing modules**

Run: `node --test --experimental-strip-types src/frontend/src/workspace-collection.test.mjs src/frontend/src/selector-request-tracker.test.mjs src/frontend/src/open-workspaces.test.mjs`

Expected: FAIL with missing-module errors.

- [ ] **Step 3: Implement the collection and request helpers**

```ts
import type { TerminalTab } from "./types";
import { normalizeSelector } from "./workspace-selection";

export function replaceSelectorTabs<T extends Pick<TerminalTab, "id" | "selector">>(
  tabs: T[],
  selector: string,
  replacements: T[],
  insertAfterId?: string,
): T[] {
  const normalized = normalizeSelector(selector);
  const first = tabs.findIndex((tab) => normalizeSelector(tab.selector) === normalized);
  const retained = tabs.filter((tab) => normalizeSelector(tab.selector) !== normalized);
  let index = first >= 0 ? Math.min(first, retained.length) : retained.length;
  if (first < 0 && insertAfterId) {
    const anchor = retained.findIndex((tab) => tab.id === insertAfterId);
    if (anchor >= 0) index = anchor + 1;
  }
  return [...retained.slice(0, index), ...replacements, ...retained.slice(index)];
}

export function activeTabAfterSelectorReconcile<T extends Pick<TerminalTab, "id" | "selector">>(
  previous: string | undefined,
  tabs: T[],
  selector: string,
  preferred: string | undefined,
  activateSelector: boolean,
): string | undefined {
  if (!activateSelector && previous && tabs.some((tab) => tab.id === previous)) return previous;
  if (preferred && tabs.some((tab) => tab.id === preferred)) return preferred;
  return tabs.find((tab) => normalizeSelector(tab.selector) === normalizeSelector(selector))?.id
    ?? tabs.find((tab) => tab.id === previous)?.id
    ?? tabs[0]?.id;
}
```

```ts
import { normalizeSelector } from "./workspace-selection";

export function createSelectorRequestTracker() {
  const generations = new Map<string, number>();
  return {
    begin(selector: string): number {
      const key = normalizeSelector(selector);
      const next = (generations.get(key) ?? 0) + 1;
      generations.set(key, next);
      return next;
    },
    isCurrent(selector: string, generation: number): boolean {
      return generations.get(normalizeSelector(selector)) === generation;
    },
  };
}
```

```ts
import { normalizeSelector } from "./workspace-selection";

const OPEN_SELECTORS_KEY = "lazycat-neko-webshell.openSelectors";
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readOpenSelectors(storage: StorageLike = window.localStorage): string[] {
  try {
    const parsed = JSON.parse(storage.getItem(OPEN_SELECTORS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(normalizeSelector).filter(Boolean))];
  } catch {
    return [];
  }
}

export function rememberOpenSelector(selector: string, storage: StorageLike = window.localStorage) {
  const normalized = normalizeSelector(selector);
  if (!normalized) return;
  const current = readOpenSelectors(storage).filter((item) => item !== normalized);
  storage.setItem(OPEN_SELECTORS_KEY, JSON.stringify([...current, normalized]));
}

export function forgetOpenSelector(selector: string, storage: StorageLike = window.localStorage) {
  const normalized = normalizeSelector(selector);
  storage.setItem(
    OPEN_SELECTORS_KEY,
    JSON.stringify(readOpenSelectors(storage).filter((item) => item !== normalized)),
  );
}
```

- [ ] **Step 4: Run all new tests**

Run: `node --test --experimental-strip-types src/frontend/src/workspace-collection.test.mjs src/frontend/src/selector-request-tracker.test.mjs src/frontend/src/open-workspaces.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/workspace-collection.ts src/frontend/src/workspace-collection.test.mjs src/frontend/src/selector-request-tracker.ts src/frontend/src/selector-request-tracker.test.mjs src/frontend/src/open-workspaces.ts src/frontend/src/open-workspaces.test.mjs
git commit -m "feat: add selector workspace collection helpers"
```

### Task 3: Reconcile multiple selector workspaces in the frontend

**Files:**
- Modify: `src/frontend/src/main.ts:800-950, 3861-4025, 4639-4755, 5209-5235, 5641-5762`
- Modify: `src/frontend/src/pane-selection.ts`
- Modify: `src/frontend/src/workspace-selection.ts`
- Test: `src/frontend/src/workspace-identity.test.mjs`
- Test: `src/frontend/src/workspace-collection.test.mjs`

**Interfaces:**
- Consumes all Task 1 and Task 2 helpers.
- Changes `applyWorkspaceState` to selector-scoped reconciliation.
- Keeps backend action IDs raw through `workspaceTabId`, `workspacePaneId`, and raw layout conversion.

- [ ] **Step 1: Extend focused tests with active-selector and action-boundary cases**

Add assertions proving that raw remembered IDs resolve only inside their selector and that converting a composite layout from another selector returns `undefined`.

- [ ] **Step 2: Run the focused tests before integration**

Run: `npm test`

Expected: existing tests PASS; the new integration assertions FAIL until `main.ts` consumes the new identities.

- [ ] **Step 3: Wire global IDs into tab and pane creation**

Use the following exact assignments in `makeTab` and `makePane`:

```ts
function makeTab(selector: string, workspaceTabId?: string): TerminalTab {
  const rawId = workspaceTabId || newId();
  const id = workspaceEntityId(selector, "tab", rawId);
  const mount = document.createElement("div");
  mount.className = "tab-mount";
  mount.dataset.tabId = id;
  mount.setAttribute("role", "tabpanel");
  mount.setAttribute("aria-label", selector);
  return { id, workspaceTabId: rawId, selector, label: selectorLabel(selector), mount, panes: [], pinned: false, pinnedOrder: undefined, closing: false };
}

function makePane(tab: TerminalTab, workspacePaneId?: string): TerminalPane {
  const rawId = workspacePaneId || newId();
  const id = workspaceEntityId(tab.selector, "pane", rawId);
  // Keep the current createTerminalPaneMount callback object unchanged.
  // Insert `workspacePaneId: rawId` immediately after `id` in the existing
  // TerminalPane object returned by this function.
}
```

The two comments above are edit-location instructions: do not add them to the
source file. Preserve the current pointer, gesture, clipboard, and terminal
defaults verbatim.

Restore `programKind` from `paneState.program_kind`, convert incoming layouts with `workspaceLayoutToView`, pass `workspacePaneId` to the terminal WebSocket, and compare replay `pane_id` against `workspacePaneId`.

- [ ] **Step 4: Normalize workspace actions at the single request boundary**

Before `runWorkspaceActionRequest`, resolve the frontend tab and pane and send:

```ts
const actionTab = options.tabId
  ? tabs.find((tab) => tab.id === options.tabId && tab.selector === selector)
  : undefined;
const actionPane = options.paneId
  ? actionTab?.panes.find((pane) => pane.id === options.paneId)
    ?? allPanes().find((pane) => pane.id === options.paneId && pane.selector === selector)
  : undefined;

tabId: actionTab?.workspaceTabId,
paneId: actionPane?.workspacePaneId,
layout: options.layout ? workspaceLayoutToRaw(selector, options.layout) : undefined,
activePaneId: options.activePaneId
  ? actionTab?.panes.find((pane) => pane.id === options.activePaneId)?.workspacePaneId
  : undefined,
```

- [ ] **Step 5: Replace destructive workspace application**

Refactor `applyWorkspaceState` so it:

```ts
const previousActiveTabId = activeTabId;
const existingSelectorPanes = new Map(
  allPanes()
    .filter((pane) => normalizeSelector(pane.selector) === workspaceSelector)
    .map((pane) => [pane.id, pane]),
);
const replacementTabs: TerminalTab[] = [];
// restore only workspace.tabs into replacementTabs
tabs = replaceSelectorTabs(
  tabs,
  workspaceSelector,
  replacementTabs,
  previousActiveTabId,
);
activeTabId = activeTabAfterSelectorReconcile(
  previousActiveTabId,
  tabs,
  workspaceSelector,
  preferredWorkspaceTabId,
  options.activateSelector === true,
);
// dispose only unused entries from existingSelectorPanes
```

Do not call `tabs = []` or `terminalStage.replaceChildren()`. Append only new
mounts, leave retained selector mounts in place, and restore the empty-state and
control-overlay chrome after reconciliation.

- [ ] **Step 6: Make selector activation follow tabs and restore remembered selectors**

On `activateTab`, call `setSelectedSelector(tab.selector, { updateLocation: false })`, remember the raw `workspaceTabId`, update the URL with the raw ID, render the instance selection, and refresh backend/Herdr state only when the selector changes.

After the initial selected workspace loads in `init`, iterate
`readOpenSelectors()` excluding the selected selector and call
`loadWorkspace(selector, { activateSelector: false, background: true })`.
Successful instance clicks call `rememberOpenSelector(selector)`. Background
load failures call `forgetOpenSelector(selector)` and never clear active
selector status.

Use `createSelectorRequestTracker` for workspace responses; retain the current
selected-selector generation only for active-selector UI state such as Herdr
and session backend menus.

- [ ] **Step 7: Run frontend tests, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`

Expected: all frontend tests PASS and Vite production build succeeds.

- [ ] **Step 8: Run Rust regression tests because action IDs changed**

Run: `cargo test --locked`

Expected: 208 or more tests PASS with zero failures.

- [ ] **Step 9: Commit**

```bash
git add src/frontend/src/main.ts src/frontend/src/pane-selection.ts src/frontend/src/workspace-selection.ts src/frontend/src/types.ts src/frontend/src/workspace-identity.test.mjs src/frontend/src/workspace-collection.test.mjs
git commit -m "feat: keep selector workspaces open together"
```

### Task 4: Render remote tabs as icon-only navigation entries

**Files:**
- Create: `src/frontend/src/navigation-views.test.mjs`
- Modify: `src/frontend/src/navigation-views.ts`
- Modify: `src/frontend/src/tab-labels.ts`
- Modify: `src/frontend/src/main.ts:5738-5762`
- Modify: `src/frontend/src/styles.css`
- Modify: `src/frontend/src/mobile/styles.css`

**Interfaces:**
- Extends `TabViewItem` with `icon?: string` and `iconOnly?: boolean`.
- Adds `remoteTabTitle(tab, activePane, deviceName): string` in `tab-labels.ts`.

- [ ] **Step 1: Write a failing markup test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { renderTabsView } from "./navigation-views.ts";

test("renders a remote tab as one icon without visible title text", () => {
  const html = renderTabsView([{
    id: "remote",
    active: true,
    renaming: false,
    named: false,
    pinned: false,
    pinnedGlyph: "R",
    canMovePinnedPrevious: false,
    canMovePinnedNext: false,
    displayName: "Alice PC Herdr",
    title: "Alice PC — Herdr",
    tone: "ok",
    icon: "monitor-smartphone",
    iconOnly: true,
  }], {
    empty: "Empty",
    rename: "Rename",
    close: "Close",
    pin: "Pin",
    unpin: "Unpin",
    movePinnedPrevious: "Previous",
    movePinnedNext: "Next",
  });
  assert.match(html, /data-lucide="monitor-smartphone"/);
  assert.doesNotMatch(html, /class="tab-title">Alice PC Herdr/);
  assert.match(html, /aria-label="Alice PC — Herdr"/);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test --experimental-strip-types src/frontend/src/navigation-views.test.mjs`

Expected: FAIL because icon-only rendering is absent.

- [ ] **Step 3: Implement icon-only rendering and patching**

Use this label selection in `renderTabView`:

```ts
const label = tab.renaming
  ? `<input class="tab-rename" data-rename-tab="${escapeAttr(tab.id)}" value="${escapeAttr(tab.displayName)}" aria-label="${escapeAttr(labels.rename)}" spellcheck="false" />`
  : tab.iconOnly && tab.icon
    ? `<span class="tab-remote-icon" aria-hidden="true"><i data-lucide="${escapeAttr(tab.icon)}"></i></span>`
    : tab.pinned
      ? `<span class="tab-pin-glyph" aria-hidden="true">${escapeHtml(tab.pinnedGlyph)}</span>`
      : `<span class="tab-title">${escapeHtml(tab.displayName)}</span>`;
```

Include `iconOnly` and `icon` in `tabStructureSignature`, and patch the remote
icon only when the structure remains icon-only. In `tabViewItems`, set
`iconOnly: isRemoteClientSelector(tab.selector)` and
`icon: isRemoteClientSelector(tab.selector) ? "monitor-smartphone" : undefined`.

- [ ] **Step 4: Add compact desktop and mobile sizing**

```css
.tab.icon-only .tab-main,
.tab-remote-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tab-remote-icon svg {
  width: 1rem;
  height: 1rem;
}
```

Add the `icon-only` class in render/patch logic and keep the existing close
button hit target unchanged on mobile.

- [ ] **Step 5: Run frontend verification**

Run: `npm test && npm run typecheck && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/navigation-views.ts src/frontend/src/navigation-views.test.mjs src/frontend/src/tab-labels.ts src/frontend/src/main.ts src/frontend/src/styles.css src/frontend/src/mobile/styles.css
git commit -m "feat: show remote tabs as device icons"
```

### Task 5: Persist remote terminal program metadata

**Files:**
- Create: `src/remote_program.rs`
- Modify: `src/main.rs`
- Modify: `src/state.rs`
- Modify: `src/workspace.rs`
- Modify: `src/client_terminal.rs`
- Modify: `src/frontend/src/types.ts`

**Interfaces:**
- Produces: `RemoteProgramStore::load(database)`
- Produces: `mark_pending`, `mark_sent`, `mark_pending_after_rejection`, `program_kind`, and `reconcile_selector`
- Adds: `AppState.remote_programs: Arc<RemoteProgramStore>`
- Adds: `WorkspacePaneState.program_kind: Option<String>`

- [ ] **Step 1: Write Rust store tests in `remote_program.rs`**

```rust
fn test_database() -> Arc<AppDatabase> {
    let suffix = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    Arc::new(
        AppDatabase::open(
            std::env::temp_dir().join(format!("neko-remote-program-{suffix}.db")),
        )
        .unwrap(),
    )
}

#[test]
fn persists_program_state_and_reconciles_only_one_selector() {
    let database = test_database();
    let store = RemoteProgramStore::load(Arc::clone(&database)).unwrap();
    store.mark_pending("client:first", "pane-1", RemoteProgramKind::Herdr).unwrap();
    store.mark_pending("client:second", "pane-1", RemoteProgramKind::Herdr).unwrap();
    store.reconcile_selector("client:first", ["pane-2"]).unwrap();
    assert_eq!(store.program_kind("client:first", "pane-1"), None);
    assert_eq!(store.program_kind("client:second", "pane-1"), Some(RemoteProgramKind::Herdr));
    let reloaded = RemoteProgramStore::load(database).unwrap();
    assert_eq!(reloaded.program_kind("client:second", "pane-1"), Some(RemoteProgramKind::Herdr));
}
```

- [ ] **Step 2: Run the focused Rust test and verify failure**

Run: `cargo test --locked remote_program::tests::persists_program_state_and_reconciles_only_one_selector`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the store using existing app_kv**

```rust
const REMOTE_PROGRAMS_KEY: &str = "remote_programs";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteProgramKind { Herdr }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteBootstrapState { Pending, Sent }

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RemoteProgramEntry {
    selector: String,
    pane_id: String,
    program_kind: RemoteProgramKind,
    bootstrap: RemoteBootstrapState,
    updated_at_ms: u64,
}

pub struct RemoteProgramStore {
    database: Arc<AppDatabase>,
    entries: RwLock<HashMap<String, RemoteProgramEntry>>,
}

const MAX_REMOTE_PROGRAM_ENTRIES: usize = 4096;
```

All mutating methods lock the registry, clone the pre-change map, change exactly
one selector/pane entry, serialize the complete bounded map, and call:

```rust
self.database.store_kv(
    KV_NAMESPACE_STATE,
    REMOTE_PROGRAMS_KEY,
    &serde_json::to_vec(&*entries)
        .map_err(|error| io::Error::other(error.to_string()))?,
)
```

Restore the cloned map if serialization or persistence fails.
`reconcile_selector` retains other selectors and removes only entries whose
selector matches and pane ID is absent from the authoritative returned set.
Before persisting a newly added entry, if the map exceeds
`MAX_REMOTE_PROGRAM_ENTRIES`, remove the oldest entries by `updated_at_ms`
until the limit is restored.

- [ ] **Step 4: Load the store into AppState and add workspace program_kind**

Create the store immediately after opening `AppDatabase`, add it to production
and test `AppState` constructors, export `mod remote_program` in `main.rs`, and
add:

```rust
#[serde(skip_serializing_if = "Option::is_none")]
pub program_kind: Option<String>,
```

to `WorkspacePaneState`. Set `None` at every local workspace constructor.

- [ ] **Step 5: Attach and reconcile metadata during remote conversion**

Change `convert_remote_workspace` to accept `&RemoteProgramStore`, reconcile
the selector against all returned remote pane IDs, and serialize `"herdr"`
only for mapped panes. Pass `state.remote_programs.as_ref()` through every
remote workspace call site in `workspace.rs` and `service.rs`.

- [ ] **Step 6: Run formatting, focused tests, and the full Rust suite**

Run: `cargo fmt --all -- --check && cargo test --locked remote_program && cargo test --locked`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main.rs src/state.rs src/workspace.rs src/client_terminal.rs src/remote_program.rs src/frontend/src/types.ts
git commit -m "feat: persist remote terminal program metadata"
```

### Task 6: Create and bootstrap remote Herdr over the official PTY

**Files:**
- Modify: `src/session_backend.rs`
- Modify: `src/client_terminal.rs`
- Modify: `src/terminal.rs`
- Modify: `src/workspace.rs`
- Modify: `src/frontend/src/remote-client-terminal.ts`
- Modify: `src/frontend/src/remote-client-terminal.test.mjs`
- Modify: `src/frontend/src/main.ts:4510-4905, 5209-5565`

**Interfaces:**
- Remote session backend discovery advertises Herdr optimistically.
- Remote `create_tab` accepts requested `SessionBackend::Herdr`, creates an official WebShell tab, and records pending metadata.
- `RemoteTerminalConnection` carries optional program/bootstrap information.
- Relay sends one Herdr bootstrap after history replay completion.

- [ ] **Step 1: Add failing remote adapter tests**

Extend `client_terminal.rs` tests, importing `SplitDirection`, with:

```rust
#[test]
fn remote_herdr_create_uses_native_create_tab() {
    let request = remote_session_action_request(
        "client:client-a",
        WorkspaceAction::CreateTab,
        120,
        32,
        5000,
    );
    let mut request = request;
    request.session_backend = Some(SessionBackend::Herdr);
    let outbound = remote_workspace_action(&request, 120, 32).unwrap();
    assert_eq!(outbound.action, "create_tab");
}

#[test]
fn remote_herdr_is_rejected_for_non_create_actions() {
    let mut request = remote_session_action_request(
        "client:client-a",
        WorkspaceAction::SplitPane,
        120,
        32,
        5000,
    );
    request.session_backend = Some(SessionBackend::Herdr);
    request.tab_id = Some("tab-1".to_owned());
    request.pane_id = Some("pane-1".to_owned());
    request.direction = Some(SplitDirection::Right);
    let error = remote_workspace_action(&request, 120, 32)
        .expect_err("remote Herdr split must remain unsupported");
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
}

#[test]
fn remote_herdr_bootstrap_waits_for_replay_complete_and_runs_once() {
    let mut bootstrap = RemoteHerdrBootstrap::pending();
    assert_eq!(
        bootstrap.observe(RemoteBootstrapEvent::ReplayStart),
        RemoteBootstrapAction::None,
    );
    assert_eq!(
        bootstrap.observe(RemoteBootstrapEvent::ReplayComplete),
        RemoteBootstrapAction::SendHerdr,
    );
    bootstrap.mark_sent();
    assert_eq!(
        bootstrap.observe(RemoteBootstrapEvent::ReplayComplete),
        RemoteBootstrapAction::None,
    );
}
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cargo test --locked client_terminal::tests::remote_herdr`

Expected: FAIL because remote Herdr remains rejected.

- [ ] **Step 3: Advertise remote Herdr and handle create semantics**

For client selectors, return both:

```rust
SessionBackendInfo {
    id: "webshell",
    label: "WebShell native",
    available: true,
    supports_terminal_transfer: false,
    lightos_only: false,
},
SessionBackendInfo {
    id: "herdr",
    label: "Herdr",
    available: true,
    supports_terminal_transfer: false,
    lightos_only: false,
},
```

Allow `SessionBackend::Herdr` only when `request.action == CreateTab`. Send the
same official `create_tab` payload, identify the returned active tab/pane,
persist pending Herdr metadata, then send an official `rename_tab` action with
label `Herdr`. Convert the final workspace through the metadata-aware converter.

- [ ] **Step 4: Keep frontend transport WebShell while presenting remote Herdr**

In `createTerminalTab`, run local Herdr socket behavior only when the selector
is not remote:

```ts
const remoteHerdr = isRemoteClientSelector(selector) && mode === "herdr";
if (mode === "herdr" && !remoteHerdr) {
  const existing = findPaneBySessionBackend(selector, "herdr");
  if (existing) {
    activatePane(existing.tab.id, existing.pane.id);
    const ready = herdrState?.available || await refreshHerdrState(selector);
    if (!ready) {
      setGlobalStatus(tr("status.herdrUnavailable"), "error");
      return undefined;
    }
    await runHerdrAction("create_workspace");
    await syncHerdrEventBridge({ force: true });
    return activeTab();
  }
}
await runWorkspaceAction("create_tab", {
  selector,
  sessionBackend: mode,
});
if (mode === "herdr" && !remoteHerdr) {
  scheduleHerdrActionRefresh(selector);
  void syncHerdrEventBridge({ force: true });
}
```

Restore `programKind` separately while `normalizeSessionMode` continues to
produce `webshell`. Add `isRemoteHerdrPane` in `remote-client-terminal.ts` and
tests proving it never matches a local Herdr tab.

- [ ] **Step 5: Add one-time relay bootstrap**

Add this focused state machine in `client_terminal.rs`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteBootstrapEvent {
    ReplayStart,
    ReplayComplete,
    TerminalOutput,
    ControlRejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteBootstrapAction {
    None,
    SendHerdr,
    RevertPending,
}

struct RemoteHerdrBootstrap {
    pending: bool,
    attempted: bool,
    output_seen: bool,
}

impl RemoteHerdrBootstrap {
    const fn pending() -> Self {
        Self { pending: true, attempted: false, output_seen: false }
    }

    fn observe(&mut self, event: RemoteBootstrapEvent) -> RemoteBootstrapAction {
        match event {
            RemoteBootstrapEvent::ReplayComplete if self.pending && !self.attempted => {
                self.attempted = true;
                RemoteBootstrapAction::SendHerdr
            }
            RemoteBootstrapEvent::TerminalOutput if self.attempted => {
                self.output_seen = true;
                RemoteBootstrapAction::None
            }
            RemoteBootstrapEvent::ControlRejected if self.attempted && !self.output_seen => {
                self.pending = true;
                RemoteBootstrapAction::RevertPending
            }
            RemoteBootstrapEvent::ReplayStart
            | RemoteBootstrapEvent::ReplayComplete
            | RemoteBootstrapEvent::TerminalOutput
            | RemoteBootstrapEvent::ControlRejected => RemoteBootstrapAction::None,
        }
    }

    fn mark_sent(&mut self) {
        self.pending = false;
    }
}
```

Use a shared async mutex around the remote WebSocket sink so browser input and
the server bootstrap can both send safely.

Use this exact command payload terminated by carriage return:

```rust
const REMOTE_HERDR_LAUNCH: &str = "if command -v herdr >/dev/null 2>&1; then exec herdr; elif [ -x \"$HOME/.local/bin/herdr\" ]; then exec \"$HOME/.local/bin/herdr\"; else printf '%s\\n' 'Herdr is not installed on this remote device.'; exit 127; fi\r";
```

After translating and forwarding the first matching
`history-replay-complete`, send a normal remote terminal input JSON message and
mark metadata sent. Track the attempt locally. If the same connection returns
`terminal control is held by another client` before binary terminal output,
revert metadata to pending and suppress further bootstrap attempts on that
connection.

- [ ] **Step 6: Run focused frontend and Rust tests**

Run: `node --test --experimental-strip-types src/frontend/src/remote-client-terminal.test.mjs && cargo test --locked client_terminal::tests && cargo test --locked remote_program::tests`

Expected: PASS.

- [ ] **Step 7: Run full frontend and Rust verification**

Run: `npm test && npm run typecheck && npm run build && cargo fmt --all -- --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked`

Expected: all commands PASS.

- [ ] **Step 8: Commit**

```bash
git add src/session_backend.rs src/client_terminal.rs src/terminal.rs src/workspace.rs src/frontend/src/remote-client-terminal.ts src/frontend/src/remote-client-terminal.test.mjs src/frontend/src/main.ts
git commit -m "feat: launch Herdr on remote client terminals"
```

### Task 7: Release-build and regression verification

**Files:**
- No planned source modifications. A failure returns execution to the task that owns the failing file.

**Interfaces:**
- Consumes the complete implementation from Tasks 1-6.
- Produces a release-ready source tree; it does not bump the application version or create a tag unless separately requested.

- [ ] **Step 1: Run every source gate**

Run:

```bash
npm test
npm run typecheck
npm run build
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
scripts/build-release.sh
```

Expected: every command exits 0.

- [ ] **Step 2: Build and validate the LazyCat package**

Run: `lzc-cli project release`

Expected: an LPK is produced and validation/lint succeeds. Do not publish,
create a GitHub release, or submit to a store in this task.

- [ ] **Step 3: Inspect the final diff and architectural boundaries**

Run:

```bash
git diff --check
git status --short --branch -uall
rg -n "tabs = \[\]|terminalStage\.replaceChildren" src/frontend/src/main.ts
rg -n "RemoteSocks|hidden.*pane|TCP-LISTEN" src/client_terminal.rs src/remote_program.rs
```

Expected: no whitespace errors; no destructive single-selector reset remains in
workspace application; no prohibited custom remote bridge exists; only intended
files are modified.

- [ ] **Step 4: Record manual real-device acceptance requirements**

Report these as pending until the user installs the resulting LPK:

- local and remote tabs remain simultaneously visible and connected;
- two remote clients with `tab-1`/`pane-1` do not cross-wire;
- remote tabs show exactly one device icon on desktop and mobile;
- remote Herdr launches once and survives page refresh/reconnect;
- missing Herdr and terminal-control contention show bounded errors;
- desktop and mobile attach to the same remote authoritative pane.

- [ ] **Step 5: Return failures to the owning task**

Do not create a catch-all verifier commit. If a gate fails, fix it in the task
that introduced the affected file, rerun that task's focused tests, amend only
that task's implementation with a new focused commit, and then restart Task 7
from Step 1.
