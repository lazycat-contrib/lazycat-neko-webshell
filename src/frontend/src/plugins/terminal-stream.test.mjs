import assert from "node:assert/strict";
import test from "node:test";
import { createPluginStreamBroker } from "./terminal-stream.ts";

function fixture(id, consume = false) {
  const calls = [];
  return {
    calls,
    entry: {
      id,
      stream: {
        consumePaneOutput: (...args) => { calls.push(["output", ...args]); return consume; },
        consumePaneInput: (...args) => { calls.push(["input", ...args]); return consume; },
        resetPane: (...args) => calls.push(["reset", ...args]),
        resizePane: (...args) => calls.push(["resize", ...args]),
      },
    },
  };
}
const grants = (...ids) => ids.map((id) => ({ id, resources: ["terminal-stream"] }));

test("only a plugin declaring terminal-stream can attach to the byte path", () => {
  assert.throws(() => createPluginStreamBroker([fixture("ai-chat").entry]), /Undeclared terminal-stream/);
  assert.doesNotThrow(() => createPluginStreamBroker([fixture("terminal-transfer").entry]));
});

test("unconsumed output retains the exact pane and byte chunk once", () => {
  const plugin = fixture("terminal-transfer");
  const broker = createPluginStreamBroker([plugin.entry]);
  const pane = { id: "pane", sessionBackend: "webshell" };
  const bytes = new Uint8Array([0, 0x1b, 255]);
  assert.equal(broker.consumePaneOutput(pane, bytes), false);
  assert.equal(plugin.calls.length, 1);
  assert.equal(plugin.calls[0][1], pane);
  assert.equal(plugin.calls[0][2], bytes);
  assert.deepEqual([...bytes], [0, 0x1b, 255]);
});

test("a consumed transfer cannot be processed twice by later hooks", () => {
  const first = fixture("first", true), second = fixture("second", true);
  const broker = createPluginStreamBroker([first.entry, second.entry], grants("first", "second"));
  const pane = { id: "pane" };
  assert.equal(broker.consumePaneOutput(pane, new Uint8Array([1])), true);
  assert.equal(broker.consumePaneInput(pane, "raw\u0003"), true);
  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 0);
});

test("reset and resize still reach each registered transfer lifecycle exactly once", () => {
  const plugin = fixture("terminal-transfer");
  const broker = createPluginStreamBroker([plugin.entry]);
  const pane = { id: "pane" };
  broker.resetPane(pane, "disconnected"); broker.resizePane(pane, 120);
  assert.deepEqual(plugin.calls, [["reset", pane, "disconnected"], ["resize", pane, 120]]);
});

test("an empty catalog leaves ordinary input and output on the host path", () => {
  const broker = createPluginStreamBroker([]);
  assert.equal(broker.consumePaneOutput({ id: "p" }, new Uint8Array([1])), false);
  assert.equal(broker.consumePaneInput({ id: "p" }, "text"), false);
});
