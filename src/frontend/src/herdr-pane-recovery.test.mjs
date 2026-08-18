import assert from "node:assert/strict";
import test from "node:test";

import {
  createHerdrExitRecovery,
  herdrExitShouldRemainRecoverable,
  herdrHandoffCandidatePaneIds,
  herdrPaneRecoveryIds,
  herdrWorkspacePaneIds,
  recoverHerdrPaneStatesAfterHandoff,
} from "./herdr-pane-recovery.ts";

const exitedMismatchPane = {
  id: "recover-me",
  workspacePaneId: "workspace-recover-me",
  selector: "demo@owner",
  sessionId: "session-1",
  sessionStatus: "exited",
  sessionBackend: "herdr",
  processExitObserved: true,
  exited: true,
  closing: false,
};

test("captures every active Herdr pane as a handoff candidate", () => {
  const panes = [
    { ...exitedMismatchPane, id: "active", exited: false, processExitObserved: false, sessionStatus: "running" },
    { ...exitedMismatchPane, id: "background", exited: false, processExitObserved: false, sessionStatus: "starting" },
    { ...exitedMismatchPane, id: "exited" },
    { ...exitedMismatchPane, id: "other", selector: "other@owner", exited: false },
    { ...exitedMismatchPane, id: "webshell", sessionBackend: "webshell", exited: false },
  ];

  assert.deepEqual(
    herdrHandoffCandidatePaneIds(panes, "demo@owner"),
    ["active", "background"],
  );
  assert.deepEqual(
    [...herdrWorkspacePaneIds(panes, "demo@owner")],
    ["workspace-recover-me"],
  );
});

test("recovers only explicitly eligible exited Herdr panes on the handed-off target", () => {
  const panes = [
    exitedMismatchPane,
    { ...exitedMismatchPane, id: "healthy", sessionStatus: "running", exited: false, processExitObserved: false },
    { ...exitedMismatchPane, id: "stale-workspace", sessionStatus: "running", exited: false },
    { ...exitedMismatchPane, id: "other-target", selector: "other@owner" },
    { ...exitedMismatchPane, id: "other-backend", sessionBackend: "webshell" },
    { ...exitedMismatchPane, id: "not-observed", processExitObserved: false },
    { ...exitedMismatchPane, id: "closing", closing: true },
  ];

  assert.deepEqual(
    herdrPaneRecoveryIds(panes, "demo@owner", new Set(["recover-me", "healthy", "other-target"])),
    ["recover-me"],
  );
});

test("resets and reconnects only eligible exited Herdr panes", () => {
  const recovered = [];
  const panes = [
    { ...exitedMismatchPane },
    { ...exitedMismatchPane, id: "ordinary" },
  ];

  const recoveredIds = recoverHerdrPaneStatesAfterHandoff(
    panes,
    "demo@owner",
    new Set(["recover-me"]),
    (pane) => { recovered.push(pane.id); },
  );

  assert.deepEqual(recoveredIds, ["recover-me"]);
  assert.deepEqual(recovered, ["recover-me"]);
  assert.equal(panes[0].processExitObserved, false);
  assert.equal(panes[0].exited, false);
  assert.equal(panes[0].sessionStatus, "stopped");
  assert.equal(panes[1].exited, true);
});

test("retains exited panes while the runtime may accept a replacement client", () => {
  const runtime = { state: "ready" };
  assert.equal(herdrExitShouldRemainRecoverable(runtime), true);
  assert.equal(herdrExitShouldRemainRecoverable({ ...runtime, state: "not_running" }), false);
  for (const state of ["client_older", "server_older", "unknown"]) {
    assert.equal(herdrExitShouldRemainRecoverable({ ...runtime, state }), true);
  }
});

test("retries a Herdr client attach exit even when the runtime reports ready", async () => {
  const cleaned = [];
  const retried = [];
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "ready" }),
    cleanup: (target) => { cleaned.push(target.paneId); },
    recover: () => assert.fail("a transient client attach exit must not use handoff recovery"),
    retry: (target) => { retried.push(target.paneId); },
    wait: async () => {},
    handoffStatusAttempts: 1,
  });

  await recovery.handle({
    selector: "demo@owner",
    paneId: "workspace-pane",
    recoveryId: "ui-pane",
    exitCode: 1,
  });

  assert.deepEqual(retried, ["workspace-pane"]);
  assert.deepEqual(cleaned, []);
  assert.deepEqual(recovery.recoverablePaneIds("demo@owner"), ["ui-pane"]);
});

test("bounds retries for a repeatedly failing Herdr client pane", async () => {
  let retries = 0;
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "ready" }),
    cleanup: () => assert.fail("bounded transient failures stay protected until expiry"),
    recover: () => assert.fail("a ready runtime does not require handoff recovery"),
    retry: () => { retries += 1; },
    wait: async () => {},
    handoffStatusAttempts: 1,
  });
  const target = {
    selector: "demo@owner",
    paneId: "workspace-pane",
    recoveryId: "ui-pane",
    exitCode: 1,
  };

  await recovery.handle(target);
  await recovery.handle(target);

  assert.equal(retries, 1);
});

