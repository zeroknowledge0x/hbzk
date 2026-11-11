// A table whose result cannot be read is the table's problem, not the process's. Keep the decline
// on disk so a restart (this loop restarts often) does not put the same dead table back in the
// rotation minutes later. Entries expire after a day, so tomorrow tries it again.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadDeclined(file, now = Date.now()) {
  const out = new Map();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    for (const [name, entry] of Object.entries(raw || {})) {
      const at = Number(entry?.at || 0);
      if (!name || !Number.isFinite(at) || now - at > DAY_MS) continue;
      out.set(name, { at, reason: String(entry?.reason || 'not readable') });
    }
  } catch { /* no file yet, or not ours to read */ }
  return out;
}

export function saveDeclined(file, name, reason, now = Date.now()) {
  const wanted = String(name || '').trim();
  if (!wanted) return false;
  const existing = loadDeclined(file, now);
  existing.set(wanted, { at: now, reason: String(reason || 'not readable') });
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(Object.fromEntries(existing), null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
