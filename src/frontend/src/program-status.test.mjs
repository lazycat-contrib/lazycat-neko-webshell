import assert from "node:assert/strict";
import test from "node:test";
import { applyProgramStatus, normalizeProgramStatus, programStatusForTab } from "./program-status.ts";
import { renderProgramStatusView, syncProgramStatusView } from "./program-status-view.ts";

const record = (state, app = "codex") => ({ id: "", state, app });
const pane = (id, state) => ({ id, sessionBackend: "webshell", connectionState: "connected", programStatus: [record(state)] });

test("accepts bounded replacement tables and rejects malformed events without clearing state", () => {
  const target = {};
  assert.equal(applyProgramStatus(target, [record("working")]), true);
  assert.equal(applyProgramStatus(target, [record("working")]), false);
  for (const invalid of [null, {}, [record("unknown")], [{ ...record("done"), title: "\x1battack" }], [{ ...record("working"), progress: 101 }], [record("idle"), record("done")], Array.from({ length: 65 }, (_, i) => ({ ...record("idle"), id: String(i) }))]) {
    assert.equal(applyProgramStatus(target, invalid), false);
    assert.equal(target.programStatus[0].state, "working");
  }
  assert.equal(normalizeProgramStatus([{ ...record("done"), title: "测".repeat(65) }]), undefined);
  assert.equal(applyProgramStatus(target, []), true);
  assert.equal(target.programStatus, undefined);
});

test("standard tabs reuse Herdr priority and agent icons and jump to the relevant pane", () => {
  const tab = { panes: [pane("done", "done"), pane("work", "working"), { ...pane("approval", "blocked"), programStatus: [{ ...record("blocked"), kind: "permission", progress: 42, title: '<script>alert("x")</script>' }] }] };
  const presentation = programStatusForTab(tab, key => key);
  assert.equal(presentation.paneId, "approval");
  assert.equal(presentation.icon, "codex");
  assert.equal(presentation.state, "blocked");
  assert.match(presentation.label, /42%/);
  assert.match(presentation.label, /programStatus.permission/);
  const html = renderProgramStatusView(presentation);
  assert.match(html, /herdr-agent-icon.*data-agent-icon="codex"/);
  assert.doesNotMatch(html, /herdr-jump-status|data-lucide="check"/);
  assert.doesNotMatch(html, /<script>/);
  tab.panes[2].connectionState = "offline";
  assert.equal(programStatusForTab(tab, key => key).paneId, "work");
  tab.panes.forEach(p => p.exited = true);
  assert.equal(programStatusForTab(tab, key => key), undefined);
});

test("all program states use a single branded or terminal fallback icon and keep status labels", () => {
  for (const state of ["working", "blocked", "done", "idle", "error"]) {
    for (const app of ["codex", "unknown-tool"]) {
      const presentation = programStatusForTab({ panes: [{ ...pane("p", state), programStatus: [record(state, app)] }] }, key => key);
      const html = renderProgramStatusView(presentation);
      assert.match(html, new RegExp(`data-status="${state}"`));
      assert.match(html, new RegExp(`title="${app} · herdr.activity.${state}"`));
      assert.match(html, new RegExp(`aria-label="${app} · herdr.activity.${state}"`));
      assert.doesNotMatch(html, /herdr-jump-status|[◐✓○]/);
      assert.match(html, app === "codex" ? /data-agent-icon="codex"/ : /<svg class="herdr-agent-fallback"/);
    }
  }
});

test("program status sync replaces brand icons with immediately rendered fallback icons", () => {
  const attributes = {};
  const node = { dataset: {}, innerHTML: "", hidden: true, setAttribute: (name, value) => { attributes[name] = value; } };
  const root = { querySelector: () => node };
  syncProgramStatusView(root, { icon: "codex", state: "working", label: "Codex working" });
  assert.match(node.innerHTML, /data-agent-icon="codex"/);
  syncProgramStatusView(root, { state: "blocked", label: "Tool needs attention" });
  assert.match(node.innerHTML, /<svg class="herdr-agent-fallback"/);
  assert.doesNotMatch(node.innerHTML, /data-lucide|herdr-jump-status/);
  assert.equal(node.dataset.status, "blocked");
  assert.equal(node.title, "Tool needs attention");
  assert.equal(attributes["aria-label"], "Tool needs attention");
  assert.equal(node.hidden, false);
  syncProgramStatusView(root, undefined);
  assert.equal(node.hidden, true);
  assert.equal(node.innerHTML, "");
});

test("Herdr panes retain their own authoritative agent interaction", () => {
  assert.equal(programStatusForTab({ panes: [{ ...pane("herdr", "working"), sessionBackend: "herdr" }] }, key => key), undefined);
});
