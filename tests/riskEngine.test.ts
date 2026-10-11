import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PerformanceSnapshot } from '../src/risk/performanceEngine.js';
import { failedSizing, sizePosition, type SizingResult } from '../src/risk/positionSizer.js';
import { evaluateRisk, type PortfolioView, type RiskDecision, type RiskInput } from '../src/risk/riskEngine.js';
import type { RiskLimits } from '../src/risk/riskConfig.js';

const limits: RiskLimits = {
  maxRiskPerTradePercent: 1, maxLeverage: 10, minLeverage: 5, maxDailyLossPercent: 3, maxDrawdownPercent: 5,
  maxLossStreak: 4, maxConcurrentPositions: 4, maxSymbolExposurePercent: 80, maxPortfolioGrossExposurePercent: 80,
  maxCorrelatedExposurePercent: 80, maxNotionalPerTrade: 1e9, minRiskRewardRatio: 0, feeRateTaker: 0.0004,
  slippageBufferRate: 0.0002,
};

const RISK_BUDGET = 100; // 1 % of the 10_000 equity
const BUDGET_TOLERANCE = 1.02;

const flatPerformance: PerformanceSnapshot = {
  dailyLossPercent: 0, drawdownPercent: 0, lossStreak: 0, winStreak: 0, realizedToday: 0, profitFactor: 0, expectancy: 0,
};

const sizing = (over: Partial<SizingResult> = {}): SizingResult => ({
  ok: true, quantity: 1, notional: 150, marginRequired: 75, leverage: 2, riskAmount: 50, effectiveRiskPerUnit: 50,
  feePerUnit: 0, fundingPerUnit: 0, warnings: [], ...over,
});

const portfolio = (over: Partial<PortfolioView> = {}): PortfolioView => ({
  equity: 10_000, openPositions: 0, grossExposure: 0, symbolExposure: () => 0, clusterExposure: () => 0,
  performance: flatPerformance, ...over,
});

const inputWith = (over: Partial<RiskInput> = {}): RiskInput => ({
  symbol: 'SOLUSDT', sizing: sizing(), portfolio: portfolio(), limits, ...over,
});

const withPerformance = (over: Partial<PerformanceSnapshot>): PortfolioView =>
  portfolio({ performance: { ...flatPerformance, ...over } });

const checkNamed = (decision: RiskDecision, name: string) => {
  const found = decision.checks.find((c) => c.name === name);
  assert.ok(found, `check ${name} missing from ${decision.checks.map((c) => c.name).join(',')}`);
  return found;
};

const failedNames = (decision: RiskDecision): string[] => decision.checks.filter((c) => !c.passed).map((c) => c.name);

const ALL_CHECKS = ['sizing', 'risk_per_trade', 'leverage', 'position_count', 'daily_loss', 'loss_streak', 'portfolio_limits'];

test('should approve a healthy sizing and list every passed check', () => {
  const decision = evaluateRisk(inputWith());
  assert.equal(decision.approved, true);
  assert.equal(decision.circuit, 'NORMAL');
  assert.deepEqual(decision.checks.map((c) => c.name), ALL_CHECKS);
  assert.ok(decision.checks.every((c) => c.passed));
  assert.deepEqual(decision.reasons, ['all 7 checks passed', 'circuit NORMAL']);
});

test('should approve the output of the real sizer on an empty portfolio', () => {
  const spec = { symbol: 'SOLUSDT', lotSize: 0.01, minQuantity: 0.01, maxQuantity: 10_000, minNotional: 20, tickSize: 0.01, maxLeverage: 15 };
  const sized = sizePosition({
    equity: 10_000, availableMargin: 10_000, direction: 'LONG', entry: 150, stop: 148, requestedLeverage: 2,
    spec, limits, circuitMultiplier: 1,
  });
  assert.equal(evaluateRisk(inputWith({ sizing: sized })).approved, true);
});

test('should fail sizing, risk_per_trade and leverage when the sizer rejected the trade', () => {
  const decision = evaluateRisk(inputWith({ sizing: failedSizing('contract spec unavailable') }));
  assert.equal(decision.approved, false);
  assert.deepEqual(failedNames(decision), ['sizing', 'risk_per_trade', 'leverage']);
  assert.equal(checkNamed(decision, 'sizing').detail, 'contract spec unavailable');
  assert.ok(decision.reasons.some((reason) => reason.includes('sizing') && reason.includes('contract spec unavailable')));
});

