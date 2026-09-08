import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = path.join(root, "tests-auto/artifacts/herdr-machines");
await mkdir(artifacts, { recursive: true });
const fixture = await readFile(new URL("./fixture.html", import.meta.url), "utf8");
const server = await createServer({
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "machine-fixture", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split("?")[0] !== "/__machine-fixture.html") { next(); return; }
      try { res.setHeader("Content-Type", "text/html"); res.end(await server.transformIndexHtml("/__machine-fixture.html", fixture)); }
      catch (error) { next(error); }
    });
  } }],
});
await server.listen();
const session = `neko-machine-test-${process.pid}`;
// execFileSync would stop Vite's event loop while Chromium awaits its responses.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const execute = promisify(execFile);
async function browser(...args) {
  const { stdout } = await execute("agent-browser", ["--session", session, ...args], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
const evaluate = async expression => JSON.parse(await browser("eval", expression));
const click = selector => browser("click", selector);
const wait = selector => browser("wait", selector);
const pause = () => browser("wait", "200");
try {
  const port = server.httpServer.address().port;
  await browser("--args", "--use-gl=angle,--use-angle=swiftshader,--enable-unsafe-swiftshader", "open", `http://127.0.0.1:${port}/__machine-fixture.html`);
  await browser("set", "viewport", "1200", "850");
  await wait('[data-machine-action="add"]:not(:disabled)');
  assert.equal(await evaluate('document.querySelectorAll(".machine-row").length'), 4);
  assert.equal(await evaluate('document.querySelectorAll(".machine-local").length'), 0);
  await browser("screenshot", path.join(artifacts, "desktop.png"));
  await click('[data-machine-action="add"]');
  await wait('[data-machine-action="test"]:not(:disabled)');
  await click('[data-machine-source="manual"]');
  assert.equal(await evaluate('document.activeElement.dataset.machineSource'), "manual");
  await browser("fill", 'input[name="target"]', "ssh://dev@host.example.test:2222");
  await browser("fill", 'input[name="label"]', "构建服务器");
  await click('[data-machine-source="config"]');
  await click('[data-machine-source="manual"]');
  assert.deepEqual(await evaluate('[document.querySelector("input[name=target]").value,document.querySelector("input[name=label]").value]'), ["ssh://dev@host.example.test:2222", "构建服务器"]);
  await click('[data-machine-source="config"]');
  await click('[data-machine-action="test"]');
  await browser("wait", "--fn", 'qa.sockets.length === 1 && qa.sockets[0].action?.action === "test"');
  await browser("wait", "500");
  await evaluate('qa.term.restty.getPanes()[0].runtime.search.setQuery("SSH")');
  await browser("wait", "--fn", 'qa.term.restty.getPanes()[0].runtime.search.getState().total === 1');
  await evaluate('qa.term.restty.getPanes()[0].runtime.search.clear()');
  await browser("screenshot", path.join(artifacts, "connection-test.png"));
  await browser("press", "ArrowLeft");
  await browser("press", "Control+c");
  const keys = await evaluate('qa.sockets[0].inputs');
  assert(keys.includes("\u001b[D"), "arrow keys must reach SSH");
  assert(keys.includes("\u0003"), "Ctrl+C must reach SSH");
  await browser("press", "Shift+Escape");
  assert.equal(await evaluate('document.activeElement.dataset.machineAction'), "close");
  await click('[data-machine-action="keyboard"]');
  await browser("press", "q");
  await evaluate('qa.term.restty.getPanes()[0].runtime.search.setQuery("q")');
  await pause();
  assert.equal(await evaluate('qa.term.restty.getPanes()[0].runtime.search.getState().total'), 0, "password input must not be locally echoed");
  await browser("press", "Enter");
  await wait('input[name="label"]');
  assert.match(await evaluate('document.querySelector("[data-machine-message]").textContent'), /连接成功/);
  assert.deepEqual(await evaluate('qa.requests'), ["list"], "test must not mutate catalog");
  await browser("select", 'select[name="machine-host"]', "build-box");
  assert.equal(await evaluate('document.querySelector("[data-machine-message]").textContent'), "");
  await click('[form="machine-form"]');
  await browser("wait", "--fn", 'qa.sockets.length === 2 && qa.sockets[1].action?.action === "add"');
  await browser("press", "Enter");
  await browser("wait", "--fn", 'document.querySelector("[data-machine-message]").textContent.includes("机器已添加")');
  await click('[data-machine-action="back"]');
  await wait('[data-machine-action="add"]:not(:disabled)');
  assert.equal(await evaluate('document.querySelectorAll(".machine-row").length'), 5);
  const id = "a".repeat(32);
  await click(`[data-machine-id="${id}"] [data-machine-action="rename"]`);
  await browser("fill", 'input[name="label"]', "开发机新名称");
  await click('[form="machine-form"]');
  await wait('[data-machine-action="add"]:not(:disabled)');
  assert.equal(await evaluate(`document.querySelector('[data-machine-id="${id}"] h3').textContent`), "开发机新名称");
  await click(`[data-machine-id="${id}"] [data-machine-action="toggle"]`);
  await wait('[data-machine-action="add"]:not(:disabled)');
  assert.equal(await evaluate('document.activeElement.dataset.machineAction'), "toggle");
  await click(`[data-machine-id="${id}"] [data-machine-action="remove"]`);
  const before = await evaluate('qa.requests.length');
  await click('[data-machine-action="back"]');
  await wait('[data-machine-action="add"]:not(:disabled)');
  assert.equal((await evaluate('qa.requests.slice(-1)'))[0], "list");
  assert.equal(await evaluate('qa.requests.filter(r=>r.action==="remove").length'), 0);
  await click(`[data-machine-id="${id}"] [data-machine-action="remove"]`);
  await click('[form="machine-form"]');
  await wait('[data-machine-action="add"]:not(:disabled)');
  assert.equal(await evaluate('qa.requests.filter(r=>r.action==="remove").length'), 1);
  assert(await evaluate('qa.requests.length') > before);
  await browser("set", "viewport", "375", "812");
  await browser("screenshot", path.join(artifacts, "mobile.png"));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await click('[data-machine-action="add"]');
  await wait('[data-machine-action="test"]:not(:disabled)');
  await browser("screenshot", path.join(artifacts, "mobile-add.png"));
  await browser("set", "viewport", "375", "440");
  assert.equal(await evaluate('document.querySelector("dialog > footer").getBoundingClientRect().bottom <= innerHeight'), true);
  await browser("set", "viewport", "375", "812");
  await click('[data-machine-action="test"]');
  await browser("wait", "--fn", 'qa.sockets.length === 3');
  await evaluate('qa.target.generation++; qa.manager.sync()');
  assert.equal(await evaluate('document.querySelector("dialog") === null'), true);
  assert.equal(await evaluate('qa.sockets.at(-1).readyState'), 3);
  const errors = JSON.parse(await browser("errors", "--json"));
  assert.deepEqual(errors.data.errors, []);
  console.log("Herdr machine browser checks passed: drafts, optional test, PTY output/no local echo, mutations, focus, responsive layout, target cancellation.");
} finally {
  await browser("close").catch(() => {});
  await server.close();
}
