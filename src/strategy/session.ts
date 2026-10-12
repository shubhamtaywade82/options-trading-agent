import type { Candle, Direction, Signal } from '../domain/types.js';
import { ema, superTrend } from '../market/indicators.js';
import { istParts } from '../time/ist.js';
import { evaluateOrbSupertrend, openingRangeCross, sessionRange, type OrbSupertrendParams } from './orbSupertrend.js';

export const POSTURES = ['scout', 'aligned', 'confirmed'] as const;
export type StrategyPosture = (typeof POSTURES)[number];

export const POSTURE_LABELS: Record<StrategyPosture, string> = {
  scout: 'scout (aggressive)',
  aligned: 'aligned (balanced)',
  confirmed: 'confirmed (protective)',
};

export const STRATEGY_CATALOG = [
  { id: 'range', label: 'Range break' },
  { id: 'trend', label: 'Trend flip' },
] as const;

export type StrategyId = (typeof STRATEGY_CATALOG)[number]['id'];

export interface StrategyChoice {
  readonly id: StrategyId;
  readonly label: string;
  readonly on: boolean;
}

export interface StrategySessionView {
  readonly posture: StrategyPosture;
  readonly strategies: readonly StrategyChoice[];
}

/**
 * Which posture and which strategies may fire. Shared by every underlying so one key changes the session.
 * Range break is tried before trend flip, so when both fire on the same bar the opening-range signal wins.
 */
export class StrategySession {
  private posture: StrategyPosture;
  private readonly enabled = new Set<StrategyId>(STRATEGY_CATALOG.map((row) => row.id));

  constructor(initial: StrategyPosture = 'aligned') {
    this.posture = initial;
  }

  cyclePosture(): string {
    const index = POSTURES.indexOf(this.posture);
    this.posture = POSTURES[(index + 1) % POSTURES.length] ?? 'aligned';
    return `${POSTURE_LABELS[this.posture]} · ${this.armedText()}`;
  }

  setPosture(posture: StrategyPosture): void {
    this.posture = posture;
  }

  toggle(id: StrategyId): string {
    if (this.enabled.has(id)) {
      this.enabled.delete(id);
    } else {
      this.enabled.add(id);
    }
    const label = STRATEGY_CATALOG.find((row) => row.id === id)?.label ?? id;
    const state = this.enabled.has(id) ? 'on' : 'off';
    return `${label} ${state} · ${this.armedText()}`;
  }

  view(): StrategySessionView {
    return {
      posture: this.posture,
      strategies: STRATEGY_CATALOG.map((row) => ({ id: row.id, label: row.label, on: this.enabled.has(row.id) })),
    };
  }

  evaluate(bars: readonly Candle[], params: OrbSupertrendParams): Signal | undefined {
    for (const row of STRATEGY_CATALOG) {
      if (!this.enabled.has(row.id)) {
        continue;
      }
      const signal = row.id === 'range' ? rangeSignal(bars, params, this.posture) : trendSignal(bars, params, this.posture);
      if (signal !== undefined) {
        return signal;
      }
    }
    return undefined;
  }

  private armedText(): string {
    const armed = STRATEGY_CATALOG.filter((row) => this.enabled.has(row.id)).map((row) => row.label);
    return armed.length === 0 ? 'no strategy armed' : armed.join(', ');
  }
}

function tag(signal: Signal, label: string): Signal {
  return { ...signal, reasons: [`${label} (${signal.reasons[0] ?? 'signal'})`, ...signal.reasons.slice(1)] };
}

function inWindow(bar: Candle, params: OrbSupertrendParams): boolean {
  const minute = istParts(bar.time).minuteOfDay;
  return minute >= params.entryStartMinute && minute < params.entryEndMinute;
}

function rangeSignal(bars: readonly Candle[], params: OrbSupertrendParams, posture: StrategyPosture): Signal | undefined {
  if (posture === 'aligned') {
    const signal = evaluateOrbSupertrend(bars, params);
    return signal === undefined ? undefined : tag(signal, 'Range break');
  }
  return posture === 'scout' ? rangeScout(bars, params) : rangeConfirmed(bars, params);
}

function rangeScout(bars: readonly Candle[], params: OrbSupertrendParams): Signal | undefined {
  const cross = openingRangeCross(bars, params);
  const last = bars[bars.length - 1];
  if (cross === undefined || last === undefined) {
    return undefined;
  }
  return tag(plainSignal(params, last, cross.direction, `ORB cross ${cross.level}`), 'Range break');
}

