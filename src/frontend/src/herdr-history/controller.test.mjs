import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrHistoryController } from "./controller.ts";
import { historyTargetFromPane, sameHistoryTarget } from "./types.ts";

const range = { start: { row: 19, col: 6 }, end: { row: 19, col: 10 } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(override, copyOverride) {
  let target = { selector: "box", generation: 1, paneId: "outer", sessionId: "session" };
  let state;
  const requests = [], copies = [];
  const reply = async (method, params) => {
    if (method === "pane.list") return { result: { panes: [
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", title: "Selected inner pane" },
      { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", title: "Other pane" },
    ] } };
    if (method === "pane.copy_motion") return { result: { pane_id: params.pane_id, cursor: { row: 0, col: 0 }, content_revision: 42 } };
    if (method === "pane.copy_search") return { result: { pane_id: params.pane_id, content_revision: 42, matches: [range], total: 1300, current: 0, current_global: 1200 } };
    if (method === "pane.selection.read") return { result: { pane_id: params.pane_id, text: "hello" } };
    assert.fail(method);
  };
  const controller = createHerdrHistoryController({
    target: () => target,
    request: async (method, params, target) => { requests.push({ method, params, target }); return override ? override(method, params, reply) : reply(method, params); },
    copy: copyOverride ?? (async text => copies.push(await text)), changed: value => { state = value; },
  });
  return { controller, requests, copies, state: () => state, switchTarget: () => { target = { ...target, generation: 2 }; } };
}
async function ready(fixture) {
  await fixture.controller.open();
  fixture.controller.selectPane("w1:p2");
  fixture.controller.setQuery("hello");
}

test("requires explicit inner-pane selection and labels workspace/tab/pane without trusting focus", async () => {
  const f = setup(); await f.controller.open();
  assert.equal(f.state().paneId, "");
  assert.match(f.state().panes[0].label, /w1.*w1:t1.*w1:p2/);
  f.controller.setQuery("hello"); await f.controller.search("forward");
  assert.equal(f.requests.length, 1);
  f.controller.selectPane("not-listed"); assert.equal(f.state().paneId, "");
});

test("bootstraps real content revision and copies inclusive absolute search ranges, not outer TUI coordinates", async () => {
  const f = setup(); await ready(f); await f.controller.search("forward");
  assert.deepEqual(f.requests.map(r => r.method), ["pane.list", "pane.copy_motion", "pane.copy_search", "pane.selection.read"]);
  assert.deepEqual(f.requests[1].params, { pane_id: "w1:p2", cursor: { row: 0, col: 0 }, motion: "first_non_blank" });
  assert.equal(f.requests[2].params.content_revision, 42);
  assert.deepEqual(f.requests[3].params, { pane_id: "w1:p2", anchor: range.start, cursor: range.end, content_revision: 42 });
  assert.equal(f.state().position, 1201); assert.equal(f.state().total, 1300); assert.equal(f.state().preview, "hello");
  await f.controller.copy();
  assert.equal(f.requests.at(-1).method, "pane.selection.read"); // Revalidate immediately before copying.
  assert.deepEqual(f.copies, ["hello"]); assert.equal(f.state().status, "copied");
});

test("previous and next pass the last server range, using global match count across bounded windows", async () => {
  const f = setup(); await ready(f); await f.controller.search("forward");
  await f.controller.search("backward");
  const next = f.requests.filter(r => r.method === "pane.copy_search").at(-1).params;
  assert.deepEqual(next.previous, range); assert.deepEqual(next.cursor, range.start); assert.equal(next.direction, "backward");
  assert.equal(f.requests.filter(r => r.method === "pane.copy_motion").length, 1);
});

test("stale content clears copy eligibility and refresh obtains a new revision", async () => {
  let stale = false;
  const f = setup((method, params, reply) => method === "pane.selection.read" && stale
    ? { error: { code: "stale_content", message: "changed" } } : reply(method, params));
  await ready(f); await f.controller.search("forward"); stale = true; await f.controller.copy();
  assert.equal(f.state().status, "stale"); assert.equal(f.state().match, undefined); assert.deepEqual(f.copies, []);
  stale = false; await f.controller.search("forward", true);
  assert.equal(f.requests.filter(r => r.method === "pane.copy_motion").length, 2);
  assert.equal(f.state().preview, "hello");
});

test("older Herdr invalid_request unknown variant disables only history requests", async () => {
  const f = setup((method, params, reply) => method === "pane.copy_motion"
    ? { error: { code: "invalid_request", message: "unknown variant `pane.copy_motion`" } } : reply(method, params));
  await ready(f); await f.controller.search("forward");
  assert.equal(f.state().status, "unsupported"); const count = f.requests.length;
  await f.controller.search("forward"); assert.equal(f.requests.length, count);
});

test("query UTF-8 byte budget rejects oversized text before any search request", async () => {
  const f = setup(); await ready(f); f.controller.setQuery("汉".repeat(1400)); await f.controller.search("forward");
  assert.equal(f.state().status, "queryTooLong"); assert.equal(f.requests.length, 1);
});

test("target replacement during bootstrap rejects all later requests", async () => {
  const hold = deferred();
  const f = setup(async (method, params, reply) => { if (method === "pane.copy_motion") await hold.promise; return reply(method, params); });
  await ready(f); const search = f.controller.search("forward"); f.switchTarget(); hold.resolve(); await search;
  assert.equal(f.state().status, "targetChanged"); assert.equal(f.requests.length, 2); assert.deepEqual(f.copies, []);
});

test("switching chosen inner pane or query while a result is pending discards the stale result", async () => {
  for (const change of [f => f.controller.selectPane("w1:p3"), f => f.controller.setQuery("different")]) {
    const hold = deferred();
    const f = setup(async (method, params, reply) => { if (method === "pane.copy_search") await hold.promise; return reply(method, params); });
    await ready(f); const search = f.controller.search("forward");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    change(f); hold.resolve(); await search;
    assert.equal(f.state().match, undefined); assert.deepEqual(f.copies, []);
  }
});

test("late copy read after target change or dialog dismissal never reaches clipboard", async () => {
  for (const change of [f => f.switchTarget(), f => f.controller.dismiss()]) {
    const hold = deferred(); let held = false;
    const f = setup(async (method, params, reply) => { if (method === "pane.selection.read" && held) await hold.promise; return reply(method, params); });
    await ready(f); await f.controller.search("forward"); held = true;
    const copy = f.controller.copy(); change(f); hold.resolve(); await copy; assert.deepEqual(f.copies, []);
  }
});

test("wrong pane, odd revision and out-of-window current never make text copyable", async () => {
  for (const broken of [
    { pane_id: "other", content_revision: 42, matches: [range], total: 1, current: 0, current_global: 0 },
    { pane_id: "w1:p2", content_revision: 43, matches: [range], total: 1, current: 0, current_global: 0 },
    { pane_id: "w1:p2", content_revision: 42, matches: [range], total: 1, current: 1, current_global: 0 },
  ]) {
    const f = setup((method, params, reply) => method === "pane.copy_search" ? { result: broken } : reply(method, params));
    await ready(f); await f.controller.search("forward"); await f.controller.copy();
    assert.equal(f.state().status, "error"); assert.deepEqual(f.copies, []);
  }
});

test("an empty result clears the previous match and never reads a selection", async () => {
  const f = setup((method, params, reply) => method === "pane.copy_search"
    ? { result: { pane_id: params.pane_id, content_revision: 42, matches: [], total: 0 } } : reply(method, params));
  await ready(f); await f.controller.search("forward"); await f.controller.copy();
  assert.equal(f.state().status, "empty"); assert.deepEqual(f.copies, []);
  assert.equal(f.requests.at(-1).method, "pane.copy_search");
});

test("changed targets during clipboard completion cannot publish a copied status", async () => {
  const hold = deferred(); let target = { selector: "box", generation: 1, paneId: "outer", sessionId: "session" };
  let status;
  const controller = createHerdrHistoryController({ target: () => target, changed: state => { status = state.status; },
    copy: async (text) => { await text; target = { ...target, generation: 2 }; await hold.promise; },
    request: async (method, params) => ({ result: method === "pane.list"
      ? { panes: [{ pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1" }] }
      : method === "pane.copy_motion" ? { pane_id: params.pane_id, cursor: range.start, content_revision: 42 }
      : method === "pane.copy_search" ? { pane_id: params.pane_id, content_revision: 42, matches: [range], total: 1, current: 0, current_global: 0 }
      : { pane_id: params.pane_id, text: "hello" } }),
  });
  await controller.open(); controller.selectPane("w1:p2"); controller.setQuery("hello"); await controller.search("forward");
  const copy = controller.copy(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  hold.resolve(); await copy; assert.equal(status, "targetChanged");
});

test("a bootstrap odd content sequence is rejected before search rather than guessing a revision", async () => {
  const f = setup((method, params, reply) => method === "pane.copy_motion"
    ? { result: { pane_id: params.pane_id, cursor: { row: 0, col: 0 }, content_revision: 43 } } : reply(method, params));
  await ready(f); await f.controller.search("forward");
  assert.equal(f.state().status, "stale"); assert.equal(f.requests.length, 2); assert.deepEqual(f.copies, []);
});

test("outer terminal target identity rejects wrong selectors, disposed panes and replacement sessions", () => {
  const pane = { id: "outer", selector: "box", sessionId: "session", closing: false };
  const target = historyTargetFromPane({ selector: " box ", generation: 1, pane });
  assert.equal(target.selector, "box");
  assert.equal(historyTargetFromPane({ selector: "other", generation: 1, pane }), undefined);
  assert.equal(historyTargetFromPane({ selector: "box", generation: 1, pane: { ...pane, closing: true } }), undefined);
  assert.equal(sameHistoryTarget(target, { ...target, sessionId: "replacement" }), false);
});

test("clipboard denial keeps the validated preview available for manual selection and retry", async () => {
  const f = setup(undefined, async (text) => { await text; throw new Error("NotAllowedError"); });
  await ready(f); await f.controller.search("forward"); await f.controller.copy();
  assert.equal(f.state().status, "copyError");
  assert.equal(f.state().preview, "hello");
  assert.deepEqual(f.state().match, range);
});
