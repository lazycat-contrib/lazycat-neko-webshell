import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import worker, { authorizeHost, Tunnel, Admission } from '../src/worker.mjs';
const secret=randomBytes(32).toString('base64url');
const route=createHash('sha256').update(Buffer.from(secret,'base64url')).digest('base64url');
test('routing credential proves route without exposing pairing or device keys',async()=>{
 assert.equal(await authorizeHost(`Bearer ${secret}`,route),true);
 assert.equal(await authorizeHost(`Bearer ${randomBytes(32).toString('base64url')}`,route),false);
 assert.equal(await authorizeHost(null,route),false);
 assert.equal(await authorizeHost(`Bearer ${secret}=`,route),false);
});
test('stale host close cannot kill replacement host or its peers',()=>{
 const tunnel=new Tunnel({blockConcurrencyWhile(){},storage:{}},{});
 const old={generation:1,socket:{}};const active={generation:2,socket:{}};let closed=0;
 tunnel.generation=2;tunnel.host=active;tunnel.peers.set('p',{socket:{close(){closed++}}});
 tunnel.closed('host',old);assert.equal(tunnel.host,active);assert.equal(closed,0);
 tunnel.closed('host',active);assert.equal(tunnel.host,null);assert.equal(closed,1);assert.equal(tunnel.peers.size,0);
});
test('client cannot choose authenticated peer identity',()=>{
 const messages=[];const tunnel=new Tunnel({blockConcurrencyWhile(){},storage:{}},{});
 tunnel.generation=1;tunnel.host={generation:1,sent:0,acknowledged:0,pending:new Map(),role:"host",socket:{send:s=>messages.push(JSON.parse(s))}};
 const record={role:'client',inflight:0,pending:new Map(),generation:1,peer:'actual',second:0,frames:0,hello:false,socket:{close(){}}};tunnel.peers.set('actual',record);
 tunnel.message('client',record,JSON.stringify({type:'hello',peer:'victim',mode:'pair'}));
 tunnel.message('client',record,JSON.stringify({type:'data',peer:'victim',data:'AA'}));
 assert.equal(messages.length,2);assert.equal(messages[0].peer,'actual');assert.equal(messages[1].peer,'actual');
});
test('admission limits connections before arbitrary route objects',async()=>{
 const gate=new Admission();const request=new Request('https://admission/check',{headers:{'x-source-ip':'test','x-role':'client'}});
 for(let i=0;i<60;i++)assert.equal((await gate.fetch(request)).status,204);
 assert.equal((await gate.fetch(request)).status,429);
});
test('relay limit counts UTF-8 bytes rather than UTF-16 code units',()=>{
 const tunnel=new Tunnel({blockConcurrencyWhile(){},storage:{}},{});let rejected=0;
 const socket={close(){rejected++;}};
 const record={socket,generation:1,peer:'p',frames:0,role:'client'};
 tunnel.generation=1;tunnel.peers.set('p',record);
 const text=JSON.stringify({type:'data',data:'',peer:'橘'.repeat(40000)});
 assert.ok(text.length<98304);assert.ok(Buffer.byteLength(text)>98304);
 tunnel.message('client',record,text);
 assert.equal(rejected,1);assert.equal(tunnel.peers.has('p'),false);
});
test('admission capacity recovers when its full window expires',()=>{
 const admission=new Admission();const old=Math.floor(Date.now()/60000)-2;
 for(let i=0;i<4096;i++)admission.windows.set(`client:source-${i}`,{minute:old,count:60});
 const response=admission.fetch(new Request('https://admission/check',{headers:{'x-source-ip':'new-legitimate-host','x-role':'host'}}));
 assert.equal(response.status,204);assert.equal(admission.windows.size,1);
});
test('one unauthenticated client cannot consume the shared host window',()=>{
 const messages=[];const tunnel=new Tunnel({blockConcurrencyWhile(){},storage:{}},{});
 const host={role:'host',generation:1,sent:0,acknowledged:0,pending:new Map(),socket:{send(s){messages.push(JSON.parse(s));}}};
 const bad={role:'client',inflight:0,pending:new Map(),generation:1,peer:'bad',hello:true,socket:{close(){}},frames:0};
 const good={role:'client',inflight:0,pending:new Map(),generation:1,peer:'good',hello:true,socket:{close(){}},frames:0};
 tunnel.host=host;tunnel.generation=1;tunnel.peers.set('bad',bad);tunnel.peers.set('good',good);
 for(let i=0;i<9;i++)tunnel.message('client',bad,JSON.stringify({type:'data',data:'YWJj'}));
 assert.equal(tunnel.peers.has('bad'),false);assert.equal(host.sent,8);
 tunnel.message('client',good,JSON.stringify({type:'data',data:'YWJj'}));
 assert.equal(tunnel.peers.has('good'),true);assert.equal(host.sent,9);
 tunnel.message('host',host,JSON.stringify({type:'acknowledge',peer:'host',sequence:9}));
 assert.equal(good.inflight,0);assert.equal(bad.inflight,0);
});

test('public health HTTP is unchanged and malformed probes never access business objects', async()=>{
 const env=new Proxy({}, {get(){throw Error('unexpected business object lookup');}});
 const normal=await worker.fetch(new Request('https://relay.example/healthz'),env);
 assert.equal(normal.status,200);
 assert.deepEqual(await normal.json(),{protocol:'neko.remoted.v2',version:2});
 for(const offered of ['', 'wrong.protocol']){
  const headers={upgrade:'websocket'};if(offered)headers['sec-websocket-protocol']=offered;
  const invalid=await worker.fetch(new Request('https://relay.example/healthz',{headers}),env);
  assert.equal(invalid.status,400);
 }
 assert.equal((await worker.fetch(new Request('https://relay.example/healthz?extra=1'),env)).status,404);
});
