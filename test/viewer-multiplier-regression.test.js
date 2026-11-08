import test from 'node:test';import assert from 'node:assert/strict';
import {parseIntent} from '../src/core/intents.js';import {checkAction} from '../src/core/safety.js';
test('viewer multiplier aliases route to settings, not game changes',()=>{for(const text of ['ganti multi 5','multi 5x','change multiplier to 5','set multi to 5','ganti multiplier 5','payout 5x','po 5'])assert.deepEqual(parseIntent(text),{kind:'set_multiplier',args:{value:5}},text);});
test('viewer win-chance aliases including ganti/change menang',()=>{for(const text of ['ganti menang 40','change menang 40','ganti win 40','change win 40','menang 40','win chance 40'])assert.deepEqual(parseIntent(text),{kind:'set_win_chance',args:{value:40}},text);});
test('zero stake allowed, positive stake refused under demo policy',()=>{assert.equal(checkAction({kind:'set_stake',args:{value:0}},{phase:'idle'}).ok,true);assert.equal(checkAction({kind:'set_stake',args:{value:161}},{phase:'idle'}).ok,false);});
