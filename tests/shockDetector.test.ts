import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { ShockDetector } from '../src/market/ShockDetector.js';

const OPTIONS = { returnZ: 4, volumeZ: 4, spreadMult: 2, recoveryBars: 5 };

/** Deterministic mildly noisy series: small alternating returns so the baseline has real variance. */
function calm(count: number, start = 100): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price *= 1 + (i % 2 === 0 ? 0.0005 : -0.0004) * (1 + (i % 5) / 10);
    out.push({ openTime: i * 60_000, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 100 + (i % 7) });
  }
  return out;
}
const bar = (prev: Candle, close: number, volume: number, index: number): Candle =>
  ({ openTime: index * 60_000, open: prev.close, high: Math.max(prev.close, close), low: Math.min(prev.close, close), close, volume });

test('should read NORMAL on a calm series', () => {
  const detector = new ShockDetector(OPTIONS);
  assert.equal(detector.evaluate('BTCUSDT', calm(120), 2).level, 'NORMAL');
});

test('should report insufficient data instead of a verdict on a short history', () => {
  const reading = new ShockDetector(OPTIONS).evaluate('BTCUSDT', calm(30), 2);
  assert.equal(reading.level, 'NORMAL');
  assert.equal(reading.reason, 'insufficient-data');
});

test('should flag SHOCK on a return outlier confirmed by volume', () => {
  const bars = calm(119);
  bars.push(bar(bars[118]!, bars[118]!.close * 0.97, 2_000, 119));
  const reading = new ShockDetector(OPTIONS).evaluate('BTCUSDT', bars, 2);
  assert.equal(reading.level, 'SHOCK');
  assert.ok(Math.abs(reading.retZ) >= 4 && reading.volZ >= 4);
});

test('should not flag a return outlier with ordinary volume and a normal spread', () => {
  const bars = calm(119);
  bars.push(bar(bars[118]!, bars[118]!.close * 0.97, 103, 119));
  assert.equal(new ShockDetector(OPTIONS).evaluate('BTCUSDT', bars, 2).level, 'NORMAL');
});

test('should confirm a return outlier by a spread blow-out instead of volume', () => {
  const detector = new ShockDetector(OPTIONS);
  const base = calm(119);
  for (let i = 0; i < 30; i += 1) detector.evaluate('BTCUSDT', base, 2); // spread baseline ~2 bps
  const bars = [...base, bar(base[118]!, base[118]!.close * 0.97, 103, 119)];
  const reading = detector.evaluate('BTCUSDT', bars, 9);
  assert.equal(reading.level, 'SHOCK');
  assert.ok(reading.spreadMult >= 2);
});

test('should stay in SHOCK until the configured number of calm bars has passed', () => {
  const detector = new ShockDetector(OPTIONS);
  const bars = calm(119);
  bars.push(bar(bars[118]!, bars[118]!.close * 0.97, 2_000, 119));
  assert.equal(detector.evaluate('BTCUSDT', bars, 2).level, 'SHOCK');
  const levels: string[] = [];
  for (let i = 120; i < 125; i += 1) {
    const last = bars[bars.length - 1]!;
    bars.push(bar(last, last.close * (i % 2 === 0 ? 1.0003 : 0.9998), 100, i));
    levels.push(detector.evaluate('BTCUSDT', bars, 2).level);
  }
  assert.deepEqual(levels, ['SHOCK', 'SHOCK', 'SHOCK', 'SHOCK', 'NORMAL']);
});

test('should be idempotent for the same bar: repeated cycles do not advance recovery', () => {
  const detector = new ShockDetector(OPTIONS);
  const bars = calm(119);
  bars.push(bar(bars[118]!, bars[118]!.close * 0.97, 2_000, 119));
  detector.evaluate('BTCUSDT', bars, 2);
  const last = bars[bars.length - 1]!;
  bars.push(bar(last, last.close * 1.0002, 100, 120));
  for (let i = 0; i < 20; i += 1) detector.evaluate('BTCUSDT', bars, 2);
  assert.equal(detector.levelOf('BTCUSDT'), 'SHOCK');
});

test('should never produce NaN on a flat zero-variance series', () => {
  const flat: Candle[] = Array.from({ length: 120 }, (_, i) => ({ openTime: i * 60_000, open: 100, high: 100, low: 100, close: 100, volume: 50 }));
  const reading = new ShockDetector(OPTIONS).evaluate('BTCUSDT', flat, 2);
  assert.equal(reading.level, 'NORMAL');
  assert.ok(Number.isFinite(reading.retZ) && Number.isFinite(reading.volZ));
});

test('should treat a corrupt candle (non-positive close) as insufficient data', () => {
  const bars = calm(120);
  bars[50] = { ...bars[50]!, close: 0 };
  assert.equal(new ShockDetector(OPTIONS).evaluate('BTCUSDT', bars, 2).reason, 'insufficient-data');
});

test('should keep per-symbol state independent', () => {
  const detector = new ShockDetector(OPTIONS);
  const bars = calm(119);
  bars.push(bar(bars[118]!, bars[118]!.close * 0.97, 2_000, 119));
  detector.evaluate('BTCUSDT', bars, 2);
  assert.equal(detector.levelOf('ETHUSDT'), 'NORMAL');
});
