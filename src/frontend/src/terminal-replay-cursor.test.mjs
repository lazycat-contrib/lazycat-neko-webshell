import assert from "node:assert/strict";
import test from "node:test";
import {
  beginTerminalReplayCursor,
  discardTerminalReplayCursor,
  markTerminalReplaySequence,
  takeRenderedReplaySequences,
} from "./terminal-replay-cursor.ts";

test("advances replay cursors only after their bytes were rendered", () => {
  const pane = {};
  beginTerminalReplayCursor(pane);
  markTerminalReplaySequence(pane, 7, 100);
  markTerminalReplaySequence(pane, 8, 180);
  assert.deepEqual(takeRenderedReplaySequences(pane, 99), []);
  assert.deepEqual(takeRenderedReplaySequences(pane, 100), [7]);
  assert.deepEqual(takeRenderedReplaySequences(pane, 180), [8]);
});

test("discard drops unrendered cursor markers", () => {
  const pane = {};
  beginTerminalReplayCursor(pane);
  markTerminalReplaySequence(pane, 7, 100);
  discardTerminalReplayCursor(pane);
  assert.deepEqual(takeRenderedReplaySequences(pane, 100), []);
});
