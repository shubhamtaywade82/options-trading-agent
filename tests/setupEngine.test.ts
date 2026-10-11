import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketState } from '../src/market/types.js';
import { buildSetupMap, formatDuration } from '../src/decision/SetupEngine.js';

const T0 = Date.UTC(2026, 8, 25, 18, 0, 0);

function baseState(over: Partial<MarketState> = {}): MarketState {
  return {
    version: 1,
    symbol: 'BTCUSDT',
    generatedAt: T0,
    mark: 100,
    fundingRate: 0.0001,
    regime: {
      regime: 'TREND_UP',
      trendDirection: 'BULLISH',
      trendStrength: 0.8,
      volatility: 'MEDIUM',
      volatilityPercentile: 60,
      adx14: 28,
      emaSlopePct: 0.2,
    },
    timeframes: {
      '15m': { timeframe: '15m', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 28, atr14: 1, atrPercentile: 60, rsi14: 58, vwap: 99, bollingerMiddle: 99, bollingerUpper: 101, bollingerLower: 97 },
      '1h': { timeframe: '1h', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 30, atr14: 2, atrPercentile: 60, rsi14: 60, vwap: 99, bollingerMiddle: 99, bollingerUpper: 103, bollingerLower: 95 },
      '4h': { timeframe: '4h', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 32, atr14: 3, atrPercentile: 60, rsi14: 62, vwap: 99, bollingerMiddle: 99, bollingerUpper: 105, bollingerLower: 93 },
    },
    htfStructure: {
      timeframe: '1h', trend: 'BULLISH', swingHighs: [], swingLows: [],
      lastBreak: { type: 'BOS', direction: 'BULLISH', level: 98, index: 199, time: T0 - 3_600_000, distanceAtr: 1 },
      protectedHigh: null, protectedLow: null,
    },
    ltfStructure: {
      timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [],
      lastBreak: { type: 'BOS', direction: 'BULLISH', level: 99, index: 199, time: T0 - 900_000, distanceAtr: 1 },
      protectedHigh: null, protectedLow: null,
    },
    liquidity: {
      htf: {
        timeframe: '1h', pools: [
          { type: 'SWING_HIGH', price: 105, tolerance: 0.2, strength: 0.8, timeframe: '1h', sourceTimes: [T0 - 7_200_000] },
          { type: 'SWING_HIGH', price: 110, tolerance: 0.2, strength: 0.7, timeframe: '1h', sourceTimes: [T0 - 10_800_000] },
        ],
        latestSweeps: [], recentSweeps: [],
      },
      ltf: {
        timeframe: '15m', pools: [
          { type: 'SWING_HIGH', price: 105, tolerance: 0.2, strength: 0.8, timeframe: '15m', sourceTimes: [T0 - 1_800_000] },
          { type: 'SWING_HIGH', price: 110, tolerance: 0.2, strength: 0.7, timeframe: '15m', sourceTimes: [T0 - 3_600_000] },
        ],
        latestSweeps: [],
        recentSweeps: [{
          poolType: 'EQUAL_LOW', direction: 'SELL_SIDE', level: 98, sweepPrice: 97.4, close: 100, index: 198, time: T0 - 900_000, confirmed: true,
        }],
      },
    },
    zones: [
      { type: 'DEMAND', timeframe: '15m', high: 99.2, low: 98, originTime: T0 - 1_800_000, causedBreak: 'BOS', displacementAtr: 1.2, touches: 0, fresh: true, strength: 0.9 },
    ],
    pricing: { high: 105, low: 95, equilibrium: 100, positionPct: 50, premium: false, discount: false },
    meanReversion: { mean: 99, vwap: 99, zscore: 0.2, rsi14: 58, bollingerMiddle: 99, bollingerUpper: 101, bollingerLower: 97, deviationPct: 1 },
    derivatives: null,
    crowding: {
      fundingPercentile: 60,
      topTraderVsGlobalBias: 1,
      positioningExtreme: 'BALANCED',
      takerAggressionRatio: 1.2,
      openInterestExpansion: true,
    },
    ...over,
  };
}

test('buildSetupMap exposes sweep, pullback and breakout scenarios with timing', () => {
  const map = buildSetupMap(baseState());
  assert.equal(map.state, 'TRIGGERED');
  assert.equal(map.bias, 'BULLISH');
  assert.equal(map.location, 'EQUILIBRIUM');
  assert.ok(map.scenarios.length >= 2);
  const sweep = map.scenarios.find((s) => s.kind === 'LIQUIDITY_SWEEP');
  assert.ok(sweep);
  assert.equal(sweep?.state, 'TRIGGERED');
  assert.ok((sweep?.expectedMove.minMinutes ?? 0) > 0);
  assert.ok((sweep?.expectedMove.maxMinutes ?? 0) >= (sweep?.expectedMove.minMinutes ?? 0));
  assert.match(sweep?.flowHypothesis ?? '', /sweep|reversal/i);
});

