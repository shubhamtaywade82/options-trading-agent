import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketState } from '../src/market/types.js';
import type { SetupMap, SetupScenario } from '../src/decision/SetupTypes.js';
import type { CouncilResult, ChairDecision } from '../src/llm/types.js';
import { buildCouncilSignal } from '../src/decision/CouncilSignal.js';

const T0 = 1_000_000;
const MIN_PROBABILITY = 0.65;

function state(over: Partial<MarketState> = {}): MarketState {
  return { symbol: 'BTCUSDT', generatedAt: T0, mark: 100, ...over } as MarketState;
}

function scenario(over: Partial<SetupScenario> = {}): SetupScenario {
  return {
    id: 'breakout-btc-long-10500',
    kind: 'BREAKOUT_RETEST',
    direction: 'LONG',
    state: 'TRIGGERED',
    timeframe: '15m',
    entryLow: 104.8,
    entryHigh: 105.2,
    stopLoss: 104,
    target1: 107,
    trigger: '15m close above 105 + retest hold',
    invalidation: 'acceptance back below 105',
    flowHypothesis: 'trend continuation',
    expectedMove: { minMinutes: 20, maxMinutes: 80, thesisExpiryMinutes: 120, distanceAtr: 2 },
    sourceTime: T0,
    rewardRisk: 2.75,
    quality: { verdict: 'ENTRY_ELIGIBLE', effectiveRr: 2, reasons: [], checks: { structure: 'PASS', location: 'PASS', trigger: 'PASS', evidence: 'PASS', flow: 'PASS', rr: 'PASS', freshness: 'PASS' } },
    thesisRole: 'AUTHORITATIVE',
    ...over,
  };
}

function setup(scenarios: SetupScenario[]): SetupMap {
  return {
    symbol: 'BTCUSDT',
    generatedAt: T0,
    mark: 100,
    state: scenarios.some((s) => s.state === 'TRIGGERED') ? 'TRIGGERED' : 'FORMING',
    bias: 'BULLISH',
    regime: 'TREND_UP',
    volatility: 'MEDIUM',
    positionPct: 60,
    location: 'EQUILIBRIUM',
    htfTrend: 'BULLISH',
    ltfTrend: 'BULLISH',
    lastBreak: null,
    nearestUpperLiquidity: 105,
    nearestLowerLiquidity: 98,
    crowding: 'BALANCED',
    openInterestExpansion: true,
    takerAggressionRatio: 1.1,
    scenarios,
    noTradeReasons: [],
  };
}

function chair(over: Partial<ChairDecision> = {}): CouncilResult {
  return {
    symbol: 'BTCUSDT',
    generatedAt: T0,
    opinions: [],
    chair: {
      persona: 'PORTFOLIO-CHAIR',
      action: 'TRADE',
      stance: 'LONG',
      probability: 0.75,
      scenarioId: 'breakout-btc-long-10500',
      rationale: 'Breakout confirmed with structure and liquidity aligned.',
      dissent: 'None material.',
      requiredConfirmation: 'None — already triggered.',
      horizonMinutes: 60,
      ...over,
    },
  };
}

test('council TRADE on a TRIGGERED, direction-matched scenario becomes a Signal sourced from the scenario', () => {
  const signal = buildCouncilSignal(state(), setup([scenario()]), chair(), MIN_PROBABILITY);
  assert.ok(signal);
  assert.equal(signal?.agent, 'AI-COUNCIL-κ');
  assert.equal(signal?.type, 'OPEN_LONG');
  assert.equal(signal?.entry, 100);
  assert.equal(signal?.stopLoss, 104);
  assert.equal(signal?.takeProfit, 107);
  assert.equal(signal?.confidence, 0.75);
});

test('council WATCH never becomes a Signal', () => {
  assert.equal(buildCouncilSignal(state(), setup([scenario()]), chair({ action: 'WATCH' }), MIN_PROBABILITY), null);
});

test('council NO_TRADE never becomes a Signal', () => {
  assert.equal(buildCouncilSignal(state(), setup([scenario()]), chair({ action: 'NO_TRADE' }), MIN_PROBABILITY), null);
});

test('a TRADE verdict on a scenario that is only ARMED (not yet TRIGGERED) is refused', () => {
  const map = setup([scenario({ state: 'ARMED' })]);
  assert.equal(buildCouncilSignal(state(), map, chair(), MIN_PROBABILITY), null);
});

test('a TRADE verdict referencing an unknown scenario id is refused', () => {
  const map = setup([scenario()]);
  assert.equal(buildCouncilSignal(state(), map, chair({ scenarioId: 'does-not-exist' }), MIN_PROBABILITY), null);
});

test('a TRADE verdict below the probability floor is refused', () => {
  const map = setup([scenario()]);
  assert.equal(buildCouncilSignal(state(), map, chair({ probability: 0.5 }), MIN_PROBABILITY), null);
});

test('a TRADE verdict whose stance does not match the scenario direction is refused', () => {
  const map = setup([scenario({ direction: 'SHORT' })]);
  assert.equal(buildCouncilSignal(state(), map, chair({ stance: 'LONG' }), MIN_PROBABILITY), null);
});

test('a NEUTRAL stance is never tradeable even with action TRADE', () => {
  const map = setup([scenario()]);
  assert.equal(buildCouncilSignal(state(), map, chair({ stance: 'NEUTRAL' }), MIN_PROBABILITY), null);
});

test('a triggered scenario the quality gate only rates WATCH (entry not yet in zone) is never executed', () => {
  const base = scenario();
  const map = setup([scenario({ quality: { ...base.quality!, verdict: 'WATCH' } })]);
  assert.equal(buildCouncilSignal(state(), map, chair(), MIN_PROBABILITY), null);
});

test('a NO_TRADE quality verdict overrides a council TRADE', () => {
  const base = scenario();
  const map = setup([scenario({ quality: { ...base.quality!, verdict: 'NO_TRADE', reasons: ['COST_ADJUSTED_EDGE_TOO_LOW'] } })]);
  assert.equal(buildCouncilSignal(state(), map, chair(), MIN_PROBABILITY), null);
});

test('a COMPETING-thesis scenario is never executed', () => {
  assert.equal(buildCouncilSignal(state(), setup([scenario({ thesisRole: 'COMPETING' })]), chair(), MIN_PROBABILITY), null);
});

test('a scenario that never went through the quality pipeline fails closed', () => {
  assert.equal(buildCouncilSignal(state(), setup([scenario({ quality: undefined })]), chair(), MIN_PROBABILITY), null);
});
