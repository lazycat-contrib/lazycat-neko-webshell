import assert from "node:assert/strict";
import test from "node:test";

import { herdrAgentIconKey } from "./herdr-agent-icons.ts";
import {
  buildHerdrJumpModel,
  defaultHerdrJumpDensity,
  normalizeHerdrJumpDensity,
} from "./herdr-jump-model.ts";
import { renderHerdrJumpShell } from "./herdr-jump-shell.ts";
import { renderHerdrJumpGroups } from "./herdr-jump-view.ts";

const labels = {
  workspace: (number) => `Workspace ${number}`,
  workspaceDefault: "Workspace",
  tab: (number) => `Tab ${number}`,
  tabDefault: "Tab",
  terminal: "Terminal",
};

function workspace(overrides = {}) {
  return {
    workspace_id: "w1",
    number: 1,
    label: "API",
    focused: true,
    active_tab_id: "t1",
    tab_count: 1,
    pane_count: 1,
    tokens: {},
    ...overrides,
  };
}

function tab(overrides = {}) {
  return {
    tab_id: "t1",
    workspace_id: "w1",
    number: 1,
    label: "1",
    focused: true,
    pane_count: 1,
    ...overrides,
  };
}

function pane(overrides = {}) {
  return {
    pane_id: "p1",
    workspace_id: "w1",
    tab_id: "t1",
    focused: true,
    display_agent: "Codex",
    agent: "codex",
    agent_status: "working",
    tokens: {},
    ...overrides,
  };
}

test("keeps Herdr workspace, tab, and pane order while deriving compact sequences", () => {
  const model = buildHerdrJumpModel({
    workspaces: [workspace(), workspace({ workspace_id: "w2", number: 2, label: "Docs", focused: false })],
    tabs: [
      tab({ pane_count: 2 }),
      tab({ tab_id: "t2", number: 2, focused: false }),
      tab({ workspace_id: "w2", tab_id: "t3", number: 1, focused: false }),
    ],
    panes: [
      pane(),
      pane({ pane_id: "p2", focused: false, display_agent: "Claude", agent: "claude" }),
      pane({ pane_id: "p3", tab_id: "t2", focused: false, display_agent: "Gemini", agent: "gemini" }),
      pane({ pane_id: "p4", workspace_id: "w2", tab_id: "t3", focused: true, display_agent: "Kimi", agent: "kimi" }),
    ],
  }, labels);

  assert.deepEqual(model.groups.map((group) => group.workspaceId), ["w1", "w2"]);
  assert.deepEqual(model.groups[0].targets.map((target) => target.paneId), ["p1", "p2", undefined]);
  assert.deepEqual(model.groups[0].targets.map((target) => target.sequence), ["1.1", "1.2", "2"]);
  assert.equal(model.currentWorkspace?.workspaceId, "w1");
  assert.equal(model.currentTarget?.paneId, "p1");
});

test("marks duplicate normal labels for a subtle sequence suffix", () => {
  const model = buildHerdrJumpModel({
    workspaces: [workspace({ pane_count: 2 })],
    tabs: [tab({ pane_count: 2 })],
    panes: [pane(), pane({ pane_id: "p2", focused: false })],
  }, labels);

  assert.deepEqual(model.groups[0].targets.map((target) => target.duplicate), [true, true]);
});

test("uses the socket agent as the primary brand key and falls back conservatively", () => {
  assert.equal(herdrAgentIconKey("claude"), "claudecode");
  assert.equal(herdrAgentIconKey("mastracode"), "mastra");
  assert.equal(herdrAgentIconKey("agy"), "antigravity");
  assert.equal(herdrAgentIconKey("qodercli"), "qoder");
  assert.equal(herdrAgentIconKey("droid"), undefined);
  assert.equal(herdrAgentIconKey("unknown", ["Codex", "random title"]), "codex");
  assert.equal(herdrAgentIconKey("unknown", ["fix codex auth"]), undefined);
});

test("defaults mobile to compact and desktop to normal without mixing preferences", () => {
  assert.equal(defaultHerdrJumpDensity("mobile"), "compact");
  assert.equal(defaultHerdrJumpDensity("desktop"), "normal");
  assert.equal(normalizeHerdrJumpDensity("normal", "mobile"), "normal");
  assert.equal(normalizeHerdrJumpDensity("invalid", "mobile"), "compact");
  assert.equal(normalizeHerdrJumpDensity(null, "desktop"), "normal");
});

