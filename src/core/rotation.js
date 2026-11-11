// Rotation: cycles through a list of game names on a fixed interval, persisting the
// next index to a JSON file atomically. Corrupt files are recovered by resetting to 0.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function quietIntervalMs(env = process.env.CORE_ROTATION_MS, rand = Math.random) {
  const n = Number(env);
  if (Number.isFinite(n) && n > 0) return Math.max(10_000, n);
  const min = 10 * 60 * 1000;
  const max = 60 * 60 * 1000;
  return min + Math.floor(rand() * (max - min + 1));
}

export class Rotation {
  constructor({ file, names, playable, now, intervalMs } = {}) {
    this.file = file || 'rotation.json';
    this.names = Array.isArray(names) && names.length > 0 ? names : ['Dice'];
    this.playable = playable instanceof Set ? playable : new Set(playable || this.names);
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.intervalMs = Number(intervalMs) || 300000;
    this._timer = null;
    this._playNow = false;
    this.index = this._load();
  }

  // ── public API ──────────────────────────────────────────────────────────────

  next() {
    let name = null;
    for (let tries=0; tries<this.names.length; tries++) {
      const candidate=this.names[this.index];
      this.index=(this.index+1)%this.names.length;
      if ([...this.playable].some(p=>p.toLowerCase()===candidate.toLowerCase())) { name=candidate; break; }
    }
    this._save();
    this._playNow = false;
    return name;
  }

  // Quiet stream: pick a random playable table and stay on it for the interval.
  random() {
    const pool = this.names.filter((candidate) =>
      [...this.playable].some((p) => String(p).toLowerCase() === candidate.toLowerCase()));
    if (pool.length <= 1) return this.next();
    const current = this.current();
    const rest = pool.filter((n) => n.toLowerCase() !== String(current || '').toLowerCase());
    const pick = (rest.length ? rest : pool)[Math.floor(Math.random() * (rest.length ? rest.length : pool.length))];
    const at = this.names.findIndex((n) => n.toLowerCase() === pick.toLowerCase());
    if (at >= 0) this.index = (at + 1) % this.names.length;
    this._save();
    this._playNow = false;
    return pick;
  }

  current() {
    return this.names[this.index];
  }

  due() {
    if (this._playNow) return true;
    const last = this._readAt();
    if (last === null) return true;
    return this.now() - last >= this.intervalMs;
  }

  playNow() {
    this._playNow = true;
  }

  // The drift watch is a measurement, not a steering wheel. A `stuck-loop` alert is usually a legal
  // repeat on a one-button table (the detector counting `Bet` on a table that only has `Bet`), and
  // rotating on it is how the designed 10–60 min dwell collapsed to about a minute — measured
  // 2026-11-11: 253 of 402 rotations in one day followed a stuck-loop line within 20 s.
  static driftResponse(kind) {
    return /capture-stall/i.test(String(kind)) ? 'rearm-capture' : 'log-only';
  }

  // A table whose result cannot be read comes off the pool for the rest of the run. The log line
  // that calls this must say which table and why — declining quietly is not allowed.
  decline(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return this.playable.size;
    for (const entry of [...this.playable]) {
      if (String(entry).trim().toLowerCase() === want) this.playable.delete(entry);
    }
    this._playNow = true;
    return this.playable.size;
  }

  arm(timerFactory) {
    if (typeof timerFactory !== 'function') { this._save(); return null; }
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const last = this._readAt();
    const elapsed = last === null ? this.intervalMs : this.now() - last;
    const remaining = Math.max(0, this.intervalMs - elapsed);
    const factory = typeof timerFactory === 'function' ? timerFactory : setTimeout;
    this._timer = factory(() => this.next(), remaining);
    return this._timer;
  }

  // ── persistence ─────────────────────────────────────────────────────────────

  _load() {
    try {
      if (!existsSync(this.file)) return 0;
      const raw = readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      const idx = Number(data.index);
      if (Number.isFinite(idx) && idx >= 0 && idx < this.names.length) {
        return Math.trunc(idx);
      }
    } catch {
      // Corrupt JSON or unreadable file: recover by resetting
    }
    return 0;
  }

  _save() {
    const dir = dirname(this.file);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = this.file + '.tmp';
    const payload = JSON.stringify({ index: this.index, at: this.now() });
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, this.file);
  }

  _readAt() {
    try {
      if (!existsSync(this.file)) return null;
      const raw = readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      const at = Number(data.at);
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }
}
