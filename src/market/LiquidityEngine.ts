import type { Candle } from '../types.js';
import { buildSweepLedger, markPoolsFromLedger } from './SweepLedger.js';
import type { LiquidityPool, LiquidityState, LiquiditySweep, StructureState, Timeframe } from './types.js';

const SWEEP_LOOKBACK_CANDLES = 12;
const MAX_RECENT_SWEEPS = 30;

function sweepForCandle(candle: Candle, index: number, pool: LiquidityPool): LiquiditySweep | null {
  if (pool.sourceTimes.length === 0 || Math.max(...pool.sourceTimes) >= candle.openTime) return null;

  const bullishSweep = candle.low < pool.price - pool.tolerance && candle.close > pool.price;
  const bearishSweep = candle.high > pool.price + pool.tolerance && candle.close < pool.price;

  if (bullishSweep) {
    return {
      poolType: pool.type,
      direction: 'SELL_SIDE',
      level: pool.price,
      sweepPrice: candle.low,
      close: candle.close,
      index,
      time: candle.openTime,
      confirmed: true,
    };
  }

  if (bearishSweep) {
    return {
      poolType: pool.type,
      direction: 'BUY_SIDE',
      level: pool.price,
      sweepPrice: candle.high,
      close: candle.close,
      index,
      time: candle.openTime,
      confirmed: true,
    };
  }

  return null;
}

export function detectLiquidity(
  timeframe: Timeframe,
  candles: Candle[],
  structure: StructureState,
  atrValue: number,
): LiquidityState {
  const pools: LiquidityPool[] = [];
  const tolerance = Math.max(atrValue * 0.15, 1e-12);
  const highs = structure.swingHighs.slice(-12);
  const lows = structure.swingLows.slice(-12);

  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[i].price - highs[j].price) <= tolerance) {
        pools.push({
          type: 'EQUAL_HIGH',
          price: (highs[i].price + highs[j].price) / 2,
          tolerance,
          strength: Math.min(1, 0.5 + Math.abs(j - i) / 20),
          timeframe,
          sourceTimes: [highs[i].time, highs[j].time],
        });
      }
    }
  }

  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[i].price - lows[j].price) <= tolerance) {
        pools.push({
          type: 'EQUAL_LOW',
          price: (lows[i].price + lows[j].price) / 2,
          tolerance,
          strength: Math.min(1, 0.5 + Math.abs(j - i) / 20),
          timeframe,
          sourceTimes: [lows[i].time, lows[j].time],
        });
      }
    }
  }

  for (const point of highs.slice(-6)) {
    pools.push({
      type: 'SWING_HIGH',
      price: point.price,
      tolerance,
      strength: Math.min(1, 0.4 + (point.index / Math.max(1, candles.length)) * 0.4),
      timeframe,
      sourceTimes: [point.time],
    });
  }

  for (const point of lows.slice(-6)) {
    pools.push({
      type: 'SWING_LOW',
      price: point.price,
      tolerance,
      strength: Math.min(1, 0.4 + (point.index / Math.max(1, candles.length)) * 0.4),
      timeframe,
      sourceTimes: [point.time],
    });
  }

  const lookback = candles.slice(-32);
  if (lookback.length >= 8) {
    const rangeHigh = Math.max(...lookback.map((c) => c.high));
    const rangeLow = Math.min(...lookback.map((c) => c.low));
    pools.push(
      { type: 'RANGE_HIGH', price: rangeHigh, tolerance, strength: 0.7, timeframe, sourceTimes: [lookback.at(-1)!.openTime] },
      { type: 'RANGE_LOW', price: rangeLow, tolerance, strength: 0.7, timeframe, sourceTimes: [lookback.at(-1)!.openTime] },
    );
  }

  const sweepCandles = candles.slice(-SWEEP_LOOKBACK_CANDLES);
  const recentSweeps: LiquiditySweep[] = [];

  for (let offset = 0; offset < sweepCandles.length; offset += 1) {
    const candle = sweepCandles[offset];
    const index = candles.length - sweepCandles.length + offset;

    for (const pool of pools) {
      const sweep = sweepForCandle(candle, index, pool);
      if (sweep) recentSweeps.push(sweep);
    }
  }

  const orderedSweeps = recentSweeps
    .sort((a, b) => (a.time - b.time) || (a.index - b.index))
    .slice(-MAX_RECENT_SWEEPS);
  const latestTime = candles.at(-1)?.openTime;
  const latestSweeps = latestTime === undefined
    ? []
    : orderedSweeps.filter((sweep) => sweep.time === latestTime);

  // Persistent, causally replayed sweep history + pool swept-state. The legacy
  // 12-bar recentSweeps/latestSweeps outputs above are untouched.
  const ledger = buildSweepLedger(candles, atrValue);
  markPoolsFromLedger(pools, ledger);

  return {
    timeframe,
    pools: pools.slice(-40),
    latestSweeps: latestSweeps.slice(-10),
    recentSweeps: orderedSweeps,
    sweepHistory: ledger.sweepHistory,
  };
}
