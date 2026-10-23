import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, generatedCatalog, updateCatalog } from "./plugin-catalog.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function fixture(run) {
  const directory = mkdtempSync(resolve(tmpdir(), "neko-plugin-catalog-"));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function addPlugin(root, directory, id = directory, edit = (plugin) => plugin) {
  const path = resolve(root, "src/plugins", directory);
  const frontend = resolve(root, "src/frontend/src/plugins", id);
  mkdirSync(path, { recursive: true }); mkdirSync(frontend, { recursive: true });
  writeFileSync(resolve(path, "mod.rs"), "pub fn register() {}\n");
  writeFileSync(resolve(frontend, "entry.ts"), "export {};\n");
  const manifest = edit({ id, enabled: false, metadata: {}, resources: ["ui"], frontend: { entry: `${id}/entry.ts`, tool: true, nameKey: "plugin.name", descriptionKey: "plugin.description", icon: "plug" }, configuration: { version: 1, metadata: {} } });
  writeFileSync(resolve(path, "plugin.json"), JSON.stringify(manifest));
}

test("the complete built-in catalog preserves defaults and configuration ownership", () => {
  const plugins = discoverPlugins(root);
  assert.equal(plugins.length, 9);
  const enabled = Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.enabled]));
  assert.deepEqual(enabled, { "ai-chat": false, "file-transfer": true, "lightos-port-forward": false, pomodoro: true, "public-tunnel": false, "terminal-diagnostics": false, "terminal-mcp": false, "terminal-transfer": false, "white-noise": true });
  const mcp = plugins.find((plugin) => plugin.id === "terminal-mcp");
  assert.equal(mcp.frontend.tool, false);
  assert.deepEqual(mcp.configuration.metadata.defaultPolicy.values, ["confirm", "trusted_callers", "same_user_automatic", "read_only"]);
  assert.equal(mcp.metadata.defaultPolicy, "confirm");
  assert.ok(plugins.find((plugin) => plugin.id === "ai-chat").configuration.secrets.includes("aiApiKey"));
  assert.equal(plugins.find((plugin) => plugin.id === "white-noise").metadata.floatingControls, "true");
  assert.doesNotThrow(() => updateCatalog(root, true));
});

test("adding a manifest automatically contributes backend discovery, browser registration and settings", () => fixture((root) => {
  addPlugin(root, "first"); addPlugin(root, "second");
  const plugins = discoverPlugins(root);
  assert.deepEqual(plugins.map((plugin) => plugin.id), ["first", "second"]);
  const files = generatedCatalog(plugins);
  assert.match(files.get("entries.generated.ts"), /second\(resources\["second"\]\)/);
  assert.match(files.get("entries.generated.ts"), /"second": \{ render: secondSettings/);
  updateCatalog(root);
  writeFileSync(resolve(root, "src/frontend/src/plugins/catalog.generated.ts"), "stale");
  assert.throws(() => updateCatalog(root, true), /catalog is stale/);
}));

test("catalog rejects duplicate identities and incomplete resource/configuration contracts", () => fixture((root) => {
  addPlugin(root, "first"); addPlugin(root, "second", "first");
  assert.throws(() => discoverPlugins(root), /duplicate/);
  rmSync(resolve(root, "src/plugins/second"), { recursive: true });
  addPlugin(root, "second", "second", (plugin) => ({ ...plugin, configuration: undefined }));
  assert.throws(() => discoverPlugins(root), /configuration contract/);
}));

test("catalog excludes raw credentials and rejects frontend path escapes", () => fixture((root) => {
  addPlugin(root, "first", "first", (plugin) => ({ ...plugin, metadata: { ngrokAuthtoken: "secret" } }));
  assert.throws(() => discoverPlugins(root), /Secret/);
  addPlugin(root, "first", "first", (plugin) => ({ ...plugin, frontend: { ...plugin.frontend, entry: "../outside.ts" } }));
  assert.throws(() => discoverPlugins(root), /frontend entry/);
}));
