import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/core/controller.js';
import { World } from '../src/core/world.js';
import { Planner } from '../src/core/planner.js';

function fixture(name, controls, phase, random=()=>0, report={}) {
 const world=new World({game:name,phase,controls,stake:0,report});
 const planner=new Planner({world});planner.setGoal({game:name,rounds:1});
 const calls=[];const game={setStake:async()=>({ok:true,verified:true,observed:0}),clickText:async label=>{calls.push(label);return{ok:true,text:label}},clickMinesTile:async()=>{calls.push('tile');return{ok:true}},getReport:()=>({url:'https://www.housebets.com/games/housegames-mines'})};
 const c=new Controller({world,planner,game,tools:{run:async()=>({ok:false})},verifier:{waitFor:async()=>({ok:false})},random});return{c,calls};
}
const step={kind:'start_round',args:{label:'Bet'}};

test('controller selects cashout instead of a tile when Mines has progressed',async()=>{
 const board=Array.from({length:23},(_,i)=>`Tile ${i+1}`).concat(['Cash out $0.00','Random tile']);
 const {c,calls}=fixture('Mines',board,'playing',()=>0);
 const result=await c._executeStep(step);assert.equal(result.ok,true);assert.deepEqual(calls,['Cash out']);
});

test('a fresh Mines board keeps picking instead of cashing out a zero demo',async()=>{
 const board=Array.from({length:25},(_,i)=>`Tile ${i+1}`).concat(['Cash out $0.00','Random tile']);
 const {c,calls}=fixture('Mines',board,'playing',()=>0);
 const result=await c._executeStep(step);assert.equal(result.ok,true);assert.deepEqual(calls,['Random tile']);
});

test('Dragon Tower cashes out once the floors below it are cleared',async()=>{
 const board=['Cash out $0.00','Random pick a random tile on the next floor (R)'];
 for(const floor of [4,5,6,7,8,9]) for(let t=1;t<=3;t++) board.push(`Floor ${floor}, tile ${t}`);
 const {c,calls}=fixture('Dragon Tower',board,'playing',()=>0);
 const result=await c._executeStep(step);assert.equal(result.ok,true);assert.deepEqual(calls,['Cash out']);
});

test('the bet amount field is never mistaken for the Bet button',async()=>{
 const {c,calls}=fixture('Mines',['Bet Amount 0.00','2× Double bet amount (S)','Tile 1'],'idle');
 const result=await c._executeStep(step);assert.equal(result.ok,false);assert.deepEqual(calls,[]);
});

test('Keno clears the leftover selection before picking new numbers', async () => {
  const board = ['Clear table', 'Auto pick numbers at random (R)', 'Bet'];
  for (let n = 1; n <= 20; n++) board.push(`${n} Number ${n}`);
  const { c, calls } = fixture('Keno', board, 'idle', () => 0.9);
  const result = await c._executeStep(step);
  assert.equal(result.ok, true);
  assert.equal(calls[0], 'Clear table');
  assert.ok(calls.includes('Bet'), `clicked ${calls.join(',')}`);
});

test('controller never calls the Mines tile helper for Dragon Tower', async () => {
 const {c,calls}=fixture('Dragon Tower',['Bet','Random pick'],'idle');
 const result=await c._executeStep(step);assert.equal(result.ok,true);assert.deepEqual(calls,['Bet']);
});

test('controller uses chosen Hilo cashout on zero demo',async()=>{
 const {c,calls}=fixture('Hilo',['Higher / same','Lower / same','Skip card','Cash out $0.00'],'playing',()=>0.99);
 const result=await c._executeStep(step);assert.equal(result.ok,true);assert.deepEqual(calls,['Cash out']);
});

test('controller refuses to act if no matching measured play control is visible',async()=>{
 const {c,calls}=fixture('Blackjack',['Insure $0.00'],'playing');
 const result=await c._executeStep(step);assert.equal(result.ok,false);assert.deepEqual(calls,[]);
});
