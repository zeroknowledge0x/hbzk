import { available, cashoutAvailable } from './policy-helpers.js';

// Hilo is a card ladder: one Bet to deal, then Higher/Lower each card. Skip burns a card and
// Cash out takes the demo. Clicking Skip while the table is idle is what made the host look
// stuck — the table greys Skip out and nothing ever starts.
export function decide({ phase, controls = [] } = {}, rand = Math.random) {
  // The idle check must not depend on which Bet-labelled control the snapshot happened to
  // keep: on Hilo the only control that survived was "Skip card", so the host skipped
  // forever. Bet is proposed here and verified against the live page before it is clicked.
  if (phase !== 'playing') return { label: 'Bet' };
  const hand = available(controls, ['Higher', 'Lower'], rand);
  if (hand) return { label: hand };
  if (cashoutAvailable(controls) && rand() < 0.4) return { label: 'Cash out' };
  return { label: available(controls, ['Skip'], rand) };
}
