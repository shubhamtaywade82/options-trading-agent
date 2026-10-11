import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import {
  calculateAdaptiveSuperTrend, kMeans, nearestRegime, wilderAtr,
} from '../src/binance/adaptiveSuperTrend.js';

const BAR_MS = 15 * 60_000;

function candle(index: number, close: number, halfRange = 1): Candle {
  return { openTime: index * BAR_MS, open: close, high: close + halfRange, low: close - halfRange, close, volume: 1 };
}

/** 120 flat bars, 20 rising by 1, 20 falling by 1: constant true range of 2 throughout. */
function upThenDownCloses(): number[] {
  const closes = new Array(120).fill(100);
  for (let i = 1; i <= 20; i++) closes.push(100 + i);
  for (let i = 1; i <= 20; i++) closes.push(120 - i);
  return closes;
}

test('should compute Wilder ATR with SMA seed then recursive smoothing', () => {
  const candles = Array.from({ length: 10 }, (_, i) => candle(i, 10));
  candles.push({ openTime: 10 * BAR_MS, open: 10, high: 22, low: 10, close: 10, volume: 1 });
  const atr = wilderAtr(candles, 10);
  assert.ok(Number.isNaN(atr[8]));
  assert.equal(atr[9], 2);
  assert.ok(Math.abs(atr[10] - 3) < 1e-12);
});

test('should converge K-Means to the cluster means', () => {
  const values = [1, 1, 1, 5, 5, 5, 9, 9, 9];
  assert.deepEqual(kMeans(values, { HIGH: 7, MEDIUM: 5, LOW: 3 }), { HIGH: 9, MEDIUM: 5, LOW: 1 });
});

test('should keep the previous centroid when a cluster is empty', () => {
  assert.deepEqual(kMeans([4, 4, 4], { HIGH: 6, MEDIUM: 4, LOW: 2 }), { HIGH: 6, MEDIUM: 4, LOW: 2 });
});

test('should assign an equidistant value to the higher-volatility cluster', () => {
  assert.equal(nearestRegime(5, { HIGH: 6, MEDIUM: 4, LOW: 2 }), 'HIGH');
});

test('should emit no bars until ATR and the training window both exist', () => {
  const closes = upThenDownCloses();
  assert.equal(calculateAdaptiveSuperTrend(closes.slice(0, 108).map((c, i) => candle(i, c))).length, 0);
  const bars = calculateAdaptiveSuperTrend(closes.slice(0, 109).map((c, i) => candle(i, c)));
  assert.equal(bars.length, 1);
  assert.equal(bars[0].direction, 'BEARISH');
  assert.equal(bars[0].trendShift, null);
});

test('should fire exactly one shift per crossing and use the assigned ATR for the band', () => {
  const bars = calculateAdaptiveSuperTrend(upThenDownCloses().map((c, i) => candle(i, c)));
  const shifts = bars.filter((b) => b.trendShift).map((b) => b.trendShift);
  assert.deepEqual(shifts, ['BULLISH', 'BEARISH']);
  const first = bars[0];
  assert.equal(first.assignedAtr, 2);
  assert.equal(first.superTrend, first.candle.close + 3 * first.assignedAtr);
});

test('should never loosen the lower band while bullish', () => {
  const bars = calculateAdaptiveSuperTrend(upThenDownCloses().map((c, i) => candle(i, c)));
  const bullish = bars.filter((b) => b.direction === 'BULLISH');
  for (let i = 1; i < bullish.length; i++) {
    if (bullish[i].candle.openTime - bullish[i - 1].candle.openTime === BAR_MS) {
      assert.ok(bullish[i].superTrend >= bullish[i - 1].superTrend);
    }
  }
});

test('should report a regime shift only on the bar where the regime changes', () => {
  // Alternating 20-bar calm/volatile blocks move ATR inside the 100-bar training window
  const candles = Array.from({ length: 260 }, (_, i) => candle(i, 100, Math.floor(i / 20) % 2 === 1 ? 6 : 1));
  const bars = calculateAdaptiveSuperTrend(candles);
  bars.forEach((bar, i) => {
    const expected = i > 0 && bars[i - 1].regime !== bar.regime ? bar.regime : null;
    assert.equal(bar.regimeShift, expected);
  });
  assert.ok(bars.filter((b) => b.regimeShift !== null).length >= 4);
});
