import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSettings, readSettings, setSetting, zeroStake} from '../src/game-settings.js';
function fixture(values={}) {
 const events=[];
 class Input {constructor(id,label,value,readonly=false){this.id=id;this.value=value;this.readOnly=readonly;this.disabled=false;this.type='text';this.label=label;}getAttribute(k){return k==='aria-label'?this.label:k==='type'?'text':null;}getBoundingClientRect(){return {width:80,height:30};}dispatchEvent(e){events.push([this.id,e.type,this.value]);}getRootNode(){return root;}}
 const inputs=[new Input('','Bet Amount',values.stake??'0'),new Input('hd-g-in-mult',null,values.multiplier??'2.0000'),new Input('hd-g-in-chance',null,'49.50'),new Input('profit','Profit on Win','0.00',true)];
 const root={querySelectorAll(s){return s==='input'?inputs:[];},getElementById(){return null;}};
 const page={async evaluate(fn,...args){const prev={document:global.document,location:global.location,getComputedStyle:global.getComputedStyle,HTMLInputElement:global.HTMLInputElement};global.document=root;global.location={href:'https://www.housebets.com/games/housegames-dice'};global.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});global.HTMLInputElement=Input;try{return fn(...args);}finally{Object.assign(global,prev);}}};
 return {page,inputs,events};
}
test('reads real settings without confusing stake and payout',async()=>{const f=fixture();const s=await readSettings(f.page);assert.equal(s.stake,0);assert.equal(s.multiplier,2);assert.equal(s.winChance,49.5);});
test('sets multiplier and returns observed value, leaving stake untouched',async()=>{const f=fixture();const r=await setSetting(f.page,'multiplier',5);assert.equal(r.ok,true);assert.equal(r.observed,5);assert.equal(f.inputs[0].value,'0');assert.ok(f.events.some(e=>e[1]==='input'));});
test('zero stake is explicit, rejects nonnumeric/absent observations',async()=>{const f=fixture({stake:'0.10'});const r=await zeroStake(f.page);assert.equal(r.ok,true);assert.equal(r.observed,0);assert.equal(f.inputs[0].value,'0');});
test('refuses nonzero stake before changing DOM',async()=>{const f=fixture();const r=await setSetting(f.page,'stake',161);assert.equal(r.ok,false);assert.equal(f.events.length,0);});
test('read-only stake can be verified but never changed',async()=>{const f=fixture();f.inputs[0].readOnly=true;assert.equal((await readSettings(f.page)).stake,0);assert.equal((await zeroStake(f.page)).ok,true);f.inputs[0].value='1';assert.equal((await zeroStake(f.page)).ok,false);assert.equal(f.inputs[0].value,'1');});
test('does not claim success if frontend reverts a value',async()=>{const f=fixture();const original=f.page.evaluate.bind(f.page);let n=0;f.page.evaluate=async(...a)=>{const r=await original(...a);if(++n===1)f.inputs[1].value='2.0000';return r;};const r=await setSetting(f.page,'multiplier',5);assert.equal(r.ok,false);assert.equal(r.observed,2);});
