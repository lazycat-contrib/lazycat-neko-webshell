import assert from "node:assert/strict";
import test from "node:test";
import { matchesTerminalReplayIdentity } from "./terminal-replay-identity.ts";

const pane = { sessionId: "session-1", workspacePaneId: "pane-1" };

test("requires exact replay session and pane identities", () => {
  assert.equal(matchesTerminalReplayIdentity(pane, {
    session_id: "session-1",
    pane_id: "pane-1",
  }), true);
  assert.equal(matchesTerminalReplayIdentity(pane, { pane_id: "pane-1" }), false);
  assert.equal(matchesTerminalReplayIdentity(pane, { session_id: "session-1" }), false);
  assert.equal(matchesTerminalReplayIdentity(pane, {
    session_id: "session-2",
    pane_id: "pane-1",
  }), false);
});
