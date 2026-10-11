import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contractSpecFor, DEFAULT_MAX_QUANTITY } from '../src/risk/contractSpec.js';
import type { RiskLimits } from '../src/risk/riskConfig.js';
import type { SymbolRules } from '../src/binance/symbolRules.js';

const limits = { maxLeverage: 10 } as RiskLimits;

test('should map exchange symbol rules onto the contract spec', () => {
  const rules: SymbolRules = { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001, minQty: 0.002, minNotional: 100 };
  assert.deepEqual(contractSpecFor('BTCUSDT', rules, limits), {
    symbol: 'BTCUSDT', lotSize: 0.001, minQuantity: 0.002, maxQuantity: DEFAULT_MAX_QUANTITY, minNotional: 100, tickSize: 0.1, maxLeverage: 10,
  });
});

test('should cap leverage at the configured limit, not at the exchange bracket', () => {
  const rules: SymbolRules = { pricePrecision: 0, quantityPrecision: 0, tickSize: 1, stepSize: 1, minQty: 0, minNotional: 0 };
  assert.equal(contractSpecFor('AVAXUSDT', rules, { ...limits, maxLeverage: 7 }).maxLeverage, 7);
});

test('should use a practically unbounded max quantity because rules carry no upper bound', () => {
  assert.equal(DEFAULT_MAX_QUANTITY, 1e9);
});
