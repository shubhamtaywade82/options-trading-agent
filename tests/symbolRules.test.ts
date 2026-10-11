import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FuturesSymbolExchangeInfo } from 'binance';
import {
  formatPrice, formatQty, roundPrice, roundQty, rulesFromExchangeInfo, setSymbolRules,
} from '../src/binance/symbolRules.js';

test('should read precision, tick and step from exchange info', () => {
  const info = {
    symbol: 'BTCUSDT',
    pricePrecision: 2,
    quantityPrecision: 3,
    filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.10' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
    ],
  } as unknown as FuturesSymbolExchangeInfo;
  assert.deepEqual(rulesFromExchangeInfo(info), { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 0 });
});

test('should round prices to the symbol tick and quantities down to the step', () => {
  setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001, minQty: 0, minNotional: 0 });
  setSymbolRules('AVAXUSDT', { pricePrecision: 3, quantityPrecision: 0, tickSize: 0.001, stepSize: 1, minQty: 0, minNotional: 0 });
  assert.equal(roundPrice('BTCUSDT', 81070.06), 81070.1);
  assert.equal(roundPrice('AVAXUSDT', 8.54321), 8.543);
  assert.equal(roundQty('BTCUSDT', 0.0129999), 0.012);
  assert.equal(roundQty('BTCUSDT', 0.3), 0.3);
  assert.equal(roundQty('AVAXUSDT', 117.9), 117);
});

test('should format with each symbol precision and fall back to 2dp price for unknown symbols', () => {
  setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001, minQty: 0, minNotional: 0 });
  setSymbolRules('AVAXUSDT', { pricePrecision: 3, quantityPrecision: 0, tickSize: 0.001, stepSize: 1, minQty: 0, minNotional: 0 });
  assert.equal(formatPrice('BTCUSDT', 81070.1), '81,070.10');
  assert.equal(formatPrice('AVAXUSDT', 8.5), '8.500');
  assert.equal(formatQty('AVAXUSDT', 117), '117');
  assert.equal(formatQty('BTCUSDT', 0.012), '0.012');
  assert.equal(formatPrice('UNKNOWNUSDT', 1.5), '1.50');
});

test('should read minQty and minNotional from exchange info, defaulting to no limit', () => {
  const withMin = {
    symbol: 'XRPUSDT', pricePrecision: 4, quantityPrecision: 1,
    filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.0001', maxPrice: '1000', tickSize: '0.0001' },
      { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '100000', stepSize: '0.1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ],
  } as unknown as FuturesSymbolExchangeInfo;
  assert.deepEqual(rulesFromExchangeInfo(withMin), { pricePrecision: 4, quantityPrecision: 1, tickSize: 0.0001, stepSize: 0.1, minQty: 0.1, minNotional: 5 });
  const bare = { symbol: 'X', pricePrecision: 2, quantityPrecision: 3, filters: [] } as unknown as FuturesSymbolExchangeInfo;
  const rules = rulesFromExchangeInfo(bare);
  assert.equal(rules.minQty, 0);
  assert.equal(rules.minNotional, 0);
});
