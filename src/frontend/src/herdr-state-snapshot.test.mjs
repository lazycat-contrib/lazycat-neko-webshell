import assert from "node:assert/strict";
import test from "node:test";

import {
  herdrBridgeStateForUi,
  herdrBridgeStatesEqual,
  herdrSnapshotResourcesComplete,
} from "./herdr-state-snapshot.ts";

test("rejects partial Herdr resource snapshots", () => {
  assert.equal(herdrSnapshotResourcesComplete({ resources_complete: true }), true);
  assert.equal(herdrSnapshotResourcesComplete({ resources_complete: false }), false);
});

test("keeps degraded Herdr metadata while disabling incomplete resources", () => {
  const degraded = {
    selector: "demo@owner",
    available: true,
    resources_complete: false,
    message: "pane.list failed",
    herdr_version: "0.8.0",
    herdr_protocol: 20,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
  };

  assert.deepEqual(herdrBridgeStateForUi(degraded), {
    ...degraded,
    available: false,
  });
  assert.equal(herdrBridgeStateForUi({ ...degraded, resources_complete: true }).available, true);
});

test("compares authoritative Herdr snapshots without depending on object key order", () => {
  const current = {
    selector: "alpha",
    focused_tab_id: "t2",
    tabs: [
      { tab_id: "t1", tokens: { branch: "main", cwd: "/work" } },
      { tab_id: "t2", tokens: {} },
    ],
  };
  const same = {
    tabs: [
      { tokens: { cwd: "/work", branch: "main" }, tab_id: "t1" },
      { tokens: {}, tab_id: "t2" },
    ],
    focused_tab_id: "t2",
    selector: "alpha",
  };

  assert.equal(herdrBridgeStatesEqual(current, same), true);
  assert.equal(herdrBridgeStatesEqual(undefined, same), false);
  assert.equal(herdrBridgeStatesEqual(current, { ...same, focused_tab_id: "t1" }), false);
  assert.equal(herdrBridgeStatesEqual(current, { ...same, tabs: [...same.tabs].reverse() }), false);
});
