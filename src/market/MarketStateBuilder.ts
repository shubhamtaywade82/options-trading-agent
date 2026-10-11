import type { Candle } from '../types.js';
import { detectLiquidity } from './LiquidityEngine.js';
import { classifyRegime, buildTimeframeState } from './RegimeEngine.js';
import { RegimeTracker, type RegimeOptions } from './RegimeScoring.js';
import { calculateCrowding } from './CrowdingEngine.js';
import { analyzeStructure } from './StructureEngine.js';
import { buildZoneLedger } from './ZoneLedger.js';
import { closedCandles, resampleCandles } from './TimeframeEngine.js';
import { detectCauseZone } from './ZoneEngine.js';
import type {
  MarketState,
  MarketStateInput,
  MeanReversionState,
  RangePricing,
  Timeframe,
} from './types.js';
import { bollinger, rsi, vwap, zscore } from '../binance/indicators.js';

const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h'];

function rangePricing(candles: Candle[]): RangePricing {
  const sample = candles.slice(-50);
  const high = sample.length ? Math.max(...sample.map((c) => c.high)) : 0;
  const low = sample.length ? Math.min(...sample.map((c) => c.low)) : 0;
  const equilibrium = high > low ? (high + low) / 2 : high;
  const last = sample.at(-1)?.close ?? 0;
  const positionPct = high > low ? ((last - low) / (high - low)) * 100 : 50;
  return {
    high,
    low,
    equilibrium,
    positionPct,
    premium: positionPct > 50,
    discount: positionPct < 50,
  };
}

function meanReversion(candles: Candle[]): MeanReversionState {
  const closes = candles.map((c) => c.close);
  const period = Math.min(20, closes.length);
  if (period < 2) {
    return {
      mean: null, vwap: null, zscore: null, rsi14: null,
      bollingerMiddle: null, bollingerUpper: null, bollingerLower: null, deviationPct: null,
    };
  }

  const bands = bollinger(closes, period, 2);
  const meanValue = bands.middle.at(-1);
  const recent = closes.slice(-period);
  const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const latest = closes.at(-1)!;

  return {
    mean,
    vwap: vwap(candles, Math.min(96, Math.max(2, candles.length))).at(-1) ?? null,
    zscore: zscore(closes, period),
    rsi14: rsi(closes, 14).at(-1) ?? null,
    bollingerMiddle: meanValue ?? null,
    bollingerUpper: bands.upper.at(-1) ?? null,
    bollingerLower: bands.lower.at(-1) ?? null,
    deviationPct: mean !== 0 ? ((latest - mean) / mean) * 100 : null,
  };
}

function nativeOrResampled(
  native: Partial<Record<'1m' | '5m' | '15m' | '1h' | '4h', Candle[]>> | undefined,
  timeframe: Timeframe,
  fallback15m: Candle[],
): Candle[] {
  const provided = native?.[timeframe];
  if (provided && provided.length > 0) return provided;
  return timeframe === '15m'
    ? fallback15m
    : resampleCandles(fallback15m, timeframe);
}

export class MarketStateBuilder {
  private cache = new Map<string, MarketState>();
  private readonly regimeTracker: RegimeTracker | null;

  /** Pass regime options to use the scored regime with hysteresis; omit for the original first-match classifier. */
  constructor(regimeOptions?: Partial<RegimeOptions>) {
    this.regimeTracker = regimeOptions ? new RegimeTracker(regimeOptions) : null;
  }

  build(input: MarketStateInput): MarketState {
    const fallback15m = closedCandles(input.candles);
    const tf15 = nativeOrResampled(input.candlesByTimeframe, '15m', fallback15m);
    const tf1h = nativeOrResampled(input.candlesByTimeframe, '1h', fallback15m);
    const tf4h = nativeOrResampled(input.candlesByTimeframe, '4h', fallback15m);
    const latestClosedTime = tf15.at(-1)?.openTime ?? 0;
    const cached = this.cache.get(input.symbol);

    if (cached && latestClosedTime === cached.generatedAt) {
      const derivatives = input.derivatives ?? cached.derivatives ?? null;
      return {
        ...cached,
        mark: input.mark,
        fundingRate: input.fundingRate,
        derivatives,
        crowding: calculateCrowding(derivatives, input.fundingRate),
      };
    }

    const timeframes = {
      '15m': buildTimeframeState('15m', tf15),
      '1h': buildTimeframeState('1h', tf1h),
      '4h': buildTimeframeState('4h', tf4h),
    };

    const htfStructure = analyzeStructure('1h', tf1h, timeframes['1h'].atr14 ?? 0);
    const ltfStructure = analyzeStructure('15m', tf15, timeframes['15m'].atr14 ?? 0);

    const liquidity = {
      htf: detectLiquidity('1h', tf1h, htfStructure, timeframes['1h'].atr14 ?? 0),
      ltf: detectLiquidity('15m', tf15, ltfStructure, timeframes['15m'].atr14 ?? 0),
    };

    const zones = [
      ...detectCauseZone('1h', tf1h, htfStructure.lastBreak, timeframes['1h'].atr14 ?? 0),
      ...detectCauseZone('15m', tf15, ltfStructure.lastBreak, timeframes['15m'].atr14 ?? 0),
    ];

    const zoneLedger = [
      ...buildZoneLedger('1h', tf1h, timeframes['1h'].atr14 ?? 0, htfStructure.breaks ?? []),
      ...buildZoneLedger('15m', tf15, timeframes['15m'].atr14 ?? 0, ltfStructure.breaks ?? []),
    ];

    const derivatives = input.derivatives ?? null;
    const state: MarketState = {
      version: 1,
      symbol: input.symbol,
      generatedAt: latestClosedTime,
      mark: input.mark,
      fundingRate: input.fundingRate,
      regime: this.regimeTracker
        ? this.regimeTracker.update(input.symbol, latestClosedTime, timeframes['15m'], timeframes['1h'])
        : classifyRegime(timeframes['15m'], timeframes['1h']),
      timeframes,
      htfStructure,
      ltfStructure,
      liquidity,
      zones,
      zoneLedger,
      pricing: rangePricing(tf1h),
      meanReversion: meanReversion(tf15),
      derivatives,
      crowding: calculateCrowding(derivatives, input.fundingRate),
    };

    this.cache.set(input.symbol, state);
    return state;
  }

  buildAll(inputs: MarketStateInput[]): Record<string, MarketState> {
    return Object.fromEntries(inputs.map((input) => [input.symbol, this.build(input)]));
  }
}
