import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiquidityPool, LiquiditySweep, MarketState, PriceZone } from '../src/market/types.js';
import type { Candle } from '../src/types.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import { DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS } from '../src/decision/StructureLiquidityStrategy.js';
import { DEFAULT_SWEEP_GRID, marginalAxes, sweepStructureLiquidity } from '../src/backtesting/StructLiqSweep.js';

const BAR_MS = 15 * 60_000;

function candle(index: number, close = 100): Candle {
  return {
    openTime: index * BAR_MS,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  };
}

/**
 * The qualifying long setup, moved along the timeline per `breakTime` so each
 * variant is a distinct setup (the signal id keys on symbol + break time).
 *
 * `sweepAge` candles before the break; `targetPrice` sets the reward on offer.
 */
function state(breakTime: number, overrides: { sweepAge?: number; targetPrice?: number } = {}): MarketState {
  const sweepAge = overrides.sweepAge ?? 1;
  const base = new MarketStateBuilder().build({
    symbol: 'BTCUSDT',
    candles: Array.from({ length: 300 }, (_, i) => candle(i, 90 + i * 0.05)),
    mark: 100,
    fundingRate: 0,
  });

  const sweep: LiquiditySweep = {
    poolType: 'SWING_LOW',
    direction: 'SELL_SIDE',
    level: 98,
    sweepPrice: 97,
    close: 99,
    index: breakTime / BAR_MS - sweepAge,
    time: breakTime - sweepAge * BAR_MS,
    confirmed: true,
  };

  const target: LiquidityPool = {
    type: 'SWING_HIGH',
    price: overrides.targetPrice ?? 106,
    tolerance: 0.2,
    strength: 0.8,
    timeframe: '1h',
    sourceTimes: [breakTime - 4 * BAR_MS],
  };

  const demand: PriceZone = {
    type: 'DEMAND',
    timeframe: '15m',
    high: 99,
    low: 97.5,
    originTime: breakTime - 2 * BAR_MS,
    causedBreak: 'BOS',
    displacementAtr: 2,
    touches: 0,
    fresh: true,
    strength: 0.9,
  };

  return {
    ...base,
    generatedAt: breakTime,
    mark: 100,
    regime: { ...base.regime, regime: 'TREND_UP', trendDirection: 'BULLISH', adx14: 30 },
    htfStructure: { ...base.htfStructure, trend: 'BULLISH' },
    ltfStructure: {
      ...base.ltfStructure,
      trend: 'BULLISH',
      lastBreak: {
        type: 'BOS',
        direction: 'BULLISH',
        level: 99,
        index: breakTime / BAR_MS,
        time: breakTime,
        distanceAtr: 1,
      },
    },
    timeframes: { ...base.timeframes, '15m': { ...base.timeframes['15m'], atr14: 1 } },
    liquidity: {
      htf: { ...base.liquidity.htf, pools: [] },
      ltf: { ...base.liquidity.ltf, pools: [target], latestSweeps: [sweep], recentSweeps: [sweep] },
    },
    zones: [demand],
    pricing: { ...base.pricing, positionPct: 25, premium: false, discount: true },
  };
}

// Three distinct setups: one the defaults admit (age 1, RR ~1.9), one only a
// relaxed sweep-age window admits (age 7), one only a relaxed RR floor admits (RR ~0.95).
const BASELINE = state(10 * BAR_MS);
const AGED_SWEEP = state(20 * BAR_MS, { sweepAge: 7 });
const THIN_TARGET = state(30 * BAR_MS, { targetPrice: 103 });
const STATES = [BASELINE, AGED_SWEEP, THIN_TARGET];

const GRID = { sweepAges: [6, 12], rewardRisks: [1.5, 0.8] };

test('sweep: the matrix covers the full grid and tags the baseline cell', () => {
  const result = sweepStructureLiquidity(STATES, GRID);

  assert.equal(result.cells.length, GRID.sweepAges.length);
  for (const row of result.cells) assert.equal(row.length, GRID.rewardRisks.length);
  assert.deepEqual(
    result.cells.map((row) => row.map((c) => [c.maxSweepAgeCandles, c.minimumRewardRisk])),
    [[[6, 1.5], [6, 0.8]], [[12, 1.5], [12, 0.8]]],
  );

  const baseline = result.cells[0][0];
  assert.equal(baseline.distinctSetups, 1, 'only the age-1/RR-1.9 setup clears the defaults');
  assert.equal(baseline.newSetups, 0);
  assert.equal(baseline.lostSetups, 0);
  assert.equal(result.baselineSetups, 1);
});

test('sweep: relaxing the sweep age admits the aged setup, and only that one', () => {
  const result = sweepStructureLiquidity(STATES, GRID);
  const relaxedAge = result.cells[1][0]; // age 12, RR 1.5

  assert.equal(relaxedAge.distinctSetups, 2);
  assert.equal(relaxedAge.newSetups, 1, 'the 7-candle-old sweep setup is new');
  assert.equal(relaxedAge.lostSetups, 0, 'relaxing a threshold never loses setups');
});

test('sweep: relaxing the reward-risk floor admits the thin-target setup', () => {
  const result = sweepStructureLiquidity(STATES, GRID);
  const relaxedRr = result.cells[0][1]; // age 6, RR 0.8

  assert.equal(relaxedRr.distinctSetups, 2);
  assert.equal(relaxedRr.newSetups, 1);
});

test('sweep: the most relaxed cell fires every setup', () => {
  const result = sweepStructureLiquidity(STATES, GRID);
  const max = result.cells[1][1]; // age 12, RR 0.8

  assert.equal(max.distinctSetups, 3);
});

test('sweep: emissions count bars, distinctSetups dedupes by signal id', () => {
  // The same state twice = two emissions of one setup
  const result = sweepStructureLiquidity([BASELINE, BASELINE], GRID);
  const baseline = result.cells[0][0];

  assert.equal(baseline.emissions, 2);
  assert.equal(baseline.distinctSetups, 1);
  assert.ok(baseline.emissions >= baseline.distinctSetups);
});

test('sweep: marginal axes hold the other parameter at its default', () => {
  const result = sweepStructureLiquidity(STATES, GRID);
  const { age, rewardRisk } = marginalAxes(result, GRID);

  assert.deepEqual(age.map((c) => c.maxSweepAgeCandles), [6, 12]);
  assert.ok(age.every((c) => c.minimumRewardRisk === DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.minimumRewardRisk));
  assert.deepEqual(rewardRisk.map((c) => c.minimumRewardRisk), [1.5, 0.8]);
  assert.ok(rewardRisk.every((c) => c.maxSweepAgeCandles === DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.maxSweepAgeCandles));
});

test('sweep: the default grid brackets the current defaults on both axes', () => {
  assert.equal(DEFAULT_SWEEP_GRID.sweepAges[0], DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.maxSweepAgeCandles);
  assert.equal(DEFAULT_SWEEP_GRID.rewardRisks[0], DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.minimumRewardRisk);
  assert.ok(DEFAULT_SWEEP_GRID.sweepAges.length > 1);
  assert.ok(DEFAULT_SWEEP_GRID.rewardRisks.length > 1);
});
