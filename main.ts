// pump-fun-bot-sprint: a delayed-ramp scalper for the Pump.fun Bot Sprint
// (agent-fun/replay/v2). The strategy lives in strategy.ts; the SDK shim is
// the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The grader runs `node /bot/main.ts` (Node strips the types; no build step).
//
// One small, time-boxed shot per launch: buy a coin that is STILL near its
// create price (at most +18% over create) at 12-25 slots old, with a real
// crowd already on the tape (5+ distinct buyers, 6+ trades, 0.3+ SOL net
// inflow). Add up to twice into strength (0.1 SOL each, once +12% up with
// fresh inflow), and exit fast (half at +25%, rest at +60%, cut at -10%,
// trail after +30%, 60-slot hold limit). See STRATEGY.md for the dev-window
// numbers and the ideas the tape rejected (dip-buying, top-buyer filter).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
