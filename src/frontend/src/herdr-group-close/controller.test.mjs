import assert from "node:assert/strict";
import test from "node:test";

import {
  createHerdrGroupCloseController,
  herdrWorkspaceGroup,
  herdrWorkspaceFingerprint,
} from "./controller.ts";

const GROUP_REQUIRED = "workspace_group_close_required";
const templates = {
  "confirm.closeHerdrSpaceGroup": "Close {parent} and {count}: {children}{extra}",
  "confirm.closeHerdrSpaceGroupExtra": ", plus {count}",
};
const tr = (key, values = {}) => Object.entries(values).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
  templates[key] ?? key,
);
const tick = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };

function groupResponse(childLabel = "Feature auth") {
  return {
    result: {
      type: "workspace_list",
      workspaces: [
        { workspace_id: "plain", label: "Notes" },
        { workspace_id: "parent", label: "Main repo", worktree: { repo_key: "repo", is_linked_worktree: false } },
        { workspace_id: "child", label: childLabel, worktree: { repo_key: "repo", is_linked_worktree: true } },
      ],
    },
  };
}

function requiredError() {
  return Object.assign(new Error("group intent required"), { code: GROUP_REQUIRED });
}

function harness(overrides = {}) {
  let current = { selector: "box", generation: 1, workspaceId: "parent" };
  const calls = [];
  const statuses = [];
  const visibility = [];
  let confirms = 0;
  let afterClose = 0;
  const request = overrides.request ?? (async (method, params) => {
    calls.push({ method, params });
    return method === "workspace.list" ? groupResponse() : { result: { type: "ok" } };
  });
  const controller = createHerdrGroupCloseController({
    target: () => current,
    isCurrent: (target) => target.selector === current.selector && target.generation === current.generation,
    canMutate: () => true,
    request: async (method, params, target) => request(method, params, target, calls),
    runExclusive: overrides.runExclusive ?? (async (task) => task()),
    confirm: async (options) => { confirms += 1; return overrides.confirm?.(options, () => current) ?? false; },
    afterClose: async () => { afterClose += 1; },
    setGroupActionVisible: (visible) => visibility.push(visible),
    onStatus: (message, tone) => statuses.push({ message, tone }),
    tr,
  });
  return {
    controller,
    calls,
    statuses,
    visibility,
    confirms: () => confirms,
    afterClose: () => afterClose,
    setCurrent: (next) => { current = next; },
    current: () => current,
  };
}

test("resolves a parent and linked worktree group while ignoring unrelated workspaces", () => {
  const group = herdrWorkspaceGroup(groupResponse(), "parent");
  assert.equal(group.parent.label, "Main repo");
  assert.deepEqual(group.members.map((member) => member.workspaceId), ["child", "parent"]);
  assert.equal(herdrWorkspaceGroup(groupResponse(), "child"), undefined);
  assert.notEqual(
    herdrWorkspaceFingerprint([{ workspace_id: "parent", label: "Main", tab_count: 1, pane_count: 1 }]),
    herdrWorkspaceFingerprint([{ workspace_id: "parent", label: "Main", tab_count: 2, pane_count: 1 }]),
  );
});

test("ordinary close remains a single request for old and ungrouped servers", async () => {
  const h = harness();
  await h.controller.closeWorkspace();
  assert.deepEqual(h.calls, [{ method: "workspace.close", params: { workspace_id: "parent" } }]);
  assert.equal(h.confirms(), 0);
  assert.equal(h.afterClose(), 1);
});

test("cancelling the guarded group retry sends no close_group request", async () => {
  const h = harness({
    request: async (method, params, _target, calls) => {
      calls.push({ method, params });
      if (method === "workspace.close") throw requiredError();
      return groupResponse();
    },
    confirm: () => false,
  });
  await h.controller.closeWorkspace();
  assert.equal(h.confirms(), 1);
  assert.equal(h.calls.filter((call) => call.params.close_group === true).length, 0);
  assert.equal(h.afterClose(), 0);
});

