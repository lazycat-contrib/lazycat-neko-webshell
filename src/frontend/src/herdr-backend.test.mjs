import assert from "node:assert/strict";
import test from "node:test";

import {
  herdrEventChangesAgentList,
  herdrEventChangesDock,
  herdrEventShowsStatus,
  herdrEventTone,
} from "./herdr-backend.ts";

test("treats Herdr metadata snapshots as silent dock changes", () => {
  assert.equal(herdrEventChangesDock("workspace.metadata_updated"), true);
  assert.equal(herdrEventChangesDock("pane.updated"), true);
  assert.equal(herdrEventChangesDock("pane.agent_detected"), false);
  assert.equal(herdrEventChangesDock("pane.agent_status_changed"), false);
  assert.equal(herdrEventChangesAgentList("pane.agent_detected"), true);
  assert.equal(herdrEventChangesAgentList("pane.agent_status_changed"), true);
  assert.equal(herdrEventShowsStatus("workspace.metadata_updated"), false);
  assert.equal(herdrEventShowsStatus("pane.updated"), false);
});

test("uses the final status when Herdr reports an agent release", () => {
  assert.equal(herdrEventTone("pane.agent_detected", { released: true, final_status: "done" }), "ok");
  assert.equal(herdrEventTone("pane.agent_detected", { released: true, final_status: "blocked" }), "error");
  assert.equal(herdrEventTone("pane.agent_detected", { released: true }), "neutral");
});
