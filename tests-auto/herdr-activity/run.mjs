import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createBrowserDriver,uniqueBrowserSession} from '../browser-driver.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function runHerdrActivityScenario(){
 const server=await createServer({configFile:false,root,server:{host:'127.0.0.1',port:0},logLevel:'error'});
 const browser=createBrowserDriver({session:uniqueBrowserSession('herdr-activity'),headed:false});
 const artifacts=path.join(root,'tests-auto/artifacts/herdr-activity');await mkdir(artifacts,{recursive:true});
 try{
  await server.listen();await browser.open(`http://127.0.0.1:${server.httpServer.address().port}/tests-auto/herdr-activity/fixture.html`);
  await browser.waitFor('window.fixtureReady');
  assert.equal(await browser.evaluate('document.querySelectorAll(".herdr-target-chip").length'),4);
  assert.equal(await browser.evaluate('document.querySelector(".herdr-jump-workspace").dataset.status'),'blocked');
  const colors=await browser.evaluate('[...document.querySelectorAll(".herdr-target-chip .herdr-jump-status")].map(element=>getComputedStyle(element).color)');
  assert.deepEqual(colors,['rgb(249, 226, 175)','rgb(243, 139, 168)','rgb(148, 226, 213)','rgb(166, 227, 161)']);
  await browser.command(['click','[data-herdr-activity-help-open]']);
  await browser.waitFor('document.querySelector("#herdrActivityHelp").open');
  await browser.screenshot(path.join(artifacts,'status-help.png'));
  await browser.press('Escape');
  assert.equal(await browser.evaluate('document.querySelector("#herdrActivityHelp").open'),false);
  assert.equal(await browser.evaluate('document.querySelector("#herdrWorkspaceMenu").hidden'),false);
  assert.equal(await browser.evaluate('document.activeElement.hasAttribute("data-herdr-activity-help-open")'),true);
  await browser.command(['set','viewport','375','812']);
  await browser.waitFor('(()=>{const r=document.querySelector("[data-herdr-activity-help-open]").getBoundingClientRect();return r.width>=43.9&&r.height>=43.9})()');
  assert.equal(await browser.evaluate('(()=>{const r=[...document.querySelector(".herdr-jump-head").children].filter(e=>getComputedStyle(e).display!=="none").map(e=>e.getBoundingClientRect());return Math.max(...r.map(v=>v.top))-Math.min(...r.map(v=>v.top))<20})()'),true);
  await browser.command(['click','[data-herdr-activity-help-open]']);
  assert.equal(await browser.evaluate('(()=>{const dialog=document.querySelector("#herdrActivityHelp"),r=dialog.getBoundingClientRect();return dialog.scrollWidth<=dialog.clientWidth&&r.left>=0&&r.right<=innerWidth})()'),true);
  await browser.command(['click','[data-herdr-activity-help-close]']);
  return {status:'passed',name:'herdr-activity',artifacts};
 }finally{await browser.close().catch(()=>{});await server.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url))runHerdrActivityScenario().then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1});
