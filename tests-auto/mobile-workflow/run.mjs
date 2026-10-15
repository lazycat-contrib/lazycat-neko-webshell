import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createServer} from 'vite';
import {createBrowserDriver,uniqueBrowserSession} from '../browser-driver.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function runMobileWorkflowScenario(){
 const artifacts=path.join(root,'tests-auto/artifacts/mobile-workflow');await mkdir(artifacts,{recursive:true});
 const server=await createServer({configFile:false,root,server:{host:'127.0.0.1',port:0},logLevel:'error'});
 const browser=createBrowserDriver({session:uniqueBrowserSession('mobile-workflow'),headed:false});
 const evaluate=s=>browser.evaluate(s);
 const click=async selector=>{
  await evaluate(`(async()=>{document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
  return browser.command(['click',selector]);
 };
 const wait=s=>browser.waitFor(s);
 const screenshot=async name=>{await browser.command(['wait','240']);await browser.screenshot(path.join(artifacts,name+'.png'))};
 const touch=(type,p,id=1,delayMs=0)=>({type,delayMs,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{...p,id,radiusX:2,radiusY:2,force:1}]});
 const tap=async selector=>{await wait('[...document.querySelectorAll("dialog:not([open])")].every(e=>getComputedStyle(e).display==="none")');const p=await evaluate(`qa.point(${JSON.stringify(selector)})`);await browser.dispatchTouch([touch('touchStart',p,1,25),touch('touchEnd',p)])};
 const composer=async()=>{await tap('[data-mobile-action="compose-text"]');await wait('document.querySelector(".mobile-composer[open]")')};
 const palette=async()=>{await tap('[data-mobile-action="command-palette"]');await wait('document.querySelector(".mobile-command-palette[open]")')};
 const closeComposer=async()=>{await click('.mobile-composer-close');await wait('!document.querySelector(".mobile-composer").open')};
 try{
  await server.listen();await browser.open(`http://127.0.0.1:${server.httpServer.address().port}/tests-auto/mobile-workflow/fixture.html`);
  await browser.command(['set','viewport','390','844']);await wait('window.qa?.ready');
  assert.equal(await evaluate('document.querySelector(".desktop-secret-file-trigger")'),null);
  await evaluate('qa.dockToolbar=document.querySelector(".mobile-keyboard-toolbar");document.querySelector("#emptyState").hidden=false');
  const dockState=()=>evaluate(`(()=>{
    const root=document.querySelector('#mobileShortcuts'),dock=root.getBoundingClientRect();
    const toolbar=document.querySelector('.mobile-keyboard-toolbar'),bar=toolbar.getBoundingClientRect();
    const empty=document.querySelector('#emptyState').getBoundingClientRect();
    const toggle=root.querySelector('[data-mobile-action="toggle-expanded-keyboard"]');
    const active=[...root.querySelectorAll('.mobile-keyboard-mode-tabs [data-mobile-page][aria-pressed="true"]')].map(node=>node.dataset.mobilePage);
    return {expanded:root.dataset.expanded,activePage:root.dataset.activePage,ariaExpanded:toggle.getAttribute('aria-expanded'),panelHidden:root.querySelector('#mobileExpandedKeyboard').hidden,toolbarCount:document.querySelectorAll('.mobile-keyboard-toolbar').length,sameToolbar:toolbar===qa.dockToolbar,active,scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,viewportHeight:innerHeight,dockTop:dock.top,dockBottom:dock.bottom,dockLeft:dock.left,dockRight:dock.right,emptyBottom:empty.bottom,toolbarBottom:bar.bottom,toolbarHeight:bar.height};
  })()`);
  const assertDockGeometry=async(label)=>{
    const state=await dockState();
    assert.equal(state.toolbarCount,1,`${label}: toolbar must exist exactly once`);
    assert.equal(state.sameToolbar,true,`${label}: mode changes must preserve the toolbar node`);
    assert.equal(state.scrollWidth<=state.viewportWidth,true,`${label}: no page-wide horizontal overflow`);
    assert.equal(state.dockLeft>=-1&&state.dockRight<=state.viewportWidth+1,true,`${label}: dock fits the viewport width`);
    assert.equal(state.dockTop>=-1&&state.dockBottom<=state.viewportHeight+1,true,`${label}: dock stays inside the viewport`);
    assert.equal(state.emptyBottom<=state.dockTop+1, true,`${label}: terminal empty state reserves dock height`);
    assert.equal(state.toolbarHeight>=44&&state.toolbarBottom<=state.dockBottom,true,`${label}: toolbar stays reachable`);
    return state;
  };
  let dock=await assertDockGeometry('compact');
  assert.deepEqual([dock.expanded,dock.ariaExpanded,dock.panelHidden],['false','false',true]);
  await screenshot('dock-compact');
  await tap('[data-mobile-action="toggle-expanded-keyboard"]');await wait('document.querySelector("#mobileShortcuts").dataset.expanded==="true"');
  dock=await assertDockGeometry('typing');
  assert.deepEqual([dock.activePage,dock.ariaExpanded,dock.panelHidden,dock.active],['typing','true',false,['typing']]);
  assert.equal(await evaluate('document.querySelector("[data-mobile-panel=typing]").hidden'),false);
  await screenshot('dock-typing');
  const beforeVirtualKey=await evaluate('qa.bytes.length');
  await tap('[data-mobile-panel="typing"] [data-mobile-shortcut="q"]');
  assert.equal(await evaluate('qa.bytes.at(-1)'),'q');
  const swipeStart=await evaluate('qa.point("[data-mobile-panel=typing] [data-mobile-shortcut=p]")');
  await browser.dispatchTouch([touch('touchStart',swipeStart,7,30),touch('touchMove',{x:swipeStart.x-110,y:swipeStart.y+4},7,60),touch('touchEnd',swipeStart,7)]);
  await wait('document.querySelector("#mobileShortcuts").dataset.activePage==="function"');
  assert.equal(await evaluate('qa.bytes.length'),beforeVirtualKey+1,'swiping keyboard pages must not send the touched key');
  await tap('.mobile-keyboard-mode-tabs [data-mobile-page="function"]');
  dock=await assertDockGeometry('function');
  assert.deepEqual([dock.activePage,dock.active],['function',['function']]);
  assert.equal(await evaluate('document.querySelector("[data-mobile-panel=typing]").hidden'),true);
  assert.equal(await evaluate('document.querySelector("[data-mobile-panel=function]").hidden'),false);
  assert.equal(await evaluate('qa.bytes.length'),beforeVirtualKey+1,'switching pages must not send terminal input');
  await screenshot('dock-function');
  await evaluate('document.documentElement.style.setProperty("--lzc-safe-area-inset-bottom","24px")');
  await browser.command(['set','viewport','390','360']);
  await assertDockGeometry('short viewport with safe inset');
  await tap('.mobile-keyboard-mode-tabs [data-mobile-page="typing"]');
  const beforeSmallPan=await evaluate('qa.bytes.length');
  const smallPan=await evaluate(`qa.point(${JSON.stringify('[data-mobile-panel=typing] [data-mobile-shortcut="1"]')})`);
  await browser.dispatchTouch([touch('touchStart',smallPan,8,30),touch('touchMove',{x:smallPan.x,y:smallPan.y-75},8,90),touch('touchEnd',smallPan,8)]);
  await wait('document.querySelector("[data-mobile-panel=typing]").scrollTop>0');
  assert.equal(await evaluate('qa.bytes.length'),beforeSmallPan,'scrolling a short touch keyboard must not send a key');
  await browser.command(['set','viewport','390','844']);
  const beforeIme=await evaluate('qa.bytes.length');
  await tap('[data-mobile-action="toggle-system-keyboard"]');
  await wait('document.querySelector("#mobileShortcuts").dataset.expanded==="false"');
  assert.equal(await evaluate('document.activeElement.id'),'qa-terminal-input','system keyboard restores terminal IME focus');
  assert.equal(await evaluate('document.querySelector(".mobile-system-keyboard-toggle").getAttribute("aria-pressed")'),'true');
  assert.equal(await evaluate('qa.bytes.length'),beforeIme,'keyboard mode changes must not send terminal bytes');
  await tap('[data-mobile-action="toggle-system-keyboard"]');
  assert.equal(await evaluate('document.querySelector(".mobile-system-keyboard-toggle").getAttribute("aria-pressed")'),'false');
  await tap('[data-mobile-action="toggle-expanded-keyboard"]');
  await tap('.mobile-keyboard-mode-tabs [data-mobile-mode-tab="shortcuts"]');
  dock=await assertDockGeometry('shortcuts');
  assert.deepEqual([dock.activePage,dock.active],['main',['main']]);
  assert.equal(await evaluate('document.querySelector("[data-mobile-panel=main]").hidden'),false);
  await tap('[data-mobile-action="toggle-expanded-keyboard"]');await wait('document.querySelector("#mobileShortcuts").dataset.expanded==="false"');
  dock=await assertDockGeometry('collapsed');
  assert.deepEqual([dock.expanded,dock.ariaExpanded,dock.panelHidden],['false','false',true]);
  await tap('.mobile-keyboard-quick-keys [data-mobile-shortcut="ctrl"]');
  assert.equal(await evaluate('document.querySelector(".mobile-keyboard-quick-keys [data-mobile-shortcut=ctrl]").getAttribute("aria-pressed")'),'true');
  const beforeSticky=await evaluate('qa.bytes.length');
  await tap('[data-mobile-action="toggle-system-keyboard"]');
  assert.equal(await evaluate('qa.keyboard.encodeStickyInput("c","ime")'),'\x03','quick-bar Ctrl survives the system keyboard switch');
  assert.equal(await evaluate('qa.bytes.length'),beforeSticky,'modifier and keyboard toggles send no standalone bytes');
  await tap('.mobile-keyboard-quick-keys [data-mobile-shortcut="ctrl"]');
  await tap('[data-mobile-action="toggle-system-keyboard"]');
  assert.equal(await evaluate('document.querySelector(".mobile-keyboard-quick-keys [data-mobile-shortcut=ctrl]").getAttribute("aria-pressed")'),'false','closing the system keyboard clears an unused modifier');
  await evaluate('qa.keyboard.activatePage("typing")');
  await tap('[data-mobile-action="toggle-expanded-keyboard"]');
  await tap('[data-mobile-panel="typing"] [data-mobile-shortcut="ctrl"]');
  assert.equal(await evaluate('document.querySelector("[data-mobile-panel=typing] [data-mobile-shortcut=ctrl]").getAttribute("aria-pressed")'),'true');
  await tap('[data-mobile-action="toggle-system-keyboard"]');
  assert.equal(await evaluate('document.querySelector("#mobileShortcuts").dataset.expanded'),'false');
  assert.equal(await evaluate('qa.keyboard.encodeStickyInput("c","ime")'),'\x03','expanded-keyboard Ctrl survives switching to the system keyboard');
  await tap('[data-mobile-action="toggle-system-keyboard"]');
  const responsiveState=()=>evaluate(`(()=>{
    const rect=selector=>document.querySelector(selector).getBoundingClientRect();
    const dock=rect('#mobileShortcuts'),toolbar=rect('.mobile-keyboard-toolbar'),content=rect('#mobileExpandedKeyboard');
    return {width:innerWidth,height:innerHeight,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),dock:{left:dock.left,right:dock.right,top:dock.top,bottom:dock.bottom},toolbar:{left:toolbar.left,right:toolbar.right,width:toolbar.width},content:{left:content.left,right:content.right,width:content.width}};
  })()`);
  const assertResponsive=async(label,sidebarWidth=0)=>{
    const state=await responsiveState();
    const center=(sidebarWidth+state.width)/2;
    assert.equal(Math.abs(state.dock.left-sidebarWidth)<=1&&Math.abs(state.dock.right-state.width)<=1,true,`${label}: bottom dock fills the available width beside the sidebar: ${JSON.stringify(state)}`);
    assert.equal(state.toolbar.width<=Math.min(state.width-sidebarWidth,760)+1&&state.content.width<=Math.min(state.width-sidebarWidth,760)+1,true,`${label}: keyboard content is at most 760px: ${JSON.stringify(state)}`);
    assert.equal(Math.abs((state.toolbar.left+state.toolbar.right)/2-center)<=1&&Math.abs((state.content.left+state.content.right)/2-center)<=1,true,`${label}: keyboard content is centered: ${JSON.stringify(state)}`);
    assert.equal(state.scrollWidth<=state.width,true,`${label}: page has no horizontal overflow`);
    assert.equal(state.dock.top>=-1&&state.dock.bottom<=state.height+1,true,`${label}: bottom dock remains inside the viewport`);
    return state;
  };
  const hitState=()=>evaluate(`(()=>{
    const hit=selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect(),target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {reachable:r.width>0&&r.height>0&&(target===node||node.contains(target)),rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},obstruction:target?.closest('button')?.id||target?.className?.baseVal||target?.className||target?.tagName};};
    return {tabA:hit('#qa-responsive-tab-a'),tabB:hit('#qa-responsive-tab-b'),settings:hit('#settingsButton'),toolsHidden:getComputedStyle(document.querySelector('#pluginsButton')).display==='none',tools:hit('#pluginsButton'),quickUp:hit('.mobile-keyboard-quick-keys [data-mobile-shortcut=up]'),firstTypingKey:hit('[data-mobile-panel=typing] [data-mobile-virtual-row="1"] .mobile-virtual-key'),typingEnter:hit('[data-mobile-panel=typing] [data-mobile-shortcut=enter]'),menuTools:hit('#openPluginsItem')};
  })()`);
  const tabMarkup='<div class="tab named active"><div class="tab-main" id="qa-responsive-tab-a" role="tab" tabindex="0" aria-selected="true" aria-label="Tab A"><span class="tab-status"></span><span class="tab-title">A</span></div></div><div class="tab named"><div class="tab-main" id="qa-responsive-tab-b" role="tab" tabindex="0" aria-selected="false" aria-label="Tab B"><span class="tab-status"></span><span class="tab-title">B</span></div></div>';
  await evaluate(`document.querySelector('#tabList').innerHTML=${JSON.stringify(tabMarkup)}`);
  for(const [width,height] of [[768,1024],[1024,768],[667,375],[390,844],[320,568]]){
    const label=`${width}x${height}`;
    await browser.command(['set','viewport',String(width),String(height)]);
    await evaluate('qa.keyboard.activatePage("typing");qa.keyboard.setExpanded(true);document.querySelector("[data-mobile-panel=typing]").scrollTop=0');
    await assertResponsive(label);
    if(width===320&&height===568){
      const enter=await evaluate(`(()=>{const panel=document.querySelector('[data-mobile-panel=typing]'),key=panel.querySelector('[data-mobile-shortcut=enter]'),p=panel.getBoundingClientRect(),r=key.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {scrollTop:panel.scrollTop,panel:{top:p.top,bottom:p.bottom},key:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},reachable:hit===key||key.contains(hit)}})()`);
      assert.equal(enter.scrollTop===0&&enter.key.top>=enter.panel.top-1&&enter.key.bottom<=enter.panel.bottom+1&&enter.reachable,true,`${label}: Typing Enter is visible and tappable before scrolling: ${JSON.stringify(enter)}`);
    }
    if(width===667&&height===375){
      const visibleTerminal=await evaluate('(()=>{const r=document.querySelector("#emptyState").getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}})()');
      assert.equal(visibleTerminal.height>=99,true,`${label}: at least about 100px of terminal remains above the expanded dock: ${JSON.stringify(visibleTerminal)}`);
      await evaluate('qa.keyboard.activatePage("function");document.querySelector("[data-mobile-panel=function]").scrollTop=0');
      const beforeFunction=await evaluate('qa.bytes.length');
      const functionScroll=await evaluate('(()=>{const panel=document.querySelector("[data-mobile-panel=function]");panel.scrollTop=panel.scrollHeight;const key=panel.querySelector("[data-mobile-shortcut=enter]"),p=panel.getBoundingClientRect(),r=key.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {scrollTop:panel.scrollTop,panel:{top:p.top,bottom:p.bottom},key:{top:r.top,bottom:r.bottom},reachable:hit===key||key.contains(hit)}})()');
      assert.equal(functionScroll.scrollTop>0&&functionScroll.key.top>=functionScroll.panel.top-1&&functionScroll.key.bottom<=functionScroll.panel.bottom+1&&functionScroll.reachable,true,`${label}: function keyboard last row scrolls into a tappable area: ${JSON.stringify(functionScroll)}`);
      await tap('[data-mobile-panel="function"] [data-mobile-shortcut="enter"]');
      assert.equal(await evaluate('qa.bytes.length'),beforeFunction+1,`${label}: scrolled function Enter activates once`);
      assert.equal(await evaluate('qa.bytes.at(-1)'),'\r');
      await evaluate('qa.keyboard.activatePage("typing")');
    }
    await evaluate('document.querySelector("#webshell").dataset.tabLayout="vertical"');
    const unnamedDock=await assertResponsive(`${label} vertical tabs`,width<=760?0:48);
    if(width<=760){
      const unnamedSidebar=await evaluate('(()=>{const r=document.querySelector(".topbar").getBoundingClientRect();return {right:r.right,bottom:r.bottom}})()');
      assert.equal(Math.abs(unnamedSidebar.right-48)<=1&&unnamedSidebar.bottom<=unnamedDock.dock.top+1,true,`${label}: compact vertical sidebar stops before the full-width dock: ${JSON.stringify({sidebar:unnamedSidebar,dock:unnamedDock.dock})}`);
    }
    await evaluate('document.querySelector("#webshell").classList.add("has-named-tabs")');
    const phoneNamedSidebar=width<=760;
    const namedDock=await assertResponsive(`${label} named vertical tabs`,phoneNamedSidebar?0:156);
    const vertical=await hitState();
    const sidebarLayout=phoneNamedSidebar?await evaluate(`(()=>{const selectors=['.topbar','.tabs-shell','#tabList','#newTabShell','#newTabButton','.topbar-actions','#instanceButton','#settingsButton'];return Object.fromEntries(selectors.map(selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect(),style=getComputedStyle(node);return [selector,{rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},flex:style.flex,flexBasis:style.flexBasis,flexGrow:style.flexGrow,flexShrink:style.flexShrink,overflow:style.overflow,minHeight:style.minHeight,position:style.position}] }))})()`):undefined;
    assert.equal(vertical.tabA.reachable&&vertical.tabB.reachable&&vertical.quickUp.reachable,true,`${label}: both named tabs and first quick arrow must be directly tappable: ${JSON.stringify({vertical,sidebarLayout})}`);
    assert.equal(vertical.settings.reachable&& (vertical.toolsHidden||vertical.tools.reachable),true,`${label}: vertical settings and tools controls must remain reachable above the dock: ${JSON.stringify(vertical)}`);
    if(phoneNamedSidebar){
      const sidebar=await evaluate('(()=>{const bar=document.querySelector(".topbar").getBoundingClientRect(),titles=[...document.querySelectorAll("#tabList .tab-title")].map(node=>({text:node.textContent,width:node.getBoundingClientRect().width,opacity:getComputedStyle(node).opacity}));return {left:bar.left,right:bar.right,bottom:bar.bottom,titles}})()');
      assert.equal(Math.abs(sidebar.right-72)<=1&&sidebar.bottom<=namedDock.dock.top+1,true,`${label}: 72px named sidebar stops before the full-width keyboard: ${JSON.stringify({sidebar,dock:namedDock.dock})}`);
      assert.deepEqual(sidebar.titles.map(title=>title.text),['A','B'],`${label}: named tabs retain distinct titles`);
      assert.equal(sidebar.titles.every(title=>title.width>0&&Number(title.opacity)>0),true,`${label}: A and B titles remain visibly distinct: ${JSON.stringify(sidebar.titles)}`);
      if(width<=600)assert.equal(vertical.firstTypingKey.reachable&&vertical.typingEnter.reachable,true,`${label}: first Typing key and Enter are tappable without scrolling: ${JSON.stringify(vertical)}`);
    }
    if(width<=390)await screenshot(`dock-named-vertical-${width}`);
    await evaluate('qa.keyboard.setExpanded(false);document.querySelector("#settingsMenu").hidden=false');
    await browser.command(['wait','220']);
    const menu=await hitState();
    assert.equal(menu.menuTools.reachable,true,`${label}: settings menu Tools action must not be covered by the compact dock: ${JSON.stringify(menu)}`);
    const menuPosition=await evaluate('(()=>{const node=document.querySelector("#settingsMenu"),menu=node.getBoundingClientRect(),sidebar=document.querySelector(".topbar").getBoundingClientRect(),style=getComputedStyle(node),shell=node.parentElement.getBoundingClientRect();return {left:menu.left,right:menu.right,top:menu.top,bottom:menu.bottom,sidebarRight:sidebar.right,width:innerWidth,height:innerHeight,computed:{position:style.position,left:style.left,right:style.right,width:style.width,transform:style.transform},offsetParent:node.offsetParent?.className??null,shell:{left:shell.left,right:shell.right}}})()');
    assert.equal((width>600||menuPosition.left>=menuPosition.sidebarRight)&&menuPosition.left>=-1&&menuPosition.right<=menuPosition.width+1&&menuPosition.top>=-1&&menuPosition.bottom<=menuPosition.height+1,true,`${label}: settings and Tools menu stays inside the viewport and outside narrow sidebar: ${JSON.stringify(menuPosition)}`);
    await evaluate('document.querySelector("#settingsMenu").hidden=true');
    for(const overlay of ['settings-open','plugins-open']){
      await evaluate(`document.querySelector('#webshell').classList.add(${JSON.stringify(overlay)})`);
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#mobileShortcuts")).display'),'none',`${label}: ${overlay} hides the keyboard dock`);
      await evaluate(`document.querySelector('#webshell').classList.remove(${JSON.stringify(overlay)})`);
    }
    await composer();
    const draft=await evaluate(`(()=>{const dialog=document.querySelector('.mobile-composer'),actions=document.querySelector('.mobile-composer-actions'),button=actions.querySelector('button'),r=dialog.getBoundingClientRect(),a=actions.getBoundingClientRect(),b=button.getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return {dockHidden:getComputedStyle(document.querySelector('#mobileShortcuts')).display==='none',left:r.left,right:r.right,top:r.top,bottom:r.bottom,actionsTop:a.top,actionsBottom:a.bottom,actionReachable:hit===button||button.contains(hit),scrollWidth:document.documentElement.scrollWidth,width:innerWidth,height:innerHeight}})()`);
    assert.equal(draft.dockHidden&&draft.left>=-1&&draft.right<=draft.width+1&&draft.top>=-1&&draft.bottom<=draft.height+1,true,`${label}: draft composer fits while the dock is hidden`);
    assert.equal(draft.actionsTop>=0&&draft.actionsBottom<=draft.height+1&&draft.actionReachable,true,`${label}: draft actions are not covered`);
    assert.equal(draft.scrollWidth<=draft.width,true,`${label}: draft composer causes no horizontal overflow`);
    await closeComposer();
    await evaluate('document.querySelector("#webshell").removeAttribute("data-tab-layout");document.querySelector("#webshell").classList.remove("has-named-tabs")');
  }
  await browser.command(['set','viewport','800','600']);
  await evaluate(`(()=>{const style=document.documentElement.style;style.setProperty('--app-viewport-offset-left','400px');style.setProperty('--app-viewport-width','400px');qa.experience.openComposer()})()`);
  await wait('document.querySelector(".mobile-composer[open]")');
  const shiftedDraft=await evaluate(`(()=>{const r=document.querySelector('.mobile-composer').getBoundingClientRect(),a=document.querySelector('.mobile-composer-actions').getBoundingClientRect();return {left:r.left,right:r.right,center:(r.left+r.right)/2,actionsBottom:a.bottom,scrollWidth:document.documentElement.scrollWidth}})()`);
  assert.equal(shiftedDraft.left>=399&&shiftedDraft.right<=801&&Math.abs(shiftedDraft.center-600)<=1,true,'draft composer stays centered inside a visual viewport offset to the right');
  assert.equal(shiftedDraft.actionsBottom<=600&&shiftedDraft.scrollWidth<=800,true,'offset visual viewport keeps draft actions reachable without horizontal overflow');
  await closeComposer();
  await evaluate('document.documentElement.style.removeProperty("--app-viewport-offset-left");document.documentElement.style.removeProperty("--app-viewport-width")');
  await browser.command(['set','viewport','390','844']);
  await evaluate('document.documentElement.style.setProperty("--lzc-safe-area-inset-bottom","0px");document.querySelector("#emptyState").hidden=true');
  await tap('[data-mobile-action="toggle-expanded-keyboard"]');
  await tap('.mobile-keyboard-mode-tabs [data-mobile-mode-tab="shortcuts"]');
  await tap('[data-mobile-page="nav"]');
  const navigation = () => evaluate('(()=>{const panel=document.querySelector("[data-mobile-panel=nav]"),controls=document.querySelector(".mobile-keyboard-controls"),tabs=document.querySelector(".mobile-keyboard-pages");const r=panel.getBoundingClientRect(),c=controls.getBoundingClientRect(),t=tabs.getBoundingClientRect();return {visible:!panel.hidden,inFlow:getComputedStyle(panel).position==="static",below:r.top>=t.bottom,inside:r.top>=c.top&&r.bottom<=c.bottom,rows:c.height}})()');
  const nav=await navigation();assert.equal(nav.visible&&nav.inFlow&&nav.below&&nav.inside&&nav.rows>=44,true,'navigation stays within the expanded shortcuts area');
  for(const direction of ['left','down','up','right'])assert.equal(await evaluate(`(()=>{const r=document.querySelector('[data-mobile-panel=nav] [data-mobile-shortcut=${direction}]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`),true,'arrows must be visible without scrolling');
  const arrows=await evaluate('[...document.querySelectorAll("[data-mobile-shortcut=left]")].filter(e=>e.getClientRects().length).length');assert(arrows>=1);
  await tap('[data-mobile-panel="nav"] [data-mobile-shortcut="left"]');assert.equal(await evaluate('qa.bytes.at(-1)'),'\x1b[D');
  await screenshot('navigation');
  const beforePan = await evaluate('qa.bytes.length');
  const pan = await evaluate('qa.point("[data-mobile-panel=nav] [data-mobile-shortcut=left]")');
  await browser.dispatchTouch([touch('touchStart',pan,4,30),touch('touchMove',{x:pan.x-80,y:pan.y},4,60),touch('touchMove',{x:pan.x-160,y:pan.y},4,60),touch('touchEnd',pan,4)]);
  assert.equal(await evaluate('qa.bytes.length'),beforePan,'swiping navigation must not send the key under the finger');

  const p=await evaluate('qa.point("[data-mobile-panel=nav] [data-mobile-shortcut=down]")');
  await evaluate('qa.bytes=[]');await browser.dispatchTouch([touch('touchStart',p,2,550),touch('touchCancel',p,2)]);
  const repeated=await evaluate('qa.bytes.length');assert(repeated>=2);await browser.command(['wait','200']);assert.equal(await evaluate('qa.bytes.length'),repeated);
  await tap('[data-mobile-page="nav"]');assert.equal((await navigation()).visible,true,'reselecting Navigation must not dismiss it');
  await click('#qa-terminal-input');assert.equal((await navigation()).visible,true,'outside interaction must not reset the selected category');
  await browser.press('Escape');assert.equal((await navigation()).visible,true,'Escape is a terminal key, not a navigation dismissal');
  await tap('[data-mobile-page="main"]');assert.equal((await navigation()).visible,false);
  await evaluate('qa.bytes=[]');await composer();
  assert.equal(await evaluate('document.activeElement.id'),'mobile-composer-input');
  await browser.command(['fill','#mobile-composer-input','第一行\n  second line']);
  await browser.press('Enter');assert.equal(await evaluate('qa.bytes.length'),0,'editing newlines must not send input');
  await screenshot('composer');
  await click('.mobile-composer-actions button:first-child');await wait('!document.querySelector(".mobile-composer").open');
  assert.equal(await evaluate('qa.bytes.at(-1)'),'\x1b[200~第一行\n  second line\n\x1b[201~');
  await composer();await browser.command(['fill','#mobile-composer-input','草稿 A']);await closeComposer();
  await evaluate('qa.switch("b")');await composer();assert.equal(await evaluate('document.querySelector("#mobile-composer-input").value'),'');
  await browser.command(['fill','#mobile-composer-input','草稿 B']);await closeComposer();await evaluate('qa.switch("a")');await composer();assert.equal(await evaluate('document.querySelector("#mobile-composer-input").value'),'草稿 A');
  await evaluate('qa.fail=true');await click('.mobile-composer-actions button:first-child');await wait('document.querySelector(".mobile-composer-status").textContent.includes("失败")');assert.equal(await evaluate('document.querySelector("#mobile-composer-input").value'),'草稿 A');
  await evaluate('qa.fail=false');await click('.mobile-composer-actions button:nth-child(2)');await wait('!document.querySelector(".mobile-composer").open');assert.equal(await evaluate('qa.bytes.at(-1)'),'\x1b[200~草稿 A\x1b[201~\r');
  await composer();await browser.command(['fill','#mobile-composer-input','未提交']);await evaluate('qa.switch("b")');await wait('!document.querySelector(".mobile-composer").open');
  await evaluate('qa.switch("h","herdr");qa.defer=true');await composer();await browser.command(['fill','#mobile-composer-input','remote\nprompt']);await click('.mobile-composer-actions button:first-child');await wait('document.querySelector(".mobile-composer-status").textContent.includes("无法确认")');assert.equal(await evaluate('qa.remote.length'),0);await click('.mobile-composer-actions button:nth-child(2)');await wait('typeof qa.finish==="function"');
  await closeComposer();await composer();assert.equal(await evaluate('document.querySelector(".mobile-composer-actions button").disabled'),true,'reopening cannot send duplicate pending text');
  const count=await evaluate('qa.remote.length');await evaluate('qa.finish();qa.defer=false');await wait('!document.querySelector(".mobile-composer-actions button").disabled');assert.equal(await evaluate('qa.remote.length'),count);assert.equal(await evaluate('document.querySelector("#mobile-composer-input").value'),'');await closeComposer();
  await evaluate('qa.switch("a");qa.bytes=[]');await palette();assert.notEqual(await evaluate('document.activeElement.id'),'mobile-command-palette-search');
  await click('#mobile-command-palette-tab-all');
  await evaluate('qa.focusedChoice=document.querySelector(".mobile-command-palette-choice");qa.focusedChoice.focus();qa.experience.sync()');
  assert.equal(await evaluate('document.activeElement===qa.focusedChoice&&qa.focusedChoice.isConnected'),true,'unchanged refresh retains the exact focused result node');
  await browser.command(['fill','#mobile-command-palette-search','目录']);assert.equal(await evaluate('document.querySelectorAll(".mobile-command-palette-choice").length'),1);await screenshot('palette');
  await click('.mobile-command-palette-choice');await wait('!document.querySelector(".mobile-command-palette").open');assert.equal(await evaluate('qa.bytes.at(-1)'),'\x1b[200~ls -la\x1b[201~');
  await palette();assert.match(await evaluate('document.querySelector(".mobile-command-palette-choice strong").textContent'),/查看目录/);
  await click('#mobile-command-palette-tab-all');await browser.command(['fill','#mobile-command-palette-search','运行测试']);assert.match(await evaluate('document.querySelector(".mobile-command-palette-mode").textContent'),/自动回车/);await click('.mobile-command-palette-choice');await wait('!document.querySelector(".mobile-command-palette").open');assert.equal(await evaluate('qa.bytes.at(-1)'),'\x1b[200~npm test\x1b[201~\r');
  await palette();await click('#mobile-command-palette-tab-all');await browser.command(['fill','#mobile-command-palette-search','目录']);await evaluate('qa.phrases[0].text="changed remotely"');const before=await evaluate('qa.bytes.length');await click('.mobile-command-palette-choice');assert.equal(await evaluate('qa.bytes.length'),before);assert.match(await evaluate('document.querySelector(".mobile-command-palette-status").textContent'),/变化/);
  await click('#mobile-command-palette-tab-keys');await browser.command(['fill','#mobile-command-palette-search','F1']);assert(await evaluate('document.querySelectorAll(".mobile-command-palette-choice").length')>0);await click('.mobile-command-palette-close');
  await tap('[data-mobile-page="ops"]');await tap('[data-mobile-action="workspace-overview"]');await wait('!document.querySelector("#mobileWorkspaceOverview").hidden');await screenshot('overview');
  assert.match(await evaluate('document.querySelector(".mobile-workspace-overview-list").textContent'),/1 个窗格/);await click('[data-mobile-overview-pane="b"]');assert.equal(await evaluate('qa.selected'),'b');await browser.command(['wait','180']);
  await browser.command(['set','viewport','320','560']);await composer();await browser.command(['fill','#mobile-composer-input','窄屏输入\n第二行']);await screenshot('composer-narrow');
  await browser.command(['set','viewport','390','360']);await browser.command(['wait','100']);
  assert.equal(await evaluate('(()=>{const r=document.querySelector(".mobile-composer-actions").getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0})()'),true,'composer actions remain visible above a short keyboard viewport');
  await screenshot('composer-keyboard');await browser.command(['set','viewport','320','560']);assert.equal(await evaluate('document.querySelector(".mobile-composer").scrollWidth<=document.querySelector(".mobile-composer").clientWidth'),true);await closeComposer();
  await evaluate('qa.preset="custom";qa.layout.pages[0].keys.push({id:"custom-left",kind:"shortcut",value:"left",label:"My Left",ariaLabel:"My Left",width:"md",hidden:false,repeat:true,autoEnter:false,custom:true});qa.refresh()');assert.equal(await evaluate('document.querySelector("[data-mobile-panel=main] [data-mobile-shortcut=left]").textContent'),'My Left');await tap('[data-mobile-page="nav"]');assert.equal(await evaluate('document.querySelector("[data-mobile-panel=nav]").hidden'),false);
  await evaluate(`(()=>{
    for(let i=0;i<26;i++){
      qa.switch('retired-'+i);qa.experience.openComposer();
      const input=document.querySelector('#mobile-composer-input');input.value='old draft '+i;input.dispatchEvent(new Event('input',{bubbles:true}));
      qa.experience.close();qa.panes.delete(qa.pane.id);qa.experience.sync();
    }
    qa.switch('after-retirement');qa.experience.openComposer();
    const input=document.querySelector('#mobile-composer-input');input.value='still editable';input.dispatchEvent(new Event('input',{bubbles:true}));
    qa.experience.close();qa.experience.openComposer();
  })()`);
  assert.equal(await evaluate('document.querySelector("#mobile-composer-input").value'),'still editable','retired targets must not permanently fill draft slots');
  const errors=JSON.parse(await browser.command(['errors','--json']));assert.deepEqual(errors.data.errors,[]);
  return {status:'passed',name:'mobile-workflow',artifacts};
 }catch(error){
  console.error(await evaluate('({actions:qa.actions,point:qa.lastPoint,focus:document.activeElement?.outerHTML.slice(0,120),dialogs:[...document.querySelectorAll("dialog")].map(d=>({open:d.open,style:getComputedStyle(d).display,cls:d.className})),root:document.querySelector("#mobileShortcuts").getBoundingClientRect().toJSON()})'));
  await browser.screenshot(path.join(artifacts,'failure.png'));
  throw error;
 }finally{await browser.close().catch(()=>{});await server.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){runMobileWorkflowScenario().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})}
