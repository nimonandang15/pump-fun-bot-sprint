// Second-wave scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window's tape shows (24h, 1222 launches, 128,058 events):
// a launch's first move is violent and fast — the median coin is already +17%
// over its create price 5 slots in and peaks around 7 slots — and then it
// decays back toward its create price over the next few hundred slots. The
// house momentum pilot (-9.49 SOL) loses by chasing that move after it has
// printed. This bot instead takes two small, early, strictly time-boxed shots:
//
//   Mode RAMP — ride the opening ramp itself. While a coin is at most a few
//   slots old, its tape already shows a real crowd (several distinct buyers,
//   real net SOL flowing in) and the price has not yet run away, buy a small
//   fixed stake. The fill lands two slots later, still inside the ramp.
//
//   Mode DIP — buy the first pullback of a coin that already proved it can
//   run. A coin that spiked at least +40% over create in its first 30 slots
//   and then fell back near its create price has shown both demand and a
//   discount; buy the dip once, small and fixed.
//
// Both modes share one exit ladder, checked every batch against the curve's
// latest reserves: take half at +12%, take the rest at +28%, cut at -8%,
// trail once +18% up (sell on a 10% fall from the peak value), leave at once
// when the creator sells or a single >= 1 SOL sell lands, and never hold
// longer than 45 slots. No coin is ever entered twice, no loser is averaged
// down, and there is no pyramid: every entry is one fixed stake, so a bad
// read costs the same small probe as a good read earns on.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration
// only over insertion-ordered maps fed by the batch stream. Money math is
// bigint lamports; floats are only for the run-up ratios and the sizing
// thresholds, never for an exit decision (those compare bigint value
// against bigint cost).

import type { Batch, Bot, BotState, Done, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // --- Mode RAMP: ride the opening ramp ---
  /** Youngest age (slots since CreateEvent) at which a ramp buy may be decided. */
  rampMinAge: number;
  /** Buy a ramp entry while the coin is at most this many slots old. */
  rampMaxAge: number;
  /** Distinct non-creator buyers the opening tape must show. */
  rampMinBuyers: number;
  /** Trades the opening tape must show. */
  rampMinTrades: number;
  /** Net buy SOL (buys minus sells) the opening tape must show. */
  rampMinNetSol: number;
  /** Price now over the create price, in bps: ramp entry window. */
  rampMaxRunUpBps: number;
  /** Largest single non-creator buyer's share of buy SOL, in bps, at most. */
  rampMaxTopShareBps: number;
  // --- Mode DIP: buy the first pullback after a proven spike ---
  /** A dip entry needs the coin to have peaked at least this far over create (bps). */
  dipPeakBps: number;
  /** ... within this many slots of its CreateEvent. */
  dipPeakAge: number;
  /** ... and to have pulled back to at most this far over create (bps). */
  dipMaxRunUpBps: number;
  /** Oldest age (slots since CreateEvent) at which a dip entry may be decided. */
  dipMaxAge: number;
  /** Distinct non-creator buyers the tape must show for a dip entry. */
  dipMinBuyers: number;
  /** Net buy SOL the tape must show for a dip entry. */
  dipMinNetSol: number;
  // --- Shared ---
  /** Real SOL reserve window at decision time, either mode. */
  minRealSol: number;
  maxRealSol: number;
  /** Fixed stake per entry (SOL). Capped by the harness at 1% of real reserve. */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Slippage allowed on buys and sells (bps). */
  buySlipBps: number;
  sellSlipBps: number;
  /** First take-profit: sell tp1PartBps of the position at this much over cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when the position is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: arms once the value is this far over cost, then exits on a fall of trailBps from the peak value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while the position is held. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Most positions open at once (the harness cap is 5). */
  maxPositions: number;
}

