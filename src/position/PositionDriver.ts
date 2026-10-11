import type { Position } from '../types.js';
import { isRefusal, errorText } from '../binance/remoteOrders.js';
import { formatPrice, roundPrice } from '../binance/symbolRules.js';
import { dec } from '../risk/primitives.js';
import {
  advance, initState, isStale, pmKey, revertReduce,
  type LotRules, type PmAction, type PmConfig, type PmInput, type PmState, type VolClass,
} from './PositionManager.js';
import type { PositionManagerStore } from './PositionManagerStore.js';

/** Per-symbol facts refreshed once per orchestrator cycle; prices come from the live tick on every manage pass. */
export interface SymbolFeatures {
  atr: number | null;
  vol: VolClass;
  /** Latest protected 15m swing low / high prices; the driver adds the ATR buffer on the side that protects the position. */
  swingLow?: number | null;
  swingHigh?: number | null;
  /** SuperTrend line and the only strategy whose positions it may tighten. */
  superTrend?: { agent: Position['strategy']; level: number } | null;
}

const SWING_BUFFER_ATR = 0.15;

/** What a venue reports for a partial: a venue that can fill less than asked says how much it did. */
export type ReduceResult = void | { executedQty?: number };

export interface PositionVenue {
  reducePosition(pos: Position, qty: number): Promise<ReduceResult>;
  /** May be asynchronous (a live venue replaces an exchange order); the driver waits for it and only then records the stop. */
  updateStops(symbol: string, strategy: Position['strategy'], stopLoss: number, takeProfit: number | null, side: Position['side']): void | Promise<void>;
}

export interface PositionDriverDeps {
  venue: PositionVenue;
  store: PositionManagerStore;
  cfg: PmConfig;
  lotOf(symbol: string): LotRules;
  log(agent: string, message: string, level: 'info' | 'warn' | 'error'): void;
  now?(): number;
}

/**
 * Applies PositionManager intents to a venue. Tick-driven: `manage` is cheap (no indicator work, features are cached),
 * serialised per position so the 250 ms tick and the 8 s cycle can never act on the same state at once.
 */
export class PositionDriver {
  private readonly features = new Map<string, SymbolFeatures>();
  private readonly busy = new Set<string>();

  constructor(private readonly deps: PositionDriverDeps) {}

  setFeatures(symbol: string, features: SymbolFeatures): void {
    this.features.set(symbol, features);
  }

  async manage(positions: readonly Position[]): Promise<void> {
    const { store } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const live = new Set(positions.map((p) => pmKey(p.symbol, p.strategy)));
    for (const key of store.keys()) if (!live.has(key)) store.delete(key);
    for (const pos of positions) {
      const key = pmKey(pos.symbol, pos.strategy);
      if (this.busy.has(key)) continue;
      this.busy.add(key);
      try {
        await this.step(pos, key, now);
      } catch (err) {
        this.deps.log(pos.strategy, `PM ${pos.symbol} step failed: ${errorText(err)}`, 'error');
      } finally {
        this.busy.delete(key);
      }
    }
    store.tick();
  }