test("confirmed guarded retry revalidates the unchanged group before explicit closure", async () => {
  let closeAttempts = 0;
  const h = harness({
    request: async (method, params, _target, calls) => {
      calls.push({ method, params });
      if (method === "workspace.close" && closeAttempts++ === 0) throw requiredError();
      return method === "workspace.list" ? groupResponse() : { result: { type: "ok" } };
    },
    confirm: (options) => {
      assert.match(options.message, /Main repo/);
      assert.match(options.message, /Feature auth/);
      assert.equal(options.danger, true);
      return true;
    },
  });
  await h.controller.closeWorkspace();
  assert.equal(h.calls.filter((call) => call.method === "workspace.list").length, 3);
  assert.deepEqual(h.calls.at(-1), {
    method: "workspace.close",
    params: { workspace_id: "parent", close_group: true },
  });
  assert.equal(h.afterClose(), 1);
});

test("explicit group entry previews first and cancellation does nothing", async () => {
  const h = harness({ confirm: () => false });
  await h.controller.closeWorkspaceGroup();
  assert.deepEqual(h.calls.map((call) => call.method), ["workspace.list"]);
  assert.equal(h.afterClose(), 0);
});

test("explicit group entry confirms the named scope before close_group true", async () => {
  const h = harness({
    confirm: (options) => {
      assert.match(options.message, /Main repo/);
      assert.match(options.message, /and 1: Feature auth/);
      return true;
    },
  });
  await h.controller.closeWorkspaceGroup();
  assert.deepEqual(h.calls.map((call) => call.method), [
    "workspace.list", "workspace.list", "workspace.list", "workspace.close",
  ]);
  assert.deepEqual(h.calls.at(-1).params, { workspace_id: "parent", close_group: true });
  assert.equal(h.afterClose(), 1);
});

test("changed target after confirmation prevents group closure", async () => {
  const h = harness({
    confirm: (_options, current) => {
      h.setCurrent({ ...current(), workspaceId: "other" });
      return true;
    },
  });
  await h.controller.closeWorkspaceGroup();
  assert.equal(h.calls.filter((call) => call.params.close_group === true).length, 0);
  assert.match(h.statuses.at(-1).message, /status\.herdrTargetChanged/);
});

test("changed group membership after confirmation prevents group closure", async () => {
  let lists = 0;
  const h = harness({
    request: async (method, params, _target, calls) => {
      calls.push({ method, params });
      if (method !== "workspace.list") return { result: { type: "ok" } };
      lists += 1;
      return lists === 1 ? groupResponse() : groupResponse("Renamed after prompt");
    },
    confirm: () => true,
  });
  await h.controller.closeWorkspaceGroup();
  assert.equal(h.calls.filter((call) => call.params.close_group === true).length, 0);
  assert.match(h.statuses.at(-1).message, /status\.herdrSpaceGroupChanged/);
});

test("background observation shows the explicit action only for a current parent group", async () => {
  const h = harness();
  h.controller.observe(h.current(), "one");
  await tick();
  assert.equal(h.controller.groupActionVisible(), true);
  h.setCurrent({ ...h.current(), workspaceId: "child" });
  h.controller.observe(h.current(), "two");
  await tick();
  assert.equal(h.controller.groupActionVisible(), false);
});

test("non-group close errors are surfaced without retrying destructively", async () => {
  const h = harness({
    request: async (method, params, _target, calls) => {
      calls.push({ method, params });
      throw Object.assign(new Error("permission denied"), { code: "forbidden" });
    },
  });
  await h.controller.closeWorkspace();
  assert.equal(h.calls.length, 1);
  assert.equal(h.confirms(), 0);
  assert.deepEqual(h.statuses.at(-1), {
    message: "status.herdrActionFailed",
    tone: "error",
  });
});

test("a queued ordinary close revalidates the delayed target before requesting", async () => {
  const h = harness({
    runExclusive: async (task) => {
      await Promise.resolve();
      h.setCurrent({ ...h.current(), workspaceId: "other" });
      return task();
    },
  });
  await h.controller.closeWorkspace();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.statuses.at(-1), {
    message: "status.herdrTargetChanged",
    tone: "neutral",
  });
});
