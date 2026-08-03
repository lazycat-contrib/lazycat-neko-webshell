import assert from "node:assert/strict";
import test from "node:test";

import { buildAIChatTerminalTarget } from "./terminal-target.ts";

const tr = (key) => key;
const pane = {
  id: "outer-pane",
  sessionId: "session-1",
  selector: "demo@owner",
  sessionBackend: "herdr",
  closing: false,
  label: "Herdr",
  title: "Herdr",
};
const tab = {
  selector: "demo@owner",
  panes: [pane],
  label: "Herdr",
};
const baseState = {
  herdr_protocol: 18,
  protocol_compatible: true,
  workspaces: [{ workspace_id: "w1", label: "repo", focused: true }],
  tabs: [{ tab_id: "w1:t1", label: "1", focused: true }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", focused: true }],
  agents: [{
    pane_id: "w1:p1",
    name: "reviewer",
    display_agent: "Codex review",
    agent_status: "working",
    interactive_ready: true,
  }],
};

test("attaches the active protocol-18 Herdr Agent to the AI terminal target", () => {
  const target = buildAIChatTerminalTarget({
    pane,
    tab,
    selectedSelector: "demo@owner",
    herdrState: baseState,
    tabDisplayName: () => "Herdr",
    tr,
  });

  assert.deepEqual(target.herdrAgent, {
    target: "w1:p1",
    label: "Codex review",
    status: "working",
    interactiveReady: true,
  });
});

test("keeps protocol-16 and Agent-less Herdr targets on the legacy AI path", () => {
  const protocol16 = buildAIChatTerminalTarget({
    pane,
    tab,
    selectedSelector: "demo@owner",
    herdrState: { ...baseState, herdr_protocol: 16 },
    tabDisplayName: () => "Herdr",
    tr,
  });
  assert.equal(protocol16.herdrAgent, undefined);

  const noAgent = buildAIChatTerminalTarget({
    pane,
    tab,
    selectedSelector: "demo@owner",
    herdrState: { ...baseState, agents: [] },
    tabDisplayName: () => "Herdr",
    tr,
  });
  assert.equal(noAgent.herdrAgent, undefined);
});
