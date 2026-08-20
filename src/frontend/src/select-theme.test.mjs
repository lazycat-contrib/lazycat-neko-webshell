import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

test("native select menus keep the active interface theme", () => {
  assert.match(css, /select option,\s*select optgroup\s*{[^}]*background-color:\s*var\(--bg\);[^}]*color:\s*var\(--text\);/s);
});
