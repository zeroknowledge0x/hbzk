// Capture health: a live screencast can still be a black table. Age is not enough.
import { createCanvas } from '@napi-rs/canvas';

export function isFrameBlack(img, { threshold = 16, sample = 32 } = {}) {
  if (!img) return true;
  try {
    const w = Number(img.width) || 0;
    const h = Number(img.height) || 0;
    if (w < 4 || h < 4) return true;
    const canvas = createCanvas(sample, sample);
    canvas.getContext('2d').drawImage(img, 0, 0, sample, sample);
    const data = canvas.getContext('2d').getImageData(0, 0, sample, sample).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 16) {
      sum += data[i] + data[i + 1] + data[i + 2];
      n += 1;
    }
    if (!n) return true;
    if ((sum / n / 3) < threshold) return true;
    // Site chrome can be bright while the game renderer is an empty dark panel.
    // Inspect the game-relative centre, excluding the header, footer and sidebars.
    // Covered Mines tiles are dark too, but their grid has variance and edges;
    // darkness alone must never label that static, healthy board as missing.
    const size = Math.max(64, sample);
    const centre = createCanvas(size, size);
    const ctx = centre.getContext('2d');
    ctx.drawImage(img, w * 0.25, h * 0.2, w * 0.5, h * 0.48, 0, 0, size, size);
    const pixels = ctx.getImageData(0, 0, size, size).data;
    const levels = new Float64Array(size * size);
    let total = 0, squares = 0, edges = 0, pairs = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const k = y * size + x, i = k * 4;
      const level = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      levels[k] = level;
      total += level;
      squares += level * level;
      if (x) { edges += Math.abs(level - levels[k - 1]); pairs++; }
      if (y) { edges += Math.abs(level - levels[k - size]); pairs++; }
    }
    const mean = total / levels.length;
    const variance = Math.max(0, squares / levels.length - mean * mean);
    // A cursor-sized bright speck can dominate variance on an otherwise empty
    // renderer. Require distributed texture, not a single outlier, for health.
    const sorted = levels.slice().sort();
    const spread = sorted[Math.floor(sorted.length * 0.99)] - sorted[Math.floor(sorted.length * 0.01)];
    return mean < 80 && (variance < 9 || spread < 8) && edges / pairs < 3;
  } catch {
    return true;
  }
}

export const ALLOWED_OPS = ['noop', 'rearm_capture', 'play_now', 'speak', 'cycle_table', 'click'];
export const OWNER_MS = 5000;
export const CAPTURE_MS = 2000;

export function shouldPumpCapture({ ageMs, black, quietMs = 700 } = {}) {
  if (black) return true;
  return Number(ageMs) >= quietMs;
}

export function pickLargestRect(rects) {
  const list = Array.isArray(rects) ? rects.filter((r) => r && Number(r.width) > 0 && Number(r.height) > 0) : [];
  if (!list.length) return null;
  return list.reduce((best, r) => {
    const area = Number(r.width) * Number(r.height);
    const prev = Number(best.width) * Number(best.height);
    return area > prev ? r : best;
  });
}

export function parseOps(text) {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { do: 'noop', say: null, why: 'no-json' };
  try {
    const o = JSON.parse(m[0]);
    const action = String(o.do || o.action || 'noop').toLowerCase();
    const mapped = action === 'reload' || action === 'rearm' ? 'rearm_capture'
      : action === 'navigate' ? 'play_now'
        : action === 'silence' || action === 'wait' ? 'noop'
          : action;
    const allowed = ALLOWED_OPS.includes(mapped) ? mapped : 'noop';
    const say = o.say ? String(o.say).slice(0, 140) : null;
    const why = String(o.why || o.reason || '').slice(0, 80);
    const click = String(o.click || o.label || '').slice(0, 40);
    return { do: allowed, say, why, click: click || null };
  } catch {
    return { do: 'noop', say: null, why: 'bad-json' };
  }
}
