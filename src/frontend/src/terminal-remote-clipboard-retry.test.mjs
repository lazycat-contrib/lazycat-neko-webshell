import assert from "node:assert/strict";
import test from "node:test";

import {
  createTerminalRemoteClipboardRetry,
  discardAllRemoteClipboardRetries,
  discardInactiveRemoteClipboardRetries,
} from "./terminal-remote-clipboard-retry.ts";
import {
  createSerializedTerminalRemoteClipboardWriter,
  createTerminalRemoteClipboardBridge,
  createTerminalRemoteClipboardSourceWriter,
} from "./terminal-remote-clipboard.ts";

function osc52(text) {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMilliseconds = 100) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await delay(1);
  }
}

function fakeDocument() {
  const createElement = (tagName) => ({
    tagName,
    children: [],
    className: "",
    hidden: false,
    disabled: false,
    isConnected: false,
    textContent: "",
    type: "",
    listeners: new Map(),
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    append(...children) {
      this.children.push(...children);
    },
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    remove() {
      this.isConnected = false;
    },
  });
  return { createElement };
}

test("retries the latest blocked remote clipboard write from an explicit action", async () => {
  const writes = [];
  const blocked = [];
  let copied = 0;
  const ownerDocument = fakeDocument();
  const mount = {
    children: [],
    append(element) {
      element.isConnected = true;
      this.children.push(element);
    },
  };
  const retry = createTerminalRemoteClipboardRetry({
    mount,
    enabled: () => true,
    writeText: async (text) => writes.push(text),
    message: "Remote content is ready",
    actionLabel: "Copy",
    onCopied: () => copied += 1,
    onBlocked: (error) => blocked.push(String(error)),
    ownerDocument,
  });

  retry.attach();
  retry.handleWriteError(new Error("permission denied"), "first");
  retry.handleWriteError(new Error("permission denied"), "latest");
  await retry.retry();

  assert.deepEqual(writes, ["latest"]);
  assert.equal(copied, 1);
  assert.equal(mount.children[0].hidden, true);
  assert.equal(blocked.length, 2);
});

test("exposes manual clipboard retry progress without changing the action label", async () => {
  let finishWrite;
  const blockedWrite = new Promise((resolve) => {
    finishWrite = resolve;
  });
  const ownerDocument = fakeDocument();
  const mount = {
    children: [],
    append(element) {
      element.isConnected = true;
      this.children.push(element);
    },
  };
  const retry = createTerminalRemoteClipboardRetry({
    mount,
    enabled: () => true,
    writeText: async () => await blockedWrite,
    message: "Remote content is ready",
    actionLabel: "Copy",
    onCopied: () => {},
    onBlocked: () => {},
    ownerDocument,
  });

  retry.attach();
  retry.handleWriteError(new Error("permission denied"), "latest");
  const button = mount.children[0].children[1];
  const write = retry.retry();
  await Promise.resolve();

  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.textContent, "Copy");

  finishWrite();
  await write;
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), "false");
});

test("drops a pending remote clipboard value after its pane becomes inactive", async () => {
  let enabled = true;
  const writes = [];
  const retry = createTerminalRemoteClipboardRetry({
    mount: { append() {} },
    enabled: () => enabled,
    writeText: async (text) => writes.push(text),
    message: "Remote content is ready",
    actionLabel: "Copy",
    onCopied: () => assert.fail("inactive content must not copy"),
    onBlocked: () => {},
    ownerDocument: fakeDocument(),
  });

  retry.handleWriteError(new Error("permission denied"), "secret");
  discardInactiveRemoteClipboardRetries([{
    id: "inactive-pane",
    remoteClipboardRetryClear: retry.clear,
  }], "active-pane");
  enabled = false;
  retry.handleWriteError(new Error("late permission failure"), "inactive-secret");
  enabled = true;
  await retry.retry();

  assert.deepEqual(writes, []);
});

test("drops an older retry after a newer automatic clipboard write succeeds", async () => {
  const writes = [];
  const retry = createTerminalRemoteClipboardRetry({
    mount: { append() {} },
    enabled: () => true,
    writeText: async (text) => writes.push(text),
    message: "Remote content is ready",
    actionLabel: "Copy",
    onCopied: () => {},
    onBlocked: () => {},
    ownerDocument: fakeDocument(),
  });

  retry.handleWriteError(new Error("permission denied"), "older");
  retry.handleWriteSuccess("newer");
  await retry.retry();

  assert.deepEqual(writes, []);
});

