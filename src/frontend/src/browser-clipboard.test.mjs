import assert from "node:assert/strict";
import test from "node:test";

import { writeSystemClipboardText } from "./browser-clipboard.ts";

test("writes through the modern system clipboard when available", async () => {
  const writes = [];
  let fallbackCalls = 0;

  await writeSystemClipboardText("remote text", {
    writeText: async (text) => writes.push(text),
    fallbackCopy: () => {
      fallbackCalls += 1;
      return true;
    },
  });

  assert.deepEqual(writes, ["remote text"]);
  assert.equal(fallbackCalls, 0);
});

test("uses a truthful legacy fallback and rejects when the browser blocks both paths", async () => {
  await assert.doesNotReject(() => writeSystemClipboardText("fallback", {
    writeText: async () => { throw new Error("blocked"); },
    fallbackCopy: () => true,
  }));

  await assert.rejects(() => writeSystemClipboardText("blocked", {
    writeText: async () => { throw new Error("permission denied"); },
    fallbackCopy: () => false,
  }), /permission denied/);
});
