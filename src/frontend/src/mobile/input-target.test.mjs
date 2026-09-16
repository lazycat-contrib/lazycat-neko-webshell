import assert from 'node:assert/strict';
import test from 'node:test';
import {captureMobileInputTarget,sameMobileInputTarget} from './input-target.ts';
const makePane=()=>({id:'p',sessionId:'s',selector:'a@b',title:'shell',sessionBackend:'webshell',closing:false,exited:false});
test('input target distinguishes sessions, pane replacement and selector generations',()=>{
 const pane=makePane();const first=captureMobileInputTarget(pane,1);
 assert(sameMobileInputTarget(first,captureMobileInputTarget(pane,1)));
 assert(!sameMobileInputTarget(first,captureMobileInputTarget({...pane},1)));
 assert(!sameMobileInputTarget(first,captureMobileInputTarget(pane,2)));
 pane.sessionId='new';assert(!sameMobileInputTarget(first,captureMobileInputTarget(pane,1)));
});
test('Herdr drafts are bound to the actual remote pane',()=>{
 const pane={...makePane(),sessionBackend:'herdr'};
 const state={selector:'a@b',available:true,focused_pane_id:'remote-a',panes:[]};
 const first=captureMobileInputTarget(pane,1,state);
 assert(first.herdrPaneId==='remote-a');
 assert(!sameMobileInputTarget(first,captureMobileInputTarget(pane,1,{...state,focused_pane_id:'remote-b'})));
 assert.equal(captureMobileInputTarget(pane,1),undefined);
});
