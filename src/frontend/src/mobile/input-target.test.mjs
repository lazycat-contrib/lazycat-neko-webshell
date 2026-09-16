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

test('retirement does not erase inactive selectors or incomplete Herdr snapshots',async()=>{
 const {mobileInputTargetRetired}=await import('./input-target.ts');
 const pane={...makePane(),sessionBackend:'herdr'};const state={selector:'a@b',available:true,focused_pane_id:'inner',resources_complete:true,panes:[{pane_id:'inner'}]};
 const target=captureMobileInputTarget(pane,1,state);
 assert.equal(mobileInputTargetRetired(target,[],{...state,selector:'other@owner',panes:[]}),false);
 assert.equal(mobileInputTargetRetired(target,[],{...state,resources_complete:false,panes:[]}),false);
 assert.equal(mobileInputTargetRetired(target,[],{...state,panes:[]}),true);
 pane.closing=true;pane.exited=true;
 assert.equal(mobileInputTargetRetired(target,[],state),false,'recoverable Herdr client exits do not retire inner panes');
 const recovered={...pane,sessionId:'new-client',closing:false,exited:false};
 const next=captureMobileInputTarget(recovered,2,state);
 assert.equal(next.key,target.key,'inner-pane draft survives client recreation');
 assert(!sameMobileInputTarget(target,next));
});


test('provisional native close or exit keeps drafts until confirmed removal',async()=>{
 const {mobileInputTargetRetired}=await import('./input-target.ts');const pane=makePane();const target=captureMobileInputTarget(pane,1);
 pane.closing=true;pane.exited=true;assert.equal(mobileInputTargetRetired(target,[pane]),false);
 assert.equal(mobileInputTargetRetired(target,[]),true);
});
