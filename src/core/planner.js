// Planner: turns one goal into a short, ordered list of steps. It never runs a tool
// itself — tick() hands the host a step, the host awaits tools.run(), then reports the
// outcome back through settle(). Keeping every await outside means a wedged browser
// click can never block a tick, and ticks are cheap enough to call on every world and
// chat event.
//
// Failure policy: one retry per step, then one re-entry into the goal's game (the usual
// cause of a dead table is navigation, not bad arguments), then the goal fails and the
// host is told through a 'plan' event so it can speak about it.
const START_LABELS = ['Roll', 'Bet', 'Deal', 'Spin', 'Play'];
const MAX_ROUNDS = 50;
const AWAIT_MS = 8000;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const snap = (world) => (world && typeof world.get === 'function' ? world.get() : world || {});
const int = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : null;
};

function roundsOf(v) {
  const n = int(v);
  if (n === null || n < 1) return 1;
  return Math.min(n, MAX_ROUNDS);
}

export class Planner {
  constructor({ tools = null, world = null, bus = null, log = () => {} } = {}) {
    this.tools = tools;
    this.world = world;
    this.bus = bus;
    this.log = log;
    this.goal = null;
    this.steps = [];
    this.index = 0;
    this.attempts = 0;
    this.pending = null;
    this.fallback = null;
    this.fallbackUsed = false;
    this.done = false;
    this.failed = false;
    this.error = null;
    this.history = [];
  }

  setGoal(goal = {}) {
    if (goal === null) return this.reset('cancelled');
    this.#resetRun();
    const kind = str(goal.kind) || 'play';
    const game = str(goal.game) || str(snap(this.world).game);
    this.goal = { kind, game, rounds: roundsOf(goal.rounds) };

    if (kind !== 'play') {
      this.error = `unsupported goal: ${kind}`;
      return this.#fail(null);
    }
    if (!game) {
      this.error = 'goal needs a game';
      return this.#fail(null);
    }

    const settings = this.#settings(goal);
    if (settings.length) {
      this.goal.settings = Object.fromEntries(settings.map((s) => [s.tool, s.args.value]));
    }
    for (let round = 1; round <= this.goal.rounds; round += 1) {
      this.steps.push({ kind: 'enter_game', tool: 'change_game', args: { game }, round });
      for (const s of settings) {
        this.steps.push({ kind: 'configure', tool: s.tool, args: { ...s.args }, round });
      }
      this.steps.push({ kind: 'start_round', tool: 'click', args: { label: this.#startLabel() }, round });
      // No tool starts a round; only the verifier can see it. `waitFor` names the check
      // the host should run instead of tools.run().
      this.steps.push({ kind: 'await_result', tool: null, waitFor: 'round_result', timeout: AWAIT_MS, round });
    }

    this.#emitPlan(true, null, null);
    this.log(`planner: ${this.goal.rounds} round(s) on ${game} — ${this.steps.length} steps`);
    return this.status();
  }

  // Synchronous. Returns the next step, or null when the goal is finished, failed, or the
  // previous step has not been settled yet. An optional result settles that step first,
  // so `while ((step = p.tick(result))) result = await tools.run(step.tool, step.args)`
  // is a complete host loop.
  tick(result) {
    if (result !== undefined) this.settle(result);
    if (!this.goal || this.done || this.failed) return null;
    if (this.pending) return null;
    const step = this.fallback || this.steps[this.index] || null;
    if (!step) {
      this.done = true;
      this.#emitPlan(true, null, null);
      return null;
    }
    // The start control is only knowable from the live table, so resolve it at dispatch.
    if (step.kind === 'start_round') step.args.label = this.#startLabel();
    this.pending = step;
    return step;
  }

  settle(result) {
    const step = this.pending;
    if (!step) return this.status();
    this.pending = null;
    const ok = !!(result && result.ok === true);
    const error = ok ? null : str(result && result.error) || 'no result';
    this.history.push({ at: Date.now(), kind: step.kind, tool: step.tool, ok, error });
    if (this.history.length > 100) this.history.shift();

    if (ok) {
      this.attempts = 0;
      if (step === this.fallback) {
        // Re-entry itself worked, but the plan already spent its retry and its fallback.
        const failed = this.fallbackFor || step;
        this.fallback = null;
        this.error = `${failed.kind} failed after re-entering ${this.goal.game}`;
        return this.#fail(failed);
      }
      this.index += 1;
      if (this.index >= this.steps.length) {
        this.done = true;
        this.#emitPlan(true, null, null);
      }
      return this.status();
    }

    this.log(`planner: ${step.kind} failed (${error})`);
    // The fallback is the last resort; retrying it too would just burn the retry budget.
    if (step === this.fallback) {
      this.error = `fallback ${step.kind} failed: ${error}`;
      return this.#fail(step);
    }
    if (this.attempts < 1) {
      this.attempts += 1;
      return this.status();
    }
    if (!this.fallbackUsed && this.goal && this.goal.game) {
      this.fallbackUsed = true;
      this.attempts = 0;
      this.fallbackFor = step;
      this.fallback = {
        kind: 'enter_game',
        tool: 'change_game',
        args: { game: this.goal.game },
        round: step.round || this.#round(),
        fallback: true,
      };
      this.log(`planner: falling back to enter_game(${this.goal.game})`);
      return this.status();
    }
    this.error = `${step.kind} failed: ${error}`;
    return this.#fail(step);
  }

  status() {
    const step = this.pending || this.fallback || this.steps[this.index] || null;
    const out = {
      goal: this.goal,
      step: this.index,
      done: this.done,
      failed: this.failed,
      total: this.steps.length,
      attempts: this.attempts,
      kind: step ? step.kind : null,
      error: this.error,
    };
    if (step) out.current = { kind: step.kind, tool: step.tool, args: { ...step.args } };
    return out;
  }

  reset(reason = 'reset') {
    if (this.goal && !this.done && !this.failed) this.log(`planner: goal dropped (${reason})`);
    this.#resetRun();
    this.goal = null;
    this.steps = [];
    return this.status();
  }

  #resetRun() {
    this.steps = [];
    this.index = 0;
    this.attempts = 0;
    this.pending = null;
    this.fallback = null;
    this.fallbackFor = null;
    this.fallbackUsed = false;
    this.done = false;
    this.failed = false;
    this.error = null;
    this.history = [];
  }

  #fail(step) {
    this.failed = true;
    this.done = false;
    this.pending = null;
    this.fallback = null;
    this.#emitPlan(false, this.error || 'goal failed', step);
    this.log(`planner: goal failed — ${this.error || 'unknown'}`);
    return this.status();
  }

  #round() {
    const step = this.pending || this.fallback || this.steps[this.index];
    return step ? step.round || 1 : 1;
  }

