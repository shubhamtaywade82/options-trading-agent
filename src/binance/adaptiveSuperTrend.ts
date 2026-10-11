// TypeScript port of AlgoAlpha's "Machine Learning Adaptive SuperTrend" (Pine, MPL-2.0).
// SuperTrend bands use the K-Means volatility centroid instead of the raw ATR.
import type { Candle } from '../types.js';
import { wilderAtr } from './indicators.js';

export type Regime = 'HIGH' | 'MEDIUM' | 'LOW';
export type TrendDirection = 'BULLISH' | 'BEARISH';
export type Centroids = Record<Regime, number>;

export interface AdaptiveSuperTrendOptions {
  atrLength: number;
  factor: number;
  trainingPeriod: number;
}

export interface AdaptiveSuperTrendBar {
  candle: Candle;
  atr: number;
  centroids: Centroids;
  regime: Regime;
  assignedAtr: number;
  superTrend: number;
  direction: TrendDirection;
  trendShift: TrendDirection | null;
  regimeShift: Regime | null;
}

const DEFAULT_OPTIONS: AdaptiveSuperTrendOptions = { atrLength: 10, factor: 3, trainingPeriod: 100 };
const MAX_KMEANS_ITERATIONS = 100;
const INITIAL_PERCENTILES: Centroids = { HIGH: 0.75, MEDIUM: 0.5, LOW: 0.25 };

/** TP distance in assigned-ATR units per regime (LOW is only used by the trailing cap). */
export const TP_ATR_MULTIPLE: Record<Regime, number> = { LOW: 2, MEDIUM: 3, HIGH: 4 };

// Order is the tie priority: an equidistant value joins the higher-volatility cluster
const REGIMES: Regime[] = ['HIGH', 'MEDIUM', 'LOW'];

export { wilderAtr };

export function nearestRegime(value: number, centroids: Centroids): Regime {
  let best: Regime = 'HIGH';
  for (const regime of REGIMES) {
    if (Math.abs(value - centroids[regime]) < Math.abs(value - centroids[best])) best = regime;
  }
  return best;
}

/** 3-cluster K-Means over volatility values; an empty cluster keeps its previous centroid. */
export function kMeans(values: number[], initial: Centroids): Centroids {
  let centroids = initial;
  for (let iteration = 0; iteration < MAX_KMEANS_ITERATIONS; iteration++) {
    const sums: Centroids = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    const counts: Centroids = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const value of values) {
      const regime = nearestRegime(value, centroids);
      sums[regime] += value;
      counts[regime] += 1;
    }
    const next = { ...centroids };
    for (const regime of REGIMES) {
      if (counts[regime] > 0) next[regime] = sums[regime] / counts[regime];
    }
    const converged = REGIMES.every((regime) => next[regime] === centroids[regime]);
    centroids = next;
    if (converged) break;
  }
  return centroids;
}

function initialCentroids(window: number[]): Centroids {
  const lower = Math.min(...window);
  const upper = Math.max(...window);
  const at = (percentile: number) => lower + (upper - lower) * percentile;
  return { HIGH: at(INITIAL_PERCENTILES.HIGH), MEDIUM: at(INITIAL_PERCENTILES.MEDIUM), LOW: at(INITIAL_PERCENTILES.LOW) };
}

interface BandState {
  upper: number;
  lower: number;
  line: number;
  direction: TrendDirection;
}

function nextBandState(
  candle: Candle,
  previousClose: number,
  band: { assignedAtr: number; factor: number },
  previous: BandState | null,
): BandState {
  const hl2 = (candle.high + candle.low) / 2;
  let upper = hl2 + band.factor * band.assignedAtr;
  let lower = hl2 - band.factor * band.assignedAtr;
  if (!previous) return { upper, lower, line: upper, direction: 'BEARISH' };

  if (!(lower > previous.lower || previousClose < previous.lower)) lower = previous.lower;
  if (!(upper < previous.upper || previousClose > previous.upper)) upper = previous.upper;

  const direction: TrendDirection = previous.direction === 'BEARISH'
    ? (candle.close > upper ? 'BULLISH' : 'BEARISH')
    : (candle.close < lower ? 'BEARISH' : 'BULLISH');
  return { upper, lower, line: direction === 'BULLISH' ? lower : upper, direction };
}

function buildBar(
  candle: Candle,
  atr: number,
  current: { centroids: Centroids; regime: Regime; next: BandState },
  previous: AdaptiveSuperTrendBar | undefined,
): AdaptiveSuperTrendBar {
  const { centroids, regime, next } = current;
  return {
    candle,
    atr,
    centroids,
    regime,
    assignedAtr: centroids[regime],
    superTrend: next.line,
    direction: next.direction,
    trendShift: previous && previous.direction !== next.direction ? next.direction : null,
    regimeShift: previous && previous.regime !== regime ? regime : null,
  };
}

/** Runs the indicator over closed candles; the first bar is emitted once ATR and the training window both exist. */
export function calculateAdaptiveSuperTrend(
  candles: Candle[],
  options: Partial<AdaptiveSuperTrendOptions> = {},
): AdaptiveSuperTrendBar[] {
  const { atrLength, factor, trainingPeriod } = { ...DEFAULT_OPTIONS, ...options };
  const atrSeries = wilderAtr(candles, atrLength);
  const bars: AdaptiveSuperTrendBar[] = [];
  let state: BandState | null = null;

  for (let i = atrLength + trainingPeriod - 2; i < candles.length; i++) {
    if (!(atrSeries[i] > 0)) continue;
    const window = atrSeries.slice(i - trainingPeriod + 1, i + 1);
    const centroids = kMeans(window, initialCentroids(window));
    const regime = nearestRegime(atrSeries[i], centroids);
    const assignedAtr = centroids[regime];
    const next = nextBandState(candles[i], candles[i - 1].close, { assignedAtr, factor }, state);
    bars.push(buildBar(candles[i], atrSeries[i], { centroids, regime, next }, bars.at(-1)));
    state = next;
  }
  return bars;
}