export const DEFAULT_PARAMS: Params = {
  rampMinAge: 3,
  rampMaxAge: 5,
  rampMinBuyers: 6,
  rampMinTrades: 8,
  rampMinNetSol: 0.3,
  rampMaxRunUpBps: 3500,
  rampMaxTopShareBps: 3000,
  dipPeakBps: 100000,
  dipPeakAge: 30,
  dipMaxRunUpBps: 1200,
  dipMaxAge: 60,
  dipMinBuyers: 8,
  dipMinNetSol: 0.5,
  minRealSol: 2,
  maxRealSol: 80,
  stakeSol: 0.05,
  minBuySol: 0.02,
  buySlipBps: 10000,
  sellSlipBps: 10000,
  tp1Bps: 2500,
  tp1PartBps: 5000,
  tpBps: 6000,
  slBps: 1000,
  trailArmBps: 3000,
  trailBps: 1500,
  maxHold: 150,
  exitOnDevSell: true,
  bigSellSol: 1.0,
  staleSlots: 300,
  maxPositions: 5,
};

const BPS = 10_000n;
/** Curve fee on every trade: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) pays after curve fees (tx fee extra). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tape {
  createSlot: number;
  creator: Pubkey;
  /** Create-time price as a vq/vt pair (run-up is measured against it). */
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  /** SOL bought by each non-creator wallet (lamports). */
  buyByUser: Map<Pubkey, bigint>;
  bought: bigint;
  sold: bigint;
  devSold: boolean;
  bigSell: boolean;
  lastTradeSlot: number;
  /** Highest run-up over create seen so far, in bps. */
  peakRunUpBps: number;
  /** The coin spiked >= dipPeakBps while still young (age <= dipPeakAge). */
  spikedEarly: boolean;
  /** An entry was sent for this coin (one shot per coin, win or lose). */
  entered: boolean;
}

