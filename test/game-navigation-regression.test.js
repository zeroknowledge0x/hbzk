import test from 'node:test';
import assert from 'node:assert/strict';
import {GameFeed} from '../src/game.js';
test('scrolled successful card route never dereferences an earlier null hit',async()=>{
 const g=new GameFeed({url:'https://www.housebets.com/casino'});let url='https://www.housebets.com/casino';let n=0;
 g.page={url:()=>url,isClosed:()=>false,async evaluate(fn,...args){n++;if(n===1)return null;if(n===2)return null;if(n===3){url='https://www.housebets.com/games/housegames-limbo';return {via:'href-scrolled'};}return null;}};
 const r=await g.openGameByCard('Limbo');assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.slug,'limbo');assert.equal(g.lastPointer.text,'Limbo');
});
test('navigation cannot report the old wrong table as requested destination',async()=>{
 const g=new GameFeed({url:'https://www.housebets.com/casino'});let n=0;
 g.page={url:()=>n?'https://www.housebets.com/games/housegames-dice':'https://www.housebets.com/casino',isClosed:()=>false,async evaluate(){n++;return {x:1,y:2};}};
 const clock=Date.now;let now=clock();Date.now=()=>now+=20000;
 try{const r=await g.openGameByCard('Plinko');assert.equal(r.ok,false);}finally{Date.now=clock;}
});
