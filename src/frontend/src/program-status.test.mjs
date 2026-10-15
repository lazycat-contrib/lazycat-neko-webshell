import assert from "node:assert/strict";
import test from "node:test";
import { applyProgramStatus, normalizeProgramStatus, programStatusForTab } from "./program-status.ts";
import { renderProgramStatusView } from "./program-status-view.ts";

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

test("standard tabs reuse Herdr priority, agent icons, glyphs and jump to the relevant pane", () => {
  const tab = { panes: [pane("done", "done"), pane("work", "working"), { ...pane("approval", "blocked"), programStatus: [{ ...record("blocked"), kind: "permission", progress: 42, title: '<script>alert("x")</script>' }] }] };
  const presentation = programStatusForTab(tab, key => key);
  assert.equal(presentation.paneId, "approval");
  assert.equal(presentation.icon, "codex");
  assert.equal(presentation.state, "blocked");
  assert.match(presentation.label, /42%/);
  assert.match(presentation.label, /programStatus.permission/);
  const html = renderProgramStatusView(presentation);
  assert.match(html, /herdr-agent-icon.*data-agent-icon="codex"/);
  assert.match(html, /herdr-jump-status.*>!<\/span>/);
  assert.doesNotMatch(html, /<script>/);
  tab.panes[2].connectionState = "offline";
  assert.equal(programStatusForTab(tab, key => key).paneId, "work");
  tab.panes.forEach(p => p.exited = true);
  assert.equal(programStatusForTab(tab, key => key), undefined);
});

test("Herdr panes retain their own authoritative agent interaction", () => {
  assert.equal(programStatusForTab({ panes: [{ ...pane("herdr", "working"), sessionBackend: "herdr" }] }, key => key), undefined);
});
