import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSetupMap, DEFAULT_SETUP_OPTIONS } from '../src/decision/SetupEngine.js';
import type { SetupMap, SetupQuality, SetupScenario } from '../src/decision/SetupTypes.js';
import type { MarketState } from '../src/market/types.js';
import { buildSetupNotice } from '../src/ops/setupNotice.js';

const AT = Date.UTC(2026, 9, 5, 3);

// ---- the builders' reward:risk floor ----

function stateWithSweepTarget(targetPrice: number): MarketState {
  // mark 100, ATR 1: a sell-side sweep at 99.6 (wick 98.2) gives entry 99.6, stop 98.05 (risk 1.55)
  const pools = [{ type: 'SWING_HIGH' as const, price: targetPrice, tolerance: 0.2, strength: 0.8, timeframe: '15m' as const, sourceTimes: [AT - 1_800_000] }];
  return {
    version: 1, symbol: 'BTCUSDT', generatedAt: AT, mark: 100, fundingRate: 0.0001,
    regime: { regime: 'TREND_UP', trendDirection: 'BULLISH', trendStrength: 0.8, volatility: 'MEDIUM', volatilityPercentile: 60, adx14: 28, emaSlopePct: 0.2 },
    timeframes: {
      '15m': { timeframe: '15m', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 28, atr14: 1, atrPercentile: 60, rsi14: 58, vwap: 99, bollingerMiddle: 99, bollingerUpper: 101, bollingerLower: 97 },
      '1h': { timeframe: '1h', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 30, atr14: 2, atrPercentile: 60, rsi14: 60, vwap: 99, bollingerMiddle: 99, bollingerUpper: 103, bollingerLower: 95 },
      '4h': { timeframe: '4h', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 32, atr14: 3, atrPercentile: 60, rsi14: 62, vwap: 99, bollingerMiddle: 99, bollingerUpper: 105, bollingerLower: 93 },
    },
    htfStructure: { timeframe: '1h', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: null, protectedHigh: null, protectedLow: null },
    ltfStructure: { timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: { type: 'BOS', direction: 'BULLISH', level: 99, index: 199, time: AT - 900_000, distanceAtr: 1 }, protectedHigh: null, protectedLow: null },
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: {
        timeframe: '15m', pools, latestSweeps: [],
        recentSweeps: [{ poolType: 'EQUAL_LOW', direction: 'SELL_SIDE', level: 99.6, sweepPrice: 98.2, close: 100, index: 198, time: AT - 900_000, confirmed: true }],
      },
    },
    zones: [],
    pricing: { high: 105, low: 95, equilibrium: 100, positionPct: 50, premium: false, discount: false },
    meanReversion: { mean: 99, vwap: 99, zscore: 0.2, rsi14: 58, bollingerMiddle: 99, bollingerUpper: 101, bollingerLower: 97, deviationPct: 1 },
    derivatives: null,
    crowding: { fundingPercentile: 60, topTraderVsGlobalBias: 1, positioningExtreme: 'BALANCED', takerAggressionRatio: 1.2, openInterestExpansion: true },
  };
}
const sweepOf = (map: SetupMap) => map.scenarios.find((s) => s.kind === 'LIQUIDITY_SWEEP');

test('should default the setup reward:risk floor to 1.5', () => {
  assert.equal(DEFAULT_SETUP_OPTIONS.minRewardRisk, 1.5);
});

test('should drop a scenario between the old 1.25 floor and the new 1.5 one by default, and keep it when the floor is lowered', () => {
  const state = stateWithSweepTarget(101.8); // reward 2.2 over risk 1.55 = 1.42R
  assert.equal(sweepOf(buildSetupMap(state)), undefined);
  const lowered = sweepOf(buildSetupMap(state, { minRewardRisk: 1.25 }));
  assert.ok(lowered);
  assert.ok(Math.abs(lowered.rewardRisk - 2.2 / 1.55) < 1e-9);
});

