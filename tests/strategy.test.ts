import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Candle } from '../src/domain/types.js';
import { evaluateOrbSupertrend, type OrbSupertrendParams } from '../src/strategy/orbSupertrend.js';
import { bar, istEpoch, SESSION_DAY } from './support/fixtures.js';

const PREVIOUS_DAY = '2026-10-09';

const PARAMS: OrbSupertrendParams = {
  underlying: 'NIFTY',
  orbMinutes: 15,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  emaFast: 9,
  emaSlow: 21,
  entryStartMinute: 9 * 60 + 30,
  entryEndMinute: 14 * 60 + 30,
  sessionOpenMinute: 9 * 60 + 15,
};

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Five-minute bars on one IST date, each with a symmetric ±0.5 range around `close`. */
function dayBars(dateKey: string, fromMinute: number, closes: readonly number[]): Candle[] {
  return closes.map((close, index) =>
    bar(istEpoch(dateKey, hhmm(fromMinute + index * 5)), close, close + 0.5, close - 0.5, close),
  );
}

/** Previous session rising 90 → 100 so SuperTrend is established UP before today opens. */
function risingWarmup(): Candle[] {
  const closes = Array.from({ length: 60 }, (_, i) => 90 + (i * 10) / 59);
  return dayBars(PREVIOUS_DAY, 9 * 60 + 15, closes);
}

/** Today's opening range (09:15-09:25 bars) sits around 100 with its high at 100.5. */
const ORB_CLOSES = [100, 100, 100];

describe('evaluateOrbSupertrend', () => {
  it('fires BULLISH on the bar that closes through the ORB high in an established uptrend', () => {
    const today = dayBars(SESSION_DAY, 9 * 60 + 15, [...ORB_CLOSES, 100.1, 100.2, 100.3, 101.5]);
    const bars = [...risingWarmup(), ...today];
    const signal = evaluateOrbSupertrend(bars, PARAMS);
    assert.equal(signal?.direction, 'BULLISH');
    assert.equal(signal?.spot, 101.5);
    assert.equal(signal?.barTime, today[today.length - 1]?.time);
  });

  it('does not re-fire when the previous bar already closed beyond the ORB level', () => {
    const today = dayBars(SESSION_DAY, 9 * 60 + 15, [...ORB_CLOSES, 100.1, 101.5, 101.8]);
    assert.equal(evaluateOrbSupertrend([...risingWarmup(), ...today], PARAMS), undefined);
  });

  it('requires SuperTrend confirmation: a level break against a downtrend is not a signal', () => {
    const falling = Array.from({ length: 60 }, (_, i) => 110 - (i * 10) / 59);
    const warmup = dayBars(PREVIOUS_DAY, 9 * 60 + 15, falling);
    const today = dayBars(SESSION_DAY, 9 * 60 + 15, [...ORB_CLOSES, 100.1, 100.2, 100.3, 101.5]);
    assert.equal(evaluateOrbSupertrend([...warmup, ...today], PARAMS), undefined);
  });

  it('produces no signal while the opening range is still forming', () => {
    const today = dayBars(SESSION_DAY, 9 * 60 + 15, [100, 100, 101.5]);
    assert.equal(evaluateOrbSupertrend([...risingWarmup(), ...today], PARAMS), undefined);
  });

  it('produces no signal outside the entry window', () => {
    const today = dayBars(SESSION_DAY, 9 * 60 + 15, [...ORB_CLOSES, ...Array.from({ length: 64 }, () => 100.3), 101.5]);
    assert.equal(evaluateOrbSupertrend([...risingWarmup(), ...today], PARAMS), undefined);
  });

  it('never lets another IST session widen today\'s opening range', () => {
    const outlier = bar(istEpoch(PREVIOUS_DAY, '09:20'), 100, 103, 99.5, 100);
    const today = dayBars(SESSION_DAY, 9 * 60 + 15, [...ORB_CLOSES, 100.1, 100.2, 100.3, 101.5]);
    const signal = evaluateOrbSupertrend([...risingWarmup(), outlier, ...today], PARAMS);
    assert.equal(signal?.direction, 'BULLISH', 'a previous-day high of 103 must not raise today\'s ORB above 101.5');
  });
});
