import { has, cashoutAvailable } from './policy-helpers.js';
export function decide({ phase, controls = [], progress = 0 } = {}, rand = Math.random) {
  if (phase !== 'playing' && has(controls, 'Bet')) return { label: 'Bet' };
  if (phase === 'playing' && progress > 0 && cashoutAvailable(controls) && rand() < 0.4) return { label: 'Cash out' };
  if (has(controls, 'GO')) return { label: 'GO' };
  return { label: null };
}