test('buildSetupMap refuses to manufacture a setup without directional structure', () => {
  const state = baseState({
    regime: { ...baseState().regime, regime: 'RANGE', trendDirection: 'NEUTRAL' },
    htfStructure: { ...baseState().htfStructure, trend: 'NEUTRAL' },
    ltfStructure: { ...baseState().ltfStructure, trend: 'NEUTRAL' },
    zones: [],
    liquidity: { htf: { ...baseState().liquidity.htf, pools: [] }, ltf: { ...baseState().liquidity.ltf, pools: [], recentSweeps: [], latestSweeps: [] } },
  });
  const map = buildSetupMap(state);
  assert.equal(map.state, 'NO_TRADE');
  assert.equal(map.scenarios.length, 0);
  assert.ok(map.noTradeReasons.some((reason) => /unresolved/i.test(reason)));
});

function breakoutOnlyState(over: Partial<MarketState> = {}): MarketState {
  return baseState({
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: {
        timeframe: '15m',
        pools: [
          { type: 'SWING_HIGH', price: 105, tolerance: 0.2, strength: 0.8, timeframe: '15m', sourceTimes: [T0 - 3_600_000] },
          { type: 'SWING_HIGH', price: 110, tolerance: 0.2, strength: 0.7, timeframe: '15m', sourceTimes: [T0 - 7_200_000] },
        ],
        latestSweeps: [],
        recentSweeps: [],
      },
    },
    zones: [],
    zoneLedger: [],
    ...over,
  });
}

test('breakout scenario is FORMING while the liquidity level is untaken', () => {
  const map = buildSetupMap(breakoutOnlyState());
  const breakout = map.scenarios.find((s) => s.kind === 'BREAKOUT_RETEST');
  assert.ok(breakout);
  assert.equal(breakout?.state, 'FORMING');
  assert.equal(map.state, 'FORMING');
});

test('breakout scenario is ARMED once the level is taken but unconfirmed', () => {
  const sweptAt = T0 - 300_000;
  const taken = breakoutOnlyState({
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: {
        timeframe: '15m',
        pools: [
          { type: 'SWING_HIGH', price: 105, tolerance: 0.2, strength: 0.8, timeframe: '15m', sourceTimes: [T0 - 3_600_000], taken: true, sweptAt },
          { type: 'SWING_HIGH', price: 110, tolerance: 0.2, strength: 0.7, timeframe: '15m', sourceTimes: [T0 - 7_200_000] },
        ],
        latestSweeps: [],
        recentSweeps: [],
      },
    },
    ltfStructure: { timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: null, protectedHigh: null, protectedLow: null, breaks: [] },
  });
  const armedMap = buildSetupMap(taken);
  const breakout = armedMap.scenarios.find((s) => s.kind === 'BREAKOUT_RETEST');
  assert.ok(breakout);
  assert.equal(breakout?.state, 'ARMED');
  assert.equal(armedMap.state, 'ARMED');
});

test('breakout scenario TRIGGERS once a confirming BOS/CHOCH prints after the level is taken', () => {
  const sweptAt = T0 - 300_000;
  const state = breakoutOnlyState({
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: {
        timeframe: '15m',
        pools: [
          { type: 'SWING_HIGH', price: 105, tolerance: 0.2, strength: 0.8, timeframe: '15m', sourceTimes: [T0 - 3_600_000], taken: true, sweptAt },
          { type: 'SWING_HIGH', price: 110, tolerance: 0.2, strength: 0.7, timeframe: '15m', sourceTimes: [T0 - 7_200_000] },
        ],
        latestSweeps: [],
        recentSweeps: [],
      },
    },
    ltfStructure: {
      timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [], protectedHigh: null, protectedLow: null,
      lastBreak: { type: 'BOS', direction: 'BULLISH', level: 105, index: 200, time: T0 - 100_000, distanceAtr: 1 },
      breaks: [{ type: 'BOS', direction: 'BULLISH', level: 105, index: 200, time: T0 - 100_000, distanceAtr: 1 }],
    },
  });
  const map = buildSetupMap(state);
  const breakout = map.scenarios.find((s) => s.kind === 'BREAKOUT_RETEST');
  assert.ok(breakout);
  assert.equal(breakout?.state, 'TRIGGERED');
  assert.equal(map.state, 'TRIGGERED');
});

