import assert from "node:assert/strict";
import test from "node:test";

import { herdrPaneDetailForTab, herdrTabPresentation, renderHerdrWorkspaceMenuRow } from "./herdr-views.ts";

test("current workspace keeps selection semantics and styling without a check", () => {
  const html = renderHerdrWorkspaceMenuRow({ workspace_id: "w", label: "Project", focused: true, tab_count: 1, pane_count: 2 }, { tabs: "tabs", panes: "panes", close: "Close" });
  assert.match(html, /herdr-workspace-row-shell selected/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /data-herdr-workspace="w"/);
  assert.doesNotMatch(html, /data-lucide="check"/);
});

function tab(overrides = {}) {
  return {
    tab_id: "w1:t1",
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
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: true,
    agent_status: "working",
    tokens: {},
    ...overrides,
  };
}

test("uses focused pane metadata for generic Herdr tab labels", () => {
  assert.deepEqual(herdrTabPresentation(tab(), [pane({
    title: "Refactor auth",
    terminal_title: "⠋ Codex",
    terminal_title_stripped: "Codex",
  })]), {
    label: "Refactor auth",
    title: "1 · Refactor auth · w1:t1",
  });
});

test("keeps explicit Herdr tab labels and enriches only their tooltip", () => {
  assert.deepEqual(herdrTabPresentation(tab({ label: "tests" }), [pane({ title: "pytest" })]), {
    label: "tests",
    title: "tests · pytest · w1:t1",
  });
});

test("uses stripped terminal title before display agent and raw title", () => {
  const currentTab = tab();
  assert.equal(herdrPaneDetailForTab(currentTab, [pane({
    terminal_title: "⠋ Codex",
    terminal_title_stripped: "Codex",
    display_agent: "Codex auth",
  })]), "Codex");
  assert.equal(herdrPaneDetailForTab(currentTab, [pane({
    terminal_title: "⠋ Codex",
    display_agent: "Codex auth",
  })]), "Codex auth");
});

test("keeps number-only Herdr tabs when pane metadata is unavailable", () => {
  assert.deepEqual(herdrTabPresentation(tab(), []), {
    label: "",
    title: "1 · w1:t1",
  });
});

test("prefers the focused pane and ignores panes from another tab", () => {
  const currentTab = tab();
  assert.equal(herdrPaneDetailForTab(currentTab, [
    pane({ pane_id: "w1:p2", focused: false, title: "background" }),
    pane({ pane_id: "w1:p3", focused: true, title: "focused" }),
    pane({ pane_id: "w1:p4", tab_id: "w1:t2", focused: true, title: "other tab" }),
  ]), "focused");
});

test("includes restore errors in a tab tooltip without replacing its label", () => {
  const presentation = herdrTabPresentation(tab({ label: "tests" }), [pane({
    title: "shell", restore_error: "saved directory is missing",
  })]);
  assert.equal(presentation.label, "tests");
  assert.match(presentation.title, /saved directory is missing/);
});