  private async step(pos: Position, key: string, now: number): Promise<void> {
    const { store, cfg } = this.deps;
    let state = store.get(key);
    if (state && isStale(state, pos)) {
      this.deps.log(pos.strategy, `PM ${pos.symbol} position changed outside the manager; state rebuilt`, 'info');
      state = undefined;
    }
    if (!state) {
      const fresh = initState(pos, now, cfg);
      if (!fresh) { store.delete(key); return; } // no numeric stop: not managed (hedge, adopted, live server-side)
      store.set(fresh);
      state = fresh;
    }
    // The venue's stop is the truth: a failed or ignored update must be retried, a tighter outside stop must be respected
    const venueStop = Number(pos.serverSl);
    if (venueStop > 0 && venueStop !== state.stop) state = { ...state, stop: venueStop };
    const f = this.features.get(pos.symbol);
    const atr = f?.atr ?? null;
    const swing = pos.side === 'LONG' ? f?.swingLow : f?.swingHigh;
    const buffer = (atr ?? 0) * SWING_BUFFER_ATR;
    const input: PmInput = {
      mark: pos.mark, qty: pos.qty, atr, vol: f?.vol ?? 'MEDIUM',
      swingStop: typeof swing === 'number' ? (pos.side === 'LONG' ? swing - buffer : swing + buffer) : null,
      superTrend: f?.superTrend && f.superTrend.agent === pos.strategy ? f.superTrend.level : null,
      lot: this.deps.lotOf(pos.symbol),
    };
    const result = advance(state, input, cfg, now);
    store.set(result.state);
    for (const note of result.notes) this.deps.log(pos.strategy, `PM ${pos.symbol} ${note}`, 'info');
    let current = result.state;
    for (const action of result.actions) current = await this.apply(pos, action, current);
  }

  private async apply(pos: Position, action: PmAction, state: PmState): Promise<PmState> {
    const { venue, store } = this.deps;
    if (action.type === 'REDUCE') {
      try {
        const result = await venue.reducePosition(pos, action.qty);
        const executed = result && typeof result.executedQty === 'number' ? result.executedQty : action.qty;
        if (executed < action.qty - 1e-12) {
          // A partial fill: count only what executed, so the state matches the position the exchange now reports
          const adjusted: PmState = { ...state, reducedQty: Math.max(0, dec(state.reducedQty).minus(dec(action.qty).minus(executed)).toNumber()) };
          store.set(adjusted);
          this.deps.log(pos.strategy, `PM ${action.reason} ${pos.symbol} reduced ${executed} of ${action.qty} @ ${formatPrice(pos.symbol, pos.mark)} (partially filled)`, 'warn');
          return adjusted;
        }
        this.deps.log(pos.strategy, `PM ${action.reason} ${pos.symbol} reduce ${action.qty} @ ${formatPrice(pos.symbol, pos.mark)}`, 'info');
        return state;
      } catch (err) {
        const reverted = revertReduce(state, action.reason, action.qty);
        store.set(reverted);
        this.deps.log(pos.strategy, `PM ${action.reason} ${pos.symbol} not sent (${errorText(err)}); will retry`, isRefusal(err) ? 'info' : 'warn');
        return reverted;
      }
    }
    const stop = roundPrice(pos.symbol, action.stop);
    const target = action.target === null ? null : roundPrice(pos.symbol, action.target);
    const dir = pos.side === 'LONG' ? 1 : -1;
    const currentStop = Number(pos.serverSl);
    const tightens = !(currentStop > 0) || (stop - currentStop) * dir > 0;
    // Venues label "no target" differently ('trail', '—'); only a numeric level counts as a target
    const currentTarget = Number(pos.serverTp);
    const targetChanged = target === null ? currentTarget > 0 : currentTarget !== target;
    if (!tightens && !targetChanged) return state;
    // Rounding to the tick must never loosen a stop that is already tighter
    const effectiveStop = tightens ? stop : currentStop;
    try {
      await venue.updateStops(pos.symbol, pos.strategy, effectiveStop, target, pos.side);
    } catch (err) {
      // The venue's stop is unchanged; the next tick reads it back and tries again
      this.deps.log(pos.strategy, `PM ${action.reason} ${pos.symbol} stop move not applied (${errorText(err)}); will retry`, isRefusal(err) ? 'info' : 'warn');
      return state;
    }
    const next = { ...state, stop: effectiveStop };
    store.set(next);
    this.deps.log(pos.strategy, `PM ${action.reason} ${pos.symbol} SL ${formatPrice(pos.symbol, effectiveStop)} TP ${target === null ? 'trail' : formatPrice(pos.symbol, target)}`, 'info');
    return next;
  }
}
