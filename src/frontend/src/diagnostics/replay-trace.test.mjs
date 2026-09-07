import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalTrace } from "./terminal-trace.ts";
import { createTerminalReplayController } from "../terminal-replay-controller.ts";
import { createPaneConnectionLifecycle } from "../pane-connection-lifecycle.ts";
function fixture(extra = {}) {
  const target = { id: "private-target", replaying: false, closing: false, connectionState: "idle", reconnectDelay: 1000, sessionStatus: "running" };
  let clock = 100;
  const trace = createTerminalTrace({ now: () => clock++ }); trace.setEnabled(true);
  const timers = [], writes = [];
  const lifecycle = createPaneConnectionLifecycle({
    canConnect: () => true, autoRestartEnabled: () => false, isHerdr: () => false, isOnline: () => true,
    connect() {}, setStatus() {}, tr: key => key, trace: trace.record, random: () => 0,
    setTimer: () => 1, clearTimer() {},
  });
  const replay = createTerminalReplayController({
    byteBudget: 1, writeBytes: (_pane, bytes) => writes.push([...bytes]), updateSequence() {},
    onUnlocked: pane => lifecycle.markConnected(pane), trace: trace.record,
    requestFrame: () => 1, cancelFrame() {}, setTimer: callback => { timers.push(callback); return timers.length; }, clearTimer() {},
    nextFrame: async () => undefined, now: () => clock++, ...extra,
  });
  lifecycle.beginConnection(target);
  return { target, trace, lifecycle, replay, timers, writes,
    events: () => trace.snapshot().panes[0]?.events ?? [], names: () => (trace.snapshot().panes[0]?.events ?? []).map(event => event.event) };
}

test("protocol receive, renderer API drain and input readiness remain separate across asynchronous batches", async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const s = fixture({ nextFrame: () => barrier });
  s.replay.validate(s.target);
  s.replay.push(s.target, Uint8Array.from([65, 66]));
  const finished = s.replay.finish(s.target, 10);
  assert.deepEqual(s.names(), ["connect-requested", "replay-validated", "replay-received"]);
  assert.equal(s.events()[2].metrics.bufferedBytes, 2);
  assert.deepEqual(s.writes, [[65]]); assert.equal(s.target.replaying, true);
  release(); assert.equal(await finished, true);
  assert.deepEqual(s.names(), ["connect-requested", "replay-validated", "replay-received", "replay-applied", "ready"]);
  assert.equal(s.events()[3].metrics.bufferedBytes, 0); assert.equal(s.events()[3].metrics.bytes, 2);
  assert.equal(s.target.replaying, false); assert.equal(s.trace.exportJSON().includes("private-target"), false);
});

test("input chunks do not create per-frame trace entries and timeout cannot masquerade as protocol completion", async () => {
  const s = fixture(); s.replay.validate(s.target);
  for (let n = 0; n < 100; n++) s.replay.push(s.target, Uint8Array.of(65));
  assert.deepEqual(s.names(), ["connect-requested", "replay-validated"]);
  s.timers[0]();
  for (let n = 0; n < 110; n++) await Promise.resolve();
  assert.equal(s.names().includes("replay-timeout"), true);
  assert.equal(s.names().includes("replay-received"), false);
  assert.equal(s.names().includes("replay-applied"), true);
});

test("overflow is finite metadata and cannot report applied/ready after interrupted replay", async () => {
  let s;
  s = fixture({ maxLiveBytes: 1, nextFrame: async () => { s.replay.push(s.target, Uint8Array.of(1, 2)); } });
  s.replay.validate(s.target); s.replay.push(s.target, Uint8Array.of(65, 66));
  assert.equal(await s.replay.finish(s.target), false);
  const overflow = s.events().find(event => event.event === "overflow");
  assert.equal(overflow.reason, "live-bytes"); assert.equal(Number.isFinite(overflow.metrics.bufferedBytes), true);
  assert.equal(s.names().includes("ready"), false); assert.equal(s.names().includes("replay-applied"), false);
});

test("reconnect generation and ready transitions are stable; duplicate ready callbacks do not add records", () => {
  const s = fixture(); s.lifecycle.markConnected(s.target); s.lifecycle.markConnected(s.target);
  s.lifecycle.markTransientFailure(s.target); s.lifecycle.scheduleReconnect(s.target); s.lifecycle.beginConnection(s.target); s.lifecycle.markConnected(s.target);
  assert.equal(s.names().filter(event => event === "ready").length, 2);
  assert.equal(s.events().at(-1).generation, 2);
  assert.equal(s.events().find(event => event.event === "reconnect-scheduled").metrics.delayMs > 0, true);
});
