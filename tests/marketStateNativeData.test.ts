import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';

const BAR_MS = 15 * 60_000;

function candle(index: number, close: number): Candle {
  return { openTime: index * BAR_MS, open: close, high: close + 1, low: close - 1, close, volume: 100 };
}

test('prefers native higher-timeframe candles and carries derivatives into MarketState', () => {
  const fallback = Array.from({ length: 100 }, (_, i) => candle(i, 100 + i));
  const native15m = Array.from({ length: 250 }, (_, i) => candle(i, 200 + i));
  const native1h = Array.from({ length: 250 }, (_, i) => ({ ...candle(i, 200 + i), openTime: i * 60 * 60_000 }));
  const native4h = Array.from({ length: 250 }, (_, i) => ({ ...candle(i, 200 + i), openTime: i * 4 * 60 * 60_000 }));

  const builder = new MarketStateBuilder();
  const state = builder.build({
    symbol: 'BTCUSDT',
    candles: fallback,
    candlesByTimeframe: { '15m': native15m, '1h': native1h, '4h': native4h },
    mark: 250,
    fundingRate: 0.0002,
    derivatives: {
      asOf: 123,
      openInterest: 1000,
      openInterestChangePct: 2,
      globalLongShortRatio: 1.3,
      topTraderAccountLongShortRatio: 1.2,
      topTraderPositionLongShortRatio: 1.1,
      takerBuySellRatio: 1.05,
      takerVolumeImbalance: 0.02,
      orderBookImbalance: 0.1,
      spreadBps: 1,
      basisPct: 0.04,
    },
  });

  assert.equal(state.timeframes['15m'].lastClose, 449);
  assert.equal(state.timeframes['1h'].lastClose, 449);
  assert.equal(state.timeframes['4h'].lastClose, 449);
  assert.equal(state.derivatives?.openInterest, 1000);
});
