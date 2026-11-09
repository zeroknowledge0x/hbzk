# Per-game play policy

Measured 2026-11-08 with an offline table probe (`scripts/probe-tables.mjs`) that opened
every House Games card at stake `$0.00` and recorded the visible controls. Raw frames and
account-bearing screenshots stay in the private evidence repo; this file is the code-facing
summary.

One owner of clicks: `src/core/controller.js` asks the table's own policy for one measured
action, then verifies that action is visible before clicking it.

## Buttons actually on the table

| Table | Start | Settings chips | In-round | Cash out |
| --- | --- | --- | --- | --- |
| Dice | `Bet` | `Over` `Under` `Inside` `Outside` | — | no |
| Mines | `Bet` | — | `Tile 1`..`Tile 25`, `Random tile` | yes, after progress |
| Plinko | `Bet` | `Low` `Medium` `High` | — | no |
| Keno | `Bet` | `Classic` `Low` `Medium` `High` | `Auto pick numbers at random (R)`, `N Number N` | no |
| Wheel | `Bet` | `Low` `Medium` `High` | — | no |
| Limbo | `Bet` | `1.5x` `5x` `10x` `100x` (current target chip `2x`) | — | no |
| Max Win | `Bet` | `Standard 1,000×` mode chip | — | no |
| Dragon Tower | `Bet` | difficulty chip | `Random pick a random tile on the next floor (R)`, `Floor N, tile M` | yes, after progress |
| Hilo | none | — | `Higher / same` `Lower / same` `Skip card` | yes (`Cash out $ 0.00`) |
| Blackjack | `Bet` | `1` `2` `3` boxes | `Hit` `Stand` `No thanks` after the deal | no |
| Hubie's Road | `Bet` or `Go` | `Easy` `Medium` `Hard` `Daredevil` | lane tiles, `Cash out $ 0.00` | yes, after progress |
| Crash | no lobby card | — | chat `crash` maps to Limbo | — |

Two traps the probe exposed, both now covered by tests:

- `Bet Amount 0.00` and `2× Double bet amount (S)` sit next to the real `Bet`. A bare
  prefix match treats them as the play button, which is how the host opened the bet editor
  instead of rolling. `src/core/adapters/policy-helpers.js` and
  `src/core/play-labels.js` both refuse any label containing
  `info|history|rules|fair|help|amount|halve|double|wallet`.
- `Half` and `2×` are stake controls. They are never clicked; stake stays 0.

## Code per table

| Table | Policy | Note |
| --- | --- | --- |
| Dice | `adapters/dice-policy.js` | mode chip, then `Bet`. Never a cashout. |
| Mines | `adapters/mines-policy.js` | `Bet` starts and picks a tile; cash out with probability once tiles are revealed. |
| Plinko | `adapters/plinko-policy.js` | risk chip, then `Bet` |
| Keno | `adapters/keno-policy.js` | risk chip, then Auto pick or numbers read off the board |
| Wheel | `adapters/wheel-policy.js` | risk chip, then `Bet` |
| Limbo | `adapters/limbo-policy.js` | one target preset (`1.5x`/`5x`/`10x`/`100x`), then `Bet`. The target is not a payout. |
| Max Win | `adapters/maxwin-policy.js` | `Bet` only; no invented jackpot number |
| Dragon Tower | `adapters/dragon-tower-policy.js` | `Bet`, then `Random pick` or a tile, cash out after a climb |
| Hilo | `adapters/hilo-policy.js` | `Bet` while the table is idle, then `Higher / same`, `Lower / same`, occasionally `Cash out`; `Skip card` is the fallback |
| Blackjack | `adapters/blackjack-policy.js` | `Bet`/`Deal`, then `Hit` or `Stand`; `No thanks` dismisses insurance |
| Hubie's Road | `adapters/hubie-road-policy.js` | `Bet`/`Go`, then lanes, cash out after progress |

## Progress is observed, never counted

`src/core/progress.js` derives how far a round has gone from the board on screen, not from
how many clicks were sent:

- Mines: a 25-cell board that shows 23 pickable tiles has two safe reveals behind it.
- Dragon Tower / Hubie's Road: cleared floors and lanes leave the grid, so the lowest step
  still visible is the next one.
- Unknown is `0`, so a cashout never fires before a round has actually progressed.

## Rounds are spaced, not spammed

After a goal settles the controller waits a random 6-15 s before starting the next one, so a
table whose round is a single click (Hilo `Bet`, Dice `Bet`) does not replay every two
seconds. A game a viewer asked for in chat jumps the wait.

## Verify

```bash
npm test                                        # full offline suite
node --test test/per-game-policies.test.js      # one policy per table
node --test test/per-game-controller.test.js    # the click the controller is allowed to make
node --test test/progress.test.js               # observed progress reads
```

`scripts/probe-tables.mjs` re-measures the live tables when the site changes. It writes
PNGs and a `report.json` to the local scratch dir; the screenshots belong in the private
evidence repo, not here.

## Rollback

Revert `src/core/adapters/*-policy.js`, `src/core/adapters/policy-helpers.js`,
`src/core/progress.js`, and the per-game block in `src/core/controller.js` in one commit.
