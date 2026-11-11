// Explicit integration suite: run against `wrangler dev --port 18791`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
const origin=process.env.REMOTED_TEST_RELAY || 'http://127.0.0.1:18791';
const wsOrigin=origin.replace(/^http/,'ws');
const protocol='neko.remoted.v1';
function credentials(){const key=randomBytes(32);return {key:key.toString('base64url'),route:createHash('sha256').update(key).digest('base64url')};}
async function open(role,c,key=c.key){
 const ws=new WebSocket(`${wsOrigin}/v1/${role}/${c.route}`,protocol,{headers:role==='host'?{authorization:`Bearer ${key}`}:{}});
 const frames=[];const listeners=[];
 ws.on('message',data=>{const f=JSON.parse(data);const listener=listeners.find(x=>x.type===f.type);if(listener){listeners.splice(listeners.indexOf(listener),1);clearTimeout(listener.timer);listener.resolve(f);}else frames.push(f);});
 const closed=new Promise(resolve=>ws.once('close',resolve));
 const take=(type)=>{const i=frames.findIndex(x=>x.type===type);if(i>=0)return Promise.resolve(frames.splice(i,1)[0]);return new Promise((resolve,reject)=>{const l={type,resolve,timer:setTimeout(()=>{listeners.splice(listeners.indexOf(l),1);reject(Error(`timed out waiting for ${type}`));},4000)};listeners.push(l);});};
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);ws.once('unexpected-response',(_,res)=>{res.resume();ws.terminate();reject(Error(`HTTP ${res.statusCode}`));});});
 return {ws,take,closed,send:frame=>ws.send(JSON.stringify(frame)),close:()=>ws.close()};
}
test('real DO multiplexes, isolates peers, rejects hijack and clears replacement generation',{timeout:20000},async()=>{
 const c=credentials();const host=await open('host',c);const peers=[];
 try {
  await host.take('connected');
  const a=await open('client',c);peers.push(a);const ac=await a.take('connected');const ao=await host.take('opened');assert.equal(ac.peer,ao.peer);
  const b=await open('client',c);peers.push(b);const bc=await b.take('connected');await host.take('opened');assert.notEqual(ac.peer,bc.peer);
  a.send({type:'hello',mode:'pair',peer:bc.peer});assert.equal((await host.take('hello')).peer,ac.peer);
  a.send({type:'data',peer:bc.peer,data:'YWJj'});const inbound=await host.take('data');assert.equal(inbound.peer,ac.peer);assert.equal(inbound.data,'YWJj');
  host.send({type:'acknowledge',peer:'host',sequence:inbound.sequence});
  host.send({type:'data',peer:ac.peer,data:'ZGVm'});const outbound=await a.take('data');assert.equal(outbound.data,'ZGVm');a.send({type:'acknowledge',peer:ac.peer,sequence:outbound.sequence});
  await assert.rejects(open('host',c,randomBytes(32).toString('base64url')),/401/);
  host.send({type:'ping',nonce:'still-live'});assert.equal((await host.take('pong')).nonce,'still-live');
  const replacement=await open('host',c);peers.push(replacement);await replacement.take('connected');
  await host.closed;await a.closed;await b.closed;
  const d=await open('client',c);peers.push(d);await d.take('connected');await replacement.take('opened');
  replacement.send({type:'ping',nonce:'new-generation'});assert.equal((await replacement.take('pong')).nonce,'new-generation');
 } finally {host.close();for(const p of peers)p.close();}
});
test('offline route returns an explicit failure and never an empty session list',async()=>{
 const c=credentials();await assert.rejects(open('client',c),/503/);
});
test('delivery credits recover and a slow client cannot disconnect the host', {timeout:20000}, async()=>{
 const c=credentials();const host=await open('host',c);const peers=[];
 try {
  await host.take('connected');
  const slow=await open('client',c);peers.push(slow);const {peer}=await slow.take('connected');await host.take('opened');
  slow.send({type:'hello',mode:'connect'});await host.take('hello');
  for(let i=0;i<8;i++)host.send({type:'data',peer,data:'YWJj'});
  let last;for(let i=0;i<8;i++)last=await slow.take('data');
  slow.send({type:'acknowledge',peer,sequence:last.sequence});
  for(let i=0;i<8;i++){const delivered=await host.take('delivered');assert.equal(delivered.peer,peer);assert.equal(delivered.count,1);}
  for(let i=0;i<8;i++)host.send({type:'data',peer,data:'YWJj'});
  for(let i=0;i<8;i++)await slow.take('data');
  host.send({type:'data',peer,data:'YWJj'});
  assert.equal(await slow.closed,1008);
  assert.equal((await host.take('closed')).peer,peer);
  host.send({type:'ping',nonce:'survived-slow-client'});assert.equal((await host.take('pong')).nonce,'survived-slow-client');
  const fast=await open('client',c);peers.push(fast);const current=await fast.take('connected');await host.take('opened');
  fast.send({type:'hello',mode:'connect'});await host.take('hello');
  host.send({type:'data',peer:current.peer,data:'ZGVm'});assert.equal((await fast.take('data')).data,'ZGVm');
 }finally{host.close();for(const p of peers)p.close();}
});
test('invalid cumulative acknowledgement closes only its sender', {timeout:10000},async()=>{
 const c=credentials();const host=await open('host',c);let client;
 try{await host.take('connected');client=await open('client',c);const {peer}=await client.take('connected');await host.take('opened');
 client.send({type:'acknowledge',peer,sequence:1});assert.equal(await client.closed,1008);
 host.send({type:'ping',nonce:'healthy'});assert.equal((await host.take('pong')).nonce,'healthy');
 }finally{host.close();client?.close();}
});
test('unapproved peer cannot occupy the shared host window', {timeout:10000},async()=>{
 const c=credentials();const host=await open('host',c);const peers=[];
 try{await host.take('connected');const bad=await open('client',c);peers.push(bad);await bad.take('connected');await host.take('opened');
 bad.send({type:'hello',mode:'pair'});await host.take('hello');
 for(let i=0;i<9;i++)bad.send({type:'data',data:'YWJj'});
 assert.equal(await bad.closed,1008);
 for(let i=0;i<8;i++)await host.take('data');await host.take('closed');
 const good=await open('client',c);peers.push(good);const {peer}=await good.take('connected');await host.take('opened');
 good.send({type:'hello',mode:'pair'});await host.take('hello');good.send({type:'data',data:'ZGVm'});
 const record=await host.take('data');assert.equal(record.peer,peer);assert.equal(record.data,'ZGVm');
 }finally{host.close();for(const p of peers)p.close();}
});

test('health WebSocket returns protocol and closes after one response', {timeout:10000}, async()=>{
 const socket=new WebSocket(`${wsOrigin}/healthz`,protocol,{handshakeTimeout:4000});
 const frames=[];
 try {
  const code=await new Promise((resolve,reject)=>{
   socket.on('message',data=>frames.push(JSON.parse(data.toString())));
   socket.once('close',resolve);
   socket.once('error',reject);
   socket.once('unexpected-response',(_,response)=>{response.resume();socket.terminate();reject(Error(`health upgrade returned HTTP ${response.statusCode}`));});
  });
  assert.equal(code,1000);
  assert.equal(socket.protocol,protocol);
  assert.deepEqual(frames,[{protocol,version:1}]);
 } finally {socket.close();}
});