function rangeConfirmed(bars: readonly Candle[], params: OrbSupertrendParams): Signal | undefined {
  const prior = bars.slice(0, -1);
  const crossed = evaluateOrbSupertrend(prior, params);
  const last = bars[bars.length - 1];
  if (crossed === undefined || last === undefined || !inWindow(last, params)) {
    return undefined;
  }
  const day = istParts(last.time).date;
  const range = sessionRange(bars, day, params.sessionOpenMinute, params.sessionOpenMinute + params.orbMinutes);
  if (range === undefined) {
    return undefined;
  }
  const held = crossed.direction === 'BULLISH' ? last.close > range.high : last.close < range.low;
  if (!held || !trendConfluence(bars, params, crossed.direction)) {
    return undefined;
  }
  return tag(
    { ...crossed, barTime: last.time, spot: last.close, reasons: [`held beyond the range at ${last.close}`, ...crossed.reasons.slice(1)] },
    'Range break',
  );
}

function trendConfluence(bars: readonly Candle[], params: OrbSupertrendParams, direction: Direction): boolean {
  const trend = superTrend(bars, params.supertrendPeriod, params.supertrendMultiplier);
  const closes = bars.map((bar) => bar.close);
  const fast = ema(closes, params.emaFast);
  const slow = ema(closes, params.emaSlow);
  if (trend === undefined || fast === undefined || slow === undefined) {
    return false;
  }
  return direction === 'BULLISH' ? trend.trend === 'UP' && fast > slow : trend.trend === 'DOWN' && fast < slow;
}

function plainSignal(params: OrbSupertrendParams, bar: Candle, direction: Direction, detail: string): Signal {
  return { underlying: params.underlying, direction, barTime: bar.time, spot: bar.close, reasons: [detail] };
}

function trendSignal(bars: readonly Candle[], params: OrbSupertrendParams, posture: StrategyPosture): Signal | undefined {
  const last = bars[bars.length - 1];
  const trend = superTrend(bars, params.supertrendPeriod, params.supertrendMultiplier);
  if (last === undefined || trend === undefined || !inWindow(last, params)) {
    return undefined;
  }
  if (posture === 'scout') {
    return trend.flipped ? trendSignalOf(params, last, trend.trend, 'flip') : undefined;
  }
  const closes = bars.map((bar) => bar.close);
  const fast = ema(closes, params.emaFast);
  const slow = ema(closes, params.emaSlow);
  const agrees = fast !== undefined && slow !== undefined && (trend.trend === 'UP' ? fast > slow : fast < slow);
  if (!agrees) {
    return undefined;
  }
  if (posture === 'aligned') {
    return trend.flipped ? trendSignalOf(params, last, trend.trend, 'flip with EMA') : undefined;
  }
  return trendConfirmed(bars, params, last, trend);
}

function trendConfirmed(
  bars: readonly Candle[],
  params: OrbSupertrendParams,
  last: Candle,
  trend: { trend: 'UP' | 'DOWN'; flipped: boolean },
): Signal | undefined {
  const prior = superTrend(bars.slice(0, -1), params.supertrendPeriod, params.supertrendMultiplier);
  if (prior === undefined || !prior.flipped || prior.trend !== trend.trend || trend.flipped) {
    return undefined;
  }
  const day = istParts(last.time).date;
  const orbEnd = params.sessionOpenMinute + params.orbMinutes;
  const range = sessionRange(bars, day, params.sessionOpenMinute, orbEnd);
  if (range === undefined) {
    return undefined;
  }
  const beyond = trend.trend === 'UP' ? last.close > range.high : last.close < range.low;
  return beyond ? trendSignalOf(params, last, trend.trend, 'flip held beyond the range') : undefined;
}

function trendSignalOf(params: OrbSupertrendParams, bar: Candle, trend: 'UP' | 'DOWN', detail: string): Signal {
  const direction: Direction = trend === 'UP' ? 'BULLISH' : 'BEARISH';
  return {
    underlying: params.underlying,
    direction,
    barTime: bar.time,
    spot: bar.close,
    reasons: [`Trend flip (${detail})`, `SuperTrend ${trend}`],
  };
}
