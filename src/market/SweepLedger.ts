import type { Candle } from '../types.js';
import type { LiquidityPool, LiquiditySweep } from './types.js';

const MAX_SWEEP_EVENTS = 200;
const MAX_ACTIVE_POOLS = 60;
const EQUAL_PAIR_LOOKBACK = 11;

interface LedgerPool {
  type: 'EQUAL_HIGH' | 'EQUAL_LOW' | 'SWING_HIGH' | 'SWING_LOW';
  price: number;
  sourceTimes: number[];
  formedAt: number;
}

export interface SweepLedgerResult {
  /** Immutable sweep events, oldest first, capped. */
  sweepHistory: LiquiditySweep[];
  /** Pool identity -> sweep fact, for pools consumed during the replay. */
  sweptPools: Map<string, { sweptAt: number; sweepPrice: number }>;
}

function poolIdentity(type: string, sourceTimes: number[]): string {
  return `${type}|${sourceTimes.join(',')}`;
}

function isSwingHigh(candles: Candle[], index: number, strength: number): boolean {
  const price = candles[index]?.high;
  if (price === undefined) return false;
  for (let i = 1; i <= strength; i++) {
    if (price <= candles[index - i]?.high || price <= candles[index + i]?.high) return false;
  }
  return true;
}

function isSwingLow(candles: Candle[], index: number, strength: number): boolean {
  const price = candles[index]?.low;
  if (price === undefined) return false;
  for (let i = 1; i <= strength; i++) {
    if (price >= candles[index - i]?.low || price >= candles[index + i]?.low) return false;
  }
  return true;
}

function sweepForCandle(
  candle: Candle,
  index: number,
  pool: LedgerPool,
  tolerance: number,
): LiquiditySweep | null {
  const bullishSweep = candle.low < pool.price - tolerance && candle.close > pool.price;
  const bearishSweep = candle.high > pool.price + tolerance && candle.close < pool.price;

  if (!bullishSweep && !bearishSweep) return null;

  const direction = bullishSweep ? 'SELL_SIDE' : 'BUY_SIDE';
  return {
    poolType: pool.type,
    direction,
    level: pool.price,
    sweepPrice: bullishSweep ? candle.low : candle.high,
    close: candle.close,
    index,
    time: candle.openTime,
    confirmed: true,
    id: `${candle.openTime}|${direction}|${pool.price}|${pool.type}|${pool.sourceTimes.join(',')}`,
    poolSourceTimes: [...pool.sourceTimes],
  };
}

/**
 * Replays the candle window causally to build a persistent sweep history.
 *
 * Pools form the moment their swing confirms (equal highs/lows pair with any of
 * the previous eleven same-side swings, plus one pool per swing) and persist
 * until swept or aged out of the active budget — unlike the per-snapshot pool
 * list in `detectLiquidity`, a pool does not vanish merely because new swings
 * pushed it out of the last twelve. Every sweep is recorded as an immutable
 * event whose pool always predates the sweeping candle.
 *
 * Append-stability contract: extending the candle window never rewrites an
 * existing event (identical id and fields) and never un-sweeps a pool.
 */
export function buildSweepLedger(
  candles: Candle[],
  atrValue: number,
  opts: { strength?: number; maxEvents?: number; maxActivePools?: number } = {},
): SweepLedgerResult {
  const strength = opts.strength ?? 2;
  const maxEvents = opts.maxEvents ?? MAX_SWEEP_EVENTS;
  const maxActivePools = opts.maxActivePools ?? MAX_ACTIVE_POOLS;
  const tolerance = Math.max(atrValue * 0.15, 1e-12);

  const sweepHistory: LiquiditySweep[] = [];
  const sweptPools = new Map<string, { sweptAt: number; sweepPrice: number }>();
  const activePools: LedgerPool[] = [];
  const swingHighs: Array<{ index: number; time: number; price: number }> = [];
  const swingLows: Array<{ index: number; time: number; price: number }> = [];
  let formedAt = 0;

  const formPool = (pool: LedgerPool) => {
    activePools.push(pool);
    if (activePools.length > maxActivePools) activePools.shift();
  };

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    const pivot = i - strength;
    if (pivot >= strength) {
      if (isSwingHigh(candles, pivot, strength)) {
        const swing = {
          index: pivot,
          time: candles[pivot].openTime,
          price: candles[pivot].high,
        };
        swingHighs.push(swing);
        formedAt += 1;
        formPool({ type: 'SWING_HIGH', price: swing.price, sourceTimes: [swing.time], formedAt });
        for (const prior of swingHighs.slice(-EQUAL_PAIR_LOOKBACK, -1)) {
          if (Math.abs(prior.price - swing.price) <= tolerance) {
            formedAt += 1;
            formPool({
              type: 'EQUAL_HIGH',
              price: (prior.price + swing.price) / 2,
              sourceTimes: [prior.time, swing.time],
              formedAt,
            });
          }
        }
      }
      if (isSwingLow(candles, pivot, strength)) {
        const swing = {
          index: pivot,
          time: candles[pivot].openTime,
          price: candles[pivot].low,
        };
        swingLows.push(swing);
        formedAt += 1;
        formPool({ type: 'SWING_LOW', price: swing.price, sourceTimes: [swing.time], formedAt });
        for (const prior of swingLows.slice(-EQUAL_PAIR_LOOKBACK, -1)) {
          if (Math.abs(prior.price - swing.price) <= tolerance) {
            formedAt += 1;
            formPool({
              type: 'EQUAL_LOW',
              price: (prior.price + swing.price) / 2,
              sourceTimes: [prior.time, swing.time],
              formedAt,
            });
          }
        }
      }
    }

    // A candle can only sweep pools that fully formed before it opened.
    for (let p = activePools.length - 1; p >= 0; p--) {
      const pool = activePools[p];
      if (Math.max(...pool.sourceTimes) >= candle.openTime) continue;
      const sweep = sweepForCandle(candle, i, pool, tolerance);
      if (sweep) {
        sweepHistory.push(sweep);
        sweptPools.set(poolIdentity(pool.type, pool.sourceTimes), {
          sweptAt: candle.openTime,
          sweepPrice: sweep.sweepPrice,
        });
        activePools.splice(p, 1);
      }
    }
  }

  return { sweepHistory: sweepHistory.slice(-maxEvents), sweptPools };
}

/** Marks pools from a per-snapshot pool list using the replayed ledger. */
export function markPoolsFromLedger(pools: LiquidityPool[], ledger: SweepLedgerResult): void {
  for (const pool of pools) {
    if (pool.type === 'RANGE_HIGH' || pool.type === 'RANGE_LOW') continue;
    const hit = ledger.sweptPools.get(poolIdentity(pool.type, pool.sourceTimes));
    if (hit) {
      pool.taken = true;
      pool.sweptAt = hit.sweptAt;
    }
  }
}
