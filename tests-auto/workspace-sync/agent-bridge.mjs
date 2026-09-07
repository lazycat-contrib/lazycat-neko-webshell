import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { WebSocketServer } from 'ws';

const FRAME_LIMIT = 32 * 1024 * 1024;

export async function startAgentBridge({ root, directory, runtimeDirectory, selector, binary }) {
  const source = await readFile(join(root, 'src/frontend/src/gen/lazycat/webshell/v1/capability_pb.ts'), 'utf8');
  const moduleFile = join(directory, 'capability.mjs');
  await writeFile(moduleFile, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  const schema = await import(pathToFileURL(moduleFile));
  const { AgentRequestSchema, AgentResponseSchema, AgentFrameSchema,
    AgentRequestType: R, AgentWorkspaceActionType: A, AgentFrameType: F, AgentControlType: C } = schema;
  const socketPath = join(runtimeDirectory, 'agent.sock');
  const env = Object.fromEntries(['HOME','USER','LOGNAME','LANG','PATH'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
  Object.assign(env, { SHELL:'/bin/sh', TERM:'xterm-256color', NEKO_WEBSHELL_TTY_INIT:'generic' });
  const child = spawn(binary, ['daemon','--socket',socketPath,'--selector',selector], { cwd: runtimeDirectory, env, stdio:['ignore','ignore','pipe'] });
  let stderr = '';
  child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4096); });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const connections = new Set();
  let heldResponse;
  let holdNextCreate = false;
  let holding = false;
  const errors = [];

  function send(stream, descriptor, message) {
    const body = toBinary(descriptor, create(descriptor, message));
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    stream.write(Buffer.concat([header, body]));
  }
  function readFrames(stream, descriptor, consume) {
    let buffer = Buffer.alloc(0);
    stream.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size > FRAME_LIMIT) { stream.destroy(new Error('oversized agent frame')); return; }
        if (buffer.length < size + 4) break;
        const payload = buffer.subarray(4, size + 4); buffer = buffer.subarray(size + 4);
        try { consume(fromBinary(descriptor, payload)); }
        catch (error) { stream.destroy(error); return; }
      }
    });
  }
  function request(type, action) {
    return new Promise((resolve, reject) => {
      const stream = createConnection(socketPath);
      connections.add(stream);
      let answered = false;
      const timer = setTimeout(() => stream.destroy(new Error('agent request timeout')), 8000);
      stream.on('close', () => { clearTimeout(timer); connections.delete(stream); if (!answered) reject(new Error("agent closed without a response")); });
      stream.on('error', reject);
      stream.on('connect', () => send(stream, AgentRequestSchema, { type, selector, cols:100,rows:30,outputLimit:1024,action }));
      readFrames(stream, AgentResponseSchema, response => {
        answered = true; stream.end();
        if (!response.ok) reject(new Error(response.error || 'agent request failed'));
        else resolve(response.state);
      });
    });
  }
  function layout(value) {
    if (!value) return undefined;
    if (value.type === 1) return { type:'pane',paneId:value.paneId };
    return { type:'split',axis:value.axis === 1?'rows':'columns',children:value.children.map(layout) };
  }
  function workspace(state) {
    return { selector, active_tab_id:state.activeTabId, tabs:state.tabs.map(tab => ({
      id:tab.id,label:tab.label,custom_label:tab.customLabel,active_pane_id:tab.activePaneId,layout:layout(tab.layout),
      panes:tab.panes.map(pane=>({id:pane.id,session_id:pane.sessionId,status:pane.status,session_backend:'webshell',
        terminal_reply_authority:pane.terminalReplyAuthority,cols:pane.cols,rows:pane.rows})),
    })) };
  }
  async function snapshot() { return workspace(await request(R.SNAPSHOT)); }
  async function action(name, extra={}) { return workspace(await request(R.ACTION, { action:A[name.toUpperCase()],...extra })); }

  async function middleware(req,res,next) {
    if (!req.url?.startsWith('/bridge/')) { next(); return; }
    try {
      if (req.url === '/bridge/config') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({selector})); return; }
      if (req.url === '/bridge/hold') { holdNextCreate=true; res.end('ok'); return; }
      if (req.url === '/bridge/release') { heldResponse?.(); heldResponse=undefined; res.end('ok'); return; }
      if (req.url === '/bridge/status') { res.setHeader('content-type','application/json');res.end(JSON.stringify({holding,errors}));return; }
      if (req.url.startsWith('/bridge/workspace')) {
        let state;
        if (req.method === 'PUT') {
          const chunks=[];let bytes=0;
          for await (const b of req) { bytes+=b.length;if(bytes>8192)throw new Error('request too large');chunks.push(b); }
          const body=JSON.parse(Buffer.concat(chunks));
          state=await action(body.action,{tabId:body.tab_id,paneId:body.pane_id,label:body.label,direction:body.direction});
          if (body.action==='create_tab' && holdNextCreate) {
            holdNextCreate=false;holding=true;
            await new Promise(resolve=>{ const timer=setTimeout(resolve,8000);heldResponse=()=>{clearTimeout(timer);resolve();}; });
            holding=false;
          }
        } else state=await snapshot();
        res.setHeader('content-type','application/json');res.end(JSON.stringify(state));return;
      }
      res.statusCode=404;res.end();
    } catch(error) { res.statusCode=503;res.end(error.message); }
  }
  const wss = new WebSocketServer({ noServer:true,maxPayload:64*1024 });
  function upgrade(req,socket,head) {
    if (!req.url.startsWith('/bridge/pty')) return;
    wss.handleUpgrade(req,socket,head,ws=> {
      const pane = new URL(req.url,'http://localhost').searchParams.get('pane');
      const stream=createConnection(socketPath);connections.add(stream);stream.setTimeout(120000);
      stream.on('connect',()=>send(stream,AgentRequestSchema,{type:R.ATTACH,selector,paneId:pane,cols:100,rows:30,outputLimit:1024,replayAfter:0n}));
      readFrames(stream,AgentFrameSchema,frame=>{
        if(ws.readyState!==1)return;
        if(frame.type===F.BINARY)ws.send(frame.payload);
        else if(frame.control?.type===C.REPLAY_COMPLETE)ws.send(JSON.stringify({type:'replay-complete'}));
        else if(frame.control?.type===C.PROCESS_EXIT)ws.send(JSON.stringify({type:'process-exit'}));
        else if(frame.control?.type===C.REPLAY_START)ws.send(JSON.stringify({type:'replay-start'}));
      });
      ws.on('message',(data)=>send(stream,AgentFrameSchema,{type:F.INPUT,payload:new Uint8Array(data)}));
      ws.on('close',()=>{if(!stream.destroyed)send(stream,AgentFrameSchema,{type:F.DETACH});stream.destroy();});
      ws.on('error',()=>stream.destroy());
      stream.on('timeout',()=>stream.destroy(new Error('attach idle timeout')));
      stream.on('error',error=>{errors.push(error.message);ws.close();});
      stream.on('close',()=>{connections.delete(stream);ws.close();});
    });
  }
  async function close() {
    heldResponse?.();
    try { const state=await snapshot();for(const tab of state.tabs)await action('close_tab',{tabId:tab.id}); } catch {}
    for(const client of wss.clients)client.terminate();
    for(const stream of connections)stream.destroy();
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WebSocket cleanup timeout')),3000);wss.close(()=>{clearTimeout(timer);resolve();});});
    child.kill('SIGTERM');
    await new Promise((resolve,reject)=>{if(child.exitCode!==null)return resolve();const killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);const deadline=setTimeout(()=>reject(new Error('agent cleanup timeout')),5000);child.once('exit',()=>{clearTimeout(killTimer);clearTimeout(deadline);resolve();});});
    const hash=createHash('sha256').update(selector).digest('hex').slice(0,24);
    await rm(`/tmp/lazycat-neko-webshell-agent-${hash}.workspace`,{force:true});
  }
  try {
    const deadline=Date.now()+8000;
    while(true){if(spawnError)throw spawnError;try{await request(R.PING);break;}catch(error){if(Date.now()>deadline||child.exitCode!==null)throw new Error(`agent startup failed: ${stderr||error.message}`);await new Promise(r=>setTimeout(r,30));}}
    await request(R.STATE);await action('create_tab');
    return { middleware,upgrade,snapshot,action,close,selector };
  } catch(error) {await close();throw error;}
}
