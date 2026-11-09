import test from 'node:test';
import assert from 'node:assert/strict';
import { kenoNumbers, progressFromControls, readObservedProgress } from '../src/core/progress.js';

test('counts only explicit revealed safe Mines tiles',()=>{
 assert.equal(readObservedProgress('Mines',{revealedSafeTiles:2}),2);
 assert.equal(readObservedProgress('Mines',{revealedSafeTiles:0}),0);
 assert.equal(readObservedProgress('Mines',{progress:99}),0);
});

test('uses observed current floor or lane for tower and road',()=>{
 assert.equal(readObservedProgress('Dragon Tower',{currentFloor:3}),3);
 assert.equal(readObservedProgress("Hubie's Road",{currentLane:4}),4);
 assert.equal(readObservedProgress('Dragon Tower',{currentFloor:-1}),0);
});

test('does not confuse displayed target multiplier or click counts with progress',()=>{
 assert.equal(readObservedProgress('Dragon Tower',{multiplier:50,clicks:3}),0);
 assert.equal(readObservedProgress('Hilo',{currentFloor:9}),0);
});

test('reads Mines progress from tiles that left the board',()=>{
 const board=Array.from({length:23},(_,i)=>`Tile ${i+1}`).concat(['Cash out $0.00','Random tile']);
 assert.equal(progressFromControls('Mines',board),2);
 assert.equal(progressFromControls('Mines',Array.from({length:25},(_,i)=>`Tile ${i+1}`)),0);
 assert.equal(readObservedProgress('Mines',{controls:board}),2);
});

test("reads Dragon Tower and Hubie's Road progress from the lowest remaining step",()=>{
 const tower=['Floor 4, tile 1','Floor 4, tile 2','Floor 9, tile 3'];
 assert.equal(progressFromControls('Dragon Tower',tower),3);
 const road=['1.71x Lane 5','2.00x Lane 6'];
 assert.equal(progressFromControls("Hubie's Road",road),4);
 assert.equal(progressFromControls('Dragon Tower',['Bet','Random pick']),0);
});

test('Keno picks numbers the board actually shows, not a hard-coded range',()=>{
 assert.deepEqual(kenoNumbers(['1 Number 1','7 Number 7','20 Number 20']),[1,7,20]);
 assert.equal(kenoNumbers([]).length,20);
});

