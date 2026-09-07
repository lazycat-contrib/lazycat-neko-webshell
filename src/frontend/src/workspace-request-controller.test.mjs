import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceRequestController } from "./workspace-request-controller.ts";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test("focus persistence cannot discard a structural reply and latest local focus wins", async () => {
  for (const action of ["create", "split"]) {
    const controller = createWorkspaceRequestController();
    const response = deferred();
    let applied = false;
    const mutation = controller.run(" box ", "mutation", async (request) => {
      await response.promise;
      assert.equal(request.isCurrent(), true, action);
      assert.equal(request.focusUnchanged(), false);
      applied = true;
      return action;
    });
    await tick();
    await controller.run("box", "focus", async () => "persisted");
    response.resolve();
    assert.equal(await mutation, action);
    assert.equal(applied, true);
  }
});

test("structural lane serializes through apply, other selectors remain independent, failure releases lane", async () => {
  const controller = createWorkspaceRequestController();
  const first = deferred();
  const order = [];
  const a = controller.run("box", "mutation", async () => { order.push("first"); await first.promise; throw new Error("failed"); });
  const failed = assert.rejects(a, /failed/);
  const b = controller.run(" box ", "mutation", async () => { order.push("second"); return 2; });
  assert.equal(await controller.run("elsewhere", "mutation", async () => 3), 3);
  assert.deepEqual(order, ["first"]);
  first.resolve();
  await failed;
  assert.equal(await b, 2);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(controller.read("box").isCurrent(), true);
});

test("GET cannot overwrite a PUT or newer GET, queued mutations fence reads immediately", async () => {
  const controller = createWorkspaceRequestController();
  const firstRead = controller.read("box");
  const latestRead = controller.read("box");
  assert.equal(firstRead.isCurrent(), false);
  const barrier = deferred();
  const pending = controller.run("box", "mutation", async () => barrier.promise);
  const duringMutation = controller.read("box");
  assert.equal(latestRead.isCurrent(), false);
  assert.equal(duringMutation.isCurrent(), false);
  barrier.resolve(); await pending;
  assert.equal(duringMutation.isCurrent(), false);
  assert.equal(controller.read("box").isCurrent(), true);
});

test("selector replacement and disposal reject late responses and queued side effects", async () => {
  for (const invalidate of [c => c.invalidate("box"), c => c.dispose()]) {
    const controller = createWorkspaceRequestController();
    const barrier = deferred();
    let lateApplied = false, queuedRan = false;
    const first = controller.run("box", "mutation", async (request) => { await barrier.promise; lateApplied = request.isCurrent(); });
    await tick();
    const queued = controller.run("box", "mutation", async () => { queuedRan = true; });
    invalidate(controller); barrier.resolve();
    await Promise.all([first, queued]);
    assert.equal(lateApplied, false);
    assert.equal(queuedRan, false);
    controller.dispose(); controller.dispose();
  }
});

test("passive refresh cannot supersede a pending explicit restore or another passive fetch", () => {
  const controller = createWorkspaceRequestController();
  const restore = controller.read("box");
  const passive = controller.read("box", { passive: true });
  assert.equal(passive.isCurrent(), false); assert.equal(restore.isCurrent(), true);
  restore.finish();
  const first = controller.read("box", { passive: true });
  assert.equal(first.isCurrent(), true);
  assert.equal(controller.read("box", { passive: true }).isCurrent(), false);
  const newerRestore = controller.read("box");
  assert.equal(first.isCurrent(), false); assert.equal(newerRestore.isCurrent(), true);
  first.finish();
  assert.equal(controller.read("box", { passive: true }).isCurrent(), false);
  newerRestore.finish();
  assert.equal(controller.read("box", { passive: true }).isCurrent(), true);
});

test("rename, pin and layout persistence preserve local focus; creation and removal may select their result", async () => {
  const { workspaceActionChangesFocus } = await import("./workspace-request-controller.ts");
  for (const action of ["rename_tab", "set_tab_pinned", "update_layout", "activate_tab", "activate_pane"]) {
    assert.equal(workspaceActionChangesFocus(action), false, action);
  }
  for (const action of ["create_tab", "split_pane", "promote_pane_to_tab", "close_tab", "close_pane"]) {
    assert.equal(workspaceActionChangesFocus(action), true, action);
  }
});
