import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspacePassiveSync, bindWorkspacePassiveSync, refreshWorkspaceSelectors } from "./workspace-passive-sync.ts";
import { reconcileWorkspace } from "./workspace-reconcile.ts";
import { createWorkspacePaneLifetime } from "./workspace-pane-lifetime.ts";
import { workspaceEntityId } from "./workspace-identity.ts";
import { createWorkspaceRequestController } from "./workspace-request-controller.ts";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function clock() {
  let id = 0;
  const timers = new Map();
  return {
    timers,
    schedule: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    cancel: timer => timers.delete(timer),
    fire: () => { const [key, timer] = timers.entries().next().value; timers.delete(key); timer.callback(); },
  };
}

test("refresh bursts coalesce, one timer remains, failures back off within bound", async () => {
  const timer = clock(); const first = deferred(); let count = 0, fail = false;
  const sync = createWorkspacePassiveSync({ ...timer, enabled: () => true, intervalMs: 1000, maxDelayMs: 4000,
    refresh: async () => { count++; if (count === 1) await first.promise; if (fail) throw Error("offline"); },
  });
  sync.refresh(); sync.refresh(); sync.refresh();
  assert.equal(count, 1); assert.equal(timer.timers.size, 0);
  first.resolve(); await tick(); assert.equal(count, 2); assert.equal(timer.timers.size, 1);
  fail = true; timer.fire(); await tick(); assert.equal([...timer.timers.values()][0].delay, 2000);
  timer.fire(); await tick(); assert.equal([...timer.timers.values()][0].delay, 4000);
  timer.fire(); await tick(); assert.equal([...timer.timers.values()][0].delay, 4000);
  fail = false; timer.fire(); await tick(); assert.equal([...timer.timers.values()][0].delay, 1000);
  sync.dispose(); sync.dispose(); assert.equal(timer.timers.size, 0);
});

test("hidden/offline aborts pending request, late data cannot apply, resume refreshes promptly", async () => {
  const timer = clock(); let enabled = true, applied = 0, signal; const barrier = deferred();
  const sync = createWorkspacePassiveSync({ ...timer, enabled: () => enabled,
    refresh: async value => { signal = value; await barrier.promise; if (!value.aborted) applied++; },
  });
  sync.refresh(); enabled = false; sync.activityChanged();
  assert.equal(signal.aborted, true); assert.equal(timer.timers.size, 0);
  barrier.resolve(); await tick(); assert.equal(applied, 0); assert.equal(timer.timers.size, 0);
  enabled = true; sync.activityChanged(); await tick(); assert.equal(applied, 1);
  sync.dispose(); assert.equal(timer.timers.size, 0);
});

test("two visible devices converge membership with mutation fencing and preserve unchanged runtime identity", async () => {
  let server = ["one"];
  function device() {
    const timer = clock(), requests = createWorkspaceRequestController();
    let tabs = [], disposed = [], connections = 0;
    let delayed;
    const lifetime = createWorkspacePaneLifetime({ initialCols: 80, initialRows: 24,
      makePane: (tab, id) => ({ id: workspaceEntityId(tab.selector, "pane", id), term: {}, socket: { id: ++connections }, pendingInput: ["queued"], localCols: 100, localRows: 30 }),
      disposePane: pane => disposed.push(pane), prepareReplay: () => assert.fail("passive replay"),
    });
    const sync = createWorkspacePassiveSync({ ...timer, enabled: () => true,
      refresh: async signal => {
        const request = requests.read("box", { passive: true });
        const state = [...server];
        try {
          if (delayed) await delayed.promise;
          if (signal.aborted || !request.isCurrent()) return;
          tabs = reconcileWorkspace({ selector: "box", tabs, preserveFocus: true, passive: true,
            workspace: { selector: "box", tabs: state.map(id => ({ id, panes: [{ id, session_id: id, status: "running", cols: 80, rows: 24 }] })) },
            makeTab: (selector, id) => ({ id: workspaceEntityId(selector, "tab", id), workspaceTabId: id, selector, label: selector, panes: [], mount: { remove() {} } }),
            restorePane: lifetime.restore, disposePane: lifetime.dispose,
            attachTab() {}, renderLayout() {},
          }).tabs;
        } finally { request.finish(); }
      },
    });
    return { sync, timer, requests, runtime: () => new Map(tabs.map(tab => [tab.workspaceTabId, tab.panes[0]])), disposed, connections: () => connections,
      delay: value => { delayed = value; } };
  }
  const a = device(), b = device(); a.sync.refresh(); b.sync.refresh(); await tick();
  const first = b.runtime().get("one");
  await a.requests.run("box", "mutation", async () => { server.push("two"); });
  a.timer.fire(); b.timer.fire(); await tick();
  assert.equal(b.runtime().get("one"), first); assert.equal(b.connections(), 2);
  const barrier = deferred(); b.delay(barrier); b.sync.refresh();
  await b.requests.run("box", "mutation", async () => { server = ["one"]; });
  barrier.resolve(); await tick(); // stale read is rejected
  b.delay(undefined); a.timer.fire(); b.timer.fire(); await tick();
  assert.deepEqual([...a.runtime().keys()], ["one"]); assert.deepEqual([...b.runtime().keys()], ["one"]);
  assert.equal(b.runtime().get("one"), first); assert.equal(b.connections(), 2); assert.equal(b.disposed.length, 1);
  a.sync.dispose(); b.sync.dispose(); assert.equal(a.timer.timers.size + b.timer.timers.size, 0);
});

