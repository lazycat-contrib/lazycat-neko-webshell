import assert from "node:assert/strict";
import test from "node:test";

import { parseTerminalServerMessage } from "./terminal-protocol.ts";

test("preserves replay gap metadata for presentation-safe recovery", () => {
  const event = parseTerminalServerMessage(JSON.stringify({
    type: "replay-start",
    session_id: "session-1",
    pane_id: "pane-1",
    replay_after: 42,
    replay_mode: "gap",
    replay_gap: true,
    oldest_sequence: 100,
  }));

  assert.deepEqual(event, {
    type: "replay-start",
    session_id: "session-1",
    pane_id: "pane-1",
    replay_after: 42,
    replay_mode: "gap",
    replay_gap: true,
    oldest_sequence: 100,
  });
});

test("keeps legacy replay-start messages valid without optional metadata", () => {
  assert.deepEqual(
    parseTerminalServerMessage('{"type":"replay-start","replay_after":0}'),
    { type: "replay-start", replay_after: 0 },
  );
});
