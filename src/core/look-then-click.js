// The model looks at the table, then names one control. This module does not play.
// It only offers the controls that are safe to click, shrinks a long board so the prompt
// stays small, and accepts a pick solely when that exact control is on the table.
import { labelMatchesPlay } from './play-labels.js';

const NEVER = /\b(info|history|rules|fair|help|amount|halve|double|wallet)\b/i;
// Page chrome that sits in the same snapshot as the table. "Cash" alone would also hide
// "Cash out", so the money rows are matched from the start of the label.
const CHROME = /\b(account|search|weekly prize|favourite|favorite|recently played|currencies)\b/i;
const MONEY = /^(idr|usd|eur|pol|bnb|usdt|usdc|sol|eth)\b/i;
const DECISION = /cash out|random|hit anyway|cancel|don't ask|dont ask|no thanks|close|stand|higher|lower|\bskip\b|\bbet\b/i;

export function legalControls(controls = []) {
  const out = [];
  for (const raw of controls) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text || NEVER.test(text) || CHROME.test(text) || MONEY.test(text)) continue;
    if (out.some((c) => c.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out;
}

// Keep every decision button, then as many board cells as fit, and say how many were cut.
export function compressControls(controls = [], max = 24) {
  const list = legalControls(controls);
  const cap = Math.max(2, max);
  if (list.length <= cap) return list;
  const kept = [];
  const rest = [];
  for (const label of list) (DECISION.test(label) ? kept : rest).push(label);
  const room = cap - 1;
  const out = [];
  for (const label of [...kept, ...rest]) {
    if (out.length >= room) break;
    out.push(label);
  }
  const hidden = list.length - out.length;
  if (hidden > 0) out.push(`… and ${hidden} more`);
  return out;
}

// `pick` is accepted only when it names a control that is actually on the table.
// Anything else — Wallet, a stake field, a label the model invented — is a no-click.
export function resolveLookedClick({ controls = [], pick = '' } = {}) {
  const q = String(pick || '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!q || /^none\.?$/i.test(q)) return null;
  const hit = legalControls(controls).find((label) => labelMatchesPlay(q, label));
  return hit ? q : null;
}

// A model often answers with a sentence. Take the control it named, longest first so
// "Hit anyway" wins over "Hit", and ignore the compressor's "… and N more" line.
export function pickFromReply(reply, controls = []) {
  const text = String(reply || '').trim();
  if (!text) return null;
  const line = text.split('\n')[0].replace(/^\d+[).\s]+/, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  const direct = resolveLookedClick({ controls, pick: line });
  if (direct) return direct;
  const low = text.toLowerCase();
  const named = legalControls(controls)
    .filter((label) => !label.startsWith('…'))
    .sort((a, b) => b.length - a.length)
    .find((label) => low.includes(label.toLowerCase()));
  return named ? resolveLookedClick({ controls, pick: named }) : null;
}

// A page.evaluate that never returns used to freeze the whole click loop. The caller
// gets a pending result instead, and can try again.
export function withBudget(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, pending: true, error: `${label} timed out` }), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => value,
      (err) => ({ ok: false, error: err?.message || String(err) }),
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}
