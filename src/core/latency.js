// Latency budget for the mouth.
//
// Published voice-agent work converges on the same numbers for a host that talks to a live
// audience: stay under ~800 ms where it feels instant, and treat 2.5 s as the ceiling for a
// cartoon-host show (Neuro-sama's own p95 target). The stages that dominate are turn
// detection, model time-to-first-token and TTS time-to-first-byte — everything else is noise.
// This module keeps five timestamps per line so a slow stage can be named instead of guessed,
// and offers the "cover the wait" line the same sources recommend.

export const TARGETS = { p50Ms: 800, p95Ms: 2500 };

export function createLatency(patch = {}) {
  return { samples: [], last: null, overBudget: 0, ...patch };
}

export const STAGES = ['askedAt', 'llmFirstTokenAt', 'ttsFirstByteAt', 'firstPcmAt'];

// Record one spoken line. Any stage may be missing; only what was measured is kept.
export function noteLine(latency, line = {}) {
  const at = Number(line.at) || Date.now();
  const asked = Number(line.askedAt) || null;
  const llm = Number(line.llmFirstTokenAt) || null;
  const tts = Number(line.ttsFirstByteAt) || null;
  const pcm = Number(line.firstPcmAt) || null;
  const total = asked && pcm ? Math.max(0, pcm - asked) : null;
  const sample = {
    at,
    totalMs: total,
    llmMs: asked && llm ? Math.max(0, llm - asked) : null,
    ttsMs: tts && pcm ? Math.max(0, pcm - tts) : null,
    kind: String(line.kind || ''),
  };
  const samples = [...latency.samples, sample].slice(-200);
  const over = total !== null && total > TARGETS.p95Ms ? latency.overBudget + 1 : latency.overBudget;
  return { ...createLatency(latency), samples, last: sample, overBudget: over };
}

function percentile(values, p) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[idx];
}

export function stats(latency) {
  const totals = latency.samples.map((s) => s.totalMs).filter((v) => Number.isFinite(v));
  const llms = latency.samples.map((s) => s.llmMs).filter((v) => Number.isFinite(v));
  const ttss = latency.samples.map((s) => s.ttsMs).filter((v) => Number.isFinite(v));
  return {
    n: latency.samples.length,
    p50: percentile(totals, 50),
    p95: percentile(totals, 95),
    llmP50: percentile(llms, 50),
    ttsP50: percentile(ttss, 50),
    overBudget: latency.overBudget,
  };
}

// Which stage to blame, in the order the budget actually leaks.
export function slowestStage(latency) {
  const s = stats(latency);
  if (s.p50 === null) return 'unknown';
  if ((s.llmP50 || 0) >= (s.ttsP50 || 0) && (s.llmP50 || 0) >= 200) return 'llm';
  if ((s.ttsP50 || 0) > (s.llmP50 || 0) && (s.ttsP50 || 0) >= 200) return 'tts';
  return 'fine';
}

// Cover an unavoidable wait instead of leaving dead air: short, present tense, no facts.
export function coverLine(kind = '') {
  const pool = [
    'One sec, reading the table.',
    'Hold on, let me watch the board.',
    'Moment, chat.',
    'Hang on, the table is thinking.',
  ];
  const idx = Math.abs(String(kind).length + pool.length) % pool.length;
  return pool[idx];
}

// Wrap a slow call so the mouth is never silent: if `promise` has not settled after `delayMs`
// and the mouth is free, one short cover line is said. The promise itself is returned
// untouched, so the caller's then/catch chain is unchanged.
export function withCover(promise, {
  delayMs = 1400,
  isBusy = () => false,
  onCover = () => {},
  cover = () => coverLine('idle'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let settled = false;
  const timer = setTimer(() => {
    if (settled) return;
    try {
      if (isBusy()) return;
      const line = cover();
      if (line) onCover(line);
    } catch { /* a failed cover must never break the reply */ }
  }, delayMs);
  timer?.unref?.();
  const done = () => { settled = true; clearTimer(timer); };
  Promise.resolve(promise).then(done, done);
  return promise;
}

export function latencyLine(latency) {
  const s = stats(latency);
  const ms = (v) => (v === null ? '—' : `${(v / 1000).toFixed(1)}s`);
  return `MOUTH p50 ${ms(s.p50)} · p95 ${ms(s.p95)} (llm ${ms(s.llmP50)}, tts ${ms(s.ttsP50)}) · over ${s.overBudget}/${s.n}`;
}
