// Intent coverage: the stream's chat is mixed English/Indonesian, so every kind is
// exercised in both languages, plus the ordinary chatter that must stay null.
// The negative list matters as much as the positive one — a parser that fires on
// "good luck all" would make the bot act on greetings.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIntent, GAMES } from '../src/core/intents.js';

const POSITIVE = [
  // change_game
  ['switch to mines', 'change_game', { game: 'mines' }],
  ['go to limbo', 'change_game', { game: 'limbo' }],
  ['main hilo dong', 'change_game', { game: 'hilo' }],
  ['ganti ke keno', 'change_game', { game: 'keno' }],
  ['pindah ke dragon tower', 'change_game', { game: 'dragon tower' }],
  ['ubah game ke mines', 'change_game', { game: 'mines' }],
  ['play plinko', 'change_game', { game: 'plinko' }],
  ['dadu', 'change_game', { game: 'dice' }],
  ['max win', 'change_game', { game: 'max win' }],
  ['blackjack', 'change_game', { game: 'blackjack' }],
  ['main blackjack', 'change_game', { game: 'blackjack' }],
  ['bisa main wheel?', 'change_game', { game: 'wheel' }],

  // set_multiplier
  ['multiplier 5x', 'set_multiplier', { value: 5 }],
  ['set payout to 4', 'set_multiplier', { value: 4 }],
  ['pengali 10', 'set_multiplier', { value: 10 }],
  ['naikin multiplier jadi 3', 'set_multiplier', { value: 3 }],
  ['mult 2.5x', 'set_multiplier', { value: 2.5 }],

  // set_win_chance
  ['win chance 30', 'set_win_chance', { value: 30 }],
  ['chance 20%', 'set_win_chance', { value: 20 }],
  ['peluang menang 25', 'set_win_chance', { value: 25 }],
  ['winrate 45%', 'set_win_chance', { value: 45 }],
  ['set chance to 12.5', 'set_win_chance', { value: 12.5 }],
  ['30%', 'set_win_chance', { value: 30 }],
  ['ganti menang 40', 'set_win_chance', { value: 40 }],
  ['change menang 50', 'set_win_chance', { value: 50 }],
  ['ganti win 35', 'set_win_chance', { value: 35 }],
  ['change win 20', 'set_win_chance', { value: 20 }],
  ['menang 15', 'set_win_chance', { value: 15 }],

  // set_stake
  ['bet 50', 'set_stake', { value: 50 }],
  ['stake 0.01', 'set_stake', { value: 0.01 }],
  ['taruhan 100', 'set_stake', { value: 100 }],
  ['pasang 25k', 'set_stake', { value: 25_000 }],
  ['bet amount 25', 'set_stake', { value: 25 }],
  ['set stake to 10', 'set_stake', { value: 10 }],
  ['naikin bet 100 ribu', 'set_stake', { value: 100_000 }],
  ['HUBIE, bet 50!!', 'set_stake', { value: 50 }],
  ['BET 50 🚀', 'set_stake', { value: 50 }],
  ['@Hubie_bot bet 50', 'set_stake', { value: 50 }],

  // cash_out
  ['cash out', 'cash_out', {}],
  ['cashout now', 'cash_out', {}],
  ['tarik dong', 'cash_out', {}],
  ['wd', 'cash_out', {}],
  ['withdraw', 'cash_out', {}],

  // higher / lower
  ['higher', 'higher', {}],
  ['naik', 'higher', {}],
  ['lower', 'lower', {}],
  ['turun', 'lower', {}],

  // hit / stand
  ['hit', 'hit', {}],
  ['tambah kartu', 'hit', {}],
  ['stand', 'stand', {}],
  ['stop', 'stand', {}], // the CONTRACTS table maps bare "stop" to stand
  ['tahan', 'stand', {}],

  // pick_tile
  ['tile 3', 'pick_tile', { n: 3 }],
  ['pick 5', 'pick_tile', { n: 5 }],
  ['pilih 2', 'pick_tile', { n: 2 }],
  ['kotak 4', 'pick_tile', { n: 4 }],
  ['buka tile 3', 'pick_tile', { n: 3 }],

  // start_round
  ['roll', 'start_round', {}],
  ['bet', 'start_round', {}],
  ['deal', 'start_round', {}],
  ['spin', 'start_round', {}],
  ['gas', 'start_round', {}],
  ['main', 'start_round', {}],
  ['putar', 'start_round', {}],
  ['start round', 'start_round', {}],
  ['main lagi', 'start_round', {}],
  ['roll again', 'start_round', {}],
  ['ayo main', 'start_round', {}],

  // status
  ["what's the balance", 'status', {}],
  ['saldo', 'status', {}],
  ['cek saldo', 'status', {}],
  ['balance', 'status', {}],

  // stop
  ['stop playing', 'stop', {}],
  ['berhenti', 'stop', {}],
  ['quit', 'stop', {}],
  ['stop it', 'stop', {}],
];

for (const [text, kind, args] of POSITIVE) {
  test(`parses ${JSON.stringify(text)} as ${kind}`, () => {
    assert.deepEqual(parseIntent(text), { kind, args });
  });
}

const ORDINARY_CHAT = [
  'nice',
  'hello hubie',
  'gm',
  'lol',
  'good luck all',
  'mantap bang',
  'wkwk',
  'how are you',
  'selamat pagi',
  'i bet 50 you cant do it',
];

for (const text of ORDINARY_CHAT) {
  test(`leaves ordinary chat alone: ${JSON.stringify(text)}`, () => {
    assert.equal(parseIntent(text), null);
  });
}

test('never throws and never invents an intent on hostile input', () => {
  const weird = [null, undefined, 42, {}, [], Symbol('x'), () => {}, '', '   ', '🔥🔥', '\u0000', 'x'.repeat(10_000), '@@@ hubie!!!'];
  for (const input of weird) assert.equal(parseIntent(input), null);
});

test('game slugs stay lowercase and match the contract list', () => {
  for (const game of GAMES) assert.equal(game, game.toLowerCase());
  assert.deepEqual(
    [...GAMES].sort(),
    ['blackjack', 'dice', 'dragon tower', 'hilo', 'keno', 'limbo', 'max win', 'mines', 'plinko', 'wheel'],
  );
});
