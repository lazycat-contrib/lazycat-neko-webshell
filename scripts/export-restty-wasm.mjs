import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESTTY_VERSION = "0.3.0";
const EXPECTED_SHA256 = "2ac53b6ee3ea00f1b4e122cf4fa9ef3f18c5ca7e8a8dd288e8575b87626566f9";
const EXPECTED_BYTE_LENGTH = 1_058_249;
const WASM_I32 = 0x7f;
const WASM_F64 = 0x7c;
const WASM_FUNCTION = 0;
const WASM_MEMORY = 2;
const REQUIRED_EXPORTS = [
  { name: "memory", kind: WASM_MEMORY },
  functionExport("restty_alloc", [WASM_I32], [WASM_I32]),
  functionExport("restty_create", [WASM_I32, WASM_I32, WASM_I32], [WASM_I32]),
  functionExport("restty_destroy", [WASM_I32], []),
  functionExport("restty_free", [WASM_I32, WASM_I32], []),
  functionExport("restty_output_consume", [WASM_I32, WASM_I32], [WASM_I32]),
  functionExport("restty_output_len", [WASM_I32], [WASM_I32]),
  functionExport("restty_output_ptr", [WASM_I32], [WASM_I32]),
  functionExport("restty_render_update", [WASM_I32], [WASM_I32]),
  functionExport("restty_resize", [WASM_I32, WASM_I32, WASM_I32], [WASM_I32]),
  functionExport("restty_write", [WASM_I32, WASM_I32, WASM_I32], [WASM_I32]),
];

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resttyRoot = join(projectRoot, "node_modules", "restty");
const outputPath = join(projectRoot, "vendor", "restty", RESTTY_VERSION, "restty.wasm");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
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
    return;
  }
  if (bytes.byteLength !== EXPECTED_BYTE_LENGTH) {
    throw new Error(
      `Restty WASM byte length mismatch: expected ${EXPECTED_BYTE_LENGTH}, found ${bytes.byteLength}`,
    );
  }
  if (sha256 !== EXPECTED_SHA256) {
    throw new Error(`Restty WASM SHA-256 mismatch: expected ${EXPECTED_SHA256}, found ${sha256}`);
  }

  if (process.argv.includes("--write")) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, bytes);
    process.stdout.write(`wrote ${outputPath} (${bytes.byteLength} bytes)\n`);
  } else {
    const pinned = new Uint8Array(readFileSync(outputPath));
    if (!Buffer.from(pinned).equals(Buffer.from(bytes))) {
      throw new Error(`pinned Restty WASM differs from ${sources[0].name}`);
    }
    process.stdout.write(`verified ${outputPath} (${bytes.byteLength} bytes)\n`);
  }
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

export function validateWasm(bytes) {
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (bytes.byteLength < magic.length || !magic.every((value, index) => bytes[index] === value)) {
    throw new Error("Restty artifact is not a WebAssembly v1 module");
  }
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (
    imports.length !== 1 ||
    imports[0].module !== "env" ||
    imports[0].name !== "now_ms" ||
    imports[0].kind !== "function"
  ) {
    throw new Error(`unexpected Restty WASM imports: ${JSON.stringify(imports)}`);
  }
  const nowMsType = importedFunctionType(bytes, "env", "now_ms");
  if (nowMsType.parameters.length !== 0 || !sameValues(nowMsType.results, [WASM_F64])) {
    throw new Error(
      `invalid env.now_ms ABI: expected () -> f64, found ${formatFunctionType(nowMsType)}`,
    );
  }
  validateRequiredExports(bytes);
}

function functionExport(name, parameters, results) {
  return { name, kind: WASM_FUNCTION, parameters, results };
}

function validateRequiredExports(bytes) {
  const sections = wasmSections(bytes);
  const types = readFunctionTypes(requiredSection(sections, 1, "type"));
  const importedFunction = readSingleFunctionImport(requiredSection(sections, 2, "import"));
  const definedFunctionTypes = readIndexVector(
    requiredSection(sections, 3, "function"),
    "function section",
  );
  const exports = readExports(requiredSection(sections, 7, "export"));
  const functionTypeIndexes = [importedFunction.typeIndex, ...definedFunctionTypes];

  for (const expected of REQUIRED_EXPORTS) {
    const actual = exports.get(expected.name);
    if (!actual) throw new Error(`missing Restty WASM export: ${expected.name}`);
    if (actual.kind !== expected.kind) {
      throw new Error(
        `Restty WASM export ${expected.name} must be ${formatExternalKind(expected.kind)}, found ${formatExternalKind(actual.kind)}`,
      );
    }
    if (expected.kind !== WASM_FUNCTION) continue;

    const typeIndex = functionTypeIndexes[actual.index];
    const actualType = types[typeIndex];
    if (!actualType) {
      throw new Error(
        `Restty WASM export ${expected.name} references missing function type ${typeIndex ?? "unknown"}`,
      );
    }
    if (
      !sameValues(actualType.parameters, expected.parameters) ||
      !sameValues(actualType.results, expected.results)
    ) {
      throw new Error(
        `invalid Restty WASM export ${expected.name} ABI: expected ${formatFunctionType(expected)}, found ${formatFunctionType(actualType)}`,
      );
    }
  }
}

