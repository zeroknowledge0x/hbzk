// Capture health: a live screencast can still be a black table. Age is not enough.
import { createCanvas } from '@napi-rs/canvas';

export function isFrameBlack(img, { threshold = 16, sample = 32 } = {}) {
  if (!img) return true;
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (w < 4 || h < 4) return true;
  try {
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
    return (sum / n / 3) < threshold;
  } catch {
    return false;
  }
}

export const ALLOWED_OPS = ['noop', 'rearm_capture', 'play_now', 'speak', 'cycle_table'];

export function parseOps(text) {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { do: 'noop', say: null, why: 'no-json' };
  try {
    const o = JSON.parse(m[0]);
    const action = String(o.do || o.action || 'noop').toLowerCase();
    const mapped = action === 'reload' || action === 'rearm' ? 'rearm_capture'
      : action === 'click' || action === 'navigate' ? 'play_now'
        : action === 'silence' || action === 'wait' ? 'noop'
          : action;
    const allowed = ALLOWED_OPS.includes(mapped) ? mapped : 'noop';
    const say = o.say ? String(o.say).slice(0, 140) : null;
    const why = String(o.why || o.reason || '').slice(0, 80);
    return { do: allowed, say, why };
  } catch {
    return { do: 'noop', say: null, why: 'bad-json' };
  }
}
