import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer as createPortProbe } from 'node:net';
import { createServer } from 'vite';
import { startAgentBridge } from './agent-bridge.mjs';
import { createBrowserDriver, uniqueBrowserSession } from '../browser-driver.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here,'../..');

export async function runWorkspaceSyncScenario() {
  const artifacts=join(root,'tests-auto/artifacts',`workspace-sync-${Date.now()}`);
  await mkdir(artifacts,{recursive:true});
  const runtimeDirectory=await mkdtemp(join(tmpdir(),'neko-workspace-'));
  const results=[];
  let bridge,server;
  const drivers=[];
  const log=(check,details={})=>results.push({check,...details});
  try {
    await exec('npm',['run','proto:ts'],{cwd:root,timeout:60000,maxBuffer:2*1024*1024});
    if(!process.env.NEKO_BROWSER_AGENT_BINARY)await exec('cargo',['build','--locked','--bin','lazycat-neko-webshell-agent'],{cwd:root,timeout:300000,maxBuffer:4*1024*1024});
    const font=await readFile(process.env.WEBSHELL_TEST_FONT||'/usr/share/fonts/liberation/LiberationMono-Regular.ttf');
    bridge=await startAgentBridge({root,directory:artifacts,runtimeDirectory,selector:`browser-${randomUUID()}@local`,binary:process.env.NEKO_BROWSER_AGENT_BINARY||join(root,'target/debug/lazycat-neko-webshell-agent')});
    const portProbe=createPortProbe();await new Promise((resolve,reject)=>portProbe.once('error',reject).listen(0,'127.0.0.1',resolve));
    const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
    server=await createServer({configFile:false,root:here,resolve:{alias:{'/project':root}},server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[root]}},logLevel:'error',plugins:[{name:'real-agent-test-bridge',configureServer(s){
      s.middlewares.use((req,res,next)=>{if(req.url==='/font.ttf'){res.setHeader('content-type','font/ttf');res.end(font);}else void bridge.middleware(req,res,next);});
      s.httpServer.on('upgrade',bridge.upgrade);
    }}]});
    await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
    const launchArgs='--use-gl=angle,--use-angle=swiftshader,--enable-unsafe-swiftshader';
    for(const name of ['a','b'])drivers.push(createBrowserDriver({session:uniqueBrowserSession(`workspace-${name}`),headed:true,launchArgs}));
    const [a,b]=drivers;
    for(const driver of drivers){await driver.open(origin);await driver.waitFor('window.fixture?.snapshot().tabs.length === 2 && window.fixture.snapshot().tabs.every(t=>t.panes.every(p=>p.ready))',{timeoutMs:20000});}
    const snapshot=driver=>driver.evaluate('window.fixture.snapshot()');
    const before=await snapshot(b);await b.evaluate('window.fixture.seedInput(); true');
    const initialActive=(await snapshot(a)).active;
    await a.evaluate('fetch("/bridge/hold").then(r=>r.text())');
    await a.command(['click','#new-tab']);
    await a.waitFor('fetch("/bridge/status").then(r=>r.json()).then(s=>s.holding)',{timeoutMs:10000});
    await a.evaluate(`document.querySelector('[data-tab="${initialActive}"]').click(); true`);
    await a.evaluate('fetch("/bridge/release").then(r=>r.text())');
    await a.waitFor('window.fixture.snapshot().tabs.length === 3',{timeoutMs:10000});
    assert.equal((await snapshot(a)).active,initialActive,'focus persistence must not discard create or steal focus');
    await b.waitFor('window.fixture.snapshot().tabs.length === 3 && window.fixture.snapshot().tabs.every(t=>t.panes.every(p=>p.ready))',{timeoutMs:20000});
    const after=await snapshot(b);
    assert.equal(after.active,before.active,'remote mutation must preserve local focus');
    assert.equal(after.connects,before.connects+1,'only the new pane attaches');
    for(const tab of before.tabs){const current=after.tabs.find(t=>t.id===tab.id);assert.equal(current.panes[0].runtimeId,tab.panes[0].runtimeId);assert.deepEqual(current.panes[0].pendingInput,['retained-input']);}
    log('create-during-focus-and-cross-device-sync',{tabCount:after.tabs.length,additionalConnections:after.connects-before.connects});
    const third=after.tabs.find(t=>!before.tabs.some(old=>old.id===t.id));
    await bridge.action('rename_tab',{tabId:third.id,label:'renamed-from-peer'});
    await b.waitFor('window.fixture.snapshot().tabs.some(t=>t.label === "renamed-from-peer")',{timeoutMs:10000});
    assert.equal((await snapshot(b)).connects,after.connects,'rename must retain transports');
    await bridge.action('close_tab',{tabId:third.id});
    await b.waitFor('window.fixture.snapshot().tabs.length === 2',{timeoutMs:10000});
    assert.equal((await snapshot(b)).disposedCount,1,'removed peer pane disposed once');
    log('rename-and-delete-preserve-unchanged-runtimes');
    await b.evaluate('window.fixture.pause(); true');
    await bridge.action('create_tab');
    // Explicit server snapshot proves the mutation while the observer is paused.
    assert.equal((await bridge.snapshot()).tabs.length,3);
    assert.equal((await snapshot(b)).tabs.length,2);
    await b.evaluate('window.fixture.resume(); true');
    await b.waitFor('window.fixture.snapshot().tabs.length === 3',{timeoutMs:10000});
    log('pause-and-resume');
    const markerSuffix=Date.now().toString();const marker=`NEKO_BROWSER_${markerSuffix}`;
    await b.evaluate(`window.fixture.send(${JSON.stringify(`printf 'NEKO_BROWSER_%s\\n' '${markerSuffix}'\r`)}); true`);
    await b.waitFor(`window.fixture.hasOutput(${JSON.stringify(marker)})`,{timeoutMs:10000});
    await a.waitFor(`window.fixture.hasOutput(${JSON.stringify(marker)})`,{timeoutMs:10000});
    await b.evaluate(`window.fixture.searchOutput(${JSON.stringify(marker)}); true`);
    await b.waitFor('window.fixture.hasRenderedOutput()',{timeoutMs:10000});
    log('real-agent-pty-output-in-both-browsers-and-renderer');
    for(const [index,driver] of drivers.entries()){
      const state=await snapshot(driver);assert.deepEqual(state.errors,[]);
      await driver.screenshot(join(artifacts,`device-${index+1}.png`));
    }
    assert.deepEqual((await (await fetch(origin+'/bridge/status')).json()).errors,[], 'bridge stream errors must fail the scenario');
    await writeFile(join(artifacts,'results.json'),JSON.stringify({passed:true,results},null,2));
    console.log(`workspace-sync: ${results.length} real browser/agent checks passed; artifacts ${artifacts}`);
    return {scenario:'workspace-sync',status:'passed',passed:true,artifacts,checks:results.length};
  } catch(error) {
    for(const [index,driver] of drivers.entries()){
      try{await driver.screenshot(join(artifacts,`failure-${index+1}.png`));}catch{}
      try{await writeFile(join(artifacts,`state-${index+1}.json`),JSON.stringify(await driver.evaluate('({url:location.href,html:document.documentElement.outerHTML.slice(0,1400),state:window.fixture?.snapshot()})'),null,2));}catch{}
      try{await writeFile(join(artifacts,`errors-${index+1}.json`),JSON.stringify(await driver.command(['errors']),null,2));}catch{}
    }
    await writeFile(join(artifacts,'results.json'),JSON.stringify({passed:false,error:error.message,results},null,2));
    throw error;
  } finally {
    for(const driver of drivers)await driver.close().catch(()=>{});
    await bridge?.close();await server?.close();
    await rm(runtimeDirectory,{recursive:true,force:true});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){await runWorkspaceSyncScenario();}