function importedFunctionType(bytes, expectedModule, expectedName) {
  const sections = wasmSections(bytes);
  const types = readFunctionTypes(requiredSection(sections, 1, "type"));
  const imported = readSingleFunctionImport(requiredSection(sections, 2, "import"));
  if (imported.moduleName !== expectedModule || imported.importName !== expectedName) {
    throw new Error(
      `unexpected Restty WASM import ABI entry: ${imported.moduleName}.${imported.importName} kind=${imported.kind}`,
    );
  }
  const type = types[imported.typeIndex];
  if (!type) throw new Error(`Restty WASM import references missing type ${imported.typeIndex}`);
  return type;
}

function readSingleFunctionImport(bytes) {
  const reader = byteReader(bytes);
  const importCount = reader.varUint32();
  if (importCount !== 1) {
    throw new Error(`expected one Restty WASM import, found ${importCount}`);
  }
  const moduleName = reader.name();
  const importName = reader.name();
  const kind = reader.byte();
  if (kind !== WASM_FUNCTION) {
    throw new Error(`unexpected Restty WASM import ABI entry: ${moduleName}.${importName} kind=${kind}`);
  }
  const typeIndex = reader.varUint32();
  reader.done("import section");
  return { moduleName, importName, kind, typeIndex };
}

function wasmSections(bytes) {
  const reader = byteReader(bytes.subarray(8));
  const sections = new Map();
  while (!reader.atEnd()) {
    const id = reader.byte();
    const size = reader.varUint32();
    const payload = reader.bytes(size);
    if (id !== 0 && sections.has(id)) throw new Error(`duplicate WebAssembly section ${id}`);
    if (id !== 0) sections.set(id, payload);
  }
  return sections;
}

function requiredSection(sections, id, label) {
  const section = sections.get(id);
  if (!section) throw new Error(`Restty WASM is missing its ${label} section`);
  return section;
}

function readFunctionTypes(bytes) {
  const reader = byteReader(bytes);
  const count = reader.varUint32();
  const types = [];
  for (let index = 0; index < count; index += 1) {
    const form = reader.byte();
    if (form !== 0x60) throw new Error(`unsupported WebAssembly type form 0x${form.toString(16)}`);
    types.push({ parameters: reader.valueTypes(), results: reader.valueTypes() });
  }
  reader.done("type section");
  return types;
}

function readIndexVector(bytes, label) {
  const reader = byteReader(bytes);
  const count = reader.varUint32();
  const indexes = [];
  for (let index = 0; index < count; index += 1) indexes.push(reader.varUint32());
  reader.done(label);
  return indexes;
}

function readExports(bytes) {
  const reader = byteReader(bytes);
  const count = reader.varUint32();
  const exports = new Map();
  for (let index = 0; index < count; index += 1) {
    const name = reader.name();
    const kind = reader.byte();
    const exportedIndex = reader.varUint32();
    if (exports.has(name)) throw new Error(`duplicate Restty WASM export: ${name}`);
    exports.set(name, { kind, index: exportedIndex });
  }
  reader.done("export section");
  return exports;
}

function byteReader(bytes) {
  let offset = 0;
  return {
    atEnd: () => offset === bytes.byteLength,
    byte() {
      if (offset >= bytes.byteLength) throw new Error("unexpected end of WebAssembly data");
      return bytes[offset++];
    },
    bytes(length) {
      const end = offset + length;
      if (!Number.isSafeInteger(length) || length < 0 || end > bytes.byteLength) {
        throw new Error("WebAssembly field exceeds its section");
      }
      const value = bytes.subarray(offset, end);
      offset = end;
      return value;
    },
    varUint32() {
      let value = 0;
      for (let shift = 0; shift < 35; shift += 7) {
        const current = this.byte();
        value += (current & 0x7f) * 2 ** shift;
        if ((current & 0x80) === 0) {
          if (value > 0xffff_ffff) throw new Error("WebAssembly varuint32 overflow");
          return value;
        }
      }
      throw new Error("invalid WebAssembly varuint32");
    },
    name() {
      const encoded = this.bytes(this.varUint32());
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    },
    valueTypes() {
      const length = this.varUint32();
      const values = [];
      for (let index = 0; index < length; index += 1) values.push(this.byte());
      return values;
    },
    done(label) {
      if (offset !== bytes.byteLength) {
        throw new Error(`unexpected trailing data in WebAssembly ${label}`);
      }
    },
  };
}

function sameValues(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function formatFunctionType(type) {
  const names = new Map([
    [0x7f, "i32"],
    [0x7e, "i64"],
    [0x7d, "f32"],
    [0x7c, "f64"],
  ]);
  const format = (values) => values.map((value) => names.get(value) ?? `0x${value.toString(16)}`).join(", ");
  return `(${format(type.parameters)}) -> (${format(type.results)})`;
}

function formatExternalKind(kind) {
  return new Map([
    [0, "function"],
    [1, "table"],
    [2, "memory"],
    [3, "global"],
    [4, "tag"],
  ]).get(kind) ?? `external kind ${kind}`;
}
