import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { FundingArbAgent } from '../src/agents/FundingArbAgent.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';

const createAgent = () => new FundingArbAgent({} as BinanceService);

function makeContext(funding: Record<string, number>, equity = 100_000): MarketContext {
  return {
    candles: {},
    funding,
    marks: { BTCUSDT: 50_000, ETHUSDT: 3_000 },
    spot: {},
    equity,
  };
}

test('should emit OPEN_FUNDING_SHORT when funding APR exceeds 15% threshold', async () => {
  // 0.0002 per 8h = 0.0002 * 3 * 365 = 21.9% APR (> 15%)
  const agent = createAgent();
  const signals = await agent.run(makeContext({ BTCUSDT: 0.0002 }));
  assert.equal(signals.length, 1);
  const [s] = signals;
  assert.equal(s.type, 'OPEN_FUNDING_SHORT');
  assert.equal(s.symbol, 'BTCUSDT');
  assert.equal(s.notionalUsdt, 10_000); // capped at 10k
  assert.match(s.reason, /21\.9% APR, 8h/);
});

test('should scale APR calculation dynamically for non-standard funding intervals', async () => {
  // Set 4h funding interval (6 settlements per day)
  setSymbolRules('ETHUSDT', {
    pricePrecision: 2,
    quantityPrecision: 3,
    tickSize: 0.01,
    stepSize: 0.001,
    minQty: 0.001,
    minNotional: 5,
    fundingIntervalHours: 4,
  });

  // 0.0001 per 4h = 0.0001 * 6 * 365 = 21.9% APR (> 15%)
  const agent = createAgent();
  const signals = await agent.run(makeContext({ ETHUSDT: 0.0001 }));
  assert.equal(signals.length, 1);
  const [s] = signals;
  assert.equal(s.type, 'OPEN_FUNDING_SHORT');
  assert.equal(s.symbol, 'ETHUSDT');
  assert.match(s.reason, /21\.9% APR, 4h/);
});

test('should ignore funding rates below 15% APR threshold', async () => {
  // 0.0001 per 8h = 10.95% APR (< 15%)
  const agent = createAgent();
  const signals = await agent.run(makeContext({ BTCUSDT: 0.0001 }));
  assert.equal(signals.length, 0);
});
