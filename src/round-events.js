// Only accepts observations from the scoped DOM sensor below. IDs describe witnessed
// rounds, not poll times. Reload/scope changes establish a new stale-result baseline.
export function observeLocalRoundDom() {
  const root = window;
  const state = root.__hubieRounds || (root.__hubieRounds = { seq: 0, revision: 0, queue: [], armed: false });
  const deepAll = (sel, node = document, out = []) => {
    try { for (const n of node.querySelectorAll(sel)) out.push(n); } catch { /* ignore */ }
    let all = [];
    try { all = node.querySelectorAll('*'); } catch { return out; }
    for (const el of all) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
    return out;
  };
  const sample = () => {
    const href = String(location.href || '');
    const game = /housegames-keno/i.test(href) ? 'keno' : /housegames-dice/i.test(href) ? 'dice' : '';
    const marker = deepAll('[class*="hd-g-marker"]').find((el) => !String(el.className || '').includes('hd-g-chip'));
    const pay = deepAll('[class*="hl-g-payhit--on"]')[0];
    const foot = deepAll('[class*="hl-g-foot-val--hits"]').map((el) => el.textContent).find((t) => /\d+\s*of\s*\d+/i.test(t || ''));
    const multi = deepAll('[id="hd-g-in-mult"],input')[0];
    const busy = deepAll('button').some((el) => /^(bet|go)$/i.test(String(el.textContent || '').trim()) && el.disabled);
    let outcome = null;
    if (game === 'dice' && marker) {
      const n = Number(String(marker.textContent || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/)?.[0]);
      if (Number.isFinite(n)) outcome = { sensor: 'dice-marker', result: n, won: String(marker.className || '').includes('--win') };
    } else if (game === 'keno' && pay && foot) {
      const n = Number(String(pay.textContent || '').match(/(\d+(?:\.\d+)?)\s*x/i)?.[1]);
      if (Number.isFinite(n)) outcome = { sensor: 'keno-payhit', result: n, won: n > 0 };
    }
    state.seq += 1;
    return {
      scope: `${performance.timeOrigin}:${game || 'none'}`, game, seq: state.seq, busy,
      resultRevision: state.revision,
      settingsMultiplier: Number(String(multi?.value || '').replace(',', '.')),
      outcome,
    };
  };
  if (!state.armed) {
    state.armed = true;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData' || (record.type === 'attributes' && record.attributeName !== 'disabled')) state.revision += 1;
      }
      state.queue.push(sample());
    }).observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    state.queue.push(sample());
  }
  const queued = state.queue.splice(0);
  return queued.length ? queued : [sample()];
}

export class LocalRoundTracker {
  observe(sample) {
    if (!sample || !sample.scope || !['dice', 'keno'].includes(sample.game)) {
      this.previous = null; this.pending = null; this.event = null;
      return null;
    }
    const previous = this.previous;
    if (!previous || previous.scope !== sample.scope || previous.game !== sample.game) {
      this.previous = sample; this.pending = null; this.event = null;
      return null;
    }
    if (sample.seq <= previous.seq) return this.event;
    if (!previous.busy && sample.busy) {
      this.pending = { revision: previous.resultRevision,
        multiplier: previous.settingsMultiplier === sample.settingsMultiplier ? previous.settingsMultiplier : null,
        id: `${sample.scope}:round-${sample.seq}` };
      this.event = null;
    }
    const result = sample.outcome;
    if (this.pending && !sample.busy && result
      && sample.resultRevision > this.pending.revision
      && ((sample.game === 'dice' && result.sensor === 'dice-marker')
        || (sample.game === 'keno' && result.sensor === 'keno-payhit'))
      && typeof result.won === 'boolean' && Number.isFinite(result.result) && result.result >= 0) {
      const payoutMultiplier = sample.game === 'keno' ? result.result
        : result.won ? this.pending.multiplier : 0;
      this.event = { ...result, game: sample.game, source: 'local-round', confirmed: true, local: true,
        eventId: this.pending.id, roundId: this.pending.id,
        payoutMultiplier: Number.isFinite(payoutMultiplier) && payoutMultiplier >= 0 ? payoutMultiplier : null };
      this.pending = null;
    }
    this.previous = sample;
    return this.event;
  }
}
