import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketDataServiceOptions } from '../src/market/MarketDataService.js';
import { MarketDataService, parseCandles } from '../src/market/MarketDataService.js';

const NOW = 1_000_000_000;

function rawKlines(intervalMs: number, count = 3): any[][] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = NOW - intervalMs * (i + 2);
    const close = 100 + i;
    return [openTime, close, close + 1, close - 1, close, 10];
  }).reverse();
}

function options(overrides: Partial<MarketDataServiceOptions> = {}): MarketDataServiceOptions {
  return {
    candleTtlMs: { '1m': 10_000, '5m': 10_000, '15m': 10_000, '1h': 10_000, '4h': 10_000 },
    derivativesTtlMs: 10_000,
    klineLimit: 50,
    historyLimit: 3,
    orderBookDepth: 2,
    maxConcurrency: 2,
    derivativesPeriod: '1h',
    basisEnabled: false,
    ...overrides,
  };
}

function fakeClient(state: { calls: Record<string, number>; active: number; maxActive: number; rejectBook?: boolean; rejectKline?: boolean }) {
  const tick = async (name: string) => {
    state.calls[name] = (state.calls[name] ?? 0) + 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    state.active -= 1;
  };

  return {
    async getKlines({ interval }: { interval: string }) {
      await tick('kline:' + interval);
      if (state.rejectKline && interval === '1m') throw new Error('kline unavailable');
      const ms = ({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as Record<string, number>)[interval];
      return rawKlines(ms);
    },
    async getOpenInterest() {
      await tick('oi');
      return { openInterest: '110' };
    },
    async getOpenInterestStatistics() {
      await tick('oiHistory');
      return [{ sumOpenInterest: '100' }, { sumOpenInterest: '105' }, { sumOpenInterest: '110' }];
    },
    async getGlobalLongShortAccountRatio() {
      await tick('global');
      return [{ longShortRatio: '1.2' }, { longShortRatio: '1.5' }];
    },
    async getTopTradersLongShortAccountRatio() {
      await tick('topAccount');
      return [{ longShortRatio: '0.9' }, { longShortRatio: '1.1' }];
    },
    async getTopTradersLongShortPositionRatio() {
      await tick('topPosition');
      return [{ longShortRatio: '0.8' }, { longShortRatio: '1.2' }];
    },
    async getTakerBuySellVolume() {
      await tick('taker');
      return [{ buySellRatio: '1.2', buyVol: '60', sellVol: '40' }];
    },
    async getOrderBook() {
      await tick('book');
      if (state.rejectBook) throw new Error('book unavailable');
      return {
        bids: [['100', '2'], ['99', '1']],
        asks: [['101', '1'], ['102', '1']],
      };
    },
    async getBasis() {
      await tick('basis');
      return [{ basisRate: '0.0005' }];
    },
  };
}

test('parseCandles excludes the currently forming candle', () => {
  const raw = [
    [NOW - 120_000, 100, 101, 99, 100, 1],
    [NOW - 30_000, 100, 102, 98, 101, 2],
  ];
  const parsed = parseCandles(raw, '1m', NOW, 10);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].openTime, NOW - 120_000);
});

test('snapshot fetches native candles and derivatives with a concurrency cap', async () => {
  const state = { calls: {} as Record<string, number>, active: 0, maxActive: 0 };
  const service = new MarketDataService(fakeClient(state) as any, options());

  const snapshot = (await service.snapshot(['BTCUSDT'], NOW)).BTCUSDT;
  assert.equal(Object.keys(snapshot.candles).length, 5);
  assert.equal(snapshot.derivatives?.openInterest, 110);
  assert.equal(snapshot.derivatives?.openInterestChangePct, (5 / 105) * 100);
  assert.equal(snapshot.derivatives?.globalLongShortRatio, 1.5);
  assert.equal(snapshot.derivatives?.topTraderAccountLongShortRatio, 1.1);
  assert.equal(snapshot.derivatives?.topTraderPositionLongShortRatio, 1.2);
  assert.equal(snapshot.derivatives?.takerBuySellRatio, 1.2);
  assert.equal(snapshot.derivatives?.takerVolumeImbalance, 0.2);
  assert.ok((snapshot.derivatives?.orderBookImbalance ?? 0) > 0);
  assert.ok((snapshot.derivatives?.spreadBps ?? 0) > 0);
  assert.ok(state.maxActive <= 2);
});