test("keeps a newer automatic clipboard write after an older retry was already started", async () => {
  let clipboard = "";
  let releaseOlderWrite;
  const olderWriteBlocked = new Promise((resolve) => {
    releaseOlderWrite = resolve;
  });
  const copied = [];
  const writeText = createSerializedTerminalRemoteClipboardWriter(async (text) => {
    if (text === "older") await olderWriteBlocked;
    clipboard = text;
  });
  const retry = createTerminalRemoteClipboardRetry({
    mount: { append() {} },
    enabled: () => true,
    writeText,
    message: "Remote content is ready",
    actionLabel: "Copy",
    onCopied: () => copied.push("older retry"),
    onBlocked: () => {},
    ownerDocument: fakeDocument(),
  });
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText,
    onWriteStart: retry.handleWriteStart,
    onCopied: (text) => {
      retry.handleWriteSuccess(text);
      copied.push(text);
    },
    onWriteError: retry.handleWriteError,
    onError: (error) => assert.fail(String(error)),
  });

  retry.handleWriteError(new Error("permission denied"), "older");
  const olderRetry = retry.retry();
  await Promise.resolve();
  bridge.beforeRenderOutput(osc52("newer"));
  await Promise.resolve();
  releaseOlderWrite();
  await Promise.all([olderRetry, bridge.settled()]);

  assert.equal(clipboard, "newer");
  assert.deepEqual(copied, ["newer"]);
});

test("restores the latest manual retry when late reconciliation is blocked", async () => {
  let clipboard = "";
  let releaseOlderWrite;
  const olderWriteBlocked = new Promise((resolve) => {
    releaseOlderWrite = resolve;
  });
  let newerAttempts = 0;
  const writeText = createSerializedTerminalRemoteClipboardWriter(async (text) => {
    if (text === "older") {
      await olderWriteBlocked;
      clipboard = text;
      return;
    }
    newerAttempts += 1;
    if (newerAttempts === 1 || newerAttempts === 3) {
      throw new Error(`newer write blocked at attempt ${newerAttempts}`);
    }
    clipboard = text;
  }, { operationTimeoutMs: 10 });
  const source = createTerminalRemoteClipboardSourceWriter(writeText, () => true);
  const ownerDocument = fakeDocument();
  const mount = {
    children: [],
    append(element) {
      element.isConnected = true;
      this.children.push(element);
    },
  };
  const blocked = [];
  const retry = createTerminalRemoteClipboardRetry({
    mount,
    enabled: () => true,
    writeText: source.writeText,
    message: "Remote content is ready",
    actionLabel: "Copy",
    onCopied: () => {},
    onBlocked: (error) => blocked.push(String(error)),
    ownerDocument,
  });
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText: source.writeText,
    prepareWrite: source.prepareWrite,
    onWriteStart: retry.handleWriteStart,
    onCopied: retry.handleWriteSuccess,
    onWriteError: retry.handleWriteError,
    onError: (error) => assert.fail(String(error)),
  });

  retry.attach();
  const older = writeText("older");
  bridge.beforeRenderOutput(osc52("newer"));
  await bridge.settled();
  assert.equal(mount.children[0].hidden, false);

  await retry.retry();
  assert.equal(clipboard, "newer");
  assert.equal(mount.children[0].hidden, true);

  releaseOlderWrite();
  assert.equal(await older, false);
  await waitFor(() => blocked.length === 2);
  assert.equal(clipboard, "older");
  assert.equal(mount.children[0].hidden, false);
  assert.match(blocked[1], /newer write blocked at attempt 3/);
});

test("drops every pending retry when terminal clipboard integration is disabled", async () => {
  let cleared = 0;
  discardAllRemoteClipboardRetries([
    { remoteClipboardRetryClear: () => cleared += 1 },
    {},
    { remoteClipboardRetryClear: () => cleared += 1 },
  ]);

  assert.equal(cleared, 2);
});
