import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLedger } from '../src/learning/AgentLedger.js';
import { TradingCouncil } from '../src/llm/TradingCouncil.js';
import type { StructuredGenerator } from '../src/llm/TradingCouncil.js';
import type { MarketState } from '../src/market/types.js';
import type { SetupMap } from '../src/decision/SetupTypes.js';

function makeLedger(): { ledger: AgentLedger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'council-'));
  const ledger = new AgentLedger(join(dir, 'ledger.json'));
  return { ledger, cleanup: () => rmSync(dir, { recursive: true }) };
}

function marketState(): MarketState {
  return {
    version: 1,
    symbol: 'BTCUSDT',
    generatedAt: 1_000_000,
    mark: 100,
    fundingRate: 0.0001,
    regime: {
      regime: 'TREND_UP',
      trendDirection: 'BULLISH',
      trendStrength: 1,
      volatility: 'MEDIUM',
      volatilityPercentile: 55,
      adx14: 28,
      emaSlopePct: 0.3,
    },
    timeframes: {
      '15m': {
        timeframe: '15m', candleCount: 100, lastClose: 100, ema20: 99, ema50: 98, ema200: 95,
        emaSlopePct: 0.3, adx14: 28, atr14: 1, atrPercentile: 55, rsi14: 58, vwap: 99,
        bollingerMiddle: 99, bollingerUpper: 101, bollingerLower: 97,
      },
      '1h': {
        timeframe: '1h', candleCount: 100, lastClose: 100, ema20: 99, ema50: 98, ema200: 95,
        emaSlopePct: 0.3, adx14: 30, atr14: 2, atrPercentile: 60, rsi14: 60, vwap: 99,
        bollingerMiddle: 99, bollingerUpper: 103, bollingerLower: 95,
      },
      '4h': {
        timeframe: '4h', candleCount: 100, lastClose: 100, ema20: 99, ema50: 98, ema200: 95,
        emaSlopePct: 0.2, adx14: 27, atr14: 4, atrPercentile: 50, rsi14: 59, vwap: 98,
        bollingerMiddle: 99, bollingerUpper: 107, bollingerLower: 91,
      },
    },
    htfStructure: {
      timeframe: '1h', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: null,
      protectedHigh: null, protectedLow: null,
    },
    ltfStructure: {
      timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: null,
      protectedHigh: null, protectedLow: null,
    },
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: { timeframe: '15m', pools: [], latestSweeps: [], recentSweeps: [] },
    },
    zones: [],
    pricing: { high: 110, low: 90, equilibrium: 100, positionPct: 50, premium: false, discount: false },
    meanReversion: {
      mean: 100, vwap: 99, zscore: 0, rsi14: 58, bollingerMiddle: 99, bollingerUpper: 101,
      bollingerLower: 97, deviationPct: 0,
    },
    derivatives: null,
    crowding: {
      fundingPercentile: 50, topTraderVsGlobalBias: 0, positioningExtreme: 'BALANCED',
      takerAggressionRatio: 1.05, openInterestExpansion: true,
    },
  };
}

function setupMap(): SetupMap {
  return {
    symbol: 'BTCUSDT',
    generatedAt: 1_000_000,
    mark: 100,
    state: 'FORMING',
    bias: 'BULLISH',
    regime: 'TREND_UP',
    volatility: 'MEDIUM',
    positionPct: 50,
    location: 'EQUILIBRIUM',
    htfTrend: 'BULLISH',
    ltfTrend: 'BULLISH',
    lastBreak: null,
    nearestUpperLiquidity: 104,
    nearestLowerLiquidity: 96,
    crowding: 'BALANCED',
    openInterestExpansion: true,
    takerAggressionRatio: 1.05,
    noTradeReasons: [],
    scenarios: [{
      id: 'breakout-btc-long',
      kind: 'BREAKOUT_RETEST',
      direction: 'LONG',
      state: 'FORMING',
      timeframe: '15m',
      entryLow: 103,
      entryHigh: 103.2,
      stopLoss: 101,
      target1: 108,
      rewardRisk: 2.4,
      trigger: 'close above level + retest',
      invalidation: 'acceptance below level',
      flowHypothesis: 'initiative buy-flow',
      expectedMove: { minMinutes: 30, maxMinutes: 90, thesisExpiryMinutes: 180, distanceAtr: 5 },
      sourceTime: 1_000_000,
    }],
  };
}

