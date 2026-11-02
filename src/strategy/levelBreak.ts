import type { Candle, Direction, Signal } from '../domain/types.js';
import { superTrend } from '../market/indicators.js';
import { istParts } from '../time/ist.js';
import type { OrbSupertrendParams } from './orbSupertrend.js';

/** High and low of the latest IST date before `today` in `bars`. Undefined when there is none. */
function previousDayLevels(bars: readonly Candle[], today: string): { high: number; low: number } | undefined {
  let day: string | undefined;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const bar = bars[i];
    const date = bar === undefined ? undefined : istParts(bar.time).date;
    if (bar === undefined || date === undefined || date >= today) {
      continue;
    }
    if (day !== undefined && date !== day) {
      break;
    }
    day = date;
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
  }
  return day === undefined ? undefined : { high, low };
}

/**
 * A closed bar that crosses the previous session's high (bullish) or low (bearish). Outside scout posture the
 * SuperTrend must agree. Only the crossing bar fires, never a bar already beyond the level.
 */
export function previousDayBreak(bars: readonly Candle[], params: OrbSupertrendParams, isScout: boolean): Signal | undefined {
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (last === undefined || prev === undefined) return undefined;
  const parts = istParts(last.time);
  if (parts.minuteOfDay < params.entryStartMinute || parts.minuteOfDay >= params.entryEndMinute) return undefined;
  if (istParts(prev.time).date !== parts.date) return undefined;
  const levels = previousDayLevels(bars, parts.date);
  if (levels === undefined) return undefined;
  const bullish = last.close > levels.high && prev.close <= levels.high;
  const bearish = last.close < levels.low && prev.close >= levels.low;
  if (!bullish && !bearish) return undefined;
  const direction: Direction = bullish ? 'BULLISH' : 'BEARISH';
  if (!isScout) {
    const trend = superTrend(bars, params.supertrendPeriod, params.supertrendMultiplier);
    if (trend === undefined || trend.trend !== (bullish ? 'UP' : 'DOWN')) return undefined;
  }
  const level = bullish ? levels.high : levels.low;
  return {
    underlying: params.underlying,
    direction,
    barTime: last.time,
    spot: last.close,
    reasons: [`Previous-day break (${bullish ? 'high' : 'low'} ${level} crossed by close ${last.close})`],
  };
}
