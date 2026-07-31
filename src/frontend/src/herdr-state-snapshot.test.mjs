import assert from "node:assert/strict";
import test from "node:test";

import { herdrBridgeStatesEqual } from "./herdr-state-snapshot.ts";

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
