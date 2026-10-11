import type { MarketRegime, RegimeSnapshot, TimeframeState, TrendDirection, VolatilityRegime } from './types.js';
import { classifyRegime } from './RegimeEngine.js';

/**
 * Scored regime with hysteresis, layered on the same labels the router and agents already use.
 *
 * The first-match classifier flips TREND <-> TRANSITION every time ADX crosses 25, and a strategy router keyed on that
 * label then switches the whole fleet on and off. Here a trend is a continuous 0..1 score; a label is entered above one
 * threshold and kept until the score falls below a lower one (Schmitt trigger), and a change of label must also persist
 * for `confirmBars` closed bars before it is adopted (dwell time).
 */
export interface RegimeOptions {
  /** Trend score needed to ENTER TREND_UP / TREND_DOWN. */
  trendEnter: number;
  /** A held trend is kept until its score falls below this. Must be below trendEnter. */
  trendExit: number;
  /** Closed bars a different raw regime must persist before it replaces the held one. 1 = no dwell. */
  confirmBars: number;
}

export const DEFAULT_REGIME_OPTIONS: RegimeOptions = { trendEnter: 0.55, trendExit: 0.4, confirmBars: 2 };

// RANGE is entered at ADX <= 20 and kept until ADX > 23; the volatility labels keep 5 percentile points of slack
const RANGE_ENTER_ADX = 20;
const RANGE_EXIT_ADX = 23;
const HIGH_VOL_ENTER = 85;
const HIGH_VOL_EXIT = 80;
const LOW_VOL_ENTER = 15;
const LOW_VOL_EXIT = 20;
// 5-bar EMA20 slope (%) that counts as a full-strength slope
const SLOPE_FULL_PCT = 0.4;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function higherTimeframeDirection(htf: TimeframeState): TrendDirection {
  const baseline = htf.ema200 ?? htf.ema50 ?? htf.ema20;
  if (baseline === null || htf.lastClose <= 0) return 'NEUTRAL';
  const slope = htf.emaSlopePct ?? 0;
  const distance = (htf.lastClose - baseline) / baseline;
  if (distance > 0 && slope >= 0) return 'BULLISH';
  if (distance < 0 && slope <= 0) return 'BEARISH';
  return 'NEUTRAL';
}

/** Share of the available EMA/price alignment checks that agree with `dir` (1 = up, -1 = down); 0.5 when nothing is available. */
function alignment(tf: TimeframeState, dir: 1 | -1): number {
  const checks: boolean[] = [];
  if (tf.ema20 !== null && tf.ema50 !== null) checks.push(dir * (tf.ema20 - tf.ema50) > 0);
  if (tf.ema50 !== null && tf.ema200 !== null) checks.push(dir * (tf.ema50 - tf.ema200) > 0);
  if (tf.ema20 !== null && tf.lastClose > 0) checks.push(dir * (tf.lastClose - tf.ema20) > 0);
  return checks.length === 0 ? 0.5 : checks.filter(Boolean).length / checks.length;
}

/**
 * 0..1 strength of a trend in direction `dir` on the entry timeframe, gated by the higher timeframe: a trend against the
 * higher-timeframe direction scores 0, a neutral higher timeframe caps it at 0.4 (below the entry threshold).
 */
export function trendScore(entry: TimeframeState, htf: TimeframeState, dir: 1 | -1): number {
  const htfDirection = higherTimeframeDirection(htf);
  const gate = htfDirection === 'NEUTRAL' ? 0.4 : (htfDirection === 'BULLISH') === (dir === 1) ? 1 : 0;
  if (gate === 0) return 0;
  const adx = clamp01(((entry.adx14 ?? 0) - 15) / 25);
  const slope = clamp01((dir * (entry.emaSlopePct ?? 0)) / SLOPE_FULL_PCT);
  const vwapSide = entry.vwap !== null && entry.lastClose > 0 ? (dir * (entry.lastClose - entry.vwap) > 0 ? 1 : 0) : 0.5;
  return gate * (0.4 * adx + 0.2 * slope + 0.25 * alignment(entry, dir) + 0.15 * vwapSide);
}

interface Raw { regime: MarketRegime; up: number; down: number }

