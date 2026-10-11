import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { StructureTrendAgent } from '../src/agents/StructureTrendAgent.js';
import { MeanReversionAgent } from '../src/agents/MeanReversionAgent.js';
import { CrowdingAgent } from '../src/agents/CrowdingAgent.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import type { MarketState } from '../src/market/types.js';

const dummyService = {} as BinanceService;

function mockMarketState(overrides: Partial<MarketState> = {}): MarketState {
  const baseTf = {
    timeframe: '15m' as const,
    candleCount: 100,
    lastClose: 100,
    ema20: 100,
    ema50: 100,
    ema200: 100,
    emaSlopePct: 0,
    adx14: 15,
    atr14: 2,
    atrPercentile: 50,
    rsi14: 50,
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
      regime: 'RANGE',
      trendDirection: 'NEUTRAL',
      trendStrength: 0,
      volatility: 'MEDIUM',
      volatilityPercentile: 50,
      adx14: 15,
      emaSlopePct: 0,
    },
    timeframes: { '15m': baseTf, '1h': { ...baseTf, timeframe: '1h' }, '4h': { ...baseTf, timeframe: '4h' } },
    htfStructure: {
      timeframe: '1h',
      trend: 'NEUTRAL',
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
      positionPct: 50,
      premium: false,
      discount: false,
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
    derivatives: null,
    crowding: null,
    ...overrides,
  };
}

function context(state: MarketState): MarketContext {
  return {
    candles: {},
    funding: { [state.symbol]: state.fundingRate },
    marks: { [state.symbol]: state.mark },
    spot: {},
    equity: 100_000,
    marketState: { [state.symbol]: state },
  };
}

test('StructureTrendAgent emits OPEN_LONG in discount with bullish HTF and LTF break', async () => {
  const state = mockMarketState({
    mark: 94,
    htfStructure: { ...mockMarketState().htfStructure, trend: 'BULLISH' },
    pricing: { high: 110, low: 90, equilibrium: 100, positionPct: 20, premium: false, discount: true },
    ltfStructure: {
      ...mockMarketState().ltfStructure,
      lastBreak: { type: 'CHOCH', direction: 'BULLISH', level: 93, index: 5, time: 1000, distanceAtr: 1 },
      protectedLow: { index: 3, time: 900, price: 91, type: 'LOW' },
    },
  });

  const agent = new StructureTrendAgent(dummyService);
  const signals = await agent.run(context(state));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'OPEN_LONG');
  assert.equal(signals[0].entry, 94);
  assert.equal(signals[0].stopLoss, 91);
  assert.ok(signals[0].takeProfit! >= 100);
});

test('MeanReversionAgent emits OPEN_LONG on extreme negative Z-score in RANGE regime', async () => {
  const state = mockMarketState({
    mark: 95,
    regime: { ...mockMarketState().regime, regime: 'RANGE', adx14: 14 },
    meanReversion: {
      ...mockMarketState().meanReversion,
      zscore: -2.3,
      rsi14: 30,
      vwap: 100,
      bollingerLower: 96,
    },
  });

  const agent = new MeanReversionAgent(dummyService);
  const signals = await agent.run(context(state));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'OPEN_LONG');
  assert.equal(signals[0].takeProfit, 100);
});

test('MeanReversionAgent ignores setups in trending regimes', async () => {
  const state = mockMarketState({
    regime: { ...mockMarketState().regime, regime: 'TREND_UP', adx14: 35 },
    meanReversion: {
      ...mockMarketState().meanReversion,
      zscore: -2.5,
      rsi14: 25,
    },
  });

  const agent = new MeanReversionAgent(dummyService);
  const signals = await agent.run(context(state));
  assert.equal(signals.length, 0);
});

import type { LiquidityPool } from '../src/market/types.js';

const pool = (type: LiquidityPool['type'], price: number, over: Partial<LiquidityPool> = {}): LiquidityPool =>
  ({ type, price, tolerance: 0.1, strength: 0.7, timeframe: '15m', sourceTimes: [500], ...over });

/** mark 108, ATR 2, buy-side sweep at 111: stop = max(111, 108 + 1.2 * 2) = 111, a 3.0 stop distance. */
function crowdedLongState(pools: LiquidityPool[], htfPools: LiquidityPool[] = []) {
  return mockMarketState({
    mark: 108,
    pricing: { high: 110, low: 90, equilibrium: 100, positionPct: 90, premium: true, discount: false },
    crowding: {
      fundingPercentile: 95,
      topTraderVsGlobalBias: 1.8,
      positioningExtreme: 'LONG_CROWDED',
      takerAggressionRatio: 1.5,
      openInterestExpansion: true,
    },
    liquidity: {
      htf: { timeframe: '1h', pools: htfPools, latestSweeps: [], recentSweeps: [] },
      ltf: {
        timeframe: '15m',
        pools,
        recentSweeps: [],
        latestSweeps: [{
          poolType: 'EQUAL_HIGH', direction: 'BUY_SIDE', level: 107.5, sweepPrice: 111, close: 108, index: 10, time: 1000, confirmed: true,
        }],
      },
    },
  });
}