test('breakout scenario is dropped (invalidated) when structure breaks the other way after the level is taken', () => {
  const sweptAt = T0 - 300_000;
  const state = breakoutOnlyState({
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: {
        timeframe: '15m',
        pools: [
          { type: 'SWING_HIGH', price: 105, tolerance: 0.2, strength: 0.8, timeframe: '15m', sourceTimes: [T0 - 3_600_000], taken: true, sweptAt },
          { type: 'SWING_HIGH', price: 110, tolerance: 0.2, strength: 0.7, timeframe: '15m', sourceTimes: [T0 - 7_200_000] },
        ],
        latestSweeps: [],
        recentSweeps: [],
      },
    },
    ltfStructure: {
      timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [], protectedHigh: null, protectedLow: null,
      lastBreak: { type: 'CHOCH', direction: 'BEARISH', level: 103, index: 200, time: T0 - 100_000, distanceAtr: 1 },
      breaks: [{ type: 'CHOCH', direction: 'BEARISH', level: 103, index: 200, time: T0 - 100_000, distanceAtr: 1 }],
    },
  });
  const map = buildSetupMap(state);
  assert.equal(map.scenarios.some((s) => s.kind === 'BREAKOUT_RETEST'), false);
});

test('formatDuration keeps Telegram timing compact', () => {
  assert.equal(formatDuration({ minMinutes: 15, maxMinutes: 90, thesisExpiryMinutes: 180, distanceAtr: 1 }), '15m–1.5h');
  assert.equal(formatDuration({ minMinutes: 120, maxMinutes: 240, thesisExpiryMinutes: 360, distanceAtr: 2 }), '2h–4h');
});

// ---- TP2 must be a different target from TP1 ----

const highPool = (type: 'SWING_HIGH' | 'EQUAL_HIGH', price: number) =>
  ({ type, price, tolerance: 0.2, strength: 0.8, timeframe: '15m' as const, sourceTimes: [T0 - 1_800_000] });
const withPools = (prices: Array<['SWING_HIGH' | 'EQUAL_HIGH', number]>): MarketState => {
  const base = baseState();
  return baseState({
    // The pullback scenario reads the zone ledger, not the legacy zones list
    zoneLedger: [{
      type: 'DEMAND', timeframe: '15m', high: 99.2, low: 98, originTime: T0 - 1_800_000, causedBreak: 'BOS', displacementAtr: 1.2,
      touches: 0, fresh: true, strength: 0.9, state: 'FRESH', testedAt: null, mitigatedAt: null, invalidatedAt: null,
      invalidatedIndex: null, expiredAt: null, breakIndex: 199, breakTime: T0 - 1_800_000, ageBars: 2,
    }],
    liquidity: {
      htf: { ...base.liquidity.htf, pools: [] },
      ltf: { ...base.liquidity.ltf, pools: prices.map(([type, price]) => highPool(type, price)) },
    },
  });
};
const scenario = (state: MarketState, kind: 'LIQUIDITY_SWEEP' | 'PULLBACK_RETEST') => {
  const found = buildSetupMap(state).scenarios.find((s) => s.kind === kind);
  assert.ok(found, `${kind} scenario missing`);
  return found;
};

test('TP2 skips pools within half an ATR of TP1 (an equal-high cluster is one target, not two)', () => {
  // ATR(15m) is 1, so 105.02 and 105.3 are both inside the 0.5 ATR gap; 106 is the first real second target
  const state = withPools([['SWING_HIGH', 105], ['EQUAL_HIGH', 105.02], ['EQUAL_HIGH', 105.3], ['SWING_HIGH', 106]]);
  for (const kind of ['LIQUIDITY_SWEEP', 'PULLBACK_RETEST'] as const) {
    const s = scenario(state, kind);
    assert.equal(s.target1, 105, kind);
    assert.equal(s.target2, 106, kind);
  }
});

test('TP2 is left out when every farther pool is inside the gap', () => {
  const state = withPools([['SWING_HIGH', 105], ['EQUAL_HIGH', 105.02], ['EQUAL_HIGH', 105.4]]);
  for (const kind of ['LIQUIDITY_SWEEP', 'PULLBACK_RETEST'] as const) assert.equal(scenario(state, kind).target2, undefined, kind);
});

test('TP2 at exactly half an ATR beyond TP1 is accepted and anything closer is not', () => {
  assert.equal(scenario(withPools([['SWING_HIGH', 105], ['SWING_HIGH', 105.5]]), 'LIQUIDITY_SWEEP').target2, 105.5);
  assert.equal(scenario(withPools([['SWING_HIGH', 105], ['SWING_HIGH', 105.49]]), 'LIQUIDITY_SWEEP').target2, undefined);
});

test('TP2 spacing leaves TP1 and the reward:risk untouched', () => {
  const clustered = scenario(withPools([['SWING_HIGH', 105], ['EQUAL_HIGH', 105.02], ['SWING_HIGH', 110]]), 'PULLBACK_RETEST');
  const plain = scenario(withPools([['SWING_HIGH', 105], ['SWING_HIGH', 110]]), 'PULLBACK_RETEST');
  assert.deepEqual([clustered.target1, clustered.rewardRisk, clustered.target2], [plain.target1, plain.rewardRisk, plain.target2]);
});
