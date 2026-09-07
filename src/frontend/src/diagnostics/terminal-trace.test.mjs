import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalTrace } from "./terminal-trace.ts";

test("disabled trace is a cheap no-op; disable/dispose clears identities and data", () => {
  let reads = 0;
  const trace = createTerminalTrace({ now: () => ++reads });
  const pane = { id: "workspace:pane:secret:user" };
  trace.record(pane, "connect-requested"); assert.equal(reads, 0); assert.deepEqual(trace.snapshot().panes, []);
  trace.setEnabled(true); trace.record(pane, "connect-requested"); assert.equal(trace.snapshot().panes.length, 1);
  trace.setEnabled(false); assert.deepEqual(trace.snapshot(), { version: 1, enabled: false, panes: [] });
  trace.setEnabled(true); trace.record(pane, "connect-requested"); assert.equal(trace.snapshot().panes[0].pane, 1);
  trace.dispose(); trace.dispose(); trace.setEnabled(true); trace.record(pane, "socket-open");
  assert.deepEqual(trace.snapshot(), { version: 1, enabled: false, panes: [] });
});

test("export has an allowlisted schema, anonymous IDs, finite metrics and fixed reasons only", () => {
  let time = 100;
  const trace = createTerminalTrace({ now: () => time }); trace.setEnabled(true);
  const secret = "ssh://user:password@example/private?token=secret";
  const pane = { id: secret, selector: secret, pendingInput: [secret], output: secret };
  trace.record(pane, "connect-requested", { bytes: 5, cols: 80, rows: NaN, durationMs: Infinity, sequence: -5, output: secret, url: secret }, secret);
  trace.record(pane, secret, { bytes: 1 }, "transport");
  time = NaN; trace.record(pane, "error", { bytes: Infinity, chunks: 3 }, "transport");
  time = 90; trace.record(pane, "resize", { cols: 100, rows: 30 });
  const result = trace.snapshot();
  assert.equal(result.panes[0].events.length, 3);
  assert.deepEqual(result.panes[0].events[0], { atMs: 0, generation: 1, event: "connect-requested", metrics: { bytes: 5, cols: 80 } });
  assert.deepEqual(result.panes[0].events[1].metrics, { chunks: 3 });
  assert.equal(result.panes[0].events[1].reason, "transport");
  assert.equal(trace.exportJSON().includes(secret), false);
  assert.equal(trace.exportJSON().includes("null"), false);
});

test("pane LRU and per-pane history are bounded; connection generations remain distinguishable", () => {
  const trace = createTerminalTrace({ now: () => 0, maxPanes: 2, maxEventsPerPane: 3 }); trace.setEnabled(true);
  const a = {}, b = {}, c = {};
  trace.record(a, "connect-requested"); trace.record(a, "socket-open"); trace.record(a, "ready");
  trace.record(a, "connect-requested");
  let data = trace.snapshot().panes[0];
  assert.equal(data.events.length, 3); assert.equal(data.dropped, 1); assert.equal(data.generation, 2);
  assert.deepEqual(data.events.map(event => event.generation), [1, 1, 2]);
  trace.record(b, "connect-requested"); trace.record(a, "socket-open"); trace.record(c, "connect-requested");
  assert.deepEqual(trace.snapshot().panes.map(pane => pane.pane), [1, 3]);
  trace.forget(a); trace.forget(a); assert.equal(trace.snapshot().panes.length, 1);
  trace.record(b, "connect-requested"); assert.equal(trace.snapshot().panes.length, 2);
});

test("snapshots cannot mutate stored events or metrics", () => {
  const trace = createTerminalTrace({ now: () => 0 }); trace.setEnabled(true); trace.record({}, "resize", { cols: 80 });
  const data = trace.snapshot(); data.panes[0].events[0].metrics.cols = 999; data.panes.length = 0;
  assert.equal(trace.snapshot().panes[0].events[0].metrics.cols, 80);
});
