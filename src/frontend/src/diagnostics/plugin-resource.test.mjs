import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalDiagnosticsResources } from "./plugin-resource.ts";

test("plugin diagnostics remain off until enabled and contain only the host's anonymous trace", () => {
  const { trace, resource } = createTerminalDiagnosticsResources();
  const pane = { selector: "private@account", pendingInput: ["secret"] };
  trace.record(pane, "socket-open");
  assert.deepEqual(resource.snapshot().trace.panes, []);
  resource.setEnabled(true);
  trace.record(pane, "connect-requested");
  trace.record(pane, "ready", { durationMs: 12 });
  assert.equal(resource.snapshot().trace.panes[0].events.length, 2);
  assert.equal(JSON.stringify(resource.snapshot()).includes("private@account"), false);
  resource.setEnabled(false);
  assert.equal(resource.snapshot().trace.enabled, false);
  assert.deepEqual(resource.snapshot().trace.panes, []);
});

test("debug tools and the plugin keep independent leases without resetting an active capture", () => {
  const { trace, resource } = createTerminalDiagnosticsResources();
  const pane = {};
  trace.setEnabled(true);
  trace.record(pane, "connect-requested");
  resource.setEnabled(true);
  trace.setEnabled(false);
  trace.record(pane, "socket-open");
  assert.equal(resource.snapshot().trace.panes[0].events.length, 2);
  trace.setEnabled(true);
  resource.setEnabled(false);
  trace.record(pane, "ready");
  assert.equal(resource.snapshot().trace.panes[0].events.length, 3);
  trace.setEnabled(false);
  assert.deepEqual(resource.snapshot().trace.panes, []);
  trace.dispose();
  resource.setEnabled(true);
  trace.record(pane, "socket-open");
  assert.deepEqual(resource.snapshot().trace.panes, []);
});
