import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateCrowding } from '../src/market/CrowdingEngine.js';
import type { DerivativesSnapshot } from '../src/market/MarketDataTypes.js';

function makeDerivatives(overrides: Partial<DerivativesSnapshot>): DerivativesSnapshot {
  return {
    asOf: Date.now(),
    openInterest: 10_000,
    openInterestChangePct: 0.5,
    globalLongShortRatio: 1.0,
    topTraderAccountLongShortRatio: 1.0,
    topTraderPositionLongShortRatio: 1.0,
    takerBuySellRatio: 1.0,
    takerVolumeImbalance: 0,
    orderBookImbalance: 0,
    spreadBps: 1,
    basisPct: 0.01,
    ...overrides,
  };
}

test('returns default balanced state when derivatives data is absent', () => {
  const result = calculateCrowding(null, 0.0001);
  assert.equal(result.positioningExtreme, 'BALANCED');
  assert.equal(result.topTraderVsGlobalBias, null);
  assert.equal(result.openInterestExpansion, false);
});

test('identifies LONG_CROWDED when global L/S is elevated with positive funding', () => {
  const deriv = makeDerivatives({
    globalLongShortRatio: 2.2,
    topTraderPositionLongShortRatio: 2.6,
    openInterestChangePct: 2.1,
    takerBuySellRatio: 1.4,
  });
  const result = calculateCrowding(deriv, 0.0005);
  assert.equal(result.positioningExtreme, 'LONG_CROWDED');
  assert.equal(result.openInterestExpansion, true);
  assert.ok(result.topTraderVsGlobalBias! > 1.0);
  assert.ok(result.fundingPercentile! >= 90);
});

test('identifies SHORT_CROWDED when global L/S is depressed with negative funding', () => {
  const deriv = makeDerivatives({
    globalLongShortRatio: 0.5,
    topTraderPositionLongShortRatio: 0.4,
    openInterestChangePct: 1.8,
    takerBuySellRatio: 0.7,
  });
  const result = calculateCrowding(deriv, -0.0005);
  assert.equal(result.positioningExtreme, 'SHORT_CROWDED');
  assert.equal(result.openInterestExpansion, true);
  assert.ok(result.fundingPercentile! <= 10);
});

test('correctly calculates top trader vs global positioning asymmetry', () => {
  const deriv = makeDerivatives({
    globalLongShortRatio: 1.0,
    topTraderPositionLongShortRatio: 1.5,
  });
  const result = calculateCrowding(deriv, 0.0001);
  assert.equal(result.positioningExtreme, 'BALANCED');
  assert.equal(result.topTraderVsGlobalBias, 1.5);
});