test('TradingCouncil: runs five specialist personas plus a chair once per closed state', async () => {
  const { ledger, cleanup } = makeLedger();
  const calls: string[] = [];
  const generator: StructuredGenerator = {
    async generateJson<T>(prompt: string, model: string): Promise<T | null> {
      calls.push(model + ':' + (prompt.includes('portfolio chair') ? 'CHAIR' : 'PERSONA'));
      if (prompt.includes('portfolio chair')) {
        return {
          action: 'WATCH', stance: 'LONG', probability: 0.65, scenarioId: 'breakout-btc-long',
          rationale: 'Wait for deterministic breakout confirmation.', dissent: 'Skeptic flags late entry risk.',
          requiredConfirmation: 'Breakout level acceptance and retest hold.', horizonMinutes: 60,
        } as T;
      }
      return {
        stance: 'LONG', probability: 0.6, horizonMinutes: 60, scenarioId: 'breakout-btc-long',
        thesis: 'Trend and liquidity align.', invalidation: 'Loss of the setup level.', riskFlags: [],
      } as T;
    },
  };
  const models = {
    technical: 'm1', liquidity: 'm2', derivatives: 'm3',
    regime: 'm4', skeptic: 'm5', chair: 'm6',
  };
  const council = new TradingCouncil(generator, ledger, true, models);
  const state = marketState();
  const setup = setupMap();

  const result = await council.analyze(state, setup);
  assert.ok(result);
  assert.equal(result.opinions.length, 5);
  assert.equal(result.chair.action, 'WATCH');
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6);

  const repeat = await council.analyze(state, setup);
  assert.equal(repeat, null, 'same closed state must not be re-analyzed');

  const resolved = ledger.resolvePredictions({ BTCUSDT: 103 }, Date.now() + 61 * 60_000);
  assert.equal(resolved.length, 6);
  assert.ok(resolved.every((row) => row.correct === true));

  const memory = ledger.personaMemory('TECHNICAL-ANALYST', 'BTCUSDT');
  assert.equal(memory.resolved, 1);
  assert.equal(memory.accuracy, 1);
  assert.ok(memory.brierScore !== null);
  cleanup();
});

test('TradingCouncil: can learn from a NO_TRADE state rather than forcing a scenario', async () => {
  const { ledger, cleanup } = makeLedger();
  const generator: StructuredGenerator = {
    async generateJson<T>(prompt: string): Promise<T | null> {
      if (prompt.includes('portfolio chair')) {
        return { action: 'NO_TRADE', stance: 'NEUTRAL', probability: 0.7, scenarioId: null, rationale: 'No admissible setup.', dissent: 'None.', requiredConfirmation: 'None.', horizonMinutes: 30 } as T;
      }
      return { stance: 'NEUTRAL', probability: 0.65, horizonMinutes: 30, scenarioId: null, thesis: 'No edge.', invalidation: 'N/A', riskFlags: [] } as T;
    },
  };
  const council = new TradingCouncil(generator, ledger, true, {
    technical: 'm', liquidity: 'm', derivatives: 'm', regime: 'm', skeptic: 'm', chair: 'm',
  });
  const setup = setupMap();
  setup.scenarios = [];
  setup.state = 'NO_TRADE';
  const result = await council.analyze(marketState(), setup);
  assert.ok(result);
  assert.equal(result.chair.action, 'NO_TRADE');
  assert.equal(ledger.personaMemory('SKEPTIC-ANALYST', 'BTCUSDT').resolved, 0);
  cleanup();
});