  #startLabel() {
    const state = snap(this.world);
    const controls = Array.isArray(state.controls) ? state.controls : [];
    for (const want of START_LABELS) {
      const hit = controls.find((c) => String(c).toLowerCase() === want.toLowerCase());
      if (hit) return String(hit);
    }
    // Nothing perceived yet: "Bet" is the common label and the tool's pre-check will
    // refuse honestly if the table offers something else.
    return 'Bet';
  }

  #settings(goal) {
    const raw = goal.settings && typeof goal.settings === 'object' ? goal.settings : goal;
    const out = [];
    const stake = Number(raw.stake);
    if (Number.isFinite(stake) && stake > 0) out.push({ tool: 'set_stake', args: { value: stake } });
    const multiplier = Number(raw.multiplier);
    if (Number.isFinite(multiplier) && multiplier > 1) {
      out.push({ tool: 'set_multiplier', args: { value: multiplier } });
    }
    const chance = Number(raw.winChance ?? raw.win_chance ?? raw.chance);
    if (Number.isFinite(chance) && chance >= 1 && chance <= 99) {
      out.push({ tool: 'set_win_chance', args: { value: chance } });
    }
    return out;
  }

  #describe(step) {
    const out = { kind: step.kind, tool: step.tool, args: { ...step.args }, round: step.round };
    if (step.waitFor) {
      out.waitFor = step.waitFor;
      out.timeout = step.timeout;
    }
    return out;
  }

  #emitPlan(ok, error, step) {
    const payload = { goal: this.goal, steps: this.steps.map((s) => this.#describe(s)), ok, status: !ok ? 'failed' : this.done ? 'completed' : 'planned' };
    if (error) payload.error = String(error);
    if (step) payload.step = this.#describe(step);
    try {
      this.bus?.emit('plan', payload);
    } catch (err) {
      this.log(`planner: plan event failed (${err.message})`);
    }
  }
}
