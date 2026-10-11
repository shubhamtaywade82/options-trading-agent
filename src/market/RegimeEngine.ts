import { adx, atrPercentile, ema, emaSlopePct, rsi, vwap, bollinger, wilderAtr } from '../binance/indicators.js';
import type { Candle } from '../types.js';
import type { MarketRegime, RegimeSnapshot, TimeframeState, TrendDirection, VolatilityRegime } from './types.js';

const VOLUME_Z_LOOKBACK = 20;

/** z-score of the latest candle's volume against the preceding window; null when undefined (short/flat history). */
export function latestVolumeZ(candles: Candle[]): number | null {
  if (candles.length < VOLUME_Z_LOOKBACK + 1) return null;
  const window = candles.slice(-VOLUME_Z_LOOKBACK - 1, -1).map((c) => c.volume);
  const mean = window.reduce((sum, v) => sum + v, 0) / window.length;
  const sd = Math.sqrt(window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (window.length - 1));
  return sd > 0 ? (candles[candles.length - 1].volume - mean) / sd : null;
}

function lastFinite(values: number[]): number | null {
  const value = values.at(-1);
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function seriesValue(values: number[], index = -1): number | null {
  const value = values.at(index);
  return value !== undefined && Number.isFinite(value) ? value : null;
}

export function buildTimeframeState(
  timeframe: TimeframeState['timeframe'],
  candles: Candle[],
): TimeframeState {
  const closes = candles.map((c) => c.close);
  const ema20Series = ema(closes, 20);
  const ema50Series = ema(closes, 50);
  const ema200Series = candles.length >= 200 ? ema(closes, 200) : [];

  const atrSeries = wilderAtr(candles, 14);
  const adxSeries = adx(candles, 14);
  const rsiSeries = rsi(closes, 14);
  const vwapSeries = vwap(candles, Math.min(96, Math.max(2, candles.length)));
  const bb = bollinger(closes, 20, 2);

  const atr14 = lastFinite(atrSeries);
  return {
    timeframe,
    candleCount: candles.length,
    lastClose: closes.at(-1) ?? 0,
    ema20: seriesValue(ema20Series),
    ema50: seriesValue(ema50Series),
    ema200: seriesValue(ema200Series),
    emaSlopePct: emaSlopePct(closes, 20, 5),
    adx14: lastFinite(adxSeries),
    atr14,
    atrPercentile: atr14 === null ? null : atrPercentile(atrSeries, atr14),
    rsi14: lastFinite(rsiSeries),
    vwap: lastFinite(vwapSeries),
    bollingerMiddle: seriesValue(bb.middle),
    bollingerUpper: seriesValue(bb.upper),
    bollingerLower: seriesValue(bb.lower),
    volumeZ: latestVolumeZ(candles),
  };
}

function inferTrend(state: TimeframeState): TrendDirection {
  const baseline = state.ema200 ?? state.ema50 ?? state.ema20;
  if (baseline === null || state.lastClose <= 0) return 'NEUTRAL';

  const slope = state.emaSlopePct ?? 0;
  const distance = (state.lastClose - baseline) / baseline;

  if (distance > 0 && slope >= 0) return 'BULLISH';
  if (distance < 0 && slope <= 0) return 'BEARISH';
  return 'NEUTRAL';
}

export function classifyRegime(
  entry: TimeframeState,
  htf: TimeframeState,
): RegimeSnapshot {
  const trendDirection = inferTrend(htf);
  const adx14 = entry.adx14;
  const trendStrength = Math.max(
    0,
    Math.min(1, ((adx14 ?? 0) - 15) / 25),
  );
  const volatilityPercentile = entry.atrPercentile;

  let volatility: VolatilityRegime = 'MEDIUM';
  if ((volatilityPercentile ?? 50) <= 20) volatility = 'LOW';
  else if ((volatilityPercentile ?? 50) >= 80) volatility = 'HIGH';

  let regime: MarketRegime = 'TRANSITION';
  if (trendDirection === 'BULLISH' && (adx14 ?? 0) >= 25) regime = 'TREND_UP';
  else if (trendDirection === 'BEARISH' && (adx14 ?? 0) >= 25) regime = 'TREND_DOWN';
  else if (volatilityPercentile !== null && volatilityPercentile >= 85) regime = 'HIGH_VOL';
  else if (volatilityPercentile !== null && volatilityPercentile <= 15) regime = 'LOW_VOL';
  else if ((adx14 ?? 0) <= 20) regime = 'RANGE';

  return {
    regime,
    trendDirection,
    trendStrength,
    volatility,
    volatilityPercentile,
    adx14,
    emaSlopePct: htf.emaSlopePct,
  };
}
