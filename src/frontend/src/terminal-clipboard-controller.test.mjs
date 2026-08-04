import assert from "node:assert/strict";
import test from "node:test";

import {
  canUseActivePaneForShortcut,
  createTerminalClipboardController,
  terminalPasteUsesBrowserEvent,
  terminalClipboardShortcut,
} from "./terminal-clipboard-controller.ts";

function keyEvent(overrides = {}) {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: "",
    code: "",
    ...overrides,
  };
}

test("keeps macOS Meta shortcuts native while supporting Ctrl+Shift terminal shortcuts", () => {
  assert.equal(
    terminalClipboardShortcut(keyEvent({ metaKey: true, key: "c", code: "KeyC" }), true),
    undefined,
  );
  assert.equal(
    terminalClipboardShortcut(keyEvent({ ctrlKey: true, shiftKey: true, key: "c", code: "KeyC" }), true),
    "copy",
  );
});

test("supports non-Apple Super copy and paste shortcuts", () => {
  assert.equal(
    terminalClipboardShortcut(keyEvent({ metaKey: true, key: "c", code: "KeyC" }), false),
    "copy",
  );
  assert.equal(
    terminalClipboardShortcut(keyEvent({ metaKey: true, key: "v", code: "KeyV" }), false),
    "paste",
  );
});

test("supports Ctrl+Shift shortcuts on every platform", () => {
  assert.equal(
    terminalClipboardShortcut(keyEvent({ ctrlKey: true, shiftKey: true, key: "C" }), false),
    "copy",
  );
  assert.equal(
    terminalClipboardShortcut(keyEvent({ ctrlKey: true, shiftKey: true, code: "KeyV" }), true),
    "paste",
  );
});

test("lets Ctrl+Shift+V use the browser paste event instead of permission-gated reads", () => {
  assert.equal(
    terminalPasteUsesBrowserEvent(keyEvent({ ctrlKey: true, shiftKey: true, key: "v", code: "KeyV" })),
    true,
  );
  assert.equal(
    terminalPasteUsesBrowserEvent(keyEvent({ metaKey: true, key: "v", code: "KeyV" })),
    false,
  );
});

test("ignores repeated, Alt-modified, and plain Ctrl shortcuts", () => {
  assert.equal(
    terminalClipboardShortcut(keyEvent({ ctrlKey: true, shiftKey: true, repeat: true, key: "c" }), false),
    undefined,
  );
  assert.equal(
    terminalClipboardShortcut(keyEvent({ ctrlKey: true, shiftKey: true, altKey: true, key: "v" }), false),
    undefined,
  );
  assert.equal(
    terminalClipboardShortcut(keyEvent({ ctrlKey: true, key: "c" }), false),
    undefined,
  );
});

test("does not route global clipboard shortcuts from editable targets or overlays", () => {
  assert.equal(canUseActivePaneForShortcut({
    targetIsEditable: true,
    settingsOpen: false,
    hasActiveTab: true,
  }), false);
  assert.equal(canUseActivePaneForShortcut({
    targetIsEditable: false,
    settingsOpen: true,
    hasActiveTab: true,
  }), false);
  assert.equal(canUseActivePaneForShortcut({
    targetIsEditable: false,
    settingsOpen: false,
    hasActiveTab: false,
  }), false);
  assert.equal(canUseActivePaneForShortcut({
    targetIsEditable: false,
    settingsOpen: false,
    hasActiveTab: true,
  }), true);
});

test("reports a keyboard recovery path when menu paste cannot read the clipboard", async () => {
  const statuses = [];
  const pane = {
    sessionBackend: "webshell",
    term: { restty: { pasteFromClipboard: async () => false } },
  };
  const controller = createTerminalClipboardController({
    settings: () => ({ useResttyClipboard: true }),
    activePane: () => pane,
    paneForEventTarget: () => pane,
    settingsOpen: () => false,
    hasActiveTab: () => true,
    canWrite: () => true,
    pasteIntoHerdrPane: async () => false,
    pasteTextIntoHerdrPane: async () => false,
    pasteClipboardImageIntoHerdrPane: async () => false,
    connectPanePty: () => undefined,
    focusPaneCanvas: () => undefined,
    scheduleReconnect: () => undefined,
    setGlobalStatus: (message, tone) => statuses.push({ message, tone }),
    tr: (key) => key,
    errorMessage: (error) => String(error),
    fallbackCopyText: () => undefined,
    imageUploadProgress: {
      start: () => undefined,
      set: () => undefined,
      finish: () => undefined,
      fail: () => undefined,
    },
    clipboardImageFile: () => undefined,
    readClipboardImagePayload: async () => undefined,
    readClipboardText: async () => "",
    imageFilePayload: async () => { throw new Error("unused"); },
    clipboardImagePayloadIsValid: () => true,
    imageFilePayloadErrorCode: () => undefined,
    maxClipboardImageBytes: 1024,
  });

  assert.equal(await controller.pasteIntoPane(pane, true), false);
  assert.deepEqual(statuses, [{ message: "status.pastePermissionHint", tone: "error" }]);
});
