import type { Candle } from '../domain/types.js';

/** Exponential moving average, seeded with the SMA of the first `period` values. Undefined until seeded. */
export function ema(values: readonly number[], period: number): number | undefined {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`EMA period must be a positive integer, got ${period}`);
  }
  if (values.length < period) {
    return undefined;
  }
  const multiplier = 2 / (period + 1);
  let average = 0;
  for (let i = 0; i < period; i += 1) {
    average += values[i] ?? NaN;
  }
  average /= period;
  for (let i = period; i < values.length; i += 1) {
    average = (values[i] ?? NaN) * multiplier + average * (1 - multiplier);
  }
  return Number.isFinite(average) ? average : undefined;
}

/** Wilder ATR for each bar index; entries before `period - 1` are undefined. */
export function wilderAtr(candles: readonly Candle[], period: number): (number | undefined)[] {
  const result: (number | undefined)[] = new Array<number | undefined>(candles.length).fill(undefined);
  if (candles.length < period) {
    return result;
  }
  const trueRange: number[] = candles.map((candle, index) => {
    const previous = candles[index - 1];
    if (previous === undefined) {
      return candle.high - candle.low;
    }
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close),
    );
  });
  let atr = 0;
  for (let i = 0; i < period; i += 1) {
    atr += trueRange[i] ?? 0;
  }
  atr /= period;
  result[period - 1] = atr;
  for (let i = period; i < candles.length; i += 1) {
    atr = ((atr * (period - 1)) + (trueRange[i] ?? 0)) / period;
    result[i] = atr;
  }
  return result;
}

export type SuperTrendTrend = 'UP' | 'DOWN';

export interface SuperTrendState {
  readonly trend: SuperTrendTrend;
  /** Active SuperTrend line: the lower band in an uptrend, the upper band in a downtrend. */
  readonly line: number;
  /** True when the trend changed on the last bar. */
  readonly flipped: boolean;
}

/**
 * SuperTrend over the full series, returning the state at the final bar.
 * Seeded from the first bar with a valid ATR; callers should supply several
 * multiples of `period` bars so the seed does not dominate the result.
 */
export function superTrend(
  candles: readonly Candle[],
  period: number,
  multiplier: number,
): SuperTrendState | undefined {
  const atr = wilderAtr(candles, period);
  let finalUpper: number | undefined;
  let finalLower: number | undefined;
  let trend: SuperTrendTrend = 'UP';
  let flipped = false;
  let previousClose: number | undefined;

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];
    const bandAtr = atr[i];
    if (candle === undefined || bandAtr === undefined) {
      continue;
    }
    const hl2 = (candle.high + candle.low) / 2;
    const basicUpper = hl2 + multiplier * bandAtr;
    const basicLower = hl2 - multiplier * bandAtr;

    if (finalUpper === undefined || finalLower === undefined || previousClose === undefined) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = candle.close > hl2 ? 'UP' : 'DOWN';
      flipped = false;
    } else {
      const nextUpper =
        basicUpper < finalUpper || previousClose > finalUpper ? basicUpper : finalUpper;
      const nextLower =
        basicLower > finalLower || previousClose < finalLower ? basicLower : finalLower;
      finalUpper = nextUpper;
      finalLower = nextLower;
      const before = trend;
      if (trend === 'DOWN' && candle.close > finalUpper) {
        trend = 'UP';
      } else if (trend === 'UP' && candle.close < finalLower) {
        trend = 'DOWN';
      }
      flipped = before !== trend;
    }
    previousClose = candle.close;
  }

  if (finalUpper === undefined || finalLower === undefined) {
    return undefined;
  }
  return { trend, line: trend === 'UP' ? finalLower : finalUpper, flipped };
}
