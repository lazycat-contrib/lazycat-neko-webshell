import assert from "node:assert/strict";
import test from "node:test";

import { createPaneFileDropController, hasDroppedFiles, paneAcceptsFileDrop } from "./pane-drop.ts";

function pane(id) {
  const children = [];
  const mount = {
    ownerDocument: { createElement: () => ({ className: "", setAttribute() {}, remove() { children.splice(children.indexOf(this), 1); } }) },
    appendChild: (child) => children.push(child),
    querySelector: () => children.find((child) => child.className === "pane-file-drop-overlay"),
  };
  return { id, sessionId: `session-${id}`, selector: "target@owner", mount, closing: false, exited: false };
}

function drag(type, files = []) {
  const event = new Event(type, { cancelable: true });
  event.dataTransfer = { types: ["Files"], items: [], files, dropEffect: "none" };
  return event;
}

test("file drops upload to their own pane and insert quoted paths once", async () => {
  const root = new EventTarget();
  const window = new EventTarget();
  const first = pane("first");
  const second = pane("second");
  let target = second;
  let releaseUpload;
  const uploaded = new Promise((resolve) => { releaseUpload = resolve; });
  const calls = [];
  const statuses = [];
  const dispose = createPaneFileDropController({
    root, window, paneForTarget: () => target,
    canUpload: (candidate) => Boolean(candidate.sessionId && !candidate.closing),
    isCurrent: (candidate, sessionId, selector) => candidate.sessionId === sessionId && candidate.selector === selector,
    upload: async (files, candidate, onProgress) => {
      calls.push(["upload", candidate.id, files[0].name]);
      onProgress({ percent: "50" }, 0);
      return uploaded;
    },
    sendText: async (candidate, value) => { calls.push(["send", candidate.id, value]); return true; },
    focus: (candidate) => calls.push(["focus", candidate.id]),
    tr: (key, values) => key === "status.dropFilesUploading" ? `progress ${values.percent}` : key,
    onStatus: (message) => statuses.push(message),
  });

  const over = drag("dragover");
  root.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  assert.ok(second.mount.querySelector(".pane-file-drop-overlay"));

  const drop = drag("drop", [{ name: "a b.txt", size: 100 }]);
  root.dispatchEvent(drop);
  root.dispatchEvent(drag("drop", [{ name: "ignored.txt", size: 1 }]));
  assert.equal(drop.defaultPrevented, true);
  assert.equal(second.mount.querySelector(".pane-file-drop-overlay"), undefined);
  target = first;
  releaseUpload(["/tmp/a b.txt"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    ["upload", "second", "a b.txt"],
    ["send", "second", "'/tmp/a b.txt'"],
    ["focus", "second"],
  ]);
  assert.deepEqual(statuses.slice(0, 2), ["progress 0", "progress 50"]);
  dispose();
});

test("drops outside a pane never upload and a replaced session never receives paths", async () => {
  const root = new EventTarget();
  const window = new EventTarget();
  const targetPane = pane("one");
  let target;
  let finish;
  const uploaded = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const dispose = createPaneFileDropController({
    root, window, paneForTarget: () => target,
    canUpload: () => true,
    isCurrent: (candidate, sessionId) => candidate.sessionId === sessionId,
    upload: async () => { calls.push("upload"); return uploaded; },
    sendText: async () => { calls.push("send"); return true; },
    focus: () => {}, tr: (key) => key, onStatus: () => {},
  });
  const outside = drag("drop", [{ name: "file.txt" }]);
  root.dispatchEvent(outside);
  assert.equal(outside.defaultPrevented, true);
  assert.deepEqual(calls, []);

  target = targetPane;
  root.dispatchEvent(drag("drop", [{ name: "file.txt" }]));
  targetPane.sessionId = "replaced";
  finish(["/tmp/file.txt"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["upload"]);
  dispose();
  assert.equal(hasDroppedFiles({ types: ["text/uri-list"], items: [] }), false);
  assert.equal(paneAcceptsFileDrop({ ...targetPane, sessionBackend: "herdr" }), false);
});
