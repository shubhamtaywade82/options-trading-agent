import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRouted, applyRouter } from '../src/decision/StrategyRouter.js';
import type { Signal } from '../src/types.js';
import type { MarketState, MarketRegime } from '../src/market/types.js';

function fakeState(regime: MarketRegime): MarketState {
  return {
    version: 1,
    symbol: 'BTCUSDT',
    generatedAt: Date.now(),
    mark: 50000,
    fundingRate: 0.0001,
    regime: {
      regime,
      trendDirection: 'BULLISH',
      trendStrength: 50,
      volatility: 'MEDIUM',
      volatilityPercentile: 50,
      adx14: 25,
      emaSlopePct: 1,
    },
    timeframes: {} as any,
    htfStructure: {} as any,
    ltfStructure: {} as any,
    liquidity: { htf: {} as any, ltf: { latestSweeps: [] } as any },
    zones: [],
    pricing: { high: 51000, low: 49000, equilibrium: 50000, positionPct: 50, premium: false, discount: false },
    meanReversion: {} as any,
  };
}

function fakeSignal(agent: string, symbol = 'BTCUSDT'): Signal {
  return {
    id: 's-1',
    symbol,
    agent: agent as any,
    type: 'OPEN_LONG',
    confidence: 0.8,
    reason: 'test',
    ts: Date.now(),
  };
}

test('StrategyRouter: blocks MeanReversion in strong trend', () => {
  const signal = fakeSignal('MEAN-REVERT-θ');
  assert.equal(isRouted(signal, fakeState('TREND_UP')), false);
  assert.equal(isRouted(signal, fakeState('TREND_DOWN')), false);
  assert.equal(isRouted(signal, fakeState('RANGE')), true);
  assert.equal(isRouted(signal, fakeState('LOW_VOL')), true);
});

test('StrategyRouter: blocks StructureTrend in range or chop', () => {
  const signal = fakeSignal('STRUCTURE-TREND-η');
  assert.equal(isRouted(signal, fakeState('RANGE')), false);
  assert.equal(isRouted(signal, fakeState('LOW_VOL')), false);
  assert.equal(isRouted(signal, fakeState('TREND_UP')), true);
  assert.equal(isRouted(signal, fakeState('TREND_DOWN')), true);
});

test('StrategyRouter: legacy signals with no rules always pass through', () => {
  const funding = fakeSignal('FUNDING-ARB-α');
  assert.equal(isRouted(funding, fakeState('TREND_UP')), true);
  assert.equal(isRouted(funding, fakeState('RANGE')), true);
  assert.equal(isRouted(funding, undefined), true);
});

test('StrategyRouter: applyRouter partitions signals into passed and vetoed', () => {
  const trend = fakeSignal('STRUCTURE-TREND-η');
  const mean = fakeSignal('MEAN-REVERT-θ');
  const states = { BTCUSDT: fakeState('TREND_UP') };

  const { passed, vetoed } = applyRouter([trend, mean], states);
  assert.equal(passed.length, 1);
  assert.equal(passed[0].agent, 'STRUCTURE-TREND-η');
  assert.equal(vetoed.length, 1);
  assert.equal(vetoed[0].agent, 'MEAN-REVERT-θ');
  assert.equal(vetoed[0].regime, 'TREND_UP');
});
