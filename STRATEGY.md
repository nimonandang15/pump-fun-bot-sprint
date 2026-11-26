# Strategy: second-wave scalper (ramp + dip, one fixed stake, fast exits)

## What the dev window says

24 hours of pump.fun launches (1,222 coins, 128,058 events). Two facts drive
everything:

1. **A launch's whole life is decided in its first seconds.** The median coin
   peaks 7 slots after its CreateEvent; the median price 5 slots in is already
   +17% over create, and the median coin is back near its create price 200
   slots later. Chasing mature momentum buys the top and rides it to zero —
   the house momentum pilot scores **-9.49 SOL** on this window.
2. **Only a few coins ever run.** 57% ever reach +20%, 25% reach +100%, 13%
   reach +200%. Most launches are losers; the money is in catching the few
   runners early, giving them a small fixed stake, and getting out fast.

## The bot

- **Two entry modes, one fixed stake per coin, ever.** RAMP: while a coin is
  at most 5 slots old, its tape already shows at least 4 distinct buyers, 4
  trades and 0.3 SOL of net inflow, and the price has run up at most +35%
  over create — buy 0.05 SOL. DIP: a coin that spiked at least +40% over
  create in its first 30 slots and has since pulled back to at most +12%
  over create, with at least 8 distinct buyers and 0.5 SOL net inflow,
  at most 60 slots old — buy 0.05 SOL. No scoring, no pyramid, no second
  entry on any coin.
- **Exit fast.** Partial take-profit at +12% (sell half), full take-profit
  at +28%, stop loss at -8%, trailing stop once +18% up (sell on a 10% fall
  from the peak value), exit at once when the creator sells or a single
  >= 1 SOL sell lands, and a hard 45-slot hold limit. No loser is ever
  averaged down.

## Dev-window result (official `grade-local`, process driver)

(To be filled after the first graded run.)

## Honest caveats

(To be filled after stress and split-half checks.)

## Files

- `main.ts` — entrypoint: hands the strategy to the SDK shim.
- `strategy.ts` — the strategy (all logic, all parameters).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