test("classifies Herdr exits from trusted runtime state and exit status", async () => {
  const cleaned = [];
  const recovered = [];
  const retried = [];
  let state = "ready";
  let handoffRecent = false;
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => {
      if (state === "error") throw new Error("unavailable");
      return { selector, state, handoff_recent: handoffRecent };
    },
    cleanup: (target) => { cleaned.push(target.paneId); },
    recover: (selector) => { recovered.push(selector); },
    retry: (target) => { retried.push(target.paneId); },
    wait: async () => {},
    handoffStatusAttempts: 1,
  });

  await recovery.handle({ selector: "demo@owner", paneId: "ordinary", recoveryId: "ordinary", exitCode: 0 });
  state = "server_older";
  await recovery.handle({
    selector: "demo@owner",
    paneId: "mismatch",
    recoveryId: "mismatch",
    exitCode: 1,
  });
  state = "error";
  await recovery.handle({ selector: "demo@owner", paneId: "unknown", recoveryId: "unknown", exitCode: 1 });
  state = "ready";
  await recovery.handle({ selector: "demo@owner", paneId: "ordinary-failure", recoveryId: "ordinary-failure", exitCode: 1 });
  handoffRecent = true;
  await recovery.handle({
    selector: "demo@owner",
    paneId: "handoff-shutdown",
    recoveryId: "handoff-shutdown",
    exitCode: 1,
  });
  await recovery.handle({ selector: "demo@owner", paneId: "later-exit", recoveryId: "later-exit", exitCode: 0 });

  assert.deepEqual(cleaned, ["ordinary", "later-exit"]);
  assert.deepEqual(recovered, ["demo@owner"]);
  assert.deepEqual(retried, ["mismatch", "ordinary-failure"]);
  assert.deepEqual(
    recovery.recoverablePaneIds("demo@owner"),
    ["mismatch", "unknown", "ordinary-failure", "handoff-shutdown"],
  );
  assert.deepEqual(
    [...recovery.removableWorkspacePaneIds("demo@owner")],
    ["ordinary", "later-exit"],
  );
});

test("forgets handoff candidates after the replacement pane becomes ready", async () => {
  const cleaned = [];
  const recovered = [];
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "ready" }),
    cleanup: (target) => { cleaned.push(target.paneId); },
    recover: (selector) => { recovered.push(selector); },
  });

  recovery.beginHandoff("demo@owner", [{ recoveryId: "pane-ui", paneId: "pane-workspace" }]);
  recovery.noteHandoff("demo@owner");
  recovery.notePaneReady("demo@owner", "pane-ui");
  await recovery.handle({ selector: "demo@owner", paneId: "pane-workspace", recoveryId: "pane-ui" });

  assert.deepEqual(recovered, []);
  assert.deepEqual(cleaned, ["pane-workspace"]);
});

test("expires a healthy handoff candidate after the bounded settlement phase", async () => {
  const cleaned = [];
  const recovered = [];
  let now = 1_000;
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "ready" }),
    cleanup: (target) => { cleaned.push(target.paneId); },
    recover: (selector) => { recovered.push(selector); },
    now: () => now,
    handoffSettlementMs: 100,
  });

  recovery.beginHandoff("demo@owner", [{ recoveryId: "pane-ui", paneId: "pane-workspace" }]);
  recovery.noteHandoff("demo@owner");
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("demo@owner")], ["pane-workspace"]);
  now += 101;
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("demo@owner")], []);
  await recovery.handle({ selector: "demo@owner", paneId: "pane-workspace", recoveryId: "pane-ui" });

  assert.deepEqual(recovered, []);
  assert.deepEqual(cleaned, ["pane-workspace"]);
});

test("keeps protected workspace pane ids isolated by selector", () => {
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "ready" }),
    cleanup: () => {},
    recover: () => {},
  });

  recovery.beginHandoff("first@owner", [{ recoveryId: "ui-a", paneId: "workspace-a" }]);
  recovery.beginHandoff("second@owner", [{ recoveryId: "ui-b", paneId: "workspace-b" }]);

  assert.deepEqual([...recovery.protectedWorkspacePaneIds("first@owner")], ["workspace-a"]);
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("second@owner")], ["workspace-b"]);
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("third@owner")], []);
});

test("recovers another browser's pane after observing the live-handoff shutdown", async () => {
  const states = [
    "error",
    { state: "not_running", handoff_recent: true },
    { state: "ready", handoff_recent: true },
  ];
  const recovered = [];
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => {
      const state = states.shift() ?? "ready";
      if (state === "error") throw new Error("agent reconnecting");
      return { selector, ...state };
    },
    cleanup: () => assert.fail("handoff shutdown must not be cleaned while replacement starts"),
    recover: (selector) => { recovered.push(selector); },
    wait: async () => {},
    handoffStatusAttempts: 4,
  });

  const handling = recovery.handle({
    selector: "demo@owner",
    paneId: "workspace-pane",
    recoveryId: "ui-pane",
    exitCode: 1,
  });
  await handling;

  assert.deepEqual(recovered, ["demo@owner"]);
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("demo@owner")], ["workspace-pane"]);
  recovery.notePaneReady("demo@owner", "ui-pane");
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("demo@owner")], []);
});

