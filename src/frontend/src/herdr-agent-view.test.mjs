import assert from "node:assert/strict";
import test from "node:test";

import {
  filterHerdrAgents,
  herdrAgentInteractionsAvailable,
  renderHerdrAgentMenuView,
} from "./herdr-agent-view.ts";

const agents = [
  {
    terminal_id: "term-1",
    name: "reviewer",
    agent: "codex",
    display_agent: "Codex review",
    agent_status: "working",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    focused: true,
    revision: 1,
    launch_pending: false,
    interactive_ready: true,
    state_change_seq: 12,
    tokens: {},
  },
  {
    terminal_id: "term-2",
    name: "tester",
    agent: "claude",
    agent_status: "blocked",
    workspace_id: "w2",
    tab_id: "w2:t1",
    pane_id: "w2:p1",
    focused: false,
    revision: 2,
    launch_pending: false,
    interactive_ready: true,
    state_change_seq: 18,
    title: "Fix tests",
    tokens: {},
  },
  {
    terminal_id: "term-3",
    agent: "pi",
    agent_status: "done",
    workspace_id: "w1",
    tab_id: "w1:t2",
    pane_id: "w1:p2",
    focused: false,
    revision: 3,
    launch_pending: false,
    interactive_ready: true,
    state_change_seq: 15,
    tokens: {},
  },
];

const labels = {
  title: "Agents",
  all: "All",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  empty: "No agents",
  focus: "Focus agent",
};

test("filters Herdr agents by effective status and keeps newest changes first", () => {
  assert.deepEqual(filterHerdrAgents(agents, "blocked").map((agent) => agent.pane_id), ["w2:p1"]);
  assert.deepEqual(filterHerdrAgents(agents, "done").map((agent) => agent.pane_id), ["w1:p2"]);
  assert.deepEqual(filterHerdrAgents(agents, "all").map((agent) => agent.pane_id), [
    "w2:p1",
    "w1:p2",
    "w1:p1",
  ]);
});

test("renders local filters and focus targets for Herdr agents", () => {
  const html = renderHerdrAgentMenuView(agents, "blocked", labels);
  assert.match(html, /data-herdr-agent-filter="blocked"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-herdr-agent-pane="w2:p1"/);
  assert.match(html, /tester/);
  assert.match(html, /Fix tests/);
  assert.doesNotMatch(html, /Codex review/);
});

test("enables new Agent interactions only for compatible protocol 17 state", () => {
  assert.equal(herdrAgentInteractionsAvailable({ herdr_protocol: 17, protocol_compatible: true }), true);
  assert.equal(herdrAgentInteractionsAvailable({ herdr_protocol: 17 }), true);
  assert.equal(herdrAgentInteractionsAvailable({ herdr_protocol: 16, protocol_compatible: true }), false);
  assert.equal(herdrAgentInteractionsAvailable({ herdr_protocol: 18, protocol_compatible: false }), false);
  assert.equal(herdrAgentInteractionsAvailable(undefined), false);
});