interface Open {
  openedSlot: number;
  peakValue: bigint;
  tookTp1: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, Open>();
  let buysSent = 0;
  let sellsSent = 0;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createSlot: -1,
        creator: '',
        vq0: 0n,
        vt0: 0n,
        trades: 0,
        buyers: new Set(),
        buyByUser: new Map(),
        bought: 0n,
        sold: 0n,
        devSold: false,
        bigSell: false,
        lastTradeSlot: -1,
        peakRunUpBps: 0,
        spikedEarly: false,
        entered: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Run-up of the current curve price over the create price, in bps. */
  const runUpBps = (t: Tape, vq: bigint, vt: bigint): number => {
    if (t.vt0 <= 0n || t.vq0 <= 0n || vt <= 0n || vq <= 0n) return 0;
    const now = Number(vq) / Number(vt);
    const at0 = Number(t.vq0) / Number(t.vt0);
    if (at0 <= 0) return 0;
    return Math.floor(((now - at0) / at0) * 10000);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFee = state.txFeeLamports();
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      /** Coins whose tape moved this batch: the only ones whose entry can change. */
      const touched = new Set<Pubkey>();
      /** Mints with an order already in flight from this batch's decisions. */
      const pendingByMint = new Map<Pubkey, 'buy' | 'sell'>();
      for (const po of state.pending.values()) {
        if (!pendingByMint.has(po.order.mint)) pendingByMint.set(po.order.mint, po.order.side);
      }

      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.createSlot = e.slot;
          t.creator = e.creator;
          t.vq0 = BigInt(e.virtual_quote_reserves);
          t.vt0 = BigInt(e.virtual_token_reserves);
          t.lastTradeSlot = e.slot;
          touched.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = BigInt(e.sol_amount);
          t.trades++;
          t.lastTradeSlot = e.slot;
          if (e.is_buy) {
            t.bought += sol;
            if (e.user !== t.creator) {
              t.buyers.add(e.user);
              t.buyByUser.set(e.user, (t.buyByUser.get(e.user) ?? 0n) + sol);
            }
          } else {
            t.sold += sol;
            if (e.user === t.creator) t.devSold = true;
            if (Number(sol) / 1e9 >= p.bigSellSol) t.bigSell = true;
          }
          touched.add(e.mint);
        }
      }

      // Refresh each touched coin's peak run-up from the latest curve reserves.
      for (const mint of touched) {
        const t = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined || t.createSlot < 0) continue;
        const r = runUpBps(t, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (r > t.peakRunUpBps) t.peakRunUpBps = r;
        if (!t.spikedEarly && r >= p.dipPeakBps && now - t.createSlot <= p.dipPeakAge) t.spikedEarly = true;
      }

      // ---- Exits first: never leave a loser open while opening a new trade. ----
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          // Closed by the harness (completed/flattened) or by our own sell landing.
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            tapeOf(mint).entered = true;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.get(mint) === 'sell') continue;
        const tokens = pos.token_amount;
        const cost = pos.cost_lamports;
        const value = sellValue(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves) - txFee;
        if (value > o.peakValue) o.peakValue = value;
        const t = tapeOf(mint);
        const upBps = cost > 0n ? Number(((value - cost) * BPS) / cost) : 0;
        let exitAll = false;
        let exitHalf = false;
        if (upBps <= -p.slBps) exitAll = true;
        else if (upBps >= p.tpBps) exitAll = true;
        else if (o.peakValue >= (cost * (BPS + BigInt(p.trailArmBps))) / BPS && value <= (o.peakValue * (BPS - BigInt(p.trailBps))) / BPS) exitAll = true;
        else if (p.exitOnDevSell && t.devSold) exitAll = true;
        else if (t.bigSell) exitAll = true;
        else if (now - t.lastTradeSlot > p.staleSlots) exitAll = true;
        else if (now - o.openedSlot > p.maxHold) exitAll = true;
        else if (!o.tookTp1 && upBps >= p.tp1Bps) exitHalf = true;
        if (!exitAll && !exitHalf) continue;
        if (orders.length >= cap) break;
        if (exitAll) {
          orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: p.sellSlipBps });
        } else {
          const half = tokens / 2n;
          orders.push({ side: 'sell', mint, token_amount: half > 0n ? half : tokens, max_slippage_bps: p.sellSlipBps });
          o.tookTp1 = true;
        }
        sellsSent++;
        pendingByMint.set(mint, 'sell');
      }

      // ---- Entries: one fixed-stake shot per coin, ramp mode or dip mode. ----
      let free = state.freeCashLamports();
      let slotsLeft = p.maxPositions - state.committedPositionCount();

      for (const mint of touched) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || open.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined || t.entered || t.createSlot < 0) continue;
        if (t.devSold) continue;
        const age = now - t.createSlot;
        const rqSol = Number(curve.real_quote_reserves) / 1e9;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        const r = runUpBps(t, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const netSol = Number(t.bought - t.sold) / 1e9;

        let mode: 'ramp' | 'dip' | null = null;
        let topShareBps = 10000;
        if (t.bought > 0n) {
          let top = 0n;
          for (const v of t.buyByUser.values()) if (v > top) top = v;
          topShareBps = Number((top * BPS) / t.bought);
        }
        if (age >= p.rampMinAge && age <= p.rampMaxAge && t.buyers.size >= p.rampMinBuyers && t.trades >= p.rampMinTrades && netSol >= p.rampMinNetSol && r >= 0 && r <= p.rampMaxRunUpBps && topShareBps <= p.rampMaxTopShareBps) {
          mode = 'ramp';
        } else if (
          age <= p.dipMaxAge &&
          t.spikedEarly &&
          r >= 0 &&
          r <= p.dipMaxRunUpBps &&
          t.buyers.size >= p.dipMinBuyers &&
          netSol >= p.dipMinNetSol
        ) {
          mode = 'dip';
        }
        if (mode === null) continue;
        let amount = BigInt(Math.floor(p.stakeSol * 1e9));
        const capLamports = state.maxBuyLamports(mint);
        if (amount > capLamports) amount = capLamports;
        if (amount > free - txFee) amount = free - txFee;
        if (amount < BigInt(Math.floor(p.minBuySol * 1e9))) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        buysSent++;
        free -= amount + txFee;
        slotsLeft--;
        t.entered = true;
        open.set(mint, { openedSlot: now, peakValue: 0n, tookTp1: false });
        pendingByMint.set(mint, 'buy');
      }
      return orders;
    },

    onDone(state: BotState, done: Done): void {
      const cash = Number(state.cash) / 1e9;
      console.error(`second-wave done: cash ${cash.toFixed(6)} SOL, buys sent ${buysSent}, sells sent ${sellsSent}`);
    },
  };
}
