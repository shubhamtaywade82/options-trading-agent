import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { bracketLevels, roundDownToTick, roundUpToTick } from '../src/options/pricing.js';
import { sizePosition } from '../src/options/sizing.js';

describe('tick rounding', () => {
  it('rounds the stop up and the target down on the tick grid', () => {
    assert.equal(roundUpToTick(70.01, 0.05), 70.05);
    assert.equal(roundDownToTick(159.99, 0.05), 159.95);
    assert.equal(roundUpToTick(70, 0.05), 70, 'exact grid values are not moved');
    assert.equal(roundUpToTick(0.1 * 3, 0.1), 0.3, 'floating-point residue is removed');
    assert.throws(() => roundUpToTick(10, 0), RangeError);
  });
});

describe('bracketLevels', () => {
  it('builds a stop at the configured percentage and a target at the configured R-multiple', () => {
    const levels = bracketLevels({ entryReference: 100, stopLossPct: 30, targetRr: 2, tickSize: 0.05 });
    assert.deepEqual(levels, { entryReference: 100, stopLossPrice: 70, targetPrice: 160, riskPerUnit: 30 });
  });

  it('returns undefined when the stop cannot be expressed on the tick grid', () => {
    assert.equal(bracketLevels({ entryReference: 0.1, stopLossPct: 30, targetRr: 2, tickSize: 0.05 }), undefined);
  });

  it('returns undefined for non-positive premiums', () => {
    assert.equal(bracketLevels({ entryReference: 0, stopLossPct: 30, targetRr: 2, tickSize: 0.05 }), undefined);
  });
});

describe('sizePosition', () => {
  const base = {
    capitalInr: 100_000,
    maxRiskPerTradePct: 1,
    availableFundsInr: 1_000_000,
    entryReference: 100,
    stopLossPrice: 70,
    lotSize: 75,
    maxLotsPerOrder: 10,
  };

  it('returns zero lots when one lot exceeds the risk budget', () => {
    const result = sizePosition(base);
    assert.equal(result.lots, 0);
    assert.equal(result.limitedBy, 'RISK');
  });

  it('floors lots to whole lots within the risk budget', () => {
    const result = sizePosition({ ...base, maxRiskPerTradePct: 5 });
    assert.equal(result.lots, 2, '5000 budget / 2250 per lot floors to 2');
    assert.equal(result.quantity, 150);
    assert.equal(result.riskInr, 4500);
    assert.ok(result.riskInr <= result.riskBudgetInr);
  });

  it('is limited by available funds when cash, not risk, binds', () => {
    const result = sizePosition({ ...base, maxRiskPerTradePct: 50, availableFundsInr: 15_000 });
    assert.equal(result.lots, 2);
    assert.equal(result.limitedBy, 'FUNDS');
  });

  it('is limited by the per-order lot cap when that binds first', () => {
    const result = sizePosition({ ...base, maxRiskPerTradePct: 50, maxLotsPerOrder: 1 });
    assert.equal(result.lots, 1);
    assert.equal(result.limitedBy, 'MAX_LOTS');
  });

  it('refuses to size a degenerate stop instead of dividing by zero', () => {
    assert.equal(sizePosition({ ...base, stopLossPrice: 100 }).lots, 0);
  });
});
