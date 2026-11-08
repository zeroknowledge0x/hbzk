# Core contracts (v1)

Every module below is plain ESM, no dependencies, and must be importable without side
effects. Tests live in `test/core-*.test.js` and run under `node --test`.

## Event bus — `src/core/bus.js`

```js
const bus = new Bus({ log });
bus.on('world', fn);            // fn(payload) — may be async, errors are caught+logged
bus.emit('world', payload);     // fire and forget, returns count of handlers
await bus.drain();              // wait for in-flight async handlers (tests + shutdown)
```

Events used by the host:

| Event | Payload | Emitted by |
| --- | --- | --- |
| `perception` | `{ at, state }` | perception loop |
| `world` | world snapshot | `World.apply` |
| `chat` | `{ id, name, text, at }` | chat ingest |
| `intent` | `{ kind, args, msg, score }` | intent router |
| `plan` | `{ goal, steps }` | planner |
| `action` | `{ tool, args, ok, ms }` | tools |
| `speak` | `{ text, kind }` | tools/host |
| `health` | `{ ok, issues[] }` | watchdog |

## World model — `src/core/world.js`

```js
const w = new World();
w.apply(perceptionState);       // merges, returns snapshot
w.get();                        // { game, round, phase, balance, multiplier, stake, controls[], lastResult, at }
w.can('bet');                    // boolean from phase + controls
w.set('game', 'Mines');          // optimistic local set (used between perceptions)
```

Rules: `phase` is one of `idle | betting | playing | result | unknown`. `controls` is the
list of labels the table currently offers. `apply` never regresses a newer `at`.

## Intents — `src/core/intents.js`

```js
parseIntent(text) -> null | { kind, args }
```

Kinds and args (all lowercase):

| kind | args | example |
| --- | --- | --- |
| `change_game` | `{ game }` | "switch to mines", "main hilo dong" |
| `set_multiplier` | `{ value }` | "multiplier 5x", "set payout to 4" |
| `set_win_chance` | `{ value }` | "win chance 30", "chance 20%" |
| `set_stake` | `{ value }` | "bet 50", "stake 0.01" |
| `cash_out` | `{}` | "cash out", "tarik" |
| `higher` / `lower` | `{}` | "higher", "lower", "naik", "turun" |
| `hit` / `stand` | `{}` | "hit", "stand", "tambah kartu", "stop" |
| `pick_tile` | `{ n }` | "tile 3", "pick 5" |
| `start_round` | `{}` | "roll", "bet", "deal", "spin", "gas" |
| `status` | `{}` | "what's the balance", "saldo" |
| `stop` | `{}` | "stop playing", "berhenti" |

`parseIntent` returns `null` for ordinary chat (no command). It must never throw.

## Priority — `src/core/priority.js`

```js
scoreMessage(msg, ctx) -> number  // 0..100
rankMessages(list, ctx) -> sorted copy
```

Signals: direct address (`hubie`, `@`), command intent, question mark, first-time viewer,
repeat penalty (same text seen recently), spam penalty (same author many times), recency.

## Safety — `src/core/safety.js`

```js
checkLine(text) -> { ok, reason? }     // before speaking
checkAction(intent) -> { ok, reason? } // before executing
```

Blocks: promises of profit, "guaranteed win", telling viewers to deposit, personal data,
slurs, and any stake change while `phase !== 'idle'`.

## Planner — `src/core/planner.js`

```js
const p = new Planner({ tools, world, bus, log });
p.setGoal({ kind: 'play', game: 'Dice', rounds: 2 });
p.tick();          // returns next step or null; host calls this on every world/chat event
p.status();        // { goal, step, done, failed }
```

A goal decomposes into steps: `enter_game` → `configure` → `start_round` → `await_result`
→ repeat until rounds exhausted. On a failed step it retries once, then falls back to
`enter_game` for the goal's game, then marks the goal failed and emits `plan` with the
failure.

## Tools — `src/core/tools.js`

```js
const t = new Tools({ game, world, bus, log });
await t.run('click', { label: 'Bet' });   // -> { ok, ms, error? }
```

Tools: `click`, `set_stake`, `set_multiplier`, `set_win_chance`, `choose_tile`,
`change_game`, `say`. Each tool declares `pre(world)` and `post(world, before)`. A tool
that cannot run returns `{ ok:false, error }` instead of throwing.

## Verifier — `src/core/verifier.js`

```js
const v = new Verifier({ world, game, log });
await v.waitFor('round_started', { timeout: 4000 });
```

Checks: `round_started` (phase became playing or round number changed), `round_result`
(lastResult changed), `bet_zero` (stake is the configured value), `game_is` (world.game).

## Adapters — `src/core/adapters/*.js`

```js
export default {
  name: 'Dice',
  slug: 'housegames-dice',
  settings: { multiplier: 'Number', winChance: 'Number' },
  startLabels: ['Bet', 'Roll'],
  async configure(tools, want) {},   // set multiplier / win chance when supported
  async start(tools) {},             // click the start control
  result(world) {},                  // -> null | { value, won, source }
};
```

Adapters are data + thin functions; they must not import `game.js`. Everything they need
arrives through `tools`.

## Host — `src/host.js`

Wires: perception → world → (priority | planner) → tools → verifier → (speak | render).
Keeps the existing `src/render.js`, `src/output.js`, `src/tts*.js`, `src/chat*.js`.