test('should pass risk_per_trade exactly at budget x 1.02 and fail just above', () => {
  const limit = RISK_BUDGET * BUDGET_TOLERANCE;
  assert.equal(checkNamed(evaluateRisk(inputWith({ sizing: sizing({ riskAmount: limit }) })), 'risk_per_trade').passed, true);
  const over = evaluateRisk(inputWith({ sizing: sizing({ riskAmount: limit + 0.01 }) }));
  assert.equal(over.approved, false);
  assert.deepEqual(failedNames(over), ['risk_per_trade']);
});

test('should shrink the risk_per_trade budget by the circuit multiplier', () => {
  // daily loss 1.5 of 3 -> CAUTION x0.75; daily loss 2.25 -> REDUCED x0.5
  const caution = withPerformance({ dailyLossPercent: 1.5 });
  const cautionLimit = RISK_BUDGET * 0.75 * BUDGET_TOLERANCE;
  assert.equal(evaluateRisk(inputWith({ portfolio: caution, sizing: sizing({ riskAmount: cautionLimit }) })).approved, true);
  const cautionOver = evaluateRisk(inputWith({ portfolio: caution, sizing: sizing({ riskAmount: cautionLimit + 0.01 }) }));
  assert.equal(cautionOver.circuit, 'CAUTION');
  assert.deepEqual(failedNames(cautionOver), ['risk_per_trade']);

  const reduced = withPerformance({ dailyLossPercent: 2.25 });
  const reducedLimit = RISK_BUDGET * 0.5 * BUDGET_TOLERANCE;
  assert.equal(evaluateRisk(inputWith({ portfolio: reduced, sizing: sizing({ riskAmount: reducedLimit }) })).approved, true);
  assert.deepEqual(failedNames(evaluateRisk(inputWith({ portfolio: reduced, sizing: sizing({ riskAmount: reducedLimit + 0.01 }) }))), ['risk_per_trade']);
});

test('should pass leverage at the maximum and fail above it', () => {
  assert.equal(evaluateRisk(inputWith({ sizing: sizing({ leverage: 10 }) })).approved, true);
  const decision = evaluateRisk(inputWith({ sizing: sizing({ leverage: 10.01 }) }));
  assert.deepEqual(failedNames(decision), ['leverage']);
});

test('should pass position_count for the last free slot and fail when full', () => {
  assert.equal(evaluateRisk(inputWith({ portfolio: portfolio({ openPositions: 3 }) })).approved, true);
  const decision = evaluateRisk(inputWith({ portfolio: portfolio({ openPositions: 4 }) }));
  assert.deepEqual(failedNames(decision), ['position_count']);
  assert.match(checkNamed(decision, 'position_count').detail, /5 of max 4/);
});

test('should pass daily_loss just under the limit while the circuit is REDUCED', () => {
  const decision = evaluateRisk(inputWith({ portfolio: withPerformance({ dailyLossPercent: 2.99 }) }));
  assert.equal(decision.circuit, 'REDUCED');
  assert.equal(checkNamed(decision, 'daily_loss').passed, true);
});

test('should fail daily_loss on its own when the limit is not above the loss', () => {
  // Config validation forbids a zero limit; 0/0 leaves the circuit NORMAL, so only the check itself can refuse
  const decision = evaluateRisk(inputWith({ limits: { ...limits, maxDailyLossPercent: 0 } }));
  assert.equal(decision.circuit, 'NORMAL');
  assert.deepEqual(failedNames(decision), ['daily_loss']);
});

test('should pass loss_streak just under the limit while the circuit is REDUCED', () => {
  const decision = evaluateRisk(inputWith({ portfolio: withPerformance({ lossStreak: 3 }) }));
  assert.equal(decision.circuit, 'REDUCED');
  assert.equal(checkNamed(decision, 'loss_streak').passed, true);
});

test('should fail loss_streak on its own when the limit is not above the streak', () => {
  const decision = evaluateRisk(inputWith({ limits: { ...limits, maxLossStreak: 0 } }));
  assert.equal(decision.circuit, 'NORMAL');
  assert.deepEqual(failedNames(decision), ['loss_streak']);
});

