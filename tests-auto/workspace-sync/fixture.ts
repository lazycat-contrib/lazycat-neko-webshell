import { createPaneTerminal } from '/project/src/frontend/src/terminal-options.ts';
import { createWorkspaceRequestController, workspaceActionChangesFocus } from '/project/src/frontend/src/workspace-request-controller.ts';
import { reconcileWorkspace } from '/project/src/frontend/src/workspace-reconcile.ts';
import { createWorkspacePaneLifetime } from '/project/src/frontend/src/workspace-pane-lifetime.ts';
import { createWorkspacePassiveSync } from '/project/src/frontend/src/workspace-passive-sync.ts';
import { workspaceEntityId } from '/project/src/frontend/src/workspace-identity.ts';

const {selector}=await (await fetch('/bridge/config')).json();
const requests=createWorkspaceRequestController();
const tabList=document.querySelector('#tabs');const workspace=document.querySelector('#workspace');
let tabs=[];let activeTabId;let nextRuntimeId=0;let connects=0;let disposedCount=0;
const errors=[];const pendingMounts=new Set();

function makeTab(selector,id){const mount=document.createElement('section');mount.className='tab-mount';return {selector,id:workspaceEntityId(selector,'tab',id),workspaceTabId:id,mount,panes:[],label:id};}
function makePane(tab,id){const mount=document.createElement('div');mount.className='terminal-mount';return {id:workspaceEntityId(selector,'pane',id),workspacePaneId:id,tabId:tab.id,selector,mount,pendingInput:[],runtimeId:++nextRuntimeId};}
function disposePane(pane){disposedCount++;pane.socket?.close();pane.term?.dispose();pane.mount.remove();}
const lifetime=createWorkspacePaneLifetime({makePane,disposePane,prepareReplay(pane){pane.socket?.close();pane.term?.dispose();pane.term=undefined;},initialCols:100,initialRows:30});
function renderLayout(tab){tab.mount.replaceChildren(...tab.panes.map(p=>p.mount));}
function render(){tabList.replaceChildren();for(const tab of tabs){const button=document.createElement('button');button.textContent=tab.customTitle||tab.label;button.dataset.tab=tab.workspaceTabId;button.onclick=()=>focusTab(tab);tabList.append(button);tab.mount.hidden=tab.id!==activeTabId;}}
async function mountPane(pane){
  let callbacks;let connected=false;
  const transport={connect(options){callbacks=options.callbacks;connected=true;callbacks.onConnect?.();},disconnect(){connected=false;},isConnected(){return connected;},destroy(){pane.socket?.close();},resize(){return true;},sendInput(data){if(pane.socket?.readyState!==1||pane.replaying)return false;pane.socket.send(data);return true;}};
  const term=createPaneTerminal({cols:100,rows:30,fonts:[{url:'/font.ttf',name:'Test mono'}],fontSize:14,fontLigatures:false,fontHinting:true,fontHintTarget:'normal',scrollbackLimit:1000,touchSelectionMode:'long-press',transport,forwardTerminalReplies:false,beforeInput:({text})=>text,contextMenuItems:()=>[],searchClearButtonText:'Clear',searchPlaceholder:'Search',onDomReady(){},onGridSize(){}});
  pane.term=term;term.open(pane.mount);await term.restty.setFonts([{url:'/font.ttf',name:'Test mono'}]);
  const deadline=performance.now()+10000;while(term.restty.activePane().getBackend()==='none'){if(performance.now()>deadline)throw new Error('renderer unavailable');await new Promise(r=>setTimeout(r,20));}
  const socket=new WebSocket(`${location.origin.replace('http','ws')}/bridge/pty?pane=${encodeURIComponent(pane.workspacePaneId)}`);socket.binaryType='arraybuffer';pane.socket=socket;pane.replaying=true;connects++;
  socket.onopen=()=>term.restty.connectPty('fixture');
  const decoder=new TextDecoder();
  socket.onmessage=e=>{if(typeof e.data==='string'){const message=JSON.parse(e.data);if(message.type==='replay-complete')pane.replaying=false;}else{const text=decoder.decode(e.data,{stream:true});pane.output=(pane.output||'')+text;if(pane.output.length>200000)pane.output=pane.output.slice(-100000);callbacks?.onData?.(text);}};
  socket.onerror=()=>errors.push('terminal websocket error');
}
function apply(state,{passive=false,preserveFocus=true}={}){
  const result=reconcileWorkspace({workspace:state,selector,tabs,activeTabId,preserveFocus,passive,makeTab,restorePane:lifetime.restore,disposePane:lifetime.dispose,markPassive:lifetime.markPassive,attachTab:tab=>workspace.append(tab.mount),renderLayout});
  tabs=result.tabs;
  if(!tabs.some(t=>t.id===activeTabId)||!preserveFocus)activeTabId=workspaceEntityId(selector,'tab',state.active_tab_id||state.tabs[0]?.id);
  render();
  for(const pane of result.toMount){const work=mountPane(pane).catch(e=>errors.push(e.message)).finally(()=>pendingMounts.delete(work));pendingMounts.add(work);}
}
async function action(kind,extra={}){return requests.run(selector,kind.startsWith('activate_')?'focus':'mutation',async request=>{
  const response=await fetch('/bridge/workspace',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({action:kind,...extra})});if(!response.ok)throw new Error(await response.text());const state=await response.json();
  if(request.isCurrent()&&!kind.startsWith('activate_'))apply(state,{preserveFocus:!workspaceActionChangesFocus(kind)||!request.focusUnchanged()});
});}
function focusTab(tab){activeTabId=tab.id;render();void action('activate_tab',{tab_id:tab.workspaceTabId}).catch(e=>errors.push(e.message));}
async function refresh(signal){const request=requests.read(selector,{passive:true});if(!request.isCurrent())return;try{const response=await fetch('/bridge/workspace?passive=true',{signal});if(!response.ok)throw new Error(await response.text());const state=await response.json();if(!signal.aborted&&request.isCurrent())apply(state,{passive:true});}finally{request.finish();}}
const sync=createWorkspacePassiveSync({enabled:()=>true,refresh,schedule:(fn,ms)=>setTimeout(fn,ms),cancel:(timer)=>window.clearTimeout(timer),intervalMs:1000});
document.querySelector('#new-tab').onclick=()=>void action('create_tab').catch(e=>errors.push(e.message));
document.querySelector('#refresh').onclick=()=>sync.refresh();
apply(await(await fetch('/bridge/workspace')).json());sync.refresh();
window.fixture={snapshot:()=>({tabs:tabs.map(t=>({id:t.workspaceTabId,label:t.customTitle||t.label,panes:t.panes.map(p=>({id:p.workspacePaneId,runtimeId:p.runtimeId,connected:p.socket?.readyState===1,ready:p.replaying===false,pendingInput:p.pendingInput}))})),active:tabs.find(t=>t.id===activeTabId)?.workspaceTabId,connects,disposedCount,errors}),
  seedInput:()=>{for(const tab of tabs)for(const pane of tab.panes)pane.pendingInput=['retained-input'];},
  send:(text)=>{const pane=tabs.find(t=>t.id===activeTabId)?.panes[0];if(!pane||pane.replaying)throw new Error('terminal not ready');pane.socket.send(text);},
  hasOutput:(text)=>tabs.some(t=>t.panes.some(p=>p.output?.includes(text))),
  searchOutput:(text)=>{for(const tab of tabs)for(const pane of tab.panes)pane.term?.restty.setSearchQuery(text);},
  hasRenderedOutput:()=>tabs.some(t=>t.panes.some(p=>(p.term?.restty.getSearchState().total||0)>0)),
  pause:()=>sync.pause(),resume:()=>sync.activityChanged(),
  dispose:()=>{sync.dispose();requests.dispose();for(const tab of tabs)for(const pane of tab.panes)lifetime.dispose(pane);},
};
window.addEventListener('pagehide',()=>window.fixture.dispose(),{once:true});
