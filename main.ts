// pump-fun-bot-sprint: a second-wave scalper for the Pump.fun Bot Sprint
// (agent-fun/replay/v2). The strategy lives in strategy.ts; the SDK shim is
// the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The grader runs `node /bot/main.ts` (Node strips the types; no build step).
//
// Two small, early, time-boxed shots per launch: ride the opening ramp while
// the coin is a few slots old and the tape already shows a real crowd, or buy
// the first pullback of a coin that spiked >= +40% in its first 30 slots.
// One fixed stake per coin, never twice; exits are a staged ladder
// (half at +12%, rest at +28%, cut at -8%, trail after +18%, 45-slot hold
// limit). See STRATEGY.md for the dev-window numbers.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