const HALTING_STATES: Array<[string, Partial<PerformanceSnapshot>, string]> = [
  ['daily loss at the limit', { dailyLossPercent: 3 }, 'HALTED'],
  ['loss streak at the limit', { lossStreak: 4 }, 'HALTED'],
  ['drawdown at the limit', { drawdownPercent: 5 }, 'EMERGENCY'],
];

for (const [name, performance, circuit] of HALTING_STATES) {
  test(`should reject with circuit_breaker before any other check when ${name}`, () => {
    // A sizing that would fail every other check proves none of them ran
    const decision = evaluateRisk(inputWith({ portfolio: withPerformance(performance), sizing: failedSizing('irrelevant') }));
    assert.equal(decision.approved, false);
    assert.equal(decision.circuit, circuit);
    assert.deepEqual(decision.checks.map((c) => c.name), ['circuit_breaker']);
    assert.equal(decision.checks[0].passed, false);
    assert.match(decision.checks[0].detail, new RegExp(circuit));
    assert.equal(decision.reasons.length, 1);
    assert.match(decision.reasons[0], /circuit_breaker/);
  });
}

test('should reject a healthy sizing when the circuit is halted', () => {
  const decision = evaluateRisk(inputWith({ portfolio: withPerformance({ dailyLossPercent: 3.5 }) }));
  assert.equal(decision.approved, false);
  assert.equal(decision.circuit, 'HALTED');
});

const EXPOSURE_LIMIT = 8_000; // 80 % of the 10_000 equity, with a 150 notional order

test('should cap symbol exposure at the limit and fail just above', () => {
  const at = portfolio({ symbolExposure: (s) => (s === 'SOLUSDT' ? EXPOSURE_LIMIT - 150 : 0) });
  assert.equal(evaluateRisk(inputWith({ portfolio: at })).approved, true);
  const over = portfolio({ symbolExposure: (s) => (s === 'SOLUSDT' ? EXPOSURE_LIMIT - 149 : 0) });
  const decision = evaluateRisk(inputWith({ portfolio: over }));
  assert.deepEqual(failedNames(decision), ['portfolio_limits']);
  assert.match(checkNamed(decision, 'portfolio_limits').detail, /symbol/);
});

test('should ignore exposure held in other symbols when checking the symbol cap', () => {
  const others = portfolio({ symbolExposure: (s) => (s === 'SOLUSDT' ? 0 : 9_000) });
  assert.equal(evaluateRisk(inputWith({ portfolio: others })).approved, true);
});

test('should cap gross exposure at the limit and fail just above', () => {
  assert.equal(evaluateRisk(inputWith({ portfolio: portfolio({ grossExposure: EXPOSURE_LIMIT - 150 }) })).approved, true);
  const decision = evaluateRisk(inputWith({ portfolio: portfolio({ grossExposure: EXPOSURE_LIMIT - 149 }) }));
  assert.deepEqual(failedNames(decision), ['portfolio_limits']);
  assert.match(checkNamed(decision, 'portfolio_limits').detail, /gross/);
});

test('should cap the cluster exposure of the symbol cluster only', () => {
  const altHeavy = (alt: number) => portfolio({ clusterExposure: (c) => (c === 'ALT' ? alt : 0) });
  assert.equal(evaluateRisk(inputWith({ symbol: 'AVAXUSDT', portfolio: altHeavy(EXPOSURE_LIMIT - 150) })).approved, true);
  const decision = evaluateRisk(inputWith({ symbol: 'AVAXUSDT', portfolio: altHeavy(EXPOSURE_LIMIT - 149) }));
  assert.deepEqual(failedNames(decision), ['portfolio_limits']);
  assert.match(checkNamed(decision, 'portfolio_limits').detail, /cluster ALT/);
  const btc = evaluateRisk(inputWith({ symbol: 'BTCUSDT', portfolio: altHeavy(9_000) }));
  assert.equal(btc.approved, true);
  const sol = evaluateRisk(inputWith({ symbol: 'SOLUSDT', portfolio: altHeavy(9_000) }));
  assert.equal(sol.approved, true);
});

test('should cap the notional of a single trade at the limit and fail just above', () => {
  const capped = (maxNotionalPerTrade: number) => inputWith({ limits: { ...limits, maxNotionalPerTrade } });
  assert.equal(evaluateRisk(capped(150)).approved, true);
  const decision = evaluateRisk(capped(149.99));
  assert.deepEqual(failedNames(decision), ['portfolio_limits']);
  assert.match(checkNamed(decision, 'portfolio_limits').detail, /notional/);
});

