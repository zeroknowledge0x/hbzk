# Table variety

Measured 2026-11-08 by clicking each House Games card. Stake stays 0. Half and 2× are stake buttons and are never clicked.

## Buttons

| Table | Start | Variety |
| --- | --- | --- |
| Dice | Bet | Over, Under, Inside, Outside |
| Mines | Bet | random tile, cash out only after a hit |
| Plinko | Bet | Low, Medium, High |
| Keno | Bet | Classic, Low, Medium, High, Auto pick or random numbers |
| Wheel | Bet | Low, Medium, High |
| Limbo | Bet | 1.5x, 2x, 5x, 10x, 100x |
| Max Win | Bet | Standard 1,000× mode is already on the table |
| Dragon Tower | Bet | Random pick, then cash out if the label is not $0.00 |
| Hilo | Higher, Lower, or Skip | no Bet button |
| Blackjack | Bet | Hit or Stand after the deal |
| Hubie's Road | Go | Easy, Medium, Hard, Daredevil |
| Crash | none | no lobby card; chat crash maps to Limbo |

## Talk

Quiet speech is a random 5–15 minute timer, even with zero viewers. A big win uses the settled payout (`keno-payhit` or `handle-row` at 3× or more), not the target multiplier field. Dice roll markers are not wins.

## Facts

`data/kb.sqlite` replaces `data/kb.json` when it has rows. Rebuild with `node scripts/build-kb.mjs`. Website and "apa kabar" are answered from `factReply` before the model.

## Review

`deepseek/deepseek-v4.1-flash` and `z-ai/glm-5.3-flash` were asked on the Command Code endpoint. Both spent the reply on reasoning and did not return a bullet list. The payout-vs-target bug was fixed in code anyway.

## Test

```
node --test test/variety.test.js
```

## Rollback

Revert `src/core/variety.js`, the controller variety block, and `data/kb.sqlite`.
