// Build data/kb.sqlite from measured Housebets facts. English only. No invented bonuses.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'kb.sqlite');
const db = new DatabaseSync(file);
db.exec('DROP TABLE IF EXISTS facts');
db.exec('CREATE TABLE facts (id TEXT PRIMARY KEY, title TEXT, tags TEXT, text TEXT)');
const insert = db.prepare('INSERT INTO facts (id, title, tags, text) VALUES (?, ?, ?, ?)');

const rows = [
  ['what', 'What Housebets is', 'housebets casino crypto sportsbook', 'Housebets is a crypto casino and sportsbook at housebets.com. It has House Games, slots, live casino, and sports betting.'],
  ['website', 'Website', 'website site url link housebets', 'The website is https://www.housebets.com. House Games are under Casino, then House Games. This stream does not take deposits.'],
  ['kabar', 'How are you', 'kabar how are you hello', 'Hubie is fine. This is a demo stream. Stake is locked at zero. Answer how-are-you and apa kabar in English.'],
  ['stream', 'This stream', 'demo kick hubie promo stake', 'Kick channel HubieZK promotes Housebets House Games. Stake is locked at 0. It is a demo show, not a deposit pitch. 18 plus.'],
  ['fair', 'Provably fair', 'fair rtp seeds provably', 'House Games are provably fair. Hilo and Hubie\'s Road tables show RTP 99.00%. Do not invent other RTP numbers.'],
  ['crash', 'No Crash card', 'crash limbo', 'There is no Crash lobby card. A chat request for crash is played as Limbo.'],
  ['dice', 'Dice buttons', 'dice over under inside outside bet', 'Dice buttons: Manual, Auto, Bet, Over, Under, Inside, Outside, and a target field. Never click half or 2x. Those change the stake. Play is Bet after a random side.'],
  ['mines', 'Mines buttons', 'mines tile bet', 'Mines shows tiles 1 through 25. Bet starts the round, then a random tile. Cash out only after a safe tile, never at $0.00.'],
  ['plinko', 'Plinko buttons', 'plinko low medium high bet', 'Plinko buttons: Bet, and risk chips Low, Medium, High. Pick a risk at random, then Bet. Never half or 2x.'],
  ['keno', 'Keno buttons', 'keno classic auto pick number', 'Keno buttons: Bet, Classic, Low, Medium, High, Auto pick, Clear table, and numbers. Pick a risk, then Auto pick or a few random numbers, then Bet. Do not always pick 3.'],
  ['wheel', 'Wheel buttons', 'wheel low medium high bet', 'Wheel buttons: Bet, and risk chips Low, Medium, High. Segments print their own multipliers. Pick a risk at random, then Bet.'],
  ['limbo', 'Limbo chips', 'limbo 1.5x 5x 10x 100x target', 'Limbo chips measured on the table: 1.5x, 2x, 5x, 10x, 100x, plus a target field. Pick a chip at random, then Bet. Do not always send 2x.'],
  ['maxwin', 'Max Win', 'max win standard bet', 'Max Win shows Bet and a Standard 1,000x mode. Bet starts the round. Do not invent a jackpot that is not on screen.'],
  ['tower', 'Dragon Tower', 'dragon tower random pick floor cash out', 'Dragon Tower idle buttons: Bet, Medium, Random pick, and floor tiles. Bet first. Then Random pick. Cash out only when the label is not $0.00.'],
  ['hilo', 'Hilo buttons', 'hilo higher lower skip cash out', 'Hilo has no Bet button. Play is Higher or same, Lower or same, or Skip card. Cash out at $0.00 does nothing. The table shows RTP 99.00%.'],
  ['blackjack', 'Blackjack buttons', 'blackjack hit stand boxes bet', 'Blackjack idle buttons: Bet, Boxes 1, 2, 3. Hit and Stand appear after the deal. Pick Hit or Stand at random. Do not click More.'],
  ['road', 'Hubie Road buttons', 'hubie road easy medium hard daredevil go', 'Hubie\'s Road start button is Go, not Bet. Difficulty chips: Easy, Medium, Hard, Daredevil. Cash out shows $0.00 until a lane is cleared. Table shows RTP 99.00%.'],
  ['wallet', 'Do not click Wallet', 'wallet deposit', 'Wallet and deposit are never play buttons. Stake stays 0. Half and 2x change the stake and are banned.'],
  ['info', 'Do not click Bet Info', 'bet info history rules', 'Bet is not Bet Info. Info, history, rules, fair, and help open panels. Never click them as the play button.'],
  ['chat', 'Chat requests', 'chat switch ganti', 'One viewer asking for a House Game switches now. Several requests play in order, a few minutes each. Say the name and the game. Do not say queued.'],
  ['talk', 'Quiet stream still talks', 'idle viewers quiet', 'Talk every 5 to 15 minutes even when nobody is watching. Also talk when a round wins at 3x or more.'],
  ['support', 'Support', 'support help center', 'Housebets has a Help Center and 24/7 support on the site. This stream cannot move money.'],
];

for (const row of rows) insert.run(...row);
console.log(JSON.stringify({ file, rows: rows.length }));
