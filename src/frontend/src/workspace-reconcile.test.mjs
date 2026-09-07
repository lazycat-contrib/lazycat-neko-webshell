import assert from "node:assert/strict";
import test from "node:test";
import { reconcileWorkspace } from "./workspace-reconcile.ts";
import { createWorkspacePaneLifetime } from "./workspace-pane-lifetime.ts";
import { workspaceEntityId } from "./workspace-identity.ts";

function fixture() {
  let tabs = [];
  const disposed = [], rendered = [], replayed = [], attached = [];
  const mount = () => ({ removed: 0, remove() { this.removed++; } });
  const lifetime = createWorkspacePaneLifetime({
    initialCols: 80, initialRows: 24,
    makePane: (tab, id) => ({ id: workspaceEntityId(tab.selector, "pane", id), mount: mount(), term: {}, socket: {}, transport: {}, pendingInput: ["queued"], localCols: 101, localRows: 35 }),
    disposePane: p => disposed.push(p), prepareReplay: p => replayed.push(p),
  });
  const apply = (workspace, extra = {}) => {
    const result = reconcileWorkspace({ workspace, selector: workspace.selector, tabs, preserveFocus: true,
      makeTab: (selector, id) => ({ id: workspaceEntityId(selector, "tab", id), workspaceTabId: id, selector, label: selector, mount: mount(), panes: [] }),
      restorePane: lifetime.restore, disposePane: lifetime.dispose, markPassive: lifetime.markPassive,
      attachTab: tab => attached.push(tab), renderLayout: tab => rendered.push(tab), ...extra,
    });
    tabs = result.tabs;
    return tabs;
  };
  return { apply, disposed, rendered, replayed, attached, lifetime };
}
const pane = (id, session = id) => ({ id, session_id: session, status: "running", cols: 80, rows: 24 });
const snapshot = (panes = [pane("p1")]) => ({ selector: "box", active_tab_id: "t1", tabs: [{ id: "t1", panes, active_pane_id: panes[0]?.id }] });

test("unchanged snapshot retains tab, DOM, layout, terminal, socket, transport, pending input and local geometry", () => {
  const f = fixture();
  const [tab] = f.apply(snapshot());
  const p = tab.panes[0], input = p.pendingInput, term = p.term, socket = p.socket, transport = p.transport, layout = tab.layout;
  const [again] = f.apply(snapshot());
  assert.equal(again, tab); assert.equal(again.layout, layout); assert.equal(again.panes[0], p);
  assert.equal(p.term, term); assert.equal(p.socket, socket); assert.equal(p.transport, transport); assert.equal(p.pendingInput, input);
  assert.equal(p.cols, 101); assert.equal(p.rows, 35);
  assert.equal(f.rendered.length, 1); assert.equal(f.attached.length, 1); assert.equal(f.disposed.length, 0);
});

test("remote rename/layout/membership converge, local pane focus survives, removals dispose exactly once", () => {
  const f = fixture();
  const state = snapshot([pane("p1"), pane("p2")]);
  const [tab] = f.apply(state), p1 = tab.panes[0], p2 = tab.panes[1];
  tab.activePaneId = p2.id;
  state.tabs[0].custom_label = "Renamed elsewhere";
  state.tabs[0].layout = { type: "split", axis: "columns", children: [{ type: "pane", paneId: "p2" }, { type: "pane", paneId: "p1" }] };
  f.apply(state);
  assert.equal(tab.customTitle, "Renamed elsewhere"); assert.equal(tab.activePaneId, p2.id); assert.equal(tab.panes[0], p1);
  assert.equal(f.rendered.length, 2);
  f.apply(snapshot([pane("p2")])); f.apply(snapshot([pane("p2")]));
  assert.deepEqual(f.disposed, [p1]); assert.equal(tab.panes[0], p2);
  f.apply({ selector: "box", tabs: [] }); f.apply({ selector: "box", tabs: [] });
  assert.deepEqual(f.disposed, [p1, p2]); assert.equal(tab.mount.removed, 1);
});

test("changed session/backend/reply authority replaces one pane; explicit history recovery replays only requested pane", () => {
  for (const change of [{ session_id: "new" }, { session_backend: "herdr" }, { terminal_reply_authority: "server" }]) {
    const f = fixture(); const [tab] = f.apply(snapshot([pane("p1"), pane("p2")]));
    const [old, unchanged] = tab.panes;
    f.apply(snapshot([{ ...pane("p1"), ...change }, pane("p2")]));
    assert.notEqual(tab.panes[0], old); assert.equal(tab.panes[1], unchanged); assert.deepEqual(f.disposed, [old]);
    f.lifetime.dispose(old); assert.equal(f.disposed.length, 1);
    f.apply(snapshot([{ ...pane("p1"), ...change }, pane("p2")]), { replayPaneId: unchanged.id });
    assert.deepEqual(f.replayed, [unchanged]);
  }
});

test("promoting a pane across tabs retains its runtime; passive discovery cannot enable restart", () => {
  const f = fixture(); const [tab] = f.apply(snapshot(), { passive: true }); const p = tab.panes[0];
  assert.equal(f.lifetime.mayRestart(p), false);
  f.apply({ selector: "box", tabs: [{ id: "promoted", panes: [pane("p1")] }] }, { passive: true });
  assert.equal(f.disposed.length, 0); assert.equal(p.tabId, workspaceEntityId("box", "tab", "promoted"));
  assert.equal(f.lifetime.mayRestart(p), false);
  f.apply({ selector: "box", tabs: [{ id: "promoted", panes: [pane("p1")] }] });
  assert.equal(f.lifetime.mayRestart(p), true);
});

test("selector identity cannot reuse a pane even when remote session IDs collide", () => {
  const f = fixture(); const [tab] = f.apply(snapshot()); const p = tab.panes[0];
  const replacement = f.lifetime.restore({ ...tab, selector: "other" }, pane("p1"), p);
  assert.notEqual(replacement, p); assert.deepEqual(f.disposed, [p]);
});

test("pending identity recovery survives passive snapshots and is replayed by the next explicit authoritative response", () => {
  const f = fixture(); const [tab] = f.apply(snapshot()); const p = tab.panes[0];
  p.workspaceRefreshPending = true;
  f.apply(snapshot(), { passive: true });
  assert.equal(p.workspaceRefreshPending, true); assert.deepEqual(f.replayed, []);
  f.apply(snapshot());
  assert.equal(p.workspaceRefreshPending, false); assert.deepEqual(f.replayed, [p]);
});
