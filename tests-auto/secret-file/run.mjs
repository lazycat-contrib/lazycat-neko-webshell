import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = path.join(root, "tests-auto/artifacts/secret-file");
await mkdir(artifacts, { recursive: true });
const fixture = await readFile(new URL("./fixture.html", import.meta.url), "utf8");
const server = await createServer({ configFile: path.join(root, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "secret-file-fixture", configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url?.split("?")[0] !== "/__secret-file-fixture.html") return next();
    try { res.setHeader("Content-Type", "text/html"); res.end(await server.transformIndexHtml("/__secret-file-fixture.html", fixture)); }
    catch (error) { next(error); }
  });
} }] });
const browser = createBrowserDriver({ session: uniqueBrowserSession("neko-secret"), headed: false, launchArgs: "--use-gl=angle,--use-angle=swiftshader,--enable-unsafe-swiftshader" });
const evaluate = source => browser.evaluate(source);
const clickText = text => browser.command(["find", "role", "button", "click", "--name", text, "--exact"]);
const open = () => browser.command(["click", "#open"]);
const close = async () => {
  await browser.press("Escape");
  await browser.waitFor('!document.querySelector("dialog").open');
  assert.equal(await evaluate('qa.manager.ownsEvent({target:document.querySelector(".secret-file-close")})'), false, 'closed dialogs do not own keyboard events');
};
const saved = () => browser.waitFor('Boolean(document.querySelector("dialog[open] .secret-file-path"))');
const input = () => browser.waitFor('Boolean(document.querySelector("dialog[open] textarea"))');
try {
  await server.listen();
  await browser.open(`http://127.0.0.1:${server.httpServer.address().port}/__secret-file-fixture.html`);
  await browser.waitFor("qa.ready");
  await browser.command(["set", "viewport", "1280", "850"]);
  // Like a fresh app load, the plugin list is unknown until tools/settings open.
  for (const backend of ["webshell", "herdr"]) {
    await evaluate(`qa.pane.sessionBackend=${JSON.stringify(backend)};qa.pane.sessionId=${JSON.stringify(`fresh-${backend}`)}`);
    const point = await evaluate('(()=>{const r=document.querySelector("#qa-terminal-pane").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
    await browser.dispatchMouse([
      {type:"mousePressed",...point,button:"right",buttons:2,clickCount:1},
      {type:"mouseReleased",...point,button:"right",buttons:0,clickCount:1},
    ]);
    await browser.command(["find", "text", "机密文件", "click", "--exact"]);
    assert.equal(await evaluate('qa.lastMenuAction'), 'secret-file', 'the native context-menu item must run');
    const state = await evaluate('({open:Boolean(document.querySelector("dialog[open]")),known:qa.pluginEnabled!==undefined,backend:qa.pane.sessionBackend,status:document.querySelector("#notice").textContent,requests:qa.requests.length})');
    assert.equal(state.open, true, `fresh-entry state: ${JSON.stringify(state)}`);
    await saved();
    await close();
  }
  await evaluate("qa.pane.sessionId='s';qa.pluginEnabled=false");
  await browser.press("Control+Alt+v");
  await saved();
  assert.equal(await evaluate('document.querySelector("dialog").dataset.instant'), "true");
  assert.equal(await evaluate('new TextDecoder().decode(new Uint8Array(qa.requests[0].payload))'), "  TEST-ONLY KEY\nsecond line\n");
  const firstPath = await evaluate('document.querySelector(".secret-file-path").textContent');
  assert.equal(await evaluate('document.querySelector(".secret-file-name").textContent'), `文件名：${firstPath.split('/').at(-1)}`);
  await browser.command(["wait", "300"]);
  await browser.screenshot(path.join(artifacts, "desktop.png"));
  await clickText("复制路径");
  assert.equal(await evaluate("qa.copied"), firstPath);
  await clickText("插入终端");
  assert.equal(await evaluate("qa.pastes[0].text"), firstPath);
  assert.equal(await evaluate("qa.pastes[0].text.includes('\\n')"), false);
  await evaluate("qa.generation++");
  await open(); await saved();
  assert.equal(await evaluate('document.querySelector(".secret-file-actions button").disabled'), false, "explicit reopen rebinds generation");
  await evaluate("qa.generation++");
  await clickText("插入终端");
  assert.equal(await evaluate("qa.pastes.length"), 1, "switching while open must not paste");
  await close();

  // Denied native copy falls back to a selected textarea inside the modal.
  await open(); await saved();
  await evaluate("qa.copyFail=true; qa.originalExec=document.execCommand.bind(document); document.execCommand=(command)=>{qa.copyParent=document.activeElement?.parentElement?.tagName;return qa.originalExec(command)}");
  await clickText("复制路径");
  await browser.waitFor('document.querySelector(".secret-file-status").textContent.includes("已复制")');
  assert.equal(await evaluate("qa.copyParent"), "DIALOG");
  await evaluate("document.execCommand=qa.originalExec;qa.copyFail=false");
  await close();

  // A permanent icon, not an operations-page shortcut, opens the mobile sheet.
  await browser.command(["set", "viewport", "390", "844"]);
  await browser.command(["click", ".mobile-secret-file-button"]);
  await saved();
  assert.equal(await evaluate("qa.restoredKeyboard"), 0);
  assert.equal(await evaluate('document.querySelector(".mobile-secret-file-button").textContent.trim()'), "");
  assert.equal(await evaluate('document.querySelector(".mobile-secret-file-button").getBoundingClientRect().width >= 44'), true);
  await browser.command(["wait", "300"]);
  await browser.screenshot(path.join(artifacts, "mobile.png"));
  await clickText("删除文件");
  await browser.waitFor('document.querySelector(".secret-file-status").textContent === "文件已删除"');
  await close();
  await evaluate("qa.mode='empty'");
  await open(); await input();
  assert.equal(await evaluate('document.activeElement.tagName === "TEXTAREA"'), false);
  await browser.command(["wait", "300"]);
  await browser.screenshot(path.join(artifacts, "mobile-manual.png"));
  await browser.command(["fill", "#secret-file-input", "  MANUAL TEST\nline 2\n"]);
  await clickText("生成文件"); await saved();
  assert.equal(await evaluate('new TextDecoder().decode(new Uint8Array(qa.requests.at(-1).payload))'), "  MANUAL TEST\nline 2\n");
  await browser.command(["set", "viewport", "320", "560"]);
  await browser.command(["wait", "300"]);
  await browser.screenshot(path.join(artifacts, "mobile-narrow.png"));
  assert.equal(await evaluate('document.querySelector("dialog").scrollWidth <= document.querySelector("dialog").clientWidth'), true);
  assert.equal(await evaluate('Math.abs(document.querySelector("dialog").getBoundingClientRect().width - innerWidth) < 1'), true, "mobile sheet spans the viewport");
  await clickText("删除文件");
  await browser.waitFor('document.querySelector(".secret-file-status").textContent === "文件已删除"');
  await close();
  await evaluate("qa.mode='deny'"); await open(); await input();
  assert.match(await evaluate('document.querySelector(".secret-file-status").textContent'), /无法读取/);
  await close();

  // Old clipboard reads cannot save content or unlock a newer create.
  await evaluate("qa.mode='pending'"); await open(); await close();
  await evaluate("qa.mode='ok';qa.delay=1500;document.querySelector('#notice').textContent=''"); await open();
  const pendingCreateCount = await evaluate('qa.requests.length');
  await evaluate("qa.pendingReads.shift()('LATE TEST DATA')");
  await close();
  await open();
  assert.equal(await evaluate('Boolean(document.querySelector("dialog[open]"))'), false, 'late read cannot unlock an unfinished create');
  assert.equal(await evaluate('qa.requests.length'), pendingCreateCount);
  await browser.waitFor('document.querySelector("#notice").textContent.includes("取回路径")');
  await open(); await saved();
  assert.equal(await evaluate('qa.requests.some(r=>new TextDecoder().decode(new Uint8Array(r.payload)).includes("LATE TEST DATA"))'), false);
  await close();
  await open(); await saved(); await clickText("删除文件");
  await browser.waitFor('document.querySelector(".secret-file-status").textContent === "文件已删除"');
  await close();
  await evaluate("qa.mode='pending';qa.delay=0"); await open();
  await input(); // Three-second timeout, without waiting for permission promise.
  assert.match(await evaluate('document.querySelector(".secret-file-status").textContent'), /无法读取/);
  await close();
  await evaluate("qa.mode='ok';qa.delay=600;document.querySelector('#notice').textContent=''"); await open(); await close();
  await browser.waitFor('document.querySelector("#notice").textContent.includes("取回路径")');
  await open(); await saved();
  assert.equal(await evaluate('document.querySelectorAll("dialog").length'), 1);
  const errors = JSON.parse(await browser.command(["errors", "--json"]));
  assert.deepEqual(errors.data.errors, []);
  console.log("Secret file browser checks passed: shortcut, exact text, copy fallback, no Enter, target isolation/reopen, permanent mobile icon, manual fallback, timeout, late reads and saves, 320px layout.");
} finally {
  await browser.close().catch(() => {});
  await server.close();
}
