// Delayed-ramp scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window's tape shows (24h, 1,222 launches, 128,058 events):
// a launch's first move is violent and fast — the median coin is already +17%
// over its create price 5 slots in and peaks around 7 slots — and then it
// decays back toward its create price over the next few hundred slots. The
// house momentum pilot (-9.49 SOL) loses by chasing that move after it has
// printed. Buying the opening seconds loses too: at age 3-5 the tape is too
// thin to tell a real crowd from noise, and the fill lands two slots later,
// after the ramp. This bot instead waits for the delayed ramp: a coin that
// is STILL near its create price (at most +18% over create) at 12-25 slots
// old, with a real crowd already on the tape (at least 5 distinct buyers, 6
// trades, 0.3 SOL of net inflow) and real SOL reserves of 2-80, has not
// pumped yet but has the buyers to do it. Buy one small fixed stake.
//
// The harness caps each batch's buys at 1% of a coin's real SOL reserve, so
// the first buy on a young coin is always small. When the position is already
// up at least +12% and fresh net SOL keeps flowing in, the reserve has grown
// and the bot adds up to twice (0.1 SOL each) — winners get real size, losers
// stay probes. No coin is ever entered twice and no loser is averaged down.
//
// Exits, checked every batch against the curve's latest reserves: take half
// at +25%, take the rest at +60%, cut at -10%, trail once +30% up (sell on
// a 15% fall from the peak value), leave at once when the creator sells or a
// single >= 1 SOL sell lands, and never hold longer than 60 slots. The 60-slot
// hold matters: cutting it to 45 slots collapses the result, because the
// winners need that long to run.
//
// Two ideas were tried and dropped because the tape rejects them: a dip mode
// (buy the pullback of a coin that spiked >= +40% early) never fires with a
// strict gate and loses ~0.07 SOL with a loose one, and a top-buyer-share
// filter (largest buyer under 30% of buy SOL) cuts the trip count in half
// and flips the second half negative.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration
// only over insertion-ordered maps fed by the batch stream. Money math is
// bigint lamports; floats are only for the run-up ratios and the sizing
// thresholds, never for an exit decision (those compare bigint value
// against bigint cost).

import type { Batch, Bot, BotState, Done, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a buy may be decided. */
  entryMinAge: number;
  /** Oldest age (slots since CreateEvent) at which a buy may be decided. */
  entryMaxAge: number;
  /** Distinct non-creator buyers the tape must show. */
  minBuyers: number;
  /** Trades the tape must show. */
  minTrades: number;
  /** Net buy SOL (buys minus sells) the tape must show. */
  minNetSol: number;
  /** Price now over the create price, in bps, at most: the coin must not have pumped yet. */
  maxRunUpBps: number;
  /** Real SOL reserve window at decision time. */
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
  /** Add to a winning position while it rises and money keeps flowing in. */
  addOn: boolean;
  /** SOL per add-on buy. */
  addSol: number;
  /** An add needs the position's value at least this far (bps) over its cost. */
  addIfUpBps: number;
  /** An add needs net SOL inflow since the entry of at least this. */
  addNetSol: number;
  /** Most add-on buys per position. */
  maxAdds: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMinAge: 12,
  entryMaxAge: 25,
  minBuyers: 5,
  minTrades: 6,
  minNetSol: 0.3,
  maxRunUpBps: 1800,
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
  maxHold: 60,
  exitOnDevSell: true,
  bigSellSol: 1.0,
  staleSlots: 300,
  maxPositions: 5,
  addOn: true,
  addSol: 0.1,
  addIfUpBps: 1200,
  addNetSol: 0.2,
  maxAdds: 2,
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
  bought: bigint;
  sold: bigint;
  devSold: boolean;
  bigSell: boolean;
  lastTradeSlot: number;
  /** An entry was sent for this coin (one shot per coin, win or lose). */
  entered: boolean;
}

interface Open {
  openedSlot: number;
  peakValue: bigint;
  tookTp1: boolean;
  /** Net bought-minus-sold lamports when the entry buy was sent. */
  entryNet: bigint;
  /** Decision price (vq/vt) of the entry buy. */
  entryPrice: number;
  adds: number;
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
        bought: 0n,
        sold: 0n,
        devSold: false,
        bigSell: false,
        lastTradeSlot: -1,
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
            if (e.user !== t.creator) t.buyers.add(e.user);
          } else {
            t.sold += sol;
            if (e.user === t.creator) t.devSold = true;
            if (Number(sol) / 1e9 >= p.bigSellSol) t.bigSell = true;
          }
          touched.add(e.mint);
        }
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

      // ---- Add-ons: scale into working positions while they rise. ----
      // The harness caps each batch's buys at 1% of a coin's real SOL reserve,
      // so the first buy on a young coin is always small. When the position is
      // already up and fresh net SOL keeps flowing in, the reserve has grown
      // and a further buy can take real size — winners get bigger, losers stay
      // probes. At most maxAdds adds per position, ever.
      let free = state.freeCashLamports();
      let slotsLeft = p.maxPositions - state.committedPositionCount();
      if (p.addOn) {
        for (const [mint, o] of open) {
          if (orders.length >= cap) break;
          const pos = state.positions.get(mint);
          const curve = state.curves.get(mint);
          if (pos === undefined || curve === undefined || curve.complete) continue;
          if (pendingByMint.has(mint)) continue;
          if (o.adds >= p.maxAdds) continue;
          const tokens = pos.token_amount;
          const cost = pos.cost_lamports;
          const value = sellValue(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves) - txFee;
          if (value < (cost * (BPS + BigInt(p.addIfUpBps))) / BPS) continue;
          const t = tapes.get(mint);
          if (t === undefined) continue;
          if (Number(t.bought - t.sold - o.entryNet) / 1e9 < p.addNetSol) continue;
          const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          if (priceNow < o.entryPrice) continue;
          let amount = BigInt(Math.floor(p.addSol * 1e9));
          const capLamports = state.maxBuyLamports(mint);
          if (amount > capLamports) amount = capLamports;
          if (amount > free - txFee) amount = free - txFee;
          if (amount < BigInt(Math.floor(p.minBuySol * 1e9))) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          buysSent++;
          free -= amount + txFee;
          o.adds++;
          pendingByMint.set(mint, 'buy');
        }
      }

      // ---- Entries: one fixed-stake shot per coin that has not pumped yet. ----
      for (const mint of touched) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || open.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined || t.entered || t.createSlot < 0) continue;
        if (t.devSold) continue;
        const age = now - t.createSlot;
        if (age < p.entryMinAge || age > p.entryMaxAge) continue;
        const rqSol = Number(curve.real_quote_reserves) / 1e9;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        if (t.buyers.size < p.minBuyers || t.trades < p.minTrades) continue;
        const netSol = Number(t.bought - t.sold) / 1e9;
        if (netSol < p.minNetSol) continue;
        const r = runUpBps(t, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (r < 0 || r > p.maxRunUpBps) continue;
        const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
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
        open.set(mint, { openedSlot: now, peakValue: 0n, tookTp1: false, entryNet: t.bought - t.sold, entryPrice: priceNow, adds: 0 });
        pendingByMint.set(mint, 'buy');
      }
      return orders;
    },

    onDone(state: BotState, done: Done): void {
      const cash = Number(state.cash) / 1e9;
      console.error(`delayed-ramp done: cash ${cash.toFixed(6)} SOL, buys sent ${buysSent}, sells sent ${sellsSent}`);
    },
  };
}
