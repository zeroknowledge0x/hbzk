import { available, pick } from './policy-helpers.js';
// Max Win pays for one target multiplier. Writing the field is the only way to vary it:
// the table ships with Standard 1,000× already selected.
const MULTI = [10, 50, 100, 1000];
export function decide({ controls = [] } = {}, rand = Math.random) {
  return { label: available(controls, ['Bet', 'Spin'], rand), multi: pick(MULTI, rand) };
}
