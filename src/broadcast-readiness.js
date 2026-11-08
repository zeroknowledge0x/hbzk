import {isFrameBlack} from './capture-health.js';
export function broadcastReadiness(game) {
  const age=Number(game?.frameAgeMs);
  if(!game?.ready||game.blocked||!Number.isFinite(age)||age<0||age>2500||isFrameBlack(game.frame))return{ok:false,reason:'missing healthy fresh game pixels'};
  let url='';try{url=game.getReport()?.url||'';}catch{return{ok:false,reason:'unreadable game report'};}
  try{const u=new URL(url);if(!/(^|\.)housebets\.com$/i.test(u.hostname)||!/^\/games\/housegames-[a-z0-9-]+\/?$/i.test(u.pathname))return{ok:false,reason:'not a House Game table'};}catch{return{ok:false,reason:'invalid table URL'};}
  return{ok:true,url};
}
