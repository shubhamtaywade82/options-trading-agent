import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuseSignals } from '../src/decision/SignalFusion.js';
import type { Signal } from '../src/types.js';
import type { MarketState } from '../src/market/types.js';

function mockSignal(overrides: Partial<Signal>): Signal {
  return {
    id: 's1',
    agent: 'MOMENTUM-γ',
    symbol: 'BTCUSDT',
    type: 'OPEN_LONG',
    confidence: 0.8,
    entry: 100,
    stopLoss: 98,
    takeProfit: 105,
    reason: 'momentum test',
    ts: 1000,
    ...overrides,
  };
}

function mockState(regime: 'TREND_UP' | 'RANGE' | 'TREND_DOWN' = 'TREND_UP'): MarketState {
  const baseTf = {
    timeframe: '15m' as const,
    candleCount: 100,
    lastClose: 100,
    ema20: 100,
    ema50: 100,
    ema200: 100,
    emaSlopePct: 0.1,
    adx14: 30,
    atr14: 2,
    atrPercentile: 50,
    rsi14: 55,
    vwap: 100,
    bollingerMiddle: 100,
    bollingerUpper: 104,
    bollingerLower: 96,
  };

  return {
    version: 1,
    symbol: 'BTCUSDT',
    generatedAt: 1000,
    mark: 100,
    fundingRate: 0.0001,
    regime: {
      regime,
      trendDirection: regime === 'TREND_UP' ? 'BULLISH' : 'NEUTRAL',
      trendStrength: 0.8,
      volatility: 'MEDIUM',
      volatilityPercentile: 50,
      adx14: 30,
      emaSlopePct: 0.1,
    },
    timeframes: { '15m': baseTf, '1h': { ...baseTf, timeframe: '1h' }, '4h': { ...baseTf, timeframe: '4h' } },
    htfStructure: {
      timeframe: '1h',
      trend: regime === 'TREND_UP' ? 'BULLISH' : 'NEUTRAL',
      swingHighs: [],
      swingLows: [],
      lastBreak: null,
      protectedHigh: null,
      protectedLow: null,
    },
    ltfStructure: {
      timeframe: '15m',
      trend: 'NEUTRAL',
      swingHighs: [],
      swingLows: [],
      lastBreak: null,
      protectedHigh: null,
      protectedLow: null,
    },
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: { timeframe: '15m', pools: [], latestSweeps: [], recentSweeps: [] },
    },
    zones: [],
    pricing: {
      high: 110,
      low: 90,
      equilibrium: 100,
      positionPct: 30,
      premium: false,
      discount: true,
    },
    meanReversion: {
      mean: 100,
      vwap: 100,
      zscore: 0,
      rsi14: 50,
      bollingerMiddle: 100,
      bollingerUpper: 104,
      bollingerLower: 96,
      deviationPct: 0,
    },
  };
}

test('boosts evidence score when signal aligns with regime and discount pricing', () => {
  const signal = mockSignal({ confidence: 0.8 });
  const states = { BTCUSDT: mockState('TREND_UP') };
  const intents = fuseSignals([signal], states);

  assert.equal(intents.length, 1);
  const intent = intents[0];
  assert.equal(intent.symbol, 'BTCUSDT');
  assert.equal(intent.side, 'LONG');
  // Base (32) + regime (20) + location (20) = 72
  assert.equal(intent.evidenceScore, 72);
  assert.ok(intent.reasons.some((r) => r.includes('regime_aligned')));
});

test('resolves conflict when one side clearly dominates evidence score', () => {
  const strongLong = mockSignal({ type: 'OPEN_LONG', confidence: 0.9 });
  const weakShort = mockSignal({ type: 'OPEN_SHORT', confidence: 0.5, stopLoss: 102, takeProfit: 95 });
  const states = { BTCUSDT: mockState('TREND_UP') };
  const intents = fuseSignals([strongLong, weakShort], states);

  assert.equal(intents.length, 1);
  assert.equal(intents[0].side, 'LONG');
});

test('stands down on conflicting signals with comparable strength', () => {
  // Both have similar confidence and no market state bonus to differentiate
  const longSig = mockSignal({ type: 'OPEN_LONG', confidence: 0.8 });
  const shortSig = mockSignal({ type: 'OPEN_SHORT', confidence: 0.8, stopLoss: 102, takeProfit: 95 });
  const intents = fuseSignals([longSig, shortSig], undefined);

  assert.equal(intents.length, 0);
});
