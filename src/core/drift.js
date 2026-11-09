// Drift watch: the self-healing signal.
//
// The observability literature is consistent about this: static thresholds miss the failures
// that matter, and the useful signals are stuck loops and slow drift away from a baseline. For
// this host the three that have actually bitten are a click loop that repeats the same action,
// the capture frame age creeping up, and the encoder's frame time drifting. Each is a rolling
// comparison, and an alert is a line the next tick can read.

export const DEFAULTS = {
  windowMs: 5 * 60_000,
  repeatLimit: 6,      // same action this many times inside the window is a loop
  frameAgeMs: 4000,
  frameMs: 120,        // supervisor "slow frame" budget
  minSamples: 8,
};

export function createWatch(patch = {}) {
  return { events: [], alerts: [], ...DEFAULTS, ...patch };
}

export function noteAction(watch, { action = '', at = Date.now() } = {}) {
  const events = [...watch.events, { action: String(action), at }].slice(-200);
  return { ...watch, events };
}

export function noteSample(watch, { frameAgeMs = null, frameMs = null, at = Date.now() } = {}) {
  const events = [...watch.events, { sample: true, frameAgeMs, frameMs, at }].slice(-200);
  return { ...watch, events };
}

function pushAlert(watch, alert) {
  if (watch.alerts.some((a) => a.kind === alert.kind && alert.at - a.at < watch.windowMs)) {
    return watch;
  }
  return { ...watch, alerts: [...watch.alerts, alert].slice(-20) };
}

export function evaluate(watch, now = Date.now()) {
  let next = { ...watch, events: watch.events.filter((e) => now - e.at <= watch.windowMs) };

  const tally = new Map();
  for (const e of next.events) {
    if (e.sample) continue;
    const hit = tally.get(e.action) || { n: 0, first: e.at };
    tally.set(e.action, { n: hit.n + 1, first: hit.first });
  }
  for (const [action, hit] of tally) {
    if (hit.n >= watch.repeatLimit) {
      next = pushAlert(next, { kind: 'stuck-loop', action, count: hit.n, at: now });
    }
  }

  const samples = next.events.filter((e) => e.sample).map((e) => e);
  const frames = samples.map((s) => s.frameMs).filter((v) => Number.isFinite(v));
  const ages = samples.map((s) => s.frameAgeMs).filter((v) => Number.isFinite(v));
  if (frames.length >= watch.minSamples) {
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    if (avg > watch.frameMs) next = pushAlert(next, { kind: 'encoder-drift', avg: Math.round(avg), at: now });
  }
  if (ages.length >= watch.minSamples) {
    const max = Math.max(...ages);
    if (max > watch.frameAgeMs) next = pushAlert(next, { kind: 'capture-stall', maxAgeMs: max, at: now });
  }
  return next;
}

export function activeAlerts(watch, now = Date.now()) {
  return watch.alerts.filter((a) => now - a.at <= watch.windowMs);
}

export function alertLine(watch, now = Date.now()) {
  const live = activeAlerts(watch, now);
  if (!live.length) return 'DRIFT clean';
  return `DRIFT ${live.map((a) => a.kind).join(',')}`;
}

export function clearKind(watch, kind) {
  return { ...watch, alerts: watch.alerts.filter((a) => a.kind !== kind) };
}
