import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRegime } from '../src/market/RegimeEngine.js';
import { RegimeTracker, trendScore } from '../src/market/RegimeScoring.js';
import type { TimeframeState } from '../src/market/types.js';

const tf = (over: Partial<TimeframeState> = {}): TimeframeState => ({
  timeframe: '15m', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.3, adx14: 30, atr14: 1,
  atrPercentile: 50, rsi14: 58, vwap: 99, bollingerMiddle: 99, bollingerUpper: 101, bollingerLower: 97, ...over,
});
const up = (over: Partial<TimeframeState> = {}) => tf(over);
const htfUp = tf({ timeframe: '1h', lastClose: 100, ema200: 95, emaSlopePct: 0.2 });
const htfDown = tf({ timeframe: '1h', lastClose: 90, ema200: 95, emaSlopePct: -0.2 });
const htfFlat = tf({ timeframe: '1h', lastClose: 100, ema200: 100, ema50: null, ema20: null, emaSlopePct: 0 });
const bar = (n: number) => n * 900_000;

// ---- the score ----

test('should score a clean aligned uptrend high and the opposite direction zero', () => {
  assert.ok(trendScore(up(), htfUp, 1) > 0.75);
  assert.equal(trendScore(up(), htfUp, -1), 0); // against the higher timeframe
});

test('should cap a trend under a neutral higher timeframe below the entry threshold', () => {
  assert.ok(trendScore(up({ adx14: 45 }), htfFlat, 1) <= 0.4 + 1e-9);
});

test('should score weak, misaligned conditions low and stay within 0..1 with missing indicators', () => {
  const weak = trendScore(up({ adx14: 14, emaSlopePct: -0.2, ema20: 97, ema50: 98, ema200: 99, lastClose: 96, vwap: 99 }), htfUp, 1);
  assert.ok(weak < 0.25, String(weak));
  const empty = tf({ adx14: null, emaSlopePct: null, ema20: null, ema50: null, ema200: null, vwap: null });
  const score = trendScore(empty, htfUp, 1);
  assert.ok(score >= 0 && score <= 1 && Number.isFinite(score));
});

// ---- hysteresis ----

test('should adopt the first bar as it is, with a confidence and the raw regime attached', () => {
  const snap = new RegimeTracker().update('BTCUSDT', bar(1), up(), htfUp);
  assert.equal(snap.regime, 'TREND_UP');
  assert.equal(snap.rawRegime, 'TREND_UP');
  assert.equal(snap.barsInRegime, 1);
  assert.ok(snap.confidence! > 0.75 && snap.trendScore! > 0);
});

test('should not flip on a single bar of contrary evidence, and flip once it persists for the dwell time', () => {
  const tracker = new RegimeTracker({ confirmBars: 2 });
  tracker.update('BTCUSDT', bar(1), up(), htfUp);
  const flat = up({ adx14: 12, emaSlopePct: 0, ema20: 100, ema50: 100, ema200: 100, lastClose: 100, vwap: 100, atrPercentile: 50 });
  const first = tracker.update('BTCUSDT', bar(2), flat, htfUp);
  assert.deepEqual([first.regime, first.rawRegime, first.pendingRegime], ['TREND_UP', 'RANGE', 'RANGE']);
  const second = tracker.update('BTCUSDT', bar(3), flat, htfUp);
  assert.deepEqual([second.regime, second.barsInRegime, second.pendingRegime], ['RANGE', 1, null]);
});

test('should drop a pending challenger that does not persist (a one-bar blip resets the dwell count)', () => {
  const tracker = new RegimeTracker({ confirmBars: 2 });
  tracker.update('BTCUSDT', bar(1), up(), htfUp);
  const flat = up({ adx14: 12, emaSlopePct: 0, ema20: 100, ema50: 100, ema200: 100, lastClose: 100, vwap: 100 });
  tracker.update('BTCUSDT', bar(2), flat, htfUp); // challenger RANGE, 1 bar
  const back = tracker.update('BTCUSDT', bar(3), up(), htfUp); // trend returns
  assert.deepEqual([back.regime, back.pendingRegime], ['TREND_UP', null]);
  const again = tracker.update('BTCUSDT', bar(4), flat, htfUp);
  assert.equal(again.regime, 'TREND_UP'); // the count restarted, so one more flat bar is still not enough
});

test('should keep a trend while its score sits between the exit and entry thresholds, where the classic rule flickers', () => {
  const tracker = new RegimeTracker({ confirmBars: 1 });
  tracker.update('BTCUSDT', bar(1), up(), htfUp); // strong trend: held
  // ADX slides 30 -> 22 while the rest of the picture stays aligned: the classic rule drops to TRANSITION below 25
  const fading = up({ adx14: 22 });
  assert.equal(classifyRegime(fading, htfUp).regime, 'TRANSITION');
  assert.ok(trendScore(fading, htfUp, 1) >= 0.4 && trendScore(fading, htfUp, 1) < 0.78);
  assert.equal(tracker.update('BTCUSDT', bar(2), fading, htfUp).regime, 'TREND_UP');
});

test('should not ENTER a trend on the same borderline evidence that a held trend would survive', () => {
  const fading = up({ adx14: 17, emaSlopePct: 0.05 });
  const score = trendScore(fading, htfUp, 1);
  assert.ok(score >= 0.4 && score < 0.55, String(score));
  const fresh = new RegimeTracker({ confirmBars: 1 }).update('BTCUSDT', bar(1), fading, htfUp);
  assert.notEqual(fresh.regime, 'TREND_UP');
  const held = new RegimeTracker({ confirmBars: 1 });
  held.update('BTCUSDT', bar(1), up(), htfUp);
  assert.equal(held.update('BTCUSDT', bar(2), fading, htfUp).regime, 'TREND_UP');
});