test('should keep a scenario that clears the floor and never show one below it', () => {
  assert.ok(sweepOf(buildSetupMap(stateWithSweepTarget(103)))); // 3.4 / 1.55 = 2.2R
  for (const target of [100.6, 101, 101.5, 101.8, 102.1, 103, 106]) {
    for (const s of buildSetupMap(stateWithSweepTarget(target)).scenarios) assert.ok(s.rewardRisk >= 1.5, `target ${target}: ${s.kind} RR ${s.rewardRisk}`);
  }
});

// ---- alert cards hide what the gate already rejected ----

const quality = (verdict: SetupQuality['verdict']): SetupQuality =>
  ({ verdict, checks: { structure: 'PASS', location: 'PASS', trigger: 'PASS', evidence: 'PASS', flow: 'PASS', rr: 'PASS', freshness: 'PASS' }, effectiveRr: 2, reasons: [] });
const scenario = (id: string, state: SetupScenario['state'], verdict?: SetupQuality['verdict']): SetupScenario => ({
  id, kind: 'PULLBACK_RETEST', direction: 'LONG', state, timeframe: '15m', entryLow: 99, entryHigh: 100, stopLoss: 98, target1: 104,
  trigger: `trigger-of-${id}`, invalidation: 'i', flowHypothesis: 'f', expectedMove: { minMinutes: 20, maxMinutes: 80, thesisExpiryMinutes: 120, distanceAtr: 2 },
  sourceTime: AT, rewardRisk: 2, ...(verdict === undefined ? {} : { quality: quality(verdict) }),
});
const mapOf = (scenarios: SetupScenario[], state: SetupMap['state'] = 'TRIGGERED'): SetupMap => ({
  symbol: 'SOLUSDT', generatedAt: AT, mark: 100, state, bias: 'BULLISH', regime: 'RANGE', volatility: 'MEDIUM', positionPct: 80, location: 'PREMIUM',
  htfTrend: 'BULLISH', ltfTrend: 'BULLISH', lastBreak: null, nearestUpperLiquidity: 105, nearestLowerLiquidity: 98, crowding: null,
  openInterestExpansion: null, takerAggressionRatio: null, scenarios, noTradeReasons: [],
});

test('should announce nothing when every scenario was rejected by the quality gate', () => {
  const map = mapOf([scenario('a', 'TRIGGERED', 'NO_TRADE'), scenario('b', 'FORMING', 'NO_TRADE')]);
  assert.equal(buildSetupNotice(map, { hideNoTrade: true }), null);
});

test('should still announce them when hiding is off (the previous behaviour)', () => {
  const map = mapOf([scenario('a', 'TRIGGERED', 'NO_TRADE')]);
  assert.ok(buildSetupNotice(map));
  assert.ok(buildSetupNotice(map, { hideNoTrade: false }));
});

test('should show only the surviving scenarios and take the headline state from them', () => {
  const map = mapOf([scenario('rejected', 'TRIGGERED', 'NO_TRADE'), scenario('watch', 'FORMING', 'WATCH'), scenario('eligible', 'ARMED', 'ENTRY_ELIGIBLE')], 'TRIGGERED');
  const notice = buildSetupNotice(map, { hideNoTrade: true });
  assert.ok(notice);
  assert.equal(notice.stateTo, 'ARMED'); // the TRIGGERED one was withheld, so the card must not claim a trigger
  assert.equal(notice.severity, 'WATCH');
  assert.equal(notice.scenarioKey, 'eligible,watch');
  assert.doesNotMatch(notice.html, /trigger-of-rejected/);
  assert.match(notice.html, /trigger-of-eligible/);
  assert.match(notice.html, /trigger-of-watch/);
});

test('should treat a scenario with no quality annotation as visible', () => {
  assert.ok(buildSetupNotice(mapOf([scenario('plain', 'FORMING')]), { hideNoTrade: true }));
});

test('should not mutate the map it filters', () => {
  const map = mapOf([scenario('a', 'TRIGGERED', 'NO_TRADE'), scenario('b', 'ARMED', 'WATCH')]);
  buildSetupNotice(map, { hideNoTrade: true });
  assert.equal(map.scenarios.length, 2);
  assert.equal(map.state, 'TRIGGERED');
});