/** mark 92, ATR 2, sell-side sweep at 89: stop = min(89, 92 - 2.4) = 89, a 3.0 stop distance. */
function crowdedShortState(pools: LiquidityPool[]) {
  return mockMarketState({
    mark: 92,
    pricing: { high: 110, low: 90, equilibrium: 100, positionPct: 10, premium: false, discount: true },
    crowding: {
      fundingPercentile: 5,
      topTraderVsGlobalBias: 0.5,
      positioningExtreme: 'SHORT_CROWDED',
      takerAggressionRatio: 0.7,
      openInterestExpansion: true,
    },
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: {
        timeframe: '15m',
        pools,
        recentSweeps: [],
        latestSweeps: [{
          poolType: 'EQUAL_LOW', direction: 'SELL_SIDE', level: 90.5, sweepPrice: 89, close: 92, index: 10, time: 1000, confirmed: true,
        }],
      },
    },
  });
}

const crowding = (minimumRewardRisk?: number) => new CrowdingAgent(dummyService, minimumRewardRisk === undefined ? {} : { minimumRewardRisk });
const rr = (s: { entry?: number; stopLoss?: number; takeProfit?: number }) =>
  Math.abs(s.takeProfit! - s.entry!) / Math.abs(s.entry! - s.stopLoss!);

test('CrowdingAgent fades LONG_CROWDED at premium after a buy-side sweep, targeting the nearest liquidity that pays 1.5R', async () => {
  const signals = await crowding().run(context(crowdedLongState([pool('SWING_LOW', 99)])));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'OPEN_SHORT');
  assert.equal(signals[0].entry, 108);
  assert.equal(signals[0].stopLoss, 111);
  assert.equal(signals[0].takeProfit, 99); // 9 / 3 = 3.0R
  assert.match(signals[0].reason, /target SWING_LOW 99 \(3\.00R\)/);
});

test('CrowdingAgent no longer targets the range midpoint: with no liquidity pool beyond the floor there is no trade', async () => {
  // equilibrium 100 is 8 away (2.7R) here, but it is not a liquidity target, so without a pool nothing is emitted
  assert.equal((await crowding().run(context(crowdedLongState([])))).length, 0);
});

test('CrowdingAgent walks outward past a pool that is too close to pay the floor', async () => {
  const state = crowdedLongState([pool('EQUAL_LOW', 105), pool('SWING_LOW', 102)]); // 3 away = 1.0R, then 6 away = 2.0R
  const [signal] = await crowding().run(context(state));
  assert.equal(signal.takeProfit, 102);
  assert.ok(rr(signal) >= 1.5);
});

test('CrowdingAgent skips the signal when every pool pays less than the floor', async () => {
  const state = crowdedLongState([pool('EQUAL_LOW', 105), pool('SWING_LOW', 104)]); // 1.0R and 1.33R
  assert.equal((await crowding().run(context(state))).length, 0);
});

test('CrowdingAgent ignores spent (taken) pools, pools on the wrong side, and the wrong pool type', async () => {
  const state = crowdedLongState([
    pool('SWING_LOW', 99, { taken: true }),       // already swept
    pool('SWING_LOW', 112),                       // below-target side but above entry
    pool('SWING_HIGH', 98),                       // a high-side pool is not a short target
  ]);
  assert.equal((await crowding().run(context(state))).length, 0);
});

test('CrowdingAgent also considers higher-timeframe pools', async () => {
  const [signal] = await crowding().run(context(crowdedLongState([], [pool('RANGE_LOW', 96, { timeframe: '1h' })])));
  assert.equal(signal.takeProfit, 96); // 12 / 3 = 4.0R
});

test('CrowdingAgent honours a configured reward:risk floor', async () => {
  const state = () => crowdedLongState([pool('EQUAL_LOW', 105)]); // 1.0R
  assert.equal((await crowding(1.5).run(context(state()))).length, 0);
  const [signal] = await crowding(0.9).run(context(state()));
  assert.equal(signal.takeProfit, 105);
});

test('CrowdingAgent squeezes SHORT_CROWDED at discount towards the nearest high-side pool that pays the floor', async () => {
  const state = crowdedShortState([pool('EQUAL_HIGH', 95), pool('SWING_HIGH', 101), pool('SWING_LOW', 99)]); // 1.0R, 3.0R, wrong type
  const [signal] = await crowding().run(context(state));
  assert.equal(signal.type, 'OPEN_LONG');
  assert.deepEqual([signal.entry, signal.stopLoss, signal.takeProfit], [92, 89, 101]);
  assert.ok(rr(signal) >= 1.5);
});

test('CrowdingAgent never emits a signal below its reward:risk floor', async () => {
  for (const price of [90, 93, 96, 99, 101, 104, 106, 107.9]) {
    for (const signal of await crowding().run(context(crowdedLongState([pool('SWING_LOW', price)])))) {
      assert.ok(rr(signal) >= 1.5, `pool ${price} produced RR ${rr(signal)}`);
    }
  }
});