test('should require the dwell time to reverse direction and not pass through a neutral label for free', () => {
  const tracker = new RegimeTracker({ confirmBars: 2 });
  tracker.update('BTCUSDT', bar(1), up(), htfUp);
  const down = tf({ lastClose: 90, ema20: 91, ema50: 93, ema200: 95, emaSlopePct: -0.3, adx14: 32, vwap: 92, atrPercentile: 50 });
  assert.equal(tracker.update('BTCUSDT', bar(2), down, htfDown).regime, 'TREND_UP');
  assert.equal(tracker.update('BTCUSDT', bar(3), down, htfDown).regime, 'TREND_DOWN');
});

test('should be idempotent for a bar it has already seen', () => {
  const tracker = new RegimeTracker({ confirmBars: 2 });
  tracker.update('BTCUSDT', bar(1), up(), htfUp);
  const flat = up({ adx14: 12, emaSlopePct: 0, ema20: 100, ema50: 100, ema200: 100, lastClose: 100, vwap: 100 });
  for (let i = 0; i < 5; i += 1) tracker.update('BTCUSDT', bar(2), flat, htfUp); // same bar, five times
  assert.equal(tracker.update('BTCUSDT', bar(2), flat, htfUp).regime, 'TREND_UP');
});

test('should keep each symbol independent', () => {
  const tracker = new RegimeTracker({ confirmBars: 2 });
  tracker.update('BTCUSDT', bar(1), up(), htfUp);
  const eth = tracker.update('ETHUSDT', bar(1), tf({ adx14: 12, emaSlopePct: 0, ema20: 100, ema50: 100, ema200: 100, lastClose: 100, vwap: 100 }), htfUp);
  assert.equal(eth.regime, 'RANGE');
  assert.equal(tracker.update('BTCUSDT', bar(1), up(), htfUp).regime, 'TREND_UP');
});

test('should hold RANGE until ADX clearly leaves it and treat the volatility labels with slack', () => {
  const tracker = new RegimeTracker({ confirmBars: 1 });
  const flat = { ema20: 100, ema50: 100, ema200: 100, lastClose: 100, vwap: 100, emaSlopePct: 0 };
  tracker.update('X', bar(1), tf({ ...flat, adx14: 15 }), htfFlat);
  assert.equal(tracker.update('X', bar(2), tf({ ...flat, adx14: 22 }), htfFlat).regime, 'RANGE'); // classic: TRANSITION above 20
  assert.equal(tracker.update('X', bar(3), tf({ ...flat, adx14: 24 }), htfFlat).regime, 'TRANSITION');
  tracker.update('Y', bar(1), tf({ ...flat, adx14: 22, atrPercentile: 90 }), htfFlat);
  assert.equal(tracker.update('Y', bar(2), tf({ ...flat, adx14: 22, atrPercentile: 82 }), htfFlat).regime, 'HIGH_VOL'); // stays above 80
});

test('should keep the legacy indicator fields and never emit an invalid confidence', () => {
  const snap = new RegimeTracker().update('BTCUSDT', bar(1), tf({ adx14: null, emaSlopePct: null, atrPercentile: null }), htfFlat);
  assert.ok(snap.confidence! >= 0 && snap.confidence! <= 1);
  assert.equal(snap.adx14, null);
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(snap.volatility));
});

test('should reject inconsistent options', () => {
  assert.throws(() => new RegimeTracker({ trendEnter: 0.4, trendExit: 0.5 }), /trendExit/);
  assert.throws(() => new RegimeTracker({ confirmBars: 0 }), /confirmBars/);
});

// ---- through MarketStateBuilder ----

import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import type { Candle } from '../src/types.js';

const BAR_MS = 900_000;
const rising = (count: number): Candle[] => Array.from({ length: count }, (_, i) => {
  const close = 100 + i * 0.4 + Math.sin(i / 5) * 0.2;
  return { openTime: i * BAR_MS, open: close - 0.2, high: close + 0.5, low: close - 0.5, close, volume: 100 };
});
const input = (candles: Candle[]) => ({ symbol: 'BTCUSDT', candles: [...candles, { ...candles.at(-1)!, openTime: candles.length * BAR_MS }], mark: candles.at(-1)!.close, fundingRate: 0 });

test('should leave the regime exactly as the classic classifier says when no options are passed', () => {
  const state = new MarketStateBuilder().build(input(rising(320)));
  assert.equal(state.regime.rawRegime, undefined);
  assert.equal(state.regime.confidence, undefined);
});

test('should attach the held regime, its confidence and dwell info when scoring is on, and not advance on a repeat build', () => {
  const builder = new MarketStateBuilder({ confirmBars: 2 });
  const first = builder.build(input(rising(320)));
  assert.equal(first.regime.regime, first.regime.rawRegime);
  assert.equal(first.regime.barsInRegime, 1);
  assert.ok(first.regime.confidence! >= 0 && first.regime.confidence! <= 1);
  const again = builder.build(input(rising(320))); // same closed bar, new mark: served from the cache
  assert.equal(again.regime.barsInRegime, 1);
  const next = builder.build(input(rising(321)));
  assert.equal(next.regime.barsInRegime, 2);
});
