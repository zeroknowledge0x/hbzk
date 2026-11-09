import { available, cashoutAvailable, has } from './policy-helpers.js';

// Hilo is a card ladder: one Bet to deal, then Higher/Lower each card. Skip burns a card and
// Cash out takes the demo. Clicking Skip while the table is idle is what made the host look
// stuck — the table greys Skip out and nothing ever starts.
export function decide({ phase, controls = [] } = {}, rand = Math.random) {
  if (phase !== 'playing' && has(controls, 'Bet')) return { label: 'Bet' };
  const hand = available(controls, ['Higher', 'Lower'], rand);
  if (hand) return { label: hand };
  if (cashoutAvailable(controls) && rand() < 0.4) return { label: 'Cash out' };
  return { label: available(controls, ['Skip'], rand) };
}
