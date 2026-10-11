import type { Candle, Signal } from '../domain/types.js';
import { istParts } from '../time/ist.js';
import { ema, superTrend } from '../market/indicators.js';

export interface OrbSupertrendParams {
  readonly underlying: string;
  readonly orbMinutes: number;
  readonly supertrendPeriod: number;
  readonly supertrendMultiplier: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  /** Signal bars must open inside [entryStartMinute, entryEndMinute) IST. */
  readonly entryStartMinute: number;
  readonly entryEndMinute: number;
  /** Opening range begins at the first regular-session minute. */
  readonly sessionOpenMinute: number;
}

/**
 * Opening-range breakout confirmed by SuperTrend direction and EMA alignment,
 * evaluated only on closed bars. A signal fires on the bar that crosses the
 * opening-range boundary; a bar that is already beyond it does not re-fire.
 *
 * Returns undefined rather than a weak signal whenever inputs are insufficient.
 */
export function evaluateOrbSupertrend(bars: readonly Candle[], params: OrbSupertrendParams): Signal | undefined {
  const signalBar = bars[bars.length - 1];
  const previousBar = bars[bars.length - 2];
  if (signalBar === undefined || previousBar === undefined) {
    return undefined;
  }

  const signalParts = istParts(signalBar.time);
  const previousParts = istParts(previousBar.time);
  if (signalParts.date !== previousParts.date) {
    return undefined;
  }
  if (signalParts.minuteOfDay < params.entryStartMinute || signalParts.minuteOfDay >= params.entryEndMinute) {
    return undefined;
  }

  const orbEndMinute = params.sessionOpenMinute + params.orbMinutes;
  if (signalParts.minuteOfDay < orbEndMinute) {
    return undefined;
  }

  const sessionBars = bars.filter((bar) => {
    const parts = istParts(bar.time);
    return parts.date === signalParts.date && parts.minuteOfDay >= params.sessionOpenMinute && parts.minuteOfDay < orbEndMinute;
  });
  if (sessionBars.length === 0) {
    return undefined;
  }
  const orbHigh = Math.max(...sessionBars.map((bar) => bar.high));
  const orbLow = Math.min(...sessionBars.map((bar) => bar.low));

  const closes = bars.map((bar) => bar.close);
  const fast = ema(closes, params.emaFast);
  const slow = ema(closes, params.emaSlow);
  const trend = superTrend(bars, params.supertrendPeriod, params.supertrendMultiplier);
  if (fast === undefined || slow === undefined || trend === undefined) {
    return undefined;
  }

  const breakoutUp = signalBar.close > orbHigh && previousBar.close <= orbHigh;
  const breakoutDown = signalBar.close < orbLow && previousBar.close >= orbLow;

  if (breakoutUp && trend.trend === 'UP' && fast > slow) {
    return {
      underlying: params.underlying,
      direction: 'BULLISH',
      barTime: signalBar.time,
      spot: signalBar.close,
      reasons: [
        `ORB high ${orbHigh} broken by close ${signalBar.close}`,
        `SuperTrend UP (line ${trend.line.toFixed(2)})`,
        `EMA${params.emaFast} ${fast.toFixed(2)} > EMA${params.emaSlow} ${slow.toFixed(2)}`,
      ],
    };
  }

  if (breakoutDown && trend.trend === 'DOWN' && fast < slow) {
    return {
      underlying: params.underlying,
      direction: 'BEARISH',
      barTime: signalBar.time,
      spot: signalBar.close,
      reasons: [
        `ORB low ${orbLow} broken by close ${signalBar.close}`,
        `SuperTrend DOWN (line ${trend.line.toFixed(2)})`,
        `EMA${params.emaFast} ${fast.toFixed(2)} < EMA${params.emaSlow} ${slow.toFixed(2)}`,
      ],
    };
  }

  return undefined;
}
