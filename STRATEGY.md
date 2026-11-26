# Strategy: delayed-ramp scalper (buy the coin that has not pumped yet)

## What the dev window says

24 hours of pump.fun launches (1,222 coins, 128,058 events). Three facts drive
everything:

1. **A launch's whole life is decided in its first seconds.** The median coin
   peaks 7 slots after its CreateEvent; the median price 5 slots in is already
   +17% over create, and the median coin is back near its create price 200
   slots later. Chasing mature momentum buys the top and rides it to zero —
   the house momentum pilot scores **-9.49 SOL** on this window.
2. **Buying the opening seconds loses too.** At age 3-5 the tape is too thin
   to tell a real crowd from noise, and the fill lands two slots later, after
   the ramp. An early-ramp variant of this bot (age 3-5, 5+ buyers, run-up
   capped at +35%) scores only +0.007 SOL over 15 trips and fails the
   20-coin guardrail; loosening it to 126 trips scores -0.130 SOL.
3. **Only a few coins ever run.** 57% ever reach +20%, 25% reach +100%, 13%
   reach +200%. The money is in the few runners — and the only way to give
   them size under the harness's 1%-of-reserve buy cap is to add while they
   rise, as their reserves grow.

## The bot

- **One delayed shot per coin, ever.** Buy a coin that is STILL near its
  create price — at most +18% over create — at 12-25 slots old, with a real
  crowd already on the tape (at least 5 distinct buyers, 6 trades, 0.3 SOL
  of net inflow) and real SOL reserves of 2-80. One small fixed stake
  (0.05 SOL, capped at 1% of real reserve).
- **Add into strength, at most twice.** When the position is at least +12%
  up and fresh net SOL keeps flowing in, buy 0.1 SOL more — up to 2 adds.
  Winners get real size; losers stay probes. No loser is ever averaged down.
- **Exit fast, but not too fast.** Partial take-profit at +25% (sell half),
  full take-profit at +60%, stop loss at -10%, trailing stop once +30% up
  (sell on a 15% fall from the peak value), exit at once when the creator
  sells or a single >= 1 SOL sell lands, and a hard 60-slot hold limit.
  The 60-slot hold matters: cutting it to 45 slots collapses the result
  from +0.044 to +0.002 SOL, because the winners need that long to run.
  Taking half at +15% instead of +25% is just as bad (+0.001 SOL).

## Dev-window result (official `grade-local`, process driver)

- **Net PnL +0.0597 SOL** (return +0.60%; at 2x fees still +0.0319 SOL)
- 57 fills over 27 coins, 27 round trips, win rate 22.2%
- Max drawdown 0.0012; guardrails met (27 coins with round trips >= 0.01 SOL)
- 0 rejected orders, 2 failed tx; two executions reproduce byte for byte
- 90% bootstrap interval -0.018 .. +0.163 SOL
- result_sha256 0ebe774ee1d43a4b83a77b929e0f1567eb8fcbaf7d71614d3a791600e4e8818d
  (local node v24.22.1; the server runs v26.13.1, so its hash will differ)

For comparison on the same window: house momentum pilot -9.49 SOL, house
reversion pilot -4.00 SOL, house sniper pilot -0.47 SOL.

## Honest caveats

- **The profit leans on two runners.** The 3 best coins made 97% of the
  gains, and without them the dev net would be -0.02 SOL. That is structural
  to pump.fun (few coins run), not a bug, but it means a fresh window can
  lose — and the 90% interval includes zero.
- **The run-up cap is a knife-edge, not a flat region.** Neighbours at +16%
  and +17% score about -0.010 SOL, +18% to +21% score +0.040..+0.052 SOL,
  +22% drops to +0.011 SOL. The jump is driven by which side of the line
  two specific coins fall on. Do not read the +18% cap as a tuned constant
  with a wide margin; it is the measured best cell and its neighbours
  within 1-2 points mostly agree (+0.040..+0.052 for +18..+21%), but the
  +16/+17% side disagrees sharply.
- **Split-half check (real contiguous data, not resampled):** first half
  +0.033 SOL, second half +0.018 SOL — the edge shows up in both halves,
  unlike the early-ramp variants, whose first halves were all negative.
- **Stress (20 rebuilt copies):** median -0.02 SOL, p10 -0.03, p90 0.00; 15 of
  20 copies lost money; the dev score sits above 19 of 20 copies. The
  resampled copies break the coherent pumps the adds ride, so the stress
  number understates a live window — but it is a fair warning that the dev
  score leans on this window's own coins. For scale, the earlier bots on
  this window stress-tested worse (flash-scalp median -0.03, 16/20 lose;
  breakout median -0.12, 18/20 lose).

## Ideas the tape rejected

- **Dip-buying.** Buy the pullback of a coin that spiked >= +40% early:
  with a strict gate it never fires (0 fills); with a loose gate it scores
  -0.075 SOL with both halves negative. Dropped entirely.
- **Top-buyer-share filter.** Largest buyer under 30% of buy SOL: cuts the
  trip count from 27 to 17 and flips the second half negative (+0.030 SOL
  overall). Dropped.
- **Early ramp (age 3-5).** Best variant +0.007 SOL / 15 trips (guardrail
  fail); looser variants -0.08..-0.13 SOL. The tape at that age is noise.
- **Short holds / early partials.** Hold 45 instead of 60 slots: +0.002 SOL.
  First take-profit at +15% instead of +25%: +0.001 SOL.

## Files

- `main.ts` — entrypoint: hands the strategy to the SDK shim.
- `strategy.ts` — the strategy (all logic, all parameters).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