test('should not add a min_rr check when no minimum is configured', () => {
  const decision = evaluateRisk(inputWith({ rr: 0.1 }));
  assert.equal(decision.approved, true);
  assert.ok(!decision.checks.some((c) => c.name === 'min_rr'));
});

test('should enforce min_rr at the boundary when configured', () => {
  const configured = { ...limits, minRiskRewardRatio: 1.5 };
  const at = evaluateRisk(inputWith({ limits: configured, rr: 1.5 }));
  assert.equal(at.approved, true);
  assert.deepEqual(at.checks.map((c) => c.name), [...ALL_CHECKS, 'min_rr']);
  const below = evaluateRisk(inputWith({ limits: configured, rr: 1.49 }));
  assert.deepEqual(failedNames(below), ['min_rr']);
});

test('should fail min_rr when the reward-to-risk ratio is unknown', () => {
  const decision = evaluateRisk(inputWith({ limits: { ...limits, minRiskRewardRatio: 1 } }));
  assert.deepEqual(failedNames(decision), ['min_rr']);
  assert.match(checkNamed(decision, 'min_rr').detail, /unavailable/);
});

test('should report every failed check in the reasons, in check order', () => {
  const decision = evaluateRisk(inputWith({
    sizing: sizing({ leverage: 12 }), portfolio: portfolio({ openPositions: 4 }),
  }));
  assert.equal(decision.approved, false);
  assert.deepEqual(failedNames(decision), ['leverage', 'position_count']);
  assert.equal(decision.reasons.length, 2);
  assert.match(decision.reasons[0], /^leverage/);
  assert.match(decision.reasons[1], /^position_count/);
});

// ---- portfolio open-risk cap ----

import { openRiskOf } from '../src/risk/riskEngine.js';

const capped: RiskLimits = { ...limits, maxPortfolioRiskPercent: 3 };

test('should sum the loss at stop of open positions and ignore stops at or beyond breakeven or without a numeric stop', () => {
  const open = [
    { side: 'LONG', entry: 100, qty: 2, serverSl: '95' }, // 10
    { side: 'SHORT', entry: 50, qty: 4, serverSl: '52' }, // 8
    { side: 'LONG', entry: 100, qty: 5, serverSl: '101' }, // stop above entry: locked profit, 0 risk
    { side: 'LONG', entry: 100, qty: 5, serverSl: '—' }, // hedge / unmanaged: excluded
  ];
  assert.equal(openRiskOf(open), 18);
});

test('should reject a trade that pushes open risk past the portfolio cap', () => {
  // equity 10_000, cap 3% = 300: open 260 + new 50 = 310
  const decision = evaluateRisk(inputWith({ limits: capped, portfolio: portfolio({ openRisk: 260 }) }));
  assert.equal(decision.approved, false);
  assert.deepEqual(failedNames(decision), ['portfolio_risk']);
  assert.match(checkNamed(decision, 'portfolio_risk').detail, /3\.10%/);
});

test('should approve a trade that lands exactly on the portfolio cap', () => {
  const decision = evaluateRisk(inputWith({ limits: capped, portfolio: portfolio({ openRisk: 250 }) }));
  assert.equal(decision.approved, true);
  assert.equal(checkNamed(decision, 'portfolio_risk').passed, true);
});

test('should free risk capacity once positions are stopped at breakeven', () => {
  const stopped = openRiskOf([{ side: 'LONG', entry: 100, qty: 3, serverSl: '100.1' }]);
  assert.equal(stopped, 0);
  assert.equal(evaluateRisk(inputWith({ limits: capped, portfolio: portfolio({ openRisk: stopped }) })).approved, true);
});

test('should not run the portfolio-risk check without a cap, without open-risk data, or for a hedge with no stop risk', () => {
  assert.ok(!evaluateRisk(inputWith({ portfolio: portfolio({ openRisk: 9_999 }) })).checks.some((c) => c.name === 'portfolio_risk'));
  assert.ok(!evaluateRisk(inputWith({ limits: capped })).checks.some((c) => c.name === 'portfolio_risk'));
  const hedge = evaluateRisk(inputWith({ limits: capped, sizing: sizing({ riskAmount: 0 }), portfolio: portfolio({ openRisk: 9_999 }) }));
  assert.ok(!hedge.checks.some((c) => c.name === 'portfolio_risk'));
});
