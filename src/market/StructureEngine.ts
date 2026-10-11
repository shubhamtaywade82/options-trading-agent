import type { Candle } from '../types.js';
import { findStructureBreakEvents } from './StructureEventLog.js';
import type { StructureBreak, StructureState, SwingPoint, Timeframe, TrendDirection } from './types.js';

function isSwingHigh(candles: Candle[], index: number, strength: number): boolean {
  const price = candles[index]?.high;
  if (price === undefined) return false;
  for (let i = 1; i <= strength; i++) {
    if (price <= candles[index - i].high || price <= candles[index + i].high) return false;
  }
  return true;
}

function isSwingLow(candles: Candle[], index: number, strength: number): boolean {
  const price = candles[index]?.low;
  if (price === undefined) return false;
  for (let i = 1; i <= strength; i++) {
    if (price >= candles[index - i].low || price >= candles[index + i].low) return false;
  }
  return true;
}

export function findSwingPoints(candles: Candle[], strength = 2): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const candle = candles[i];
    if (isSwingHigh(candles, i, strength)) highs.push({ index: i, time: candle.openTime, price: candle.high, type: 'HIGH' });
    if (isSwingLow(candles, i, strength)) lows.push({ index: i, time: candle.openTime, price: candle.low, type: 'LOW' });
  }

  return { highs, lows };
}

function inferStructureTrend(highs: SwingPoint[], lows: SwingPoint[]): TrendDirection {
  if (highs.length < 2 || lows.length < 2) return 'NEUTRAL';

  const [prevHigh, lastHigh] = highs.slice(-2);
  const [prevLow, lastLow] = lows.slice(-2);

  if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) return 'BULLISH';
  if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) return 'BEARISH';
  return 'NEUTRAL';
}

function findLatestBreak(
  candles: Candle[],
  trend: TrendDirection,
  highs: SwingPoint[],
  lows: SwingPoint[],
  atrValue: number,
): StructureBreak | null {
  if (candles.length < 2 || atrValue <= 0) return null;

  const current = candles.at(-1)!;
  const previous = candles.at(-2)!;

  const latestHigh = highs.filter((point) => point.index < candles.length - 1).at(-1);
  const latestLow = lows.filter((point) => point.index < candles.length - 1).at(-1);

  const bullishBreak = latestHigh && previous.close <= latestHigh.price && current.close > latestHigh.price;
  const bearishBreak = latestLow && previous.close >= latestLow.price && current.close < latestLow.price;

  if (!bullishBreak && !bearishBreak) return null;

  if (bullishBreak) {
    const type = trend === 'BEARISH' ? 'CHOCH' : 'BOS';
    return {
      type,
      direction: 'BULLISH',
      level: latestHigh!.price,
      index: candles.length - 1,
      time: current.openTime,
      distanceAtr: Math.abs(current.close - latestHigh!.price) / atrValue,
    };
  }

  const type = trend === 'BULLISH' ? 'CHOCH' : 'BOS';
  return {
    type,
    direction: 'BEARISH',
    level: latestLow!.price,
    index: candles.length - 1,
    time: current.openTime,
    distanceAtr: Math.abs(current.close - latestLow!.price) / atrValue,
  };
}

export function analyzeStructure(
  timeframe: Timeframe,
  candles: Candle[],
  atrValue: number,
  strength = 2,
): StructureState {
  const { highs, lows } = findSwingPoints(candles, strength);
  const trend = inferStructureTrend(highs, lows);

  const protectedHigh =
    trend === 'BEARISH' ? highs.at(-1) ?? null : highs.slice(-2, -1)[0] ?? highs.at(-1) ?? null;
  const protectedLow =
    trend === 'BULLISH' ? lows.at(-1) ?? null : lows.slice(-2, -1)[0] ?? lows.at(-1) ?? null;

  // Full causal BOS/CHOCH history with protection zones. `lastBreak` keeps its
  // exact per-snapshot semantics (only a break on the very last candle).
  const breaks = findStructureBreakEvents(candles, atrValue, strength);

  return {
    timeframe,
    trend,
    swingHighs: highs.slice(-20),
    swingLows: lows.slice(-20),
    lastBreak: findLatestBreak(candles, trend, highs, lows, atrValue),
    protectedHigh,
    protectedLow,
    breaks,
  };
}
