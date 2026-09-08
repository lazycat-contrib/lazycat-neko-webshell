import assert from "node:assert/strict";
import test from "node:test";
import { writeHistoryClipboard } from "./clipboard.ts";

function deferred() { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }

test("starts promise-backed clipboard access before the revision request resolves", async () => {
  const read = deferred(); let initiated = false, actual;
  const copy = writeHistoryClipboard(read.promise, () => true, {
    writeItem: async (blob) => { initiated = true; actual = await (await blob).text(); },
    fallbackCopy: () => assert.fail("native item should work"),
  });
  assert.equal(initiated, true);
  read.resolve("verified selection"); await copy;
  assert.equal(actual, "verified selection");
});

test("a stale target rejects the item and cannot enter the fallback", async () => {
  const read = deferred(); let current = true;
  const copy = writeHistoryClipboard(read.promise, () => current, {
    writeItem: async blob => { await blob; }, fallbackCopy: () => assert.fail("stale clipboard fallback"),
  });
  current = false; read.resolve("old target");
  await assert.rejects(copy, /target changed/i);
});

test("revision errors win over clipboard rejection without leaking unhandled promises", async () => {
  const read = deferred();
  const copy = writeHistoryClipboard(read.promise, () => true, {
    writeItem: async () => { throw new Error("Denied"); }, fallbackCopy: () => assert.fail("invalid text"),
  });
  read.reject(new Error("stale_content"));
  await assert.rejects(copy, /stale_content/);
});

test("permission failure falls back with only the validated text", async () => {
  const values = [];
  await writeHistoryClipboard(Promise.resolve("selection"), () => true, {
    writeItem: async () => { throw new Error("Denied"); }, fallbackCopy: text => { values.push(text); return true; },
  });
  assert.deepEqual(values, ["selection"]);
});

test("older browsers can write text and unsuccessful fallback remains an error", async () => {
  const values = [];
  await writeHistoryClipboard(Promise.resolve("selection"), () => true, {
    writeText: async text => { values.push(text); }, fallbackCopy: () => assert.fail("native text worked"),
  });
  assert.deepEqual(values, ["selection"]);
  await assert.rejects(writeHistoryClipboard(Promise.resolve("selection"), () => true, {
    fallbackCopy: () => false,
  }), /unavailable/i);
});
