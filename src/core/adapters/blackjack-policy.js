import { has, available } from './policy-helpers.js';
// Blackjack: play the hand first. `No thanks` only dismisses an insurance offer that is
// covering the table with nothing else to click — otherwise it would spend every round
// refusing insurance and never deal a card.
export function decide({ controls = [] } = {}, rand = Math.random) {
  const hand = available(controls, ['Hit', 'Stand'], rand);
  if (hand) return { label: hand };
  if (has(controls, 'No thanks')) return { label: 'No thanks' };
  return { label: available(controls, ['Bet', 'Deal'], rand) };
}
