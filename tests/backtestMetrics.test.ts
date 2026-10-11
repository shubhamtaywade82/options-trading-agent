import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetrics } from '../src/backtesting/BacktestMetrics.js';
import type { SimTrade } from '../src/backtesting/types.js';

const H = 3_600_000;
const trade = (over: Partial<SimTrade>): SimTrade => ({
  symbol: 'ETHUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 101, qty: 10, pnl: 10, reason: 'TAKE PROFIT', closedAt: H,
  initialRisk: 1, openedAt: 0, regime: 'TREND_UP', evidenceScore: 60, maeR: 0.2, mfeR: 1, fees: 0, funding: 0, slippage: 0, ...over,
});
const run = (trades: SimTrade[]) => computeMetrics({
  trades, curve: [{ t: 0, equity: 1000 }, { t: H, equity: 1000 }], initialEquity: 1000, investedSteps: 1,
  period: { from: 0, to: H, steps: 2, symbols: ['ETHUSDT'] },
});

test('a trade that wins on price but loses after fees is a loss, not a win', () => {
  // gross +10, fees 12 => net -2
  const m = run([trade({ fees: 12 })]);
  assert.equal(m.winningTrades, 0);
  assert.equal(m.losingTrades, 1);
  assert.equal(m.netPnl, -2);
  assert.equal(m.grossPnl, 10);
});

test('expectancy R is net of fees and funding: net dollars over qty x initial risk', () => {
  // gross +10 (1R of 10), fees 4, funding paid 1 (negative) => net 5 over 10 at risk = 0.5R
  const m = run([trade({ fees: 4, funding: -1 })]);
  assert.equal(m.expectancyR, 0.5);
  assert.equal(m.expectancyUsd, 5);
});

test('funding received improves the net result', () => {
  assert.equal(run([trade({ funding: 2 })]).netPnl, 12);
});

test('per-strategy and per-regime slices use the same net economics', () => {
  const m = run([trade({ fees: 12 }), trade({ strategy: 'STRUCTURE-TREND-η', pnl: -10, exit: 99, fees: 1 })]);
  assert.equal(m.byStrategy['MOMENTUM-γ'].wins, 0);
  assert.equal(m.byStrategy['MOMENTUM-γ'].netPnl, -2);
  assert.equal(m.byStrategy['STRUCTURE-TREND-η'].netPnl, -11);
  assert.equal(m.byRegime['TREND_UP'].netPnl, -13);
});

test('profit factor and payoff use net figures', () => {
  const m = run([trade({ pnl: 30, fees: 10 }), trade({ pnl: -10, fees: 0, exit: 99 })]);
  assert.equal(m.profitFactor, 2); // 20 / 10
  assert.equal(m.payoffRatio, 2);
});
