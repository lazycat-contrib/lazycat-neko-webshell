import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { startAgentBridge } from '../workspace-sync/agent-bridge.mjs';
import { createBrowserDriver, uniqueBrowserSession } from '../browser-driver.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";

export async function runProgramStatusScenario() {
  const directory = await mkdtemp(join(tmpdir(), 'neko-osc7501-'));
  const artifacts = join(root, 'tests-auto/artifacts', `program-status-${Date.now()}`);
  await mkdir(artifacts, { recursive: true });
  const browsers = [];
  let bridge, server;
  try {
    await exec('npm', ['run', 'proto:ts'], { cwd: root, timeout: 60000 });
    if (!process.env.NEKO_BROWSER_AGENT_BINARY) await exec('cargo', ['build', '--locked', '--bin', 'lazycat-neko-webshell-agent'], { cwd: root, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    const native = join(directory, 'native.py');
    await writeFile(native, `import sys,os,tty,termios,select,base64
saved=termios.tcgetattr(0)
try:
 tty.setraw(0)
 os.write(1,b'\\x1b]7501;?\\x1b\\\\')
 reply=b''
 expected=b'\\x1b]7501;?\\x1b\\\\'
 while len(reply)<len(expected):
  if not select.select([0],[],[],3)[0]: raise RuntimeError('probe timed out')
  reply+=os.read(0,len(expected)-len(reply))
 if reply!=b'\\x1b]7501;?\\x1b\\\\': raise RuntimeError(repr(reply))
 os.write(1,b'PROBE_OK')
 def emit(body): os.write(1,('\\x1b]7501;'+body+'\\x1b\\\\').encode())
 emit('state=working:app=codex:progress=23:title='+base64.b64encode('Fix tests'.encode()).decode())
 while True:
  key=os.read(0,1)
  if key==b'b': emit('state=blocked:app=codex:kind=permission:msg=QXBwcm92ZSB0ZXN0')
  elif key==b'd': emit('state=done:app=codex')
  elif key==b'c': emit('state=clear')
  elif key==b'q': break
  elif key in [b'\\x1b',b']']: os.write(1,b'DUPLICATE_REPLY')
finally: termios.tcsetattr(0,termios.TCSANOW,saved)
`);
    const auto = join(directory, 'auto.py');
    await writeFile(auto, "import os,tty,termios\ns=termios.tcgetattr(0)\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b]9;4;1;37\\x07AUTO_READY')\n while os.read(0,1)!=b'q': pass\nfinally: termios.tcsetattr(0,termios.TCSANOW,s)\n");
    const node = join(directory, 'node_modules/@openai/codex/bin/codex.js');
    await mkdir(resolve(node, '..'), { recursive: true });
    await writeFile(node, "process.stdin.setRawMode(true);process.stdout.write('\\x1b]9;4;1;55\\x07NODE_READY');process.stdin.on('data',b=>{if(b.includes(113))process.exit(0)});\n");
    bridge = await startAgentBridge({ root, directory: artifacts, runtimeDirectory: directory, home: directory, selector: `osc-${randomUUID()}@local`, binary: process.env.NEKO_BROWSER_AGENT_BINARY || join(root, 'target/debug/lazycat-neko-webshell-agent') });
    server = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'program-status-real-agent', configureServer(s) { s.middlewares.use(bridge.middleware); s.httpServer.on('upgrade', bridge.upgrade); } }] });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/tests-auto/program-status/`;
    for (const name of ['first', 'second']) {
      const browser = createBrowserDriver({ session: uniqueBrowserSession(`program-status-${name}`), headed: true });
      browsers.push(browser); await browser.open(url); await browser.waitFor('window.qa?.ready && qa.connected');
    }
    const [a, b] = browsers;
    const send = text => a.evaluate(`qa.send(${JSON.stringify(text)}); true`);
    const expect = async (browser, state) => browser.waitFor(`document.querySelector('.tab-program-status')?.dataset.status === ${JSON.stringify(state)} && !document.querySelector('.tab-program-status').hidden`);
    await send(`python3 ${quote(native)}\r`);
    await a.waitFor('qa.output.includes("PROBE_OK")');
    for (const browser of browsers) await expect(browser, 'working');
    assert.match(await a.evaluate('document.querySelector(".tab-main").title'), /23%.*Fix tests/);
    await a.evaluate('qa.tabNode=document.querySelector(".tab-main"); true');
    await a.command(['click', '.tab-main']);
    assert.equal(await a.evaluate('qa.jumps.at(-1) === qa.pane.id'), true);
    await send('b'); for (const browser of browsers) await expect(browser, 'blocked');
    await a.screenshot(join(artifacts, 'desktop-blocked.png'));
    await b.navigate(url); await b.waitFor('window.qa?.ready && qa.connected'); await expect(b, 'blocked');
    assert.equal(await b.evaluate('qa.statuses.filter(records=>records.length).every(records=>records[0].state==="blocked")'), true, 'reattachment must send the current table, not replay past working states');
    await b.command(['set', 'viewport', '390', '844']);
    await b.screenshot(join(artifacts, 'mobile-blocked.png'));
    await send('d'); for (const browser of browsers) await expect(browser, 'done');
    assert.equal(await a.evaluate('qa.tabNode===document.querySelector(".tab-main")'), true, 'status updates preserve the tab node and focus boundary');
    await send('c'); for (const browser of browsers) await browser.waitFor('document.querySelector(".tab-program-status").hidden');
    await send('q'); await a.waitFor('!qa.pane.programStatus');
    await send(`bash -c ${quote(`exec -a codex python3 ${quote(auto)}`)}\r`);
    await a.waitFor('qa.output.includes("AUTO_READY")');
    await expect(a, 'working');
    assert.match(await a.evaluate('document.querySelector(".tab-main").title'), /codex.*37%/);
    await send('q'); await a.waitFor('document.querySelector(".tab-program-status").hidden');
    await send(`node ${quote(node)}\r`);
    await a.waitFor('qa.output.includes("NODE_READY")'); await expect(a, 'working');
    assert.match(await a.evaluate('document.querySelector(".tab-main").title'), /codex.*55%/);
    await send('q'); await a.waitFor('document.querySelector(".tab-program-status").hidden');
    assert.equal(await a.evaluate('qa.output.includes("DUPLICATE_REPLY")'), false);
    return { status: 'passed', name: 'program-status', artifacts };
  } catch (error) {
    console.error(bridge?.debug());
    if (browsers[0]) {
      console.error(JSON.stringify(await browsers[0].evaluate('({output:qa.output.slice(-1000),statuses:qa.statuses.slice(-10)})').catch(() => ({}))));
      await browsers[0].screenshot(join(artifacts, 'failure.png')).catch(() => {});
    }
    throw error;
  } finally {
    for (const browser of browsers) await browser.close().catch(() => {});
    await bridge?.close(); await server?.close(); await rm(directory, { recursive: true, force: true });
  }
}
