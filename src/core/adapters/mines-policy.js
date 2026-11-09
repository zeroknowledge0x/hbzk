import { has, cashoutAvailable, available } from './policy-helpers.js';

export function decide({ phase, controls = [], progress = 0 } = {}, rand = Math.random) {
  const start = available(controls, ['Bet', 'Play'], rand);
  if (phase !== 'playing' && start) return { label: start, pick: 'tile' };
  if (phase === 'playing' && cashoutAvailable(controls) && progress > 0 && rand() < 0.4) return { label: 'Cash out' };
  if (phase === 'playing' && has(controls, 'Random tile')) return { label: 'Random tile' };
  if (phase === 'playing') return { label: null, pick: 'tile' };
  return { label: start };
}
