import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { detectLiquidity } from '../src/market/LiquidityEngine.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import { analyzeStructure, findSwingPoints } from '../src/market/StructureEngine.js';
import { closedCandles, resampleCandles } from '../src/market/TimeframeEngine.js';

const BAR_MS = 15 * 60_000;

function makeCandle(index: number, close: number, halfRange = 1): Candle {
  return {
    openTime: index * BAR_MS,
    open: close,
    high: close + halfRange,
    low: close - halfRange,
    close,
    volume: 100,
  };
}

test('resamples 15m candles into correctly aggregated 1h and 4h candles', () => {
  const source = Array.from({ length: 16 }, (_, i) => makeCandle(i, 100 + i, 1));
  const oneHour = resampleCandles(source, '1h');
  const fourHour = resampleCandles(source, '4h');

  assert.equal(oneHour.length, 4);
  assert.equal(fourHour.length, 1);
  assert.equal(oneHour[0].open, 100);
  assert.equal(oneHour[0].close, 103);
  assert.equal(oneHour[0].high, 104);
  assert.equal(oneHour[0].low, 99);
  assert.equal(oneHour[0].volume, 400);
});

test('closedCandles excludes the currently forming candle', () => {
  const candles = Array.from({ length: 3 }, (_, i) => makeCandle(i, 100 + i));
  assert.equal(closedCandles(candles).length, 2);
  assert.equal(closedCandles(candles).at(-1)!.openTime, candles[1].openTime);
});

test('structure engine detects confirmed swings and a bullish break', () => {
  const candles = [
    makeCandle(0, 10),
    { ...makeCandle(1, 11), high: 13, low: 9 },
    { ...makeCandle(2, 10), high: 12, low: 8 },
    { ...makeCandle(3, 12), high: 14, low: 10 },
    { ...makeCandle(4, 11), high: 13, low: 9 },
    { ...makeCandle(5, 13), high: 15, low: 11 },
    { ...makeCandle(6, 12), high: 14, low: 10 },
    { ...makeCandle(7, 14), high: 16, low: 12 },
    { ...makeCandle(8, 13), high: 15, low: 11 },
    { ...makeCandle(9, 18), high: 19, low: 12 },
  ];

  const swings = findSwingPoints(candles, 1);
  assert.ok(swings.highs.length >= 3);
  assert.ok(swings.lows.length >= 3);

  const structure = analyzeStructure('15m', candles, 1, 1);
  assert.equal(structure.lastBreak?.direction, 'BULLISH');
  assert.ok(structure.lastBreak?.type === 'BOS' || structure.lastBreak?.type === 'CHOCH');
});

test('liquidity engine detects a sell-side sweep through a prior swing low', () => {
  const candles = [
    { ...makeCandle(0, 10), high: 11, low: 9 },
    { ...makeCandle(1, 11), high: 12, low: 10 },
    { ...makeCandle(2, 10), high: 11, low: 9 },
    { ...makeCandle(3, 9.5), high: 10, low: 8.5 },
    { ...makeCandle(4, 11), high: 12, low: 9.5 },
    { ...makeCandle(5, 10.5), high: 11.5, low: 9.8 },
    { ...makeCandle(6, 12), high: 13, low: 10.5 },
    { ...makeCandle(7, 12.5), high: 13.5, low: 11 },
    { ...makeCandle(8, 12), high: 13, low: 10.5 },
    { ...makeCandle(9, 10.8), high: 12, low: 9.5 },
    { ...makeCandle(10, 11.5), high: 12.5, low: 8.0 },
  ];

  const structure = analyzeStructure('15m', candles, 1.5, 1);
  const liquidity = detectLiquidity('15m', candles, structure, 1.5);
  assert.ok(liquidity.latestSweeps.some((sweep) => sweep.direction === 'SELL_SIDE'));
});

test('MarketStateBuilder produces a deterministic read-only snapshot from closed candles', () => {
  const candles = Array.from({ length: 300 }, (_, i) => makeCandle(i, 100 + i * 0.25, 1));

  const builder = new MarketStateBuilder();
  const state1 = builder.build({
    symbol: 'BTCUSDT',
    candles,
    mark: 175,
    fundingRate: 0.0001,
  });

  assert.equal(state1.version, 1);
  assert.equal(state1.symbol, 'BTCUSDT');
  assert.equal(state1.timeframes['15m'].candleCount, 299);
  assert.ok(state1.timeframes['1h'].candleCount > 50);
  assert.ok(state1.timeframes['1h'].adx14 !== null);
  assert.ok(state1.timeframes['15m'].vwap !== null);
  assert.ok(state1.pricing.high >= state1.pricing.low);
  assert.ok(['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION'].includes(state1.regime.regime));

  const state2 = builder.build({
    symbol: 'BTCUSDT',
    candles: [...candles, makeCandle(300, 175.5, 1)],
    mark: 176,
    fundingRate: 0.0002,
  });

  assert.equal(state2.mark, 176);
  assert.equal(state2.fundingRate, 0.0002);
  assert.equal(state2.timeframes['15m'].candleCount, 300);
  assert.notEqual(state2.generatedAt, state1.generatedAt);
});