test("recovers an exact local handoff candidate after the provider loses its marker", async () => {
  const cleaned = [];
  const recovered = [];
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "ready", handoff_recent: false }),
    cleanup: (target) => { cleaned.push(target.paneId); },
    recover: (selector) => { recovered.push(selector); },
  });

  recovery.beginHandoff("demo@owner", [{ recoveryId: "pane-ui", paneId: "pane-workspace" }]);
  await recovery.handle({
    selector: "demo@owner",
    paneId: "pane-workspace",
    recoveryId: "pane-ui",
    exitCode: 1,
  });
  await recovery.handle({
    selector: "demo@owner",
    paneId: "other-workspace-pane",
    recoveryId: "other-ui-pane",
    exitCode: 1,
  });

  assert.deepEqual(recovered, ["demo@owner"]);
  assert.deepEqual(cleaned, []);
  assert.deepEqual(
    recovery.recoverablePaneIds("demo@owner"),
    ["pane-ui", "other-ui-pane"],
  );
});

test("protects a local handoff candidate during marker-less server replacement", async () => {
  const cleaned = [];
  const recovered = [];
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "not_running", handoff_recent: false }),
    cleanup: (target) => { cleaned.push(target.paneId); },
    recover: (selector) => { recovered.push(selector); },
  });

  recovery.beginHandoff("demo@owner", [{ recoveryId: "pane-ui", paneId: "pane-workspace" }]);
  await recovery.handle({
    selector: "demo@owner",
    paneId: "pane-workspace",
    recoveryId: "pane-ui",
    exitCode: 1,
  });

  assert.deepEqual(cleaned, []);
  assert.deepEqual(recovered, []);
  assert.deepEqual(recovery.recoverablePaneIds("demo@owner"), ["pane-ui"]);
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("demo@owner")], ["pane-workspace"]);
});

test("retries an expired local handoff candidate as an ordinary client attach exit", async () => {
  let now = 10_000;
  const cleaned = [];
  const retried = [];
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "ready", handoff_recent: false }),
    cleanup: (target) => { cleaned.push(target.paneId); },
    recover: () => assert.fail("expired handoff candidate must not recover"),
    retry: (target) => { retried.push(target.paneId); },
    now: () => now,
    pendingHandoffMs: 100,
  });

  recovery.beginHandoff("demo@owner", [{ recoveryId: "pane-ui", paneId: "pane-workspace" }]);
  now += 101;
  await recovery.handle({
    selector: "demo@owner",
    paneId: "pane-workspace",
    recoveryId: "pane-ui",
    exitCode: 1,
  });

  assert.deepEqual(cleaned, []);
  assert.deepEqual(retried, ["pane-workspace"]);
});

test("expires recovery protection when a reconnect never becomes ready", async () => {
  let now = 5_000;
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "server_older" }),
    cleanup: () => {},
    recover: () => {},
    now: () => now,
    recoveryProtectionMs: 100,
  });

  await recovery.handle({
    selector: "demo@owner",
    paneId: "workspace-pane",
    recoveryId: "ui-pane",
    exitCode: 1,
  });
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("demo@owner")], ["workspace-pane"]);
  now += 101;
  assert.deepEqual([...recovery.protectedWorkspacePaneIds("demo@owner")], []);
  assert.deepEqual(recovery.recoverablePaneIds("demo@owner"), []);
  assert.deepEqual([...recovery.removableWorkspacePaneIds("demo@owner")], ["workspace-pane"]);
});

test("drops uncommitted handoff candidates after a failed handoff", async () => {
  const cleaned = [];
  const recovery = createHerdrExitRecovery({
    fetchStatus: async (selector) => ({ selector, state: "ready" }),
    cleanup: (target) => { cleaned.push(target.paneId); },
    recover: () => assert.fail("failed handoff must not recover a later exit"),
  });

  recovery.beginHandoff("demo@owner", [{ recoveryId: "pane-ui", paneId: "pane-workspace" }]);
  recovery.failHandoff("demo@owner");
  await recovery.handle({ selector: "demo@owner", paneId: "pane-workspace", recoveryId: "pane-ui" });

  assert.deepEqual(cleaned, ["pane-workspace"]);
});

test("coalesces simultaneous runtime inspections for one selector", async () => {
  let fetches = 0;
  let resolveStatus;
  const recovery = createHerdrExitRecovery({
    fetchStatus: () => {
      fetches += 1;
      return new Promise((resolve) => { resolveStatus = resolve; });
    },
    cleanup: () => {},
    recover: () => {},
  });

  const first = recovery.handle({ selector: "demo@owner", paneId: "p1", recoveryId: "r1", exitCode: 1 });
  const second = recovery.handle({ selector: "demo@owner", paneId: "p2", recoveryId: "r2", exitCode: 1 });
  await Promise.resolve();
  assert.equal(fetches, 1);
  resolveStatus({ selector: "demo@owner", state: "ready" });
  await Promise.all([first, second]);
});
