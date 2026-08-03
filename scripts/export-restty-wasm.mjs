import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESTTY_VERSION = "0.2.6";
const EXPECTED_SHA256 = "998cee70f955a7f48390347d9453aa412f2305c85dec1574e046739f10e05ace";
const REQUIRED_EXPORTS = [
  "memory",
  "restty_alloc",
  "restty_create",
  "restty_destroy",
  "restty_free",
  "restty_output_consume",
  "restty_output_len",
  "restty_output_ptr",
  "restty_render_update",
  "restty_resize",
  "restty_write",
];

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resttyRoot = join(projectRoot, "node_modules", "restty");
const outputPath = join(projectRoot, "vendor", "restty", RESTTY_VERSION, "restty.wasm");
const packageJson = JSON.parse(readFileSync(join(resttyRoot, "package.json"), "utf8"));
if (packageJson.version !== RESTTY_VERSION) {
  throw new Error(`expected restty ${RESTTY_VERSION}, found ${packageJson.version ?? "unknown"}`);
}

const dist = join(resttyRoot, "dist");
const sources = readdirSync(dist)
  .filter((name) => /^chunk-.*\.js$/.test(name))
  .map((name) => ({ name, source: readFileSync(join(dist, name), "utf8") }))
  .filter(({ source }) => source.includes("var WASM_BINARY = `"));
if (sources.length !== 1) {
  throw new Error(`expected one Restty WASM chunk, found ${sources.length}`);
}

const literal = readTemplateLiteral(sources[0].source, "var WASM_BINARY = ");
if (hasUnescapedTemplateInterpolation(literal)) {
  throw new Error("Restty WASM template literal contains executable interpolation");
}
const binaryString = Function(`"use strict"; return (${literal});`)();
if (typeof binaryString !== "string") {
  throw new Error("Restty WASM literal did not evaluate to a string");
}
const bytes = Uint8Array.from(binaryString, (character) => character.charCodeAt(0) & 0xff);
validateWasm(bytes);

const sha256 = createHash("sha256").update(bytes).digest("hex");
if (process.argv.includes("--print-sha")) {
  process.stdout.write(`${sha256}  ${bytes.byteLength}\n`);
  process.exit(0);
}
if (sha256 !== EXPECTED_SHA256) {
  throw new Error(`Restty WASM SHA-256 mismatch: expected ${EXPECTED_SHA256}, found ${sha256}`);
}

if (process.argv.includes("--write")) {
  writeFileSync(outputPath, bytes);
  process.stdout.write(`wrote ${outputPath} (${bytes.byteLength} bytes)\n`);
} else {
  const pinned = new Uint8Array(readFileSync(outputPath));
  if (!Buffer.from(pinned).equals(Buffer.from(bytes))) {
    throw new Error(`pinned Restty WASM differs from ${sources[0].name}`);
  }
  process.stdout.write(`verified ${outputPath} (${bytes.byteLength} bytes)\n`);
}

function readTemplateLiteral(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`missing ${marker.trim()} marker`);
  const start = markerIndex + marker.length;
  if (source[start] !== "`") throw new Error("Restty WASM marker is not followed by a template literal");
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] !== "`") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= start && source[cursor] === "\\"; cursor -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) return source.slice(start, index + 1);
  }
  throw new Error("unterminated Restty WASM template literal");
}

function hasUnescapedTemplateInterpolation(literal) {
  for (let index = 1; index + 1 < literal.length; index += 1) {
    if (literal[index] !== "$" || literal[index + 1] !== "{") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && literal[cursor] === "\\"; cursor -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) return true;
  }
  return false;
}

function validateWasm(bytes) {
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (bytes.byteLength < magic.length || !magic.every((value, index) => bytes[index] === value)) {
    throw new Error("Restty artifact is not a WebAssembly v1 module");
  }
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 1 || imports[0].module !== "env" || imports[0].name !== "log" || imports[0].kind !== "function") {
    throw new Error(`unexpected Restty WASM imports: ${JSON.stringify(imports)}`);
  }
  const exports = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
  for (const name of REQUIRED_EXPORTS) {
    if (!exports.has(name)) throw new Error(`missing Restty WASM export: ${name}`);
  }
}
