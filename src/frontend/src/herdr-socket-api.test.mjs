import assert from "node:assert/strict";
import test from "node:test";

import {
  HERDR_SOCKET_PROTOCOL,
  HERDR_SOCKET_SCHEMA_VERSION,
  HERDR_SOCKET_SOURCE_REVISION,
  HERDR_SOCKET_SOURCE_VERSION,
  herdrEventSubscriptions,
  herdrAgentInfo,
  herdrPaneIdFromEvent,
  herdrPaneInfo,
  herdrPaneInfoFromEvent,
  herdrScrollInfoFromEvent,
  herdrWorkspaceInfoFromEvent,
  isHerdrSocketMethod,
  isHerdrSocketSubscription,
} from "./herdr-socket-api.ts";

test("tracks the current Herdr 0.7.5 socket schema", () => {
  assert.equal(HERDR_SOCKET_PROTOCOL, 17);
  assert.equal(HERDR_SOCKET_SCHEMA_VERSION, 1);
  assert.equal(HERDR_SOCKET_SOURCE_VERSION, "0.7.5");
  assert.equal(HERDR_SOCKET_SOURCE_REVISION, "0f161fac287011b3e216383e2b8482f049fd6a7b");
  assert.equal(isHerdrSocketMethod("workspace.report_metadata"), true);
  assert.equal(isHerdrSocketMethod("pane.graphics.set"), true);
  assert.equal(isHerdrSocketMethod("popup.close"), true);
  assert.equal(isHerdrSocketMethod("agent.send_keys"), true);
  assert.equal(isHerdrSocketMethod("agent.prompt"), true);
  assert.equal(isHerdrSocketMethod("agent.wait"), true);
  assert.equal(isHerdrSocketMethod("agent.view.set"), true);
  assert.equal(isHerdrSocketMethod("agent.view.clear"), true);
  assert.equal(isHerdrSocketMethod("agent.send"), false);
  assert.equal(isHerdrSocketMethod("pane.graphics.stream"), false);
  assert.equal(isHerdrSocketSubscription("workspace.metadata_updated"), true);
  assert.equal(isHerdrSocketSubscription("pane.updated"), true);
  assert.equal(isHerdrSocketSubscription("pane.scroll_changed"), true);
});

test("uses the synced event contract without enabling scroll polling", () => {
  const subscriptions = herdrEventSubscriptions(["w1:p1", "w1:p1", "w1:p2"], "0.7.4");
  assert.deepEqual(
    subscriptions.filter((item) => item.type === "pane.agent_status_changed"),
    [
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    ],
  );
  assert.deepEqual(
    subscriptions.filter((item) => item.type === "workspace.metadata_updated"),
    [{ type: "workspace.metadata_updated" }],
  );
  assert.deepEqual(
    subscriptions.filter((item) => item.type === "pane.updated"),
    [{ type: "pane.updated" }],
  );
  assert.deepEqual(subscriptions.filter((item) => item.type === "pane.scroll_changed"), []);
});

test("keeps Herdr 0.7.3 on the legacy event subscription set", () => {
  for (const version of ["0.7.3", "0.7.3-preview", "", "dev"]) {
    const subscriptions = herdrEventSubscriptions([], version);
    assert.deepEqual(subscriptions.filter((item) => item.type === "workspace.metadata_updated"), []);
    assert.deepEqual(subscriptions.filter((item) => item.type === "pane.updated"), []);
    assert.deepEqual(subscriptions.filter((item) => item.type === "pane.scroll_changed"), []);
  }
  for (const version of ["0.7.4", "0.7.4-preview", "0.8.0"]) {
    const subscriptions = herdrEventSubscriptions([], version);
    assert.equal(subscriptions.some((item) => item.type === "workspace.metadata_updated"), true);
    assert.equal(subscriptions.some((item) => item.type === "pane.updated"), true);
  }
});

