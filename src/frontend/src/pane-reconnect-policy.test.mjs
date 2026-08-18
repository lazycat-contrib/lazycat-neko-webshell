import assert from "node:assert/strict";
import test from "node:test";
import {
  canConnectPane,
  shouldConnectRestoredPane,
  terminalErrorBlocksReconnect,
} from "./pane-reconnect-policy.ts";

const herdrPane = {
  sessionId: "session-1",
  sessionStatus: "exited",
  sessionBackend: "herdr",
  processExitObserved: true,
};

test("does not restart a Herdr process that explicitly exited", () => {
  assert.equal(shouldConnectRestoredPane(herdrPane, false), false);
});

test("does not let auto-restart bypass an observed Herdr process exit", () => {
  assert.equal(shouldConnectRestoredPane(herdrPane, true), false);
});

test("still restores an exited persistent Herdr pane after a fresh page load", () => {
  assert.equal(shouldConnectRestoredPane({
    ...herdrPane,
    processExitObserved: false,
  }, false), true);
});

test("does not reconnect a pane after a fatal transport error", () => {
  assert.equal(canConnectPane({
    ...herdrPane,
    sessionStatus: "stopped",
    processExitObserved: false,
    fatalErrorObserved: true,
    exited: true,
    closing: false,
  }, true), false);
});

test("blocks reconnect only for explicitly non-retryable fatal errors", () => {
  assert.equal(terminalErrorBlocksReconnect({ fatal: true, retryable: false }), true);
  assert.equal(terminalErrorBlocksReconnect({ fatal: true }), false);
  assert.equal(terminalErrorBlocksReconnect({ fatal: false, retryable: false }), false);
});

test("keeps normal running Herdr panes reconnectable", () => {
  assert.equal(shouldConnectRestoredPane({
    ...herdrPane,
    sessionStatus: "running",
    processExitObserved: false,
  }, false), true);
});

test("keeps the Herdr exit latch closed when workspace reconciliation still reports running", () => {
  assert.equal(canConnectPane({
    ...herdrPane,
    sessionStatus: "running",
    exited: false,
    closing: false,
  }, false), false);
});

test("allows handoff recovery after the observed-exit latch is cleared", () => {
  assert.equal(canConnectPane({
    ...herdrPane,
    sessionStatus: "stopped",
    processExitObserved: false,
    exited: false,
    closing: false,
  }, false), true);
});
