import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractSpecCache, floorToLot, roundToTick, type InstrumentClient } from '../src/coindcx/contractSpec.js';

test('floorToLot rounds down to the step, never up', () => {
  assert.equal(floorToLot(0.1234, 0.001), 0.123);
  assert.equal(floorToLot(1, 0.001), 1); // already aligned
});

test('floorToLot handles IEEE-754 floating-point error on exact multiples', () => {
  // 0.3 / 0.1 = 2.9999999999999996 in IEEE-754; without STEP_EPSILON, Math.floor truncates to 2, yielding 0.2 instead of 0.3
  const r1 = floorToLot(0.3, 0.1);
  assert.ok(Math.abs(r1 - 0.3) < 1e-10, `expected ~0.3, got ${r1}`);
  // Another classic case: 0.29 is an exact multiple of 0.01
  const r2 = floorToLot(0.29, 0.01);
  assert.ok(Math.abs(r2 - 0.29) < 1e-10, `expected ~0.29, got ${r2}`);
});

test('roundToTick rounds to the nearest tick', () => {
  assert.equal(roundToTick(100.037, 0.01), 100.04);
});

function fakeClient(details: Record<string, { lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }>): InstrumentClient {
  return { futures: { market: { async getInstrumentDetails(pair: string) { return details[pair] ?? {}; } } } };
}

test('maps instrument details into a contract spec, deriving minNotional', async () => {
  const cache = new ContractSpecCache(fakeClient({ 'B-BTC_USDT': { lot_size: 0.001, min_quantity: 0.001, min_price: 10_000, max_leverage: 20 } }));
  assert.deepEqual(await cache.get('B-BTC_USDT'), { lotSize: 0.001, minQty: 0.001, minNotional: 10, maxLeverage: 20 });
});

test('missing fields default safely (never NaN/undefined leaking through)', async () => {
  const cache = new ContractSpecCache(fakeClient({ 'B-XYZ_USDT': {} }));
  assert.deepEqual(await cache.get('B-XYZ_USDT'), { lotSize: 0, minQty: 0, minNotional: 0, maxLeverage: 0 });
});

test('caches per pair — a second get() does not refetch', async () => {
  let calls = 0;
  const client: InstrumentClient = { futures: { market: { async getInstrumentDetails() { calls++; return { lot_size: 1 }; } } } };
  const cache = new ContractSpecCache(client);
  await cache.get('B-BTC_USDT');
  await cache.get('B-BTC_USDT');
  assert.equal(calls, 1);
});