function rawRegime(entry: TimeframeState, htf: TimeframeState, held: MarketRegime | null, o: RegimeOptions): Raw {
  const up = trendScore(entry, htf, 1);
  const down = trendScore(entry, htf, -1);
  const upOk = up >= (held === 'TREND_UP' ? o.trendExit : o.trendEnter);
  const downOk = down >= (held === 'TREND_DOWN' ? o.trendExit : o.trendEnter);
  if (upOk || downOk) return { regime: upOk && (!downOk || up >= down) ? 'TREND_UP' : 'TREND_DOWN', up, down };

  const pct = entry.atrPercentile;
  const adx = entry.adx14 ?? 0;
  if (pct !== null && pct >= (held === 'HIGH_VOL' ? HIGH_VOL_EXIT : HIGH_VOL_ENTER)) return { regime: 'HIGH_VOL', up, down };
  if (pct !== null && pct <= (held === 'LOW_VOL' ? LOW_VOL_EXIT : LOW_VOL_ENTER)) return { regime: 'LOW_VOL', up, down };
  if (adx <= (held === 'RANGE' ? RANGE_EXIT_ADX : RANGE_ENTER_ADX)) return { regime: 'RANGE', up, down };
  return { regime: 'TRANSITION', up, down };
}

interface Tracked { held: MarketRegime; barsInRegime: number; pending: MarketRegime | null; pendingBars: number; lastBar: number; last: RegimeSnapshot }

/** Per-symbol held regime. `update` is idempotent per bar time, so evaluating the same closed bar twice never advances a dwell counter. */
export class RegimeTracker {
  private readonly states = new Map<string, Tracked>();
  private readonly options: RegimeOptions;

  constructor(options: Partial<RegimeOptions> = {}) {
    this.options = { ...DEFAULT_REGIME_OPTIONS, ...options };
    if (!(this.options.trendExit < this.options.trendEnter)) throw new Error('trendExit must be below trendEnter');
    if (!(this.options.confirmBars >= 1)) throw new Error('confirmBars must be at least 1');
  }

  update(symbol: string, barTime: number, entry: TimeframeState, htf: TimeframeState): RegimeSnapshot {
    const prior = this.states.get(symbol);
    if (prior && prior.lastBar === barTime) return prior.last;

    const raw = rawRegime(entry, htf, prior?.held ?? null, this.options);
    const state = prior ?? { held: raw.regime, barsInRegime: 0, pending: null, pendingBars: 0, lastBar: barTime, last: undefined as unknown as RegimeSnapshot };
    if (!prior) {
      state.barsInRegime = 1; // the first bar adopts whatever it sees
    } else if (raw.regime === state.held) {
      state.barsInRegime += 1;
      state.pending = null;
      state.pendingBars = 0;
    } else {
      state.pendingBars = state.pending === raw.regime ? state.pendingBars + 1 : 1;
      state.pending = raw.regime;
      state.barsInRegime += 1;
      if (state.pendingBars >= this.options.confirmBars) {
        state.held = raw.regime;
        state.barsInRegime = 1;
        state.pending = null;
        state.pendingBars = 0;
      }
    }
    state.lastBar = barTime;
    state.last = this.snapshot(state, raw, entry, htf);
    this.states.set(symbol, state);
    return state.last;
  }

  private snapshot(state: Tracked, raw: Raw, entry: TimeframeState, htf: TimeframeState): RegimeSnapshot {
    const legacy = classifyRegime(entry, htf); // trendDirection, volatility class and the carried indicator fields
    const trend = state.held === 'TREND_UP' ? raw.up : state.held === 'TREND_DOWN' ? raw.down : 0;
    const volatility: VolatilityRegime = legacy.volatility;
    return {
      ...legacy,
      volatility,
      regime: state.held,
      rawRegime: raw.regime,
      pendingRegime: state.pending,
      barsInRegime: state.barsInRegime,
      confidence: state.held === 'TREND_UP' || state.held === 'TREND_DOWN' ? trend : 1 - Math.max(raw.up, raw.down),
      trendScore: raw.up >= raw.down ? raw.up : -raw.down,
    };
  }
}
