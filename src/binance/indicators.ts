import type { Candle } from '../types.js';

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * multiplier + result[i - 1] * (1 - multiplier));
  }
  return result;
}

function trueRangeSeries(candles: Candle[]): number[] {
  const ranges: number[] = new Array(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    ranges[i] = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
  }
  return ranges;
}

/** Canonical Wilder ATR (Pine ta.atr); returns the latest smoothed value. */
export function atr(candles: Candle[], period = 14): number {
  const series = wilderAtr(candles, period);
  const val = series.at(-1);
  return val !== undefined && Number.isFinite(val) ? val : 0;
}

/** Wilder ATR series (Pine ta.atr) with the conventional SMA seed at index period - 1. */
export function wilderAtr(candles: Candle[], period = 14): number[] {
  const atrSeries = new Array<number>(candles.length).fill(NaN);
  if (period <= 0 || candles.length < period) return atrSeries;
  let trSum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    if (i < period) trSum += tr;
    if (i === period - 1) atrSeries[i] = trSum / period;
    if (i >= period) atrSeries[i] = (atrSeries[i - 1] * (period - 1) + tr) / period;
  }
  return atrSeries;
}

export function zscore(values: number[], period = 30): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
  const variance = slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / slice.length;
  const standardDeviation = Math.sqrt(variance);
  return standardDeviation === 0 ? 0 : (values[values.length - 1] - mean) / standardDeviation;
}

/** Z-score of the latest A/B close ratio over the trailing period. */
export function pairZScore(candlesA: Candle[], candlesB: Candle[], period = 30): number {
  const length = Math.min(candlesA.length, candlesB.length);
  if (length < period) return 0;
  const ratios: number[] = [];
  for (let i = length - period; i < length; i++) ratios.push(candlesA[i].close / candlesB[i].close);
  return zscore(ratios, period);
}

export function sparkline(values: number[], len = 12): string {
  if (!values.length) return '';
  const slice = values.slice(-len);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const range = max - min || 1;
  const TICKS = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return slice.map((v) => TICKS[Math.min(7, Math.floor(((v - min) / range) * 8))]).join('');
}

export function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    result.push(i >= period - 1 ? sum / period : NaN);
  }
  return result;
}

export function rsi(values: number[], period = 14): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  if (values.length <= period) return result;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export interface BollingerBands {
  upper: number[];
  middle: number[];
  lower: number[];
}

export function bollinger(values: number[], period = 20, mult = 2): BollingerBands {
  const middle = sma(values, period);
  const upper: number[] = new Array(values.length).fill(NaN);
  const lower: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const mean = middle[i];
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
    const stdDev = Math.sqrt(variance / period);
    upper[i] = mean + mult * stdDev;
    lower[i] = mean - mult * stdDev;
  }
  return { upper, middle, lower };
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => emaFast[i] - emaSlow[i]);
  const signal = ema(macdLine, signalPeriod);
  const histogram = macdLine.map((v, i) => v - signal[i]);
  return { macd: macdLine, signal, histogram };
}

/** Wilder ADX series. Values remain NaN until the first complete ADX seed exists. */
export function adx(candles: Candle[], period = 14): number[] {
  const result = new Array<number>(candles.length).fill(NaN);
  if (period <= 0 || candles.length < period * 2) return result;

  const tr = trueRangeSeries(candles);
  const plusDm = new Array<number>(candles.length).fill(0);
  const minusDm = new Array<number>(candles.length).fill(0);

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) {
    smTr += tr[i];
    smPlus += plusDm[i];
    smMinus += minusDm[i];
  }

  const dx = new Array<number>(candles.length).fill(NaN);

  const setDx = (index: number): number => {
    const plusDi = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    const minusDi = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    const denominator = plusDi + minusDi;
    const value = denominator === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / denominator;
    dx[index] = value;
    return value;
  };

  setDx(period);

  for (let i = period + 1; i < candles.length; i++) {
    smTr = smTr - smTr / period + tr[i];
    smPlus = smPlus - smPlus / period + plusDm[i];
    smMinus = smMinus - smMinus / period + minusDm[i];
    setDx(i);
  }

  const firstAdxIndex = period * 2 - 1;
  if (firstAdxIndex >= candles.length) return result;

  let seed = 0;
  for (let i = period; i <= firstAdxIndex; i++) seed += dx[i];
  result[firstAdxIndex] = seed / period;

  for (let i = firstAdxIndex + 1; i < candles.length; i++) {
    result[i] = ((result[i - 1] * (period - 1)) + dx[i]) / period;
  }

  return result;
}

/** Percentile rank of a value within the finite values of an indicator series. */
export function atrPercentile(series: number[], value: number): number {
  const valid = series.filter(Number.isFinite);
  if (!valid.length || !Number.isFinite(value)) return 0;
  const atOrBelow = valid.filter((candidate) => candidate <= value).length;
  return (atOrBelow / valid.length) * 100;
}

/** Percentage slope of an EMA over a recent lookback. */
export function emaSlopePct(values: number[], period = 20, lookback = 5): number | null {
  if (period <= 0 || lookback <= 0 || values.length < period + lookback) return null;
  const series = ema(values, period);
  const current = series.at(-1)!;
  const previous = series.at(-1 - lookback)!;
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Rolling volume-weighted average price using typical price and candle volume. */
export function vwap(candles: Candle[], period = 96): number[] {
  const result = new Array<number>(candles.length).fill(NaN);
  if (candles.length === 0 || period <= 0) return result;

  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0;
    let volume = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const candle = candles[j];
      const typical = (candle.high + candle.low + candle.close) / 3;
      pv += typical * candle.volume;
      volume += candle.volume;
    }
    result[i] = volume > 0 ? pv / volume : candles[i].close;
  }

  return result;
}
