import assert from 'node:assert/strict';
import test from 'node:test';
import {createMobileInputDispatch} from './input-dispatch.ts';
function setup(){
 const pane={connectionState:'connected',replaying:false};const target={pane,selector:'one',herdrPaneId:undefined};const sent=[];let current=true;
 const dispatch=createMobileInputDispatch({isCurrent:()=>current,canWrite:()=>true,sendBytes:(_,text)=>{sent.push(text);return true},ensureHerdr:async()=>{current=false;return 'one'},currentHerdrPane:async()=> 'remote',sendHerdrInput:async()=>{sent.push('remote')},multilineError:()=> 'multiline unsupported'});
 return {pane,target,sent,dispatch};
}
test('multiline insert cannot become raw shell commands without paste mode',async()=>{
 const {target,sent,dispatch}=setup();await assert.rejects(dispatch.send(target,'one\ntwo',false),/multiline unsupported/);assert.deepEqual(sent,[]);
});
test('tracks split mode sequences and sends Enter outside the paste envelope only when selected',async()=>{
 const {pane,target,sent,dispatch}=setup();dispatch.observe(pane,'\x1b[?20');dispatch.observe(pane,'04h');
 assert(await dispatch.send(target,'one\ntwo',false));assert.equal(sent[0],'\x1b[200~one\ntwo\x1b[201~');
 await dispatch.send(target,'next',true);assert.equal(sent[1],'\x1b[200~next\x1b[201~\r');
 dispatch.observe(pane,'\x1b[?2004l');await assert.rejects(dispatch.send(target,'one\ntwo',false));
});
test('Herdr target changes during readiness check never send to newly focused pane',async()=>{
 const {target,sent,dispatch}=setup();target.herdrPaneId='remote';assert.equal(await dispatch.send(target,'private draft',true),false);assert.deepEqual(sent,[]);
});

test('Herdr multiline Insert refuses unverified inner paste mode even when the outer terminal enables it',async()=>{
 const {pane,target,sent,dispatch}=setup();target.herdrPaneId='remote';dispatch.observe(pane,'\x1b[?2004h');
 await assert.rejects(dispatch.send(target,'echo one\necho two\n',false),/multiline unsupported/);assert.deepEqual(sent,[]);
});

test('a replaced session or socket cannot reuse the previous terminal paste mode',async()=>{
 const {pane,target,dispatch}=setup();pane.sessionId='old';target.sessionId='old';pane.socket={};dispatch.observe(pane,'\x1b[?2004h');
 pane.sessionId='new';target.sessionId='new';
 await assert.rejects(dispatch.send(target,'one\ntwo',false),/multiline unsupported/);
 dispatch.observe(pane,'\x1b[?2004h');pane.socket={};
 await assert.rejects(dispatch.send(target,'one\ntwo',false),/multiline unsupported/);
});
