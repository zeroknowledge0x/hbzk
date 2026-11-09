import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, cfg } from '../src/config.js';
import { GameFeed } from '../src/game.js';

loadEnv();
const c = cfg();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = 'C:/Users/Administrator/AppData/Local/hermes/cache/scratch/table-probe';
fs.mkdirSync(outDir, { recursive: true });

const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['Dice', 'Mines', 'Plinko', 'Keno', 'Wheel', 'Limbo', 'Max Win', 'Dragon Tower', 'Hilo', 'Blackjack', "Hubie's Road", 'Crash'];

const game = new GameFeed({ url: c.gamesUrl, captureMode: 'screencast', headed: true });
process.env.HUBIE_HEADED = '1';
await game.start();
for (let i = 0; i < 60 && !game.page; i++) await sleep(500);
if (!game.page) {
  console.error(JSON.stringify({ error: 'no page' }));
  process.exit(1);
}

const shot = async (tag) => {
  const p = path.join(outDir, `${tag.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.png`);
  try {
    await game.page.screenshot({ path: p, type: 'png' });
    return p;
  } catch (e) {
    return String(e.message);
  }
};

await sleep(3000);
await game.getUiSnapshot({ force: true }).catch(() => {});
const lobbyRep = game.getReport() || {};
const lobbyShot = await shot('00-lobby');
console.log(JSON.stringify({
  name: 'LOBBY',
  url: lobbyRep.url,
  shot: lobbyShot,
  clickables: (lobbyRep.clickables || []).map((x) => x.text).filter(Boolean).slice(0, 80),
}));

const rows = [];
for (const name of names) {
  const entered = await game.openGameByCard(name).catch((e) => ({ ok: false, reason: e.message }));
  await sleep(4500);
  await game.getUiSnapshot({ force: true }).catch(() => {});
  const rep = game.getReport() || {};
  const texts = (rep.clickables || []).map((x) => x.text).filter(Boolean);
  const png = await shot(name);
  const row = {
    name,
    enter: entered?.ok ? 'ok' : (entered?.reason || entered?.error || JSON.stringify(entered)),
    url: rep.url || null,
    outcome: rep.outcome || null,
    shot: png,
    clickables: texts.slice(0, 50),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ lobbyShot, rows }, null, 2));
await game.stop().catch(() => {});
console.log(JSON.stringify({ done: true, n: rows.length, outDir }));
