import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle, Signal } from '../src/types.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import { buildCandidate } from '../src/decision/CandidateBuilder.js';
import { scoreCandidate } from '../src/decision/CandidateScorer.js';
import { SignalFusionEngine } from '../src/decision/SignalFusionEngine.js';
import type { MarketState } from '../src/market/types.js';

const BAR_MS = 15 * 60_000;

function candle(index: number, close: number, spread = 1): Candle {
  return {
    openTime: index * BAR_MS,
    open: close,
    high: close + spread,
    low: close - spread,
    close,
    volume: 100,
  };
}

function state(overrides: Partial<MarketState> = {}): MarketState {
  const candles = Array.from({ length: 300 }, (_, i) => candle(i, 100 + i * 0.25));
  const base = new MarketStateBuilder().build({
    symbol: 'BTCUSDT',
    candles,
    mark: 175,
    fundingRate: 0.0001,
  });
  return { ...base, ...overrides };
}

function signal(partial: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    agent: 'MOMENTUM-γ',
    symbol: 'BTCUSDT',
    type: 'OPEN_LONG',
    confidence: 0.8,
    entry: 170,
    stopLoss: 165,
    takeProfit: 185,
    reason: 'test candidate',
    ts: 1,
    ...partial,
  };
}

test('buildCandidate calculates reward:risk and evidence deterministically', () => {
  const marketState = state();
  const candidate = buildCandidate({ signal: signal(), state: marketState });
  assert.ok(candidate);
  assert.equal(candidate.rewardRisk, 3);
  assert.equal(candidate.candidateId, `sig-1:${marketState.generatedAt}`);
  assert.equal(candidate.sourceSignalId, 'sig-1');
  assert.equal(candidate.evidence.total, scoreCandidate('LONG', marketState).total);
});

test('buildCandidate rejects missing levels and zero stop distance', () => {
  const marketState = state();
  assert.equal(buildCandidate({ signal: signal({ stopLoss: undefined }), state: marketState }), null);
  assert.equal(buildCandidate({ signal: signal({ stopLoss: 170 }), state: marketState }), null);
});

test('fusion filters low-RR candidates without touching execution', () => {
  const engine = new SignalFusionEngine({ minimumScore: 0, minimumRewardRisk: 1.2, conflictMargin: 8, maxSelected: 2 });
  const result = engine.evaluate([
    signal({ id: 'bad-rr', takeProfit: 171 }),
    signal({ id: 'good', takeProfit: 185 }),
  ], { BTCUSDT: state() });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /reward:risk/);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].sourceSignalId, 'good');
});

test('fusion blocks an unresolved long/short conflict', () => {
  const marketState = state();
  const engine = new SignalFusionEngine({ minimumScore: 0, minimumRewardRisk: 1, conflictMargin: 100, maxSelected: 2 });

  const result = engine.evaluate([
    signal({ id: 'long', type: 'OPEN_LONG', takeProfit: 185 }),
    signal({ id: 'short', type: 'OPEN_SHORT', stopLoss: 175, takeProfit: 160 }),
  ], { BTCUSDT: marketState });

  assert.equal(result.selected.length, 0);
  assert.equal(result.conflicts.length, 1);
});

test('fusion resolves a clear directional conflict deterministically', () => {
  const base = state();
  const marketState: MarketState = {
    ...base,
    regime: { ...base.regime, regime: 'TREND_UP', trendDirection: 'BULLISH' },
    htfStructure: { ...base.htfStructure, trend: 'BULLISH' },
    ltfStructure: {
      ...base.ltfStructure,
      trend: 'BULLISH',
      lastBreak: {
        type: 'BOS',
        direction: 'BULLISH',
        level: 169,
        index: 298,
        time: 447200000,
        distanceAtr: 1,
      },
    },
  };

  const engine = new SignalFusionEngine({ minimumScore: 0, minimumRewardRisk: 1, conflictMargin: 1, maxSelected: 2 });
  const result = engine.evaluate([
    signal({ id: 'long', type: 'OPEN_LONG', takeProfit: 190 }),
    signal({ id: 'short', type: 'OPEN_SHORT', stopLoss: 175, takeProfit: 150 }),
  ], { BTCUSDT: marketState });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].side, 'LONG');
});

test('fusion rejects signals whose market state is missing', () => {
  const engine = new SignalFusionEngine({ minimumScore: 0, minimumRewardRisk: 1, conflictMargin: 1, maxSelected: 1 });
  const result = engine.evaluate([signal()], {});
  assert.equal(result.candidates.length, 0);
  assert.equal(result.selected.length, 0);
  assert.deepEqual(result.rejected, [{ candidateId: 'sig-1', reason: 'market state unavailable' }]);
});

test('fusion never returns more than maxSelected candidates', () => {
  const engine = new SignalFusionEngine({ minimumScore: 0, minimumRewardRisk: 1, conflictMargin: 1, maxSelected: 1 });
  const result = engine.evaluate([
    signal({ id: 'btc' }),
    signal({ id: 'eth', symbol: 'ETHUSDT' }),
  ], { BTCUSDT: state(), ETHUSDT: state() });

  assert.equal(result.selected.length, 1);
});