test("browser binding disposes listeners and request ownership on page teardown", () => {
  const windowTarget = new EventTarget(), documentTarget = new EventTarget();
  let refreshes = 0, disposed = 0, ownershipDisposed = 0;
  bindWorkspacePassiveSync({ refresh() { refreshes++; }, activityChanged() { refreshes++; }, dispose() { disposed++; } },
    windowTarget, documentTarget, () => ownershipDisposed++);
  windowTarget.dispatchEvent(new Event("focus")); documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(refreshes, 3);
  windowTarget.dispatchEvent(new Event("pagehide")); windowTarget.dispatchEvent(new Event("pagehide"));
  windowTarget.dispatchEvent(new Event("online")); documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(refreshes, 3); assert.equal(disposed, 1); assert.equal(ownershipDisposed, 1);
});

test("bfcache pagehide pauses without disposal and pageshow resumes the existing controller", async () => {
  const windowTarget = new EventTarget(), documentTarget = new EventTarget(), timer = clock();
  let count = 0, disposed = 0;
  const controller = createWorkspacePassiveSync({ ...timer, enabled: () => true, refresh: async () => { count++; } });
  bindWorkspacePassiveSync(controller, windowTarget, documentTarget, () => disposed++);
  await tick(); assert.equal(timer.timers.size, 1);
  const hide = new Event("pagehide"); Object.defineProperty(hide, "persisted", { value: true });
  windowTarget.dispatchEvent(hide);
  assert.equal(timer.timers.size, 0); assert.equal(disposed, 0);
  windowTarget.dispatchEvent(new Event("pageshow")); await tick();
  assert.equal(count, 2); assert.equal(timer.timers.size, 1);
  windowTarget.dispatchEvent(new Event("pagehide")); assert.equal(disposed, 1); assert.equal(timer.timers.size, 0);
});


test("an unavailable first target does not starve healthy retained targets and still backs off", async () => {
  const timer = clock(), refreshed = [];
  const sync = createWorkspacePassiveSync({ ...timer, enabled: () => true, intervalMs: 1000,
    refresh: signal => refreshWorkspaceSelectors({
      selectors: ["offline", "healthy"], signal, skip: () => false,
      refresh: async selector => { refreshed.push(selector); if (selector === "offline") throw Error("unavailable"); },
    }),
  });
  sync.refresh(); await tick();
  assert.deepEqual(refreshed, ["offline", "healthy"]);
  assert.equal([...timer.timers.values()][0].delay, 2000);
  timer.fire(); await tick();
  assert.deepEqual(refreshed, ["offline", "healthy", "offline", "healthy"]);
  assert.equal([...timer.timers.values()][0].delay, 4000);
  sync.dispose(); assert.equal(timer.timers.size, 0);
});

test("selector sweep normalizes and deduplicates targets and skips unsupported selectors", async () => {
  const refreshed = [], signal = new AbortController().signal;
  await refreshWorkspaceSelectors({
    selectors: ["", " ", " box ", "box", "unsupported", " unsupported ", "other"], signal,
    skip: selector => selector === "unsupported",
    refresh: async (selector, receivedSignal) => { assert.equal(receivedSignal, signal); refreshed.push(selector); },
  });
  assert.deepEqual(refreshed, ["box", "other"]);
});

test("selector sweep reports accumulated failures only after refreshing every healthy target", async () => {
  const errors = [Error("first"), Error("last")], refreshed = [];
  await assert.rejects(refreshWorkspaceSelectors({
    selectors: ["first", "healthy", "last"], signal: new AbortController().signal, skip: () => false,
    refresh: async selector => { refreshed.push(selector); if (selector === "first") throw errors[0]; if (selector === "last") throw errors[1]; },
  }), error => { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, errors); return true; });
  assert.deepEqual(refreshed, ["first", "healthy", "last"]);
});

test("aborting a sweep fences delayed application and stops all later target requests", async () => {
  const controller = new AbortController(), barrier = deferred(), started = [], applied = [];
  const pending = refreshWorkspaceSelectors({
    selectors: ["held", "later"], signal: controller.signal, skip: () => false,
    refresh: async (selector, signal) => {
      started.push(selector); await barrier.promise;
      if (!signal.aborted) applied.push(selector);
    },
  });
  controller.abort(); barrier.resolve(); await pending;
  assert.deepEqual(started, ["held"]); assert.deepEqual(applied, []);
  await refreshWorkspaceSelectors({ selectors: ["never"], signal: controller.signal, skip: () => false,
    refresh: async () => assert.fail("aborted sweep started a request"),
  });
});
