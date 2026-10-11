import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ema, superTrend, wilderAtr } from '../src/market/indicators.js';
import { bar } from './support/fixtures.js';

describe('indicators', () => {
  it('EMA of a constant series is that constant', () => {
    assert.equal(ema(Array.from({ length: 30 }, () => 100), 9), 100);
  });

  it('EMA is undefined until the seed window is full', () => {
    assert.equal(ema([1, 2, 3], 5), undefined);
    assert.throws(() => ema([1, 2, 3], 0), RangeError);
  });

  it('EMA moves toward a step change with the standard smoothing factor', () => {
    const values = [...Array.from({ length: 9 }, () => 10), 20];
    const alpha = 2 / (9 + 1);
    const expected = 20 * alpha + 10 * (1 - alpha);
    assert.ok(Math.abs((ema(values, 9) ?? NaN) - expected) < 1e-9);
  });

  it('Wilder ATR equals the true range for constant-range bars', () => {
    const candles = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 100));
    const atr = wilderAtr(candles, 5);
    assert.equal(atr[3], undefined);
    assert.ok(Math.abs((atr[19] ?? NaN) - 2) < 1e-9);
  });

  it('SuperTrend reports UP on a persistent rally and DOWN on a persistent sell-off', () => {
    const rally = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
    const selloff = Array.from({ length: 60 }, (_, i) => bar(i, 200 - i, 201 - i, 199 - i, 199.5 - i));
    assert.equal(superTrend(rally, 10, 3)?.trend, 'UP');
    assert.equal(superTrend(selloff, 10, 3)?.trend, 'DOWN');
  });

  it('SuperTrend flips when price closes through the active band', () => {
    const up = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i * 0.1, 100.6 + i * 0.1, 99.6 + i * 0.1, 100.2 + i * 0.1));
    const crash = [...up, bar(40, 104, 104.2, 90, 90.5)];
    const before = superTrend(up, 10, 3);
    const after = superTrend(crash, 10, 3);
    assert.equal(before?.trend, 'UP');
    assert.equal(after?.trend, 'DOWN');
    assert.equal(after?.flipped, true);
  });
});
