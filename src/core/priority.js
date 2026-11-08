// Chat priority: a 24/7 stream sees more messages than it can answer, so every line
// competes for a reply. Scores are relative (0..100): the host compares them, the tests
// assert ordering, and no single signal is allowed to own the whole range.
import { parseIntent } from './intents.js';

const BASE = 10;
const ADDRESS = 25;
const COMMAND = 30;
const QUESTION = 9;
const FIRST_TIME = 12;
const REPEAT = -8; // per earlier identical line
const REPEAT_MAX = -24;
const SPAM = -7; // per extra line from the same author
const SPAM_MAX = -28;
const RECENCY = 14;
const FRESH_MS = 60_000;

// Repeat detection only needs "same words", so punctuation and casing are dropped.
function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFirstTime(name, seen) {
  if (name == null || seen == null) return false;
  const key = String(name);
  if (typeof seen === 'function') return !seen(key);
  if (Array.isArray(seen)) return !seen.includes(key);
  if (typeof seen.has === 'function') return !seen.has(key);
  if (typeof seen === 'object') return !seen[key];
  return false;
}

function countRecent(text, recentTexts) {
  if (recentTexts == null) return 0;
  const key = normalise(text);
  if (!key) return 0;
  const list = Array.isArray(recentTexts)
    ? recentTexts
    : typeof recentTexts[Symbol.iterator] === 'function'
      ? [...recentTexts]
      : [];
  let count = 0;
  for (const item of list) if (normalise(item) === key) count += 1;
  return count;
}

// Counts are "messages seen from this author including this one", so the first message
// carries no penalty. Accepts a Map or a plain object because the host may use either.
function authorCount(name, authorCounts) {
  if (name == null || authorCounts == null) return 0;
  const key = String(name);
  const raw = typeof authorCounts.get === 'function' ? authorCounts.get(key) : authorCounts[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// Unknown timestamps get half credit: neither rewarded for freshness nor buried.
function freshness(at, now) {
  const stamp = Number(at);
  const clock = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!Number.isFinite(stamp)) return 0.5;
  const age = Math.max(0, clock - stamp);
  return Math.max(0, 1 - age / FRESH_MS);
}

export function scoreMessage(msg, ctx) {
  const c = ctx || {};
  try {
    const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
    if (!text) return 0;

    let score = BASE;

    if (/@|\bhubie\b/i.test(text)) score += ADDRESS;
    if (parseIntent(text)) score += COMMAND;
    if (text.includes('?')) score += QUESTION;
    if (isFirstTime(msg.name, c.seen)) score += FIRST_TIME;

    const repeats = countRecent(text, c.recentTexts);
    if (repeats > 0) score += Math.max(REPEAT_MAX, REPEAT * repeats);

    const spam = Math.max(0, authorCount(msg.name, c.authorCounts) - 1);
    if (spam > 0) score += Math.max(SPAM_MAX, SPAM * spam);

    score += RECENCY * freshness(msg.at, c.now);

    return Math.max(0, Math.min(100, Math.round(score)));
  } catch {
    return 0;
  }
}

export function rankMessages(list, ctx) {
  if (!Array.isArray(list)) return [];
  // Decorate-sort-undecorate keeps the comparator cheap and the tie-break stable, so
  // equal lines keep chat order instead of shuffling between renders.
  return list
    .map((msg, index) => ({ msg, index, score: scoreMessage(msg, ctx) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.msg);
}
