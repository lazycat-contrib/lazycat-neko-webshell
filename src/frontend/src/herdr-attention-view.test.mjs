import assert from "node:assert/strict";
import test from "node:test";
import { buildHerdrJumpModel } from "./herdr-jump-model.ts";
import { renderHerdrJumpGroups, renderHerdrCurrentTargets } from "./herdr-jump-view.ts";
import { attentionTarget, renderHerdrAttentionDetail } from "./herdr-attention-view.ts";

const labels = { workspace: n => n, workspaceDefault: "Workspace", tab: n => n, tabDefault: "Tab", terminal: "Terminal" };
const ui = { current: "Current", empty: "Empty", focusWorkspace: "Workspace", focusTab: "Tab", focusPane: "Pane", attention: "Needs your attention", activity: s => s };
function snapshot(status = "blocked", tokens = {}) {
  return {
    workspaces: [{ workspace_id: "w", number: 1, label: "Project", focused: true }],
    tabs: [{ tab_id: "t", workspace_id: "w", number: 1, label: "Build", focused: true }],
    panes: [{ pane_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: status, tokens, focused: true, title: "PRIVATE COMMAND" }],
  };
}
const model = state => buildHerdrJumpModel(state, labels);

test("attention uses authoritative blocked state and only the public summary", () => {
  const state = snapshot("working", { summary: "Old pane detail", private: "SECRET" });
  state.agents = [{ pane_id: "p", agent_status: "blocked", tokens: { summary: 'Answer "Continue?" <yes>' } }];
  const target = attentionTarget(model(state), "p");
  assert.equal(target.attention.summary, 'Answer "Continue?" <yes>');
  const html = renderHerdrJumpGroups(model(state), "normal", ui);
  assert.match(html, /title="Needs your attention · Answer &quot;Continue\?&quot; &lt;yes&gt;"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /PRIVATE COMMAND|SECRET|Old pane detail/);
});

test("action and jump remain sibling buttons with unchanged tab and pane destinations", () => {
  const state = snapshot();
  let html = renderHerdrJumpGroups(model(state), "normal", ui);
  assert.match(html, /data-herdr-jump-tab="t"/);
  assert.match(html, /<\/button>\s*<button class="herdr-attention-button"/);
  assert.doesNotMatch(renderHerdrCurrentTargets(model(state), "compact", ui), /data-herdr-attention/);
  state.panes.push({ ...state.panes[0], pane_id: "p2", focused: false });
  html = renderHerdrJumpGroups(model(state), "compact", ui);
  assert.match(html, /data-herdr-jump-pane="p"/);
  assert.match(html, /data-herdr-jump-pane="p2"/);
  assert.deepEqual(model(state).groups[0].targets.map(t => t.attention.id), ["p", "p2"]);
});

test("attention disappears on completion, removal and restore errors without reordering groups", () => {
  for (const status of ["working", "done", "idle", "error", "unknown"]) {
    const current = model(snapshot(status, { summary: "Stale reason" }));
    assert.equal(attentionTarget(current, "p"), undefined);
    assert.doesNotMatch(renderHerdrJumpGroups(current, "normal", ui), /herdr-attention-(button|target)|Stale reason/);
  }
  const failed = snapshot();
  failed.panes[0].restore_error = "failed restore";
  assert.equal(attentionTarget(model(failed), "p"), undefined);
  const removed = snapshot();
  removed.panes = [];
  assert.equal(attentionTarget(model(removed), "p"), undefined);
  assert.deepEqual(model(snapshot()).groups.map(g => g.workspaceId), ["w"]);
});

test("detail fallback is localized, escaped and bounded without private hook payloads", () => {
  const tr = key => ({ "herdr.attention.title": "需要你处理", "herdr.attention.fallback": "请在终端中继续操作。", "herdr.attention.jump": "跳转到终端", "action.close": "关闭" })[key];
  const state = snapshot("blocked", { tool_input: "SECRET" });
  let target = attentionTarget(model(state), "p");
  const fallback = renderHerdrAttentionDetail(target, tr);
  assert.match(fallback, /请在终端中继续操作。/);
  assert.match(fallback, /跳转到终端/);
  assert.doesNotMatch(fallback, /SECRET|PRIVATE COMMAND/);
  state.panes[0].tokens.summary = '<img src=x onerror="alert(1)">\x1b' + "测".repeat(300);
  target = attentionTarget(model(state), "p");
  assert.equal(target.attention.summary.length, 240);
  assert.doesNotMatch(target.attention.summary, /\x1b/);
  assert.doesNotMatch(renderHerdrAttentionDetail(target, tr), /<img/);
  assert.match(renderHerdrAttentionDetail(target, tr), /&lt;img/);
});

test("authoritative omitted or empty summary never revives an older pane summary", () => {
  for (const tokens of [{}, { summary: "" }, { summary: "   " }]) {
    const state = snapshot("blocked", { summary: "STALE PANE SUMMARY" });
    state.agents = [{ pane_id: "p", agent_status: "blocked", tokens }];
    const current = model(state);
    assert.equal(attentionTarget(current, "p").attention.summary, undefined);
    assert.doesNotMatch(renderHerdrJumpGroups(current, "normal", ui), /STALE PANE SUMMARY/);
  }
  assert.equal(attentionTarget(model(snapshot("blocked", { summary: "Pane-only summary" })), "p").attention.summary, "Pane-only summary");
});

test("unavailable retained snapshots and disconnected models preserve chips but remove attention", () => {
  const state = { ...snapshot(), available: false };
  for (const current of [model(state), buildHerdrJumpModel({ ...state, available: true }, labels, { attentionConnected: false })]) {
    assert.equal(attentionTarget(current, "p"), undefined);
    const html = renderHerdrJumpGroups(current, "normal", ui);
    assert.match(html, /data-herdr-jump-tab="t"/);
    assert.doesNotMatch(html, /data-herdr-attention/);
  }
});