test('snapshot is TTL cached and refreshes after expiry', async () => {
  const state = { calls: {} as Record<string, number>, active: 0, maxActive: 0 };
  const service = new MarketDataService(fakeClient(state) as any, options());

  await service.snapshot(['BTCUSDT'], NOW);
  const firstTotal = Object.values(state.calls).reduce((sum, value) => sum + value, 0);
  await service.snapshot(['BTCUSDT'], NOW + 9_999);
  const secondTotal = Object.values(state.calls).reduce((sum, value) => sum + value, 0);
  assert.equal(secondTotal, firstTotal);
  await service.snapshot(['BTCUSDT'], NOW + 10_000);
  const thirdTotal = Object.values(state.calls).reduce((sum, value) => sum + value, 0);
  assert.ok(thirdTotal > secondTotal);
});

test('a failing order-book endpoint does not invalidate the rest of the derivative snapshot', async () => {
  const state = { calls: {} as Record<string, number>, active: 0, maxActive: 0, rejectBook: true };
  const snapshot = (await new MarketDataService(fakeClient(state) as any, options()).snapshot(['BTCUSDT'], NOW)).BTCUSDT;
  assert.equal(snapshot.derivatives?.openInterest, 110);
  assert.equal(snapshot.derivatives?.globalLongShortRatio, 1.5);
  assert.equal(snapshot.derivatives?.orderBookImbalance, null);
  assert.equal(snapshot.derivatives?.spreadBps, null);
});

test('basis remains disabled unless explicitly enabled', async () => {
  const state = { calls: {} as Record<string, number>, active: 0, maxActive: 0 };
  const service = new MarketDataService(fakeClient(state) as any, options({ basisEnabled: false }));
  const snapshot = (await service.snapshot(['BTCUSDT'], NOW)).BTCUSDT;
  assert.equal(snapshot.derivatives?.basisPct, null);
  assert.equal(state.calls.basis ?? 0, 0);

  const enabled = new MarketDataService(fakeClient(state) as any, options({ basisEnabled: true }));
  const next = (await enabled.snapshot(['ETHUSDT'], NOW)).ETHUSDT;
  assert.equal(next.derivatives?.basisPct, 0.05);
  assert.equal(state.calls.basis, 1);
});


test('concurrent snapshots share in-flight requests', async () => {
  const state = { calls: {} as Record<string, number>, active: 0, maxActive: 0 };
  const service = new MarketDataService(fakeClient(state) as any, options());

  await Promise.all([
    service.snapshot(['BTCUSDT'], NOW),
    service.snapshot(['BTCUSDT'], NOW),
  ]);

  assert.equal(state.calls['kline:1m'], 1);
  assert.equal(state.calls.oi, 1);
});

test('failed kline refreshes receive a bounded retry backoff', async () => {
  const state = { calls: {} as Record<string, number>, active: 0, maxActive: 0, rejectKline: true };
  const service = new MarketDataService(fakeClient(state) as any, options());

  await service.snapshot(['BTCUSDT'], NOW);
  const first = state.calls['kline:1m'] ?? 0;

  await service.snapshot(['BTCUSDT'], NOW + 5_000);
  const second = state.calls['kline:1m'] ?? 0;
  assert.equal(second, first);

  await service.snapshot(['BTCUSDT'], NOW + 15_000);
  const third = state.calls['kline:1m'] ?? 0;
  assert.equal(third, first + 1);
});
