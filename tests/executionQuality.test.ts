import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateExecutionQuality } from '../src/execution/ExecutionQuality.js';
import type { TradeIntent } from '../src/decision/SignalFusion.js';
import type { DerivativesSnapshot } from '../src/market/MarketDataTypes.js';

const mockIntent: TradeIntent = {
  symbol: 'BTCUSDT',
  side: 'LONG',
  sourceAgent: 'STRUCTURE-TREND-η',
  evidenceScore: 80,
  entry: 60_000,
  stopLoss: 59_000,
  takeProfit: 62_500,
  reasons: ['test'],
};

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
    spreadBps: 1.5,
    basisPct: 0.01,
    ...overrides,
  };
}

test('approves healthy market conditions with tight spread and low slippage', () => {
  const deriv = makeDerivatives({ spreadBps: 1.2, orderBookImbalance: 0.05 });
  const verdict = evaluateExecutionQuality(mockIntent, deriv, 5_000);
  assert.equal(verdict.approved, true);
  assert.ok(verdict.effectiveCostBps < 10);
});

test('rejects execution when spread exceeds maximum allowable limit', () => {
  const deriv = makeDerivatives({ spreadBps: 15.0 });
  const verdict = evaluateExecutionQuality(mockIntent, deriv, 5_000);
  assert.equal(verdict.approved, false);
  assert.match(verdict.reason, /Spread 15\.0 bps exceeds/);
});

test('rejects execution when size impact causes excessive estimated slippage', () => {
  const deriv = makeDerivatives({ spreadBps: 2.0, orderBookImbalance: 0.8 });
  // Very large trade relative to liquidity
  const verdict = evaluateExecutionQuality(mockIntent, deriv, 120_000);
  assert.equal(verdict.approved, false);
  assert.match(verdict.reason, /Estimated slippage/);
});
