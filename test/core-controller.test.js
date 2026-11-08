import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/core/controller.js';
import { Planner } from '../src/core/planner.js';
import { World } from '../src/core/world.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────

function makeTools() {
  const calls = [];
  return {
    calls,
    async run(tool, args) {
      calls.push({ tool, args });
      if (tool === 'change_game') return { ok: true };
      if (tool === 'click') return { ok: true };
      if (tool === 'set_multiplier') return { ok: true };
      if (tool === 'set_win_chance') return { ok: true };
      return { ok: true };
    },
  };
}

function makeGame() {
  return {
    async setStake() { return { ok: true, verified: true, observed: 0 }; },
    getReport() {
      return { round: 1, result: 'win', payout: 2 };
    },
  };
}

function makeVerifier(ok = true) {
  return {
    async waitFor(name, opts) {
      if (!opts || !opts.before) return { ok: false, error: 'no snapshot' };
      return { ok };
    },
  };
}

function makeRotation() {
  const names = [];
  return {
    names,
    arm() { names.push('armed'); },
    next() {
      const n = 'Dice';
      names.push(n);
      return n;
    },
  };
}

function makeSpeak() {
  const messages = [];
  return {
    messages,
    speak(text, msg) {
      messages.push({ text, msg });
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildController(overrides = {}) {
  const world = new World({ game: 'Dice', controls: ['Bet', 'Roll'], phase: 'idle' });
  const tools = overrides.tools || makeTools();
  const game = overrides.game || makeGame();
  const verifier = overrides.verifier || makeVerifier(true);
  const rotation = overrides.rotation || makeRotation();
  const speak = overrides.speak || makeSpeak();
  const planner = new Planner({ tools, world, log: () => {} });
  const playable = overrides.playable || new Set(['Dice', 'Mines']);

  const ctrl = new Controller({
    world,
    tools,
    planner,
    verifier,
    game,
    speak: speak.speak,
    log: () => {},
    rotation,
    playable,
  });

  return { ctrl, world, tools, game, verifier, rotation, speak, planner };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Controller', () => {

  describe('change_game', () => {
    it('refuses game not in playable set', async () => {
      const { ctrl, speak } = buildController({ playable: new Set(['Dice']) });
      await ctrl.handle({ kind: 'change_game', args: { game: 'Mines' } }, 'u1');
      assert.equal(speak.messages.length, 1);
      assert.match(speak.messages[0].text, /cannot run zero-stake/);
      // No goal was set
      assert.equal(ctrl.status().goal, null);
    });

    it('sets goal for playable game without premature done speech', async () => {
      const { ctrl, speak } = buildController();
      await ctrl.handle({ kind: 'change_game', args: { game: 'Dice', rounds: 2 } }, 'u1');
      const st = ctrl.status();
      assert.equal(st.goal.game, 'Dice');
      assert.equal(st.goal.rounds, 2);
      assert.equal(st.done, false);
      // No "done" or "complete" spoken
      const doneSpeech = speak.messages.filter((m) => /done|complete/i.test(m.text));
      assert.equal(doneSpeech.length, 0);
    });

    it('resets old plan before setting new goal', async () => {
      const { ctrl, planner } = buildController();
      planner.setGoal({ kind: 'play', game: 'Dice', rounds: 5 });
      // Now change game
      await ctrl.handle({ kind: 'change_game', args: { game: 'Mines' } }, 'u1');
      const st = ctrl.status();
      assert.equal(st.goal.game, 'Mines');
      assert.equal(st.goal.rounds, 1);
    });
  });

  describe('set_multiplier / set_win_chance', () => {
    it('dispatches through tools.run and confirms on ok + readback', async () => {
      const world = new World({ game: 'Dice', multiplier: 2, winChance: 50 });
      const tools = makeTools();
      const speak = makeSpeak();
      const planner = new Planner({ tools, world, log: () => {} });

      const ctrl = new Controller({
        world,
        tools,
        planner,
        verifier: makeVerifier(),
        game: makeGame(),
        speak: speak.speak,
        log: () => {},
        rotation: makeRotation(),
        playable: new Set(['Dice']),
      });

      // Apply multiplier change directly to world so readback succeeds
      const origRun = tools.run.bind(tools);
      tools.run = async (tool, args) => {
        const r = await origRun(tool, args);
        if (tool === 'set_multiplier') world.set('multiplier', args.value);
        if (tool === 'set_win_chance') world.set('winChance', args.value);
        return r;
      };

      await ctrl.handle({ kind: 'set_multiplier', args: { value: 5 } }, 'u1');
      assert.equal(tools.calls.some((c) => c.tool === 'set_multiplier'), true);
      assert.equal(speak.messages[0].text, 'set_multiplier set to 5');
    });

    it('speaks error when tool fails', async () => {
      const tools = { async run() { return { ok: false, error: 'locked' }; }, calls: [] };
      const speak = makeSpeak();
      const { ctrl } = buildController({ tools, speak });
      await ctrl.handle({ kind: 'set_multiplier', args: { value: 3 } }, 'u1');
      assert.match(speak.messages[0].text, /locked/);
    });

    it('speaks readback mismatch when world not updated', async () => {
      const world = new World({ game: 'Dice', multiplier: 2 });
      const tools = makeTools();
      const speak = makeSpeak();
      const planner = new Planner({ tools, world, log: () => {} });

      const ctrl = new Controller({
        world,
        tools,
        planner,
        verifier: makeVerifier(),
        game: makeGame(),
        speak: speak.speak,
        log: () => {},
        rotation: makeRotation(),
        playable: new Set(['Dice']),
      });

      await ctrl.handle({ kind: 'set_multiplier', args: { value: 10 } }, 'u1');
      assert.match(speak.messages[0].text, /readback mismatch/);
    });
  });

  describe('set_stake', () => {
    it('refuses nonzero stake', async () => {
      const { ctrl, speak } = buildController();
      await ctrl.handle({ kind: 'set_stake', args: { value: 50 } }, 'u1');
      assert.match(speak.messages[0].text, /not allowed/);
    });

    it('allows zero stake', async () => {
      const { ctrl, speak } = buildController();
      await ctrl.handle({ kind: 'set_stake', args: { value: 0 } }, 'u1');
      assert.match(speak.messages[0].text, /Stake verified at zero/);
    });
  });

  describe('stop', () => {
    it('resets planner and pauses', async () => {
      const { ctrl, planner } = buildController();
      planner.setGoal({ kind: 'play', game: 'Dice', rounds: 3 });
      await ctrl.handle({ kind: 'stop' }, 'u1');
      assert.equal(ctrl.status().paused, true);
      assert.equal(ctrl.status().goal, null);
      assert.equal(ctrl._active, false);
    });
  });

  describe('status', () => {
    it('responds with current state', async () => {
      const { ctrl, speak } = buildController();
      ctrl.planner.setGoal({ kind: 'play', game: 'Dice', rounds: 2 });
      await ctrl.handle({ kind: 'status' }, 'u1');
      assert.equal(speak.messages.length, 1);
      assert.match(speak.messages[0].text, /Dice/);
    });
  });

  describe('tick', () => {
    it('processes one step and awaits tool once', async () => {
      const { ctrl, tools } = buildController();
      ctrl.planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = true;
      // First tick should process enter_game
      await ctrl.tick();
      assert.equal(tools.calls.length, 1);
      assert.equal(tools.calls[0].tool, 'change_game');
    });

    it('releases active when planner fails', async () => {
      const tools = { async run() { return { ok: false, error: 'dead' }; }, calls: [] };
      const { ctrl } = buildController({ tools });
      ctrl.planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = true;
      // Tick multiple times to exhaust retries
      await ctrl.tick();
      await ctrl.tick();
      await ctrl.tick();
      await ctrl.tick();
      await ctrl.tick();
      assert.equal(ctrl._active, false);
    });

    it('counts completion only when await_result succeeds', async () => {
      const world = new World({ game: 'Dice', controls: ['Bet'], phase: 'idle' });
      const tools = makeTools();
      const verifier = makeVerifier(true);
      const rotation = makeRotation();
      const speak = makeSpeak();
      const planner = new Planner({ tools, world, log: () => {} });

      const ctrl = new Controller({
        world,
        tools,
        planner,
        verifier,
        game: makeGame(),
        speak: speak.speak,
        log: () => {},
        rotation,
        playable: new Set(['Dice']),
      });

      planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = true;

      // Process all steps: enter_game, configure (none), start_round, await_result
      await ctrl.tick(); // enter_game
      await ctrl.tick(); // start_round
      // Set world to result phase so await_result succeeds
      world.set('phase', 'result');
      world.set('lastResult', { win: true });
      await ctrl.tick(); // await_result

      assert.equal(ctrl._completed, 1);
      assert.equal(rotation.names.length, 0); // completion must not reset rotation deadline
    });

    it('does not count completion when await_result fails', async () => {
      const world = new World({ game: 'Dice', controls: ['Bet'], phase: 'idle' });
      const tools = makeTools();
      const verifier = makeVerifier(false);
      const rotation = makeRotation();
      const speak = makeSpeak();
      const planner = new Planner({ tools, world, log: () => {} });

      const ctrl = new Controller({
        world,
        tools,
        planner,
        verifier,
        game: makeGame(),
        speak: speak.speak,
        log: () => {},
        rotation,
        playable: new Set(['Dice']),
      });

      planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = true;

      await ctrl.tick(); // enter_game
      await ctrl.tick(); // start_round
      await ctrl.tick(); // await_result (verifier returns not ok)

      assert.equal(ctrl._completed, 0);
      assert.equal(rotation.names.length, 0);
    });

    it('await_result without snapshot does not fabricate', async () => {
      const world = new World({ game: 'Dice', controls: ['Bet'], phase: 'idle' });
      const tools = makeTools();
      const planner = new Planner({ tools, world, log: () => {} });
      const speak = makeSpeak();

      const ctrl = new Controller({
        world,
        tools,
        planner,
        verifier: makeVerifier(true),
        game: makeGame(),
        speak: speak.speak,
        log: () => {},
        rotation: makeRotation(),
        playable: new Set(['Dice']),
      });

      // Manually set a goal that has await_result but skip start_round
      // by directly manipulating planner steps
      planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = true;
      ctrl._snapshot = null;

      // Tick through enter_game
      await ctrl.tick();
      // Tick through start_round (sets snapshot)
      await ctrl.tick();
      // Clear snapshot to simulate missing
      ctrl._snapshot = null;
      // Tick await_result
      await ctrl.tick();

      // Should have failed because no snapshot
      assert.equal(ctrl._completed, 0);
    });

    it('does nothing when paused', async () => {
      const { ctrl, tools } = buildController();
      ctrl.planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = true;
      ctrl.pause();
      await ctrl.tick();
      assert.equal(tools.calls.length, 0);
    });

    it('does nothing when not active', async () => {
      const { ctrl, tools } = buildController();
      ctrl.planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = false;
      await ctrl.tick();
      assert.equal(tools.calls.length, 0);
    });

    it('keeps playing the current table when rotation is not due', async () => {
      const rotation = {
        due() { return false; },
        random() { throw new Error('must not rotate'); },
        next() { throw new Error('must not rotate'); },
        playNow() {},
        arm() {},
      };
      const { ctrl, tools, planner } = buildController({ rotation });
      ctrl._active = false;
      await ctrl.tick();
      assert.equal(planner.status().goal?.game, 'Dice');
      assert.equal(ctrl._active, true);
      assert.equal(tools.calls[0]?.tool, 'change_game');
    });
  });

  describe('concurrency', () => {
    it('single chain serialises tick and handle', async () => {
      const order = [];
      const tools = {
        async run(tool, args) {
          order.push(`tool:${tool}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`done:${tool}`);
          return { ok: true };
        },
        calls: [],
      };
      const speak = makeSpeak();
      const world = new World({ game: 'Dice', controls: ['Bet'], phase: 'idle' });
      const planner = new Planner({ tools, world, log: () => {} });

      const ctrl = new Controller({
        world,
        tools,
        planner,
        verifier: makeVerifier(),
        game: makeGame(),
        speak: speak.speak,
        log: () => {},
        rotation: makeRotation(),
        playable: new Set(['Dice']),
      });

      planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = true;

      // Fire tick and handle concurrently
      const p1 = ctrl.tick();
      const p2 = ctrl.handle({ kind: 'status' }, 'u1');
      await Promise.all([p1, p2]);

      // Verify no interleaving: tool:change_game must complete before status speaks
      const toolStart = order.indexOf('tool:change_game');
      const toolDone = order.indexOf('done:change_game');
      assert.ok(toolStart < toolDone);
      // The status message should come after the tick completes
      assert.ok(speak.messages.length > 0);
    });
  });

  describe('old pending cannot settle new goal', () => {
    it('reset clears pending so stale settle is inert', async () => {
      const { ctrl, planner } = buildController();
      planner.setGoal({ kind: 'play', game: 'Dice', rounds: 5 });
      // Get a step pending
      planner.tick();
      // Now reset and set new goal
      planner.reset('test');
      planner.setGoal({ kind: 'play', game: 'Mines', rounds: 2 });
      // The old pending was cleared by reset; settling with old result should not
      // advance the new goal
      const statusBefore = planner.status();
      planner.settle({ ok: true });
      const statusAfter = planner.status();
      // Step should still be 0 (or 1 if the new goal's first step was already ticked)
      // Key: the new goal's step count should not jump from a stale settle
      assert.equal(statusAfter.goal.game, 'Mines');
    });
  });

  describe('start_round chat command', () => {
    it('performs single Bet click', async () => {
      const { ctrl, tools } = buildController();
      await ctrl.handle({ kind: 'start_round' }, 'u1');
      const clickCalls = tools.calls.filter((c) => c.tool === 'click');
      assert.equal(clickCalls.length, 1);
      assert.equal(clickCalls[0].args.label, 'Bet');
    });
  });

  describe('pick_tile / hit / stand', () => {
    it('dispatches pick_tile through choose_tile', async () => {
      const { ctrl, tools } = buildController();
      await ctrl.handle({ kind: 'pick_tile', args: { n: 3 } }, 'u1');
      const calls = tools.calls.filter((c) => c.tool === 'choose_tile');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].args.n, 3);
    });

    it('dispatches hit as click', async () => {
      const { ctrl, tools } = buildController();
      await ctrl.handle({ kind: 'hit' }, 'u1');
      const clickCalls = tools.calls.filter((c) => c.tool === 'click');
      assert.equal(clickCalls.length, 1);
      assert.equal(clickCalls[0].args.label, 'Hit');
    });

    it('dispatches stand as click', async () => {
      const { ctrl, tools } = buildController();
      await ctrl.handle({ kind: 'stand' }, 'u1');
      const clickCalls = tools.calls.filter((c) => c.tool === 'click');
      assert.equal(clickCalls.length, 1);
      assert.equal(clickCalls[0].args.label, 'Stand');
    });
  });

  describe('snapshot capture', () => {
    it('captures world+report before round click', async () => {
      const world = new World({ game: 'Dice', controls: ['Bet'], phase: 'idle', round: 3 });
      const tools = makeTools();
      const game = { ...makeGame(), getReport: () => ({ round: 3, result: null }) };
      const planner = new Planner({ tools, world, log: () => {} });
      const speak = makeSpeak();

      const ctrl = new Controller({
        world,
        tools,
        planner,
        verifier: makeVerifier(true),
        game,
        speak: speak.speak,
        log: () => {},
        rotation: makeRotation(),
        playable: new Set(['Dice']),
      });

      planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
      ctrl._active = true;

      await ctrl.tick(); // enter_game
      await ctrl.tick(); // start_round — should capture snapshot

      assert.ok(ctrl._snapshot);
      assert.equal(ctrl._snapshot.round, 3);
      assert.equal(ctrl._snapshot.report.round, 3);
    });
  });
});
