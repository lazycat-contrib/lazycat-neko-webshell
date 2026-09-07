import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateWasm } from "./export-restty-wasm.mjs";

const wasm = new Uint8Array(
  readFileSync(new URL("../vendor/restty/0.3.0/restty.wasm", import.meta.url)),
);

test("rejects a required memory export with a different WebAssembly kind", () => {
  const malformed = wasm.slice();
  const memory = findExportEntry(malformed, "memory");
  assert.equal(memory.kind, 2);

  // Global zero exists, so this is still a valid module but no longer exports its memory.
  malformed[memory.kindOffset] = 3;

  assert.throws(
    () => validateWasm(malformed),
    /Restty WASM export memory.*memory/,
  );
});

test("rejects a required function export with another valid function signature", () => {
  const malformed = wasm.slice();
  const destroy = findExportEntry(malformed, "restty_destroy");
  const outputLength = findExportEntry(malformed, "restty_output_len");
  assert.equal(destroy.kind, 0);
  assert.equal(outputLength.kind, 0);
  assert.equal(destroy.indexBytes.length, outputLength.indexBytes.length);

  // Both targets are valid functions, but output_len returns i32 while destroy returns nothing.
  malformed.set(outputLength.indexBytes, destroy.indexOffset);

  assert.throws(
    () => validateWasm(malformed),
    /invalid Restty WASM export restty_destroy ABI: expected \(i32\) -> \(\)/,
  );
});

function findExportEntry(bytes, expectedName) {
  let offset = 8;
  while (offset < bytes.byteLength) {
    const id = bytes[offset++];
    const size = readVarUint32(bytes, offset);
    offset = size.end;
    const sectionEnd = offset + size.value;
    if (id === 7) return findNamedExport(bytes, offset, sectionEnd, expectedName);
    offset = sectionEnd;
  }
  throw new Error("test artifact has no export section");
}

function findNamedExport(bytes, offset, sectionEnd, expectedName) {
  const count = readVarUint32(bytes, offset);
  offset = count.end;
  for (let index = 0; index < count.value; index += 1) {
    const nameLength = readVarUint32(bytes, offset);
    offset = nameLength.end;
    const nameEnd = offset + nameLength.value;
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, nameEnd));
    offset = nameEnd;
    const kindOffset = offset;
    const kind = bytes[offset++];
    const indexOffset = offset;
    const exportedIndex = readVarUint32(bytes, offset);
    offset = exportedIndex.end;
    if (name === expectedName) {
      return {
        kind,
        kindOffset,
        indexOffset,
        indexBytes: bytes.slice(indexOffset, exportedIndex.end),
      };
    }
  }
  assert.equal(offset, sectionEnd);
  throw new Error(`test artifact has no ${expectedName} export`);
}

function readVarUint32(bytes, offset) {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const current = bytes[offset++];
    value += (current & 0x7f) * 2 ** shift;
    if ((current & 0x80) === 0) return { value, end: offset };
  }
  throw new Error("invalid test varuint32");
}