test("parses PaneInfo and pane.scroll_changed metrics", () => {
  assert.deepEqual(herdrPaneInfo({
    pane: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      scroll: {
        offset_from_bottom: 12,
        max_offset_from_bottom: 240,
        viewport_rows: 30,
      },
    },
  }), {
    paneId: "w1:p1",
    workspaceId: "w1",
    scroll: {
      offsetFromBottom: 12,
      maxOffsetFromBottom: 240,
      viewportRows: 30,
    },
  });
  const event = {
    pane_id: "w1:p1",
    workspace_id: "w1",
    scroll: {
      offset_from_bottom: 0,
      max_offset_from_bottom: 240,
      viewport_rows: 30,
    },
  };
  assert.equal(herdrPaneIdFromEvent(event), "w1:p1");
  assert.deepEqual(herdrScrollInfoFromEvent(event), {
    offsetFromBottom: 0,
    maxOffsetFromBottom: 240,
    viewportRows: 30,
  });
});

test("parses Herdr workspace metadata and pane presentation snapshots", () => {
  assert.deepEqual(herdrWorkspaceInfoFromEvent({
    workspace: {
      workspace_id: "w1",
      number: 1,
      label: "repo",
      focused: true,
      active_tab_id: "w1:t1",
      tab_count: 1,
      pane_count: 1,
      tokens: { summary: "review ready" },
    },
  }), {
    workspace_id: "w1",
    number: 1,
    label: "repo",
    focused: true,
    active_tab_id: "w1:t1",
    tab_count: 1,
    pane_count: 1,
    tokens: { summary: "review ready" },
  });

  assert.deepEqual(herdrPaneInfoFromEvent({
    pane: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: true,
      title: "Refactor auth",
      terminal_title: "⠋ Codex",
      terminal_title_stripped: "Codex",
      display_agent: "Codex auth",
      agent: "codex",
      agent_status: "working",
      tokens: { model: "gpt-5" },
    },
  }), {
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: true,
    title: "Refactor auth",
    terminal_title: "⠋ Codex",
    terminal_title_stripped: "Codex",
    display_agent: "Codex auth",
    agent: "codex",
    agent_status: "working",
    tokens: { model: "gpt-5" },
  });
});

test("parses Herdr 0.7.5 agent lifecycle snapshots", () => {
  assert.deepEqual(herdrAgentInfo({
    agent: {
      terminal_id: "term-1",
      name: "reviewer",
      agent: "codex",
      display_agent: "Codex review",
      agent_status: "working",
      workspace_id: "w1",
      tab_id: "w1:t1",
      pane_id: "w1:p1",
      focused: true,
      revision: 4,
      launch_pending: false,
      interactive_ready: true,
      state_change_seq: 12,
      title: "Review auth",
      terminal_title_stripped: "Codex",
      tokens: { model: "gpt-5" },
    },
  }), {
    terminal_id: "term-1",
    name: "reviewer",
    agent: "codex",
    display_agent: "Codex review",
    agent_status: "working",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    focused: true,
    revision: 4,
    launch_pending: false,
    interactive_ready: true,
    state_change_seq: 12,
    title: "Review auth",
    terminal_title_stripped: "Codex",
    tokens: { model: "gpt-5" },
  });

  assert.deepEqual(herdrAgentInfo({
    terminal_id: "term-old",
    agent_status: "idle",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p2",
    focused: false,
    revision: 1,
  }), {
    terminal_id: "term-old",
    agent_status: "idle",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p2",
    focused: false,
    revision: 1,
    launch_pending: false,
    interactive_ready: false,
    state_change_seq: 0,
    tokens: {},
  });
});

test("rejects malformed Herdr resource snapshots", () => {
  assert.equal(herdrWorkspaceInfoFromEvent({ workspace: { label: "missing id" } }), undefined);
  assert.equal(herdrWorkspaceInfoFromEvent({
    workspace_id: "w1",
    number: 1,
    label: "repo",
    focused: true,
    active_tab_id: "w1:t1",
    tab_count: 1,
    pane_count: 1,
    tokens: { summary: 3 },
  }), undefined);
  assert.equal(herdrPaneInfoFromEvent({ pane: { pane_id: "w1:p1" } }), undefined);
  assert.equal(herdrAgentInfo({ agent: { pane_id: "w1:p1" } }), undefined);
  assert.equal(herdrPaneInfoFromEvent({
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: true,
    agent_status: "working",
    tokens: ["not", "a", "map"],
  }), undefined);
});
