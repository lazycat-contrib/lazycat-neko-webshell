import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SECRET_BYTES, secretFilePayload, secretFilePathIsValid, secretFileShortcutMatches, secretFileTargetIsCurrent } from "./secret-file-state.ts";
import { mobileActionEventPhase, mobileActionRestoresKeyboard } from "../../mobile/action-event-phase.ts";

test("secret text preserves exact whitespace and enforces UTF-8 byte limits", () => {
  const text = "  test-only secret\n第二行\n\n";
  assert.equal(new TextDecoder().decode(secretFilePayload(text)), text);
  assert.equal(secretFilePayload(""), undefined);
  assert.equal(secretFilePayload("中".repeat(MAX_SECRET_BYTES / 2)), undefined);
  assert.equal(secretFilePayload("x".repeat(MAX_SECRET_BYTES)).length, MAX_SECRET_BYTES);
  assert.equal(secretFilePayload("x".repeat(MAX_SECRET_BYTES + 1)), undefined);
});

test("only generated shell-safe paths are accepted", () => {
  const path = `/tmp/lazycat-webshell-secret-${"a".repeat(32)}/key-${"b".repeat(32)}`;
  assert.equal(secretFilePathIsValid(path), true);
  for (const value of [undefined, "/etc/passwd", path + "\n", path + "$(echo x)", path + "/../other", path.replace("key-", "key-'")]) {
    assert.equal(secretFilePathIsValid(value), false);
  }
});

test("captured target rejects replacement panes, sessions, selectors and generations", () => {
  const pane = { sessionId: "s", selector: "target", closing: false, exited: false };
  const target = { pane, sessionId: "s", selector: "target", generation: 1 };
  assert.equal(secretFileTargetIsCurrent(target, pane, 1), true);
  assert.equal(secretFileTargetIsCurrent(target, { ...pane }, 1), false);
  assert.equal(secretFileTargetIsCurrent(target, pane, 2), false);
  for (const [field, value] of [["sessionId", "other"], ["selector", "other"], ["closing", true], ["exited", true]]) {
    const previous = pane[field]; pane[field] = value;
    assert.equal(secretFileTargetIsCurrent(target, pane, 1), false);
    pane[field] = previous;
  }
});

test("desktop shortcut is exact, configurable and ignores repeats and composition", () => {
  const event = { code: "KeyV", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, repeat: false, isComposing: false };
  assert.equal(secretFileShortcutMatches(event, "alt-v", false), true);
  assert.equal(secretFileShortcutMatches(event, "disabled", false), false);
  assert.equal(secretFileShortcutMatches(event, "alt-k", false), false);
  assert.equal(secretFileShortcutMatches({ ...event, code: "KeyK" }, "alt-k", false), true);
  for (const field of ["shiftKey", "metaKey", "repeat", "isComposing"]) assert.equal(secretFileShortcutMatches({ ...event, [field]: true }, "alt-v", false), false);
  assert.equal(secretFileShortcutMatches({ ...event, ctrlKey: false }, "alt-v", false), false);
  assert.equal(secretFileShortcutMatches({ ...event, ctrlKey: false, metaKey: true }, "alt-v", true), true);
});

test("mobile action runs in the gesture and does not restore the keyboard over the sheet", () => {
  assert.equal(mobileActionEventPhase("secret-file"), "pointerup");
  assert.equal(mobileActionRestoresKeyboard("secret-file"), false);
});
