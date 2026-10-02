import assert from "node:assert/strict";
import test from "node:test";
import { aggregateHerdrActivity, normalizeHerdrActivity } from "./herdr-activity.ts";
import { buildHerdrJumpModel } from "./herdr-jump-model.ts";
import { renderHerdrJumpGroups } from "./herdr-jump-view.ts";

test("active work remains visible over completed panes and blocked work has priority", () => {
  assert.equal(aggregateHerdrActivity(["done", "working", "idle"]), "working");
  assert.equal(aggregateHerdrActivity(["working", "blocked"]), "blocked");
  assert.equal(aggregateHerdrActivity(["unknown", "idle"]), "idle");
  assert.equal(normalizeHerdrActivity("future-state"), "unknown");
});

test("jump groups use authoritative agent statuses and lightweight accessible marks", () => {
  const model = buildHerdrJumpModel({
    workspaces: [{workspace_id:"w",number:1,label:"Project",focused:true}],
    tabs:[{tab_id:"t",workspace_id:"w",number:1,label:"Build",focused:true}],
    panes:[{pane_id:"p",tab_id:"t",workspace_id:"w",agent_status:"idle",focused:true}],
    agents:[{pane_id:"p",agent_status:"working"}],
  }, {workspace:n=>n,workspaceDefault:"Workspace",tab:n=>n,tabDefault:"Tab",terminal:"Terminal"});
  assert.equal(model.groups[0].status, "working");
  assert.equal(model.groups[0].targets[0].status, "working");
  const html=renderHerdrJumpGroups(model,"compact",{current:"Current",empty:"Empty",focusWorkspace:"Workspace",focusTab:"Tab",focusPane:"Pane",activity:s=>s});
  assert.match(html,/data-status="working"/);assert.match(html,/aria-label="Tab: Build · 1 · working"/);
  assert.match(html,/herdr-jump-status" aria-hidden="true">◐/);
});
