import assert from "node:assert/strict";
import test from "node:test";

import {
  herdrEventChangesAgentList,
  herdrEventChangesDock,
  herdrEventNeedsStateReconciliation,
  herdrEventNeedsStateRefresh,
  herdrEventShowsStatus,
  herdrEventTone,
  selectActiveHerdrTerminalPane,
} from "./herdr-backend.ts";

test("shows Herdr-only controls only for the active pane in a mixed-backend tab", () => {
  const herdrPane = {
    id: "herdr",
    tabId: "tab-1",
    selector: "alpha@owner",
    sessionBackend: "herdr",
    closing: false,
  };
  const webshellPane = {
    id: "webshell",
    tabId: "tab-1",
    selector: "alpha@owner",
    sessionBackend: "webshell",
    closing: false,
  };
  const tab = {
    id: "tab-1",
    selector: "alpha@owner",
    panes: [herdrPane, webshellPane],
  };

  assert.equal(selectActiveHerdrTerminalPane(tab, herdrPane), herdrPane);
  assert.equal(selectActiveHerdrTerminalPane(tab, webshellPane), undefined);
});

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

test("keeps applied Herdr focus signals on the realtime path", () => {
  for (const event of ["workspace.focused", "tab.focused", "pane.focused"]) {
    assert.equal(herdrEventNeedsStateRefresh(event, true), false);
    assert.equal(herdrEventNeedsStateRefresh(event, false), true);
    assert.equal(herdrEventNeedsStateReconciliation(event, true), true);
    assert.equal(herdrEventNeedsStateReconciliation(event, false), false);
  }
  assert.equal(herdrEventNeedsStateRefresh("tab.created", false), true);
  assert.equal(herdrEventNeedsStateRefresh("pane.agent_detected", false), false);
  assert.equal(herdrEventNeedsStateReconciliation("tab.created", true), false);
});

test("uses the final status when Herdr reports an agent release", () => {
  assert.equal(herdrEventTone("pane.agent_detected", { released: true, final_status: "done" }), "ok");
  assert.equal(herdrEventTone("pane.agent_detected", { released: true, final_status: "blocked" }), "error");
  assert.equal(herdrEventTone("pane.agent_detected", { released: true }), "neutral");
});
