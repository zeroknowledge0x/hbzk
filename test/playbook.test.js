import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  advise, createPlaybook, hitRate, loadPlaybook, playbookLine, record, savePlaybook, summary,
} from '../src/core/playbook.js';

test('a delivered click that was never settled earns no lesson', () => {
  const book = createPlaybook();
  const after = record(book, 'Mines', { verified: false, won: true, multiplier: 9 });
  assert.deepEqual(after.tables, {});
  assert.equal(summary(after, 'Mines').rounds, 0);
});

test('verified rounds accumulate per table, case-insensitively', () => {
  let book = createPlaybook();
  book = record(book, 'Mines', { verified: true, won: true, multiplier: 1.9, cashoutAt: 1.3 });
  book = record(book, 'mines', { verified: true, won: false, multiplier: 0, cashoutAt: 2.1 });
  assert.equal(summary(book, 'MINES').rounds, 2);
  assert.equal(summary(book, 'Mines').hits, 1);
  assert.equal(hitRate(book, 'Mines'), 0.5);
  assert.equal(summary(book, 'Mines').bestMultiplier, 1.9);
});

test('advice waits for a sample worth trusting', () => {
  let book = createPlaybook();
  book = record(book, 'Hilo', { verified: true, won: false });
  assert.equal(advise(book, 'Hilo', { progress: 2 }), null, 'one bad round is not a pattern');
  for (let i = 0; i < 5; i++) book = record(book, 'Hilo', { verified: true, won: false });
  assert.match(advise(book, 'Hilo', { progress: 2 }), /cold/);
  assert.equal(advise(book, 'Hilo', { progress: 0 }), null, 'no early cashout advice with no progress');
});

test('a hot table is told about its own best run, never promised', () => {
  let book = createPlaybook();
  book = record(book, 'Keno', { verified: true, won: true, multiplier: 7.5 });
  for (let i = 0; i < 4; i++) book = record(book, 'Keno', { verified: true, won: true, multiplier: 2 });
  const line = advise(book, 'Keno', { progress: 1 });
  assert.match(line, /7\.50x/);
  assert.doesNotMatch(line, /guaranteed|will win/i);
});

test('cashout history turns into a sweet-spot hint', () => {
  let book = createPlaybook();
  for (const c of [1.2, 1.4, 1.6, 1.8]) book = record(book, "Hubie's Road", { verified: true, won: true, cashoutAt: c });
  assert.equal(summary(book, "Hubie's Road").cashoutMean, 1.5);
  assert.match(advise(book, "Hubie's Road", { progress: 1 }), /1\.5/);
});

test('notes and cashouts stay bounded', () => {
  let book = createPlaybook();
  for (let i = 0; i < 20; i++) book = record(book, 'Dice', { verified: true, won: true, cashoutAt: i, note: `n${i}` });
  const s = book.tables.dice;
  assert.ok(s.cashouts.length <= 12, String(s.cashouts.length));
  assert.ok(s.notes.length <= 6, String(s.notes.length));
});

test('the playbook survives a save/load round trip and a corrupt file', () => {
  const file = path.join(os.tmpdir(), `hubie-playbook-${process.pid}.json`);
  let book = createPlaybook();
  book = record(book, 'Wheel', { verified: true, won: true, multiplier: 3 });
  assert.equal(savePlaybook(file, book).ok, true);
  assert.equal(summary(loadPlaybook(file), 'Wheel').rounds, 1);
  fs.writeFileSync(file, 'not json at all');
  assert.deepEqual(loadPlaybook(file).tables, {});
});

test('the one-line summary names each table it has seen', () => {
  let book = createPlaybook();
  assert.equal(playbookLine(book), 'PLAYBOOK empty');
  book = record(book, 'Dice', { verified: true, won: true });
  assert.match(playbookLine(book), /PLAYBOOK 1 table\(s\)/);
  assert.match(playbookLine(book), /dice 1r\/1w/);
});
