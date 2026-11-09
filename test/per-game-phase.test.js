import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPhase } from '../src/core/play-labels.js';
import { byName } from '../src/core/adapters/index.js';

test('Keno can prepare Auto pick before Bet becomes enabled', () => {
  const a=byName('Keno').decide({phase:'idle',controls:['Auto pick numbers at random (R)','Classic (Q)']},()=>0);
  assert.equal(a.label,'Bet');
  assert.equal(a.pick,'auto-or-numbers');
});

test('enabled Random tile without Bet is an in-round Mines control', () => {
  assert.equal(inferPhase(['Random tile','Cash out $0.00']), 'playing');
  assert.equal(byName('Mines').decide({phase:'playing',controls:['Random tile','Cash out $0.00'],progress:0},()=>0).label,'Random tile');
});

test('Mines and Dragon Tower do not cash out before observed progress',()=>{
  for(const name of ['Mines','Dragon Tower']){
    const action=byName(name).decide({phase:'playing',controls:['Cash out $0.00','Random pick','Random tile'],progress:0},()=>0);
    assert.notEqual(action.label,'Cash out');
  }
});

test('limbo policy distinguishes exact 2x preset from stake double',()=>{
  const action=byName('Limbo').decide({controls:['Bet','2× Double bet amount (S)','5x']},()=>0);
  assert.equal(action.settings,'5x');
});