test("keeps legacy Herdr tabs navigable when pane snapshots are unavailable", () => {
  const model = buildHerdrJumpModel({
    workspaces: [workspace()],
    tabs: [tab({ label: "Build" })],
    panes: [],
  }, labels);

  assert.equal(model.currentTarget?.paneId, undefined);
  assert.equal(model.currentTarget?.tabId, "t1");
  assert.equal(model.currentTarget?.label, "Build");
  const html = renderHerdrJumpGroups(model, "normal", {
    jumpTo: "Jump to…",
    compact: "Compact",
    normal: "Normal",
    density: "Display density",
    current: "Current",
    empty: "No panes",
    focusWorkspace: "Focus workspace",
    focusTab: "Focus tab",
    focusPane: "Focus pane",
  });
  assert.match(html, /data-herdr-jump-tab="t1"/);
});

test("keeps single-pane targets on the legacy tab focus path", () => {
  const model = buildHerdrJumpModel({
    workspaces: [workspace()],
    tabs: [tab()],
    panes: [pane()],
  }, labels);

  assert.equal(model.currentTarget?.paneId, undefined);
  assert.equal(model.currentTarget?.tabId, "t1");
  const html = renderHerdrJumpGroups(model, "normal", {
    jumpTo: "Jump to…",
    compact: "Compact",
    normal: "Normal",
    density: "Display density",
    current: "Current",
    empty: "No panes",
    focusWorkspace: "Focus workspace",
    focusTab: "Focus tab",
    focusPane: "Focus pane",
  });
  assert.match(html, /data-herdr-jump-tab="t1"/);
  assert.doesNotMatch(html, /data-herdr-jump-pane=/);
});

test("keeps panes navigable when a partial fallback omits their tab metadata", () => {
  const model = buildHerdrJumpModel({
    workspaces: [workspace()],
    tabs: [],
    panes: [pane({ display_agent: "Claude Code", agent: "claude" })],
  }, labels);

  assert.equal(model.currentTarget?.paneId, undefined);
  assert.equal(model.currentTarget?.tabId, "t1");
  assert.equal(model.currentTarget?.label, "Claude Code");
  assert.equal(model.currentTarget?.sequence, "1");
});

test("uses terminal fallback without trailing whitespace when numbers and labels are missing", () => {
  const model = buildHerdrJumpModel({
    workspaces: [workspace({ number: 0, label: "" })],
    tabs: [tab({ number: 0, label: "" })],
    panes: [],
  }, labels);

  assert.equal(model.currentWorkspace?.label, "Workspace");
  assert.equal(model.currentTarget?.label, "Tab");
});

test("bounds untrusted socket labels before rendering and accessibility duplication", () => {
  const model = buildHerdrJumpModel({
    workspaces: [workspace({ label: "w".repeat(500) })],
    tabs: [tab()],
    panes: [pane({ display_agent: "a".repeat(500), agent_status: "s".repeat(100) })],
  }, labels);

  assert.equal(model.currentWorkspace?.label.length, 160);
  assert.equal(model.currentTarget?.label.length, 160);
  assert.equal(model.currentTarget?.status.length, 32);
});

test("renders compact icon sequences and normal duplicate suffixes as density choices", () => {
  const model = buildHerdrJumpModel({
    workspaces: [workspace({ pane_count: 2 })],
    tabs: [tab({ pane_count: 2 })],
    panes: [pane(), pane({ pane_id: "p2", focused: false })],
  }, labels);
  const ui = {
    jumpTo: "Jump to…",
    compact: "Compact",
    normal: "Normal",
    density: "Display density",
    current: "Current",
    empty: "No panes",
    focusWorkspace: "Focus workspace",
    focusTab: "Focus tab",
    focusPane: "Focus pane",
  };

  const compact = renderHerdrJumpGroups(model, "compact", ui);
  assert.match(compact, /herdr-target-compact-sequence">1\.1/);
  assert.match(compact, /herdr-target-compact-sequence">1\.2/);
  assert.match(compact, /herdr-target-name">Codex/);
  assert.match(compact, /data-agent-icon="codex"/);
  assert.match(compact, />Current</);

  const normal = renderHerdrJumpGroups(model, "normal", ui);
  assert.match(normal, /herdr-target-name">Codex/);
  assert.match(normal, /herdr-target-sequence">1\.1/);
  assert.match(normal, /herdr-target-sequence">1\.2/);
});

test("renders the Herdr jump trigger as a single icon instead of a select-like field", () => {
  const html = renderHerdrJumpShell();

  assert.match(html, /class="herdr-icon-button herdr-jump-trigger"/);
  assert.doesNotMatch(html, /herdr-context-copy/);
  assert.doesNotMatch(html, /herdr-context-chevron/);
  assert.match(html, /aria-label="Jump to"/);
});
