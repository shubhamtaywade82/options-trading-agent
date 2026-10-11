import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseAssetOfSymbol, futuresPair, SymbolRouter, type MarketsClient } from '../src/coindcx/symbolRouter.js';

function fakeClient(pairs: string[], usdtInr = 87): MarketsClient {
  return {
    futures: { market: { async getMarketsDetails() { return pairs.map((pair) => ({ pair, status: 'active' })); } } },
    marketData: { async getSpotTicker() { return [{ pair: 'USDTINR', last_price: String(usdtInr) }]; } },
  };
}

test('futuresPair formats the CoinDCX convention', () => {
  assert.equal(futuresPair('BTC', 'USDT'), 'B-BTC_USDT');
  assert.equal(futuresPair('sol', 'INR'), 'B-SOL_INR');
});

test('baseAssetOfSymbol strips the quote suffix', () => {
  assert.equal(baseAssetOfSymbol('BTCUSDT'), 'BTC');
  assert.equal(baseAssetOfSymbol('ETHUSDT'), 'ETH');
});

test('prefers USDT when listed', async () => {
  const router = new SymbolRouter(fakeClient(['B-BTC_USDT', 'B-BTC_INR']), 'auto');
  const resolved = await router.resolve('BTCUSDT');
  assert.deepEqual(resolved, { symbol: 'BTCUSDT', base: 'BTC', pair: 'B-BTC_USDT', quote: 'USDT', fxRate: 1 });
});

test('falls back to INR with a live FX rate when USDT is not listed', async () => {
  const router = new SymbolRouter(fakeClient(['B-SOL_INR']), 'auto');
  const resolved = await router.resolve('SOLUSDT');
  assert.deepEqual(resolved, { symbol: 'SOLUSDT', base: 'SOL', pair: 'B-SOL_INR', quote: 'INR', fxRate: 87 });
});

test('COINDCX_QUOTE_PREFERENCE=INR forces INR even when USDT is listed', async () => {
  const router = new SymbolRouter(fakeClient(['B-BTC_USDT', 'B-BTC_INR']), 'INR');
  const resolved = await router.resolve('BTCUSDT');
  assert.equal(resolved.quote, 'INR');
});

test('throws when neither quote is listed', async () => {
  await assert.rejects(() => new SymbolRouter(fakeClient([]), 'auto').resolve('XRPUSDT'), /no CoinDCX futures market for XRPUSDT/);
});

test('pairToSymbol reverses a resolved pair', async () => {
  const router = new SymbolRouter(fakeClient(['B-BTC_USDT']), 'auto');
  await router.resolve('BTCUSDT'); // populates the instrument cache
  assert.equal(router.pairToSymbol('B-BTC_USDT'), 'BTCUSDT');
  assert.equal(router.pairToSymbol('B-UNKNOWN_USDT'), undefined);
});

test('an unusable FX rate throws instead of pricing at a guess', async () => {
  const router = new SymbolRouter(fakeClient(['B-SOL_INR'], NaN), 'auto');
  await assert.rejects(() => router.resolve('SOLUSDT'), /USDTINR rate unavailable/);
});

test('forced INR mode uses the real FX rate, not hardcoded 1', async () => {
  const router = new SymbolRouter(fakeClient(['B-BTC_USDT', 'B-BTC_INR'], 87), 'INR');
  const resolved = await router.resolve('BTCUSDT');
  assert.equal(resolved.quote, 'INR');
  assert.equal(resolved.fxRate, 87);
});

test('pairToSymbol returns the symbol for both USDT and INR pairs after resolve', async () => {
  const router = new SymbolRouter(fakeClient(['B-BTC_USDT']), 'auto');
  await router.resolve('BTCUSDT');
  assert.equal(router.pairToSymbol('B-BTC_USDT'), 'BTCUSDT');
  // INR pair should also be registered even though we used USDT
  assert.equal(router.pairToSymbol('B-BTC_INR'), 'BTCUSDT');
});

test('getFxRate falls back to stale rate when getSpotTicker rejects', async () => {
  // Build a client that first succeeds, then fails
  let callCount = 0;
  const flakyClient: MarketsClient = {
    futures: { market: { async getMarketsDetails() { return [{ pair: 'B-SOL_INR' }]; } } },
    marketData: {
      async getSpotTicker() {
        callCount++;
        if (callCount === 1) {
          return [{ pair: 'USDTINR', last_price: '87' }];
        }
        throw new Error('Network timeout');
      },
    },
  };
  const router = new SymbolRouter(flakyClient, 'auto');
  // First call succeeds and caches the rate
  const resolved1 = await router.resolve('SOLUSDT');
  assert.equal(resolved1.fxRate, 87);

  // Age the cached rate to be in the stale-usable window (60s old, within 120s)
  // so the second call actually tries to fetch again instead of using fresh cache
  (router as any).fxRateTime = Date.now() - 60 * 1000;

  // Second call should now try to fetch, catch the error, and fall back to stale rate
  const resolved2 = await router.resolve('SOLUSDT');
  assert.equal(resolved2.fxRate, 87);
});

test('rejects bad rate from successful fetch (validation error not masked as network error)', async () => {
  // This test ensures validation errors throw even when the fetch succeeds
  let callCount = 0;
  const flakyClient: MarketsClient = {
    futures: { market: { async getMarketsDetails() { return [{ pair: 'B-SOL_INR' }]; } } },
    marketData: {
      async getSpotTicker() {
        callCount++;
        if (callCount === 1) {
          // First call succeeds with a good rate
          return [{ pair: 'USDTINR', last_price: '87' }];
        }
        // Second call succeeds but returns a bad value
        return [{ pair: 'USDTINR', last_price: '-999' }];
      },
    },
  };
  const router = new SymbolRouter(flakyClient, 'auto');
  // First call succeeds and caches the rate
  const resolved1 = await router.resolve('SOLUSDT');
  assert.equal(resolved1.fxRate, 87);

  // Age the cached rate to be in stale window so second call tries to fetch
  (router as any).fxRateTime = Date.now() - 60 * 1000;

  // Second call should fetch successfully but reject due to validation (not fall back to stale)
  await assert.rejects(
    () => router.resolve('SOLUSDT'),
    /USDTINR rate unavailable/,
  );
});

test('rejects a negative or zero FX rate', async () => {
  const badRateClient: MarketsClient = {
    futures: { market: { async getMarketsDetails() { return [{ pair: 'B-SOL_INR' }]; } } },
    marketData: { async getSpotTicker() { return [{ pair: 'USDTINR', last_price: '-5' }]; } },
  };
  const router = new SymbolRouter(badRateClient, 'auto');
  await assert.rejects(() => router.resolve('SOLUSDT'), /USDTINR rate unavailable/);
});
