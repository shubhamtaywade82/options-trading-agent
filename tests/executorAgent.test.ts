import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { startsCooldown } from '../src/agents/BaseAgent.js';
import { ExecutorAgent, stopPlacement } from '../src/agents/ExecutorAgent.js';
import { config } from '../src/config.js';
import { VenueUnavailableError } from '../src/binance/paperExchangeClient.js';
import { OrderInFlightError, OwnershipError } from '../src/binance/remoteOrders.js';
import type { RiskDecision, Signal } from '../src/types.js';

const symbol = config.symbols[0];
const risk: RiskDecision = { approved: true, positionSizeUsdt: 1000, leverage: 5, marginType: 'ISOLATED', liqBufferAtr: 3, reason: '' };

function signal(overrides: Partial<Signal>): Signal {
  return { id: 's', agent: 'ADAPTIVE-ST-ζ', symbol, type: 'OPEN_LONG', confidence: 0.75, reason: '', ts: 0, ...overrides };
}

function stubService() {
  const captured: Record<string, unknown>[] = [];
  const service = {
    openFuturesPosition: async (params: Record<string, unknown>) => { captured.push(params); return { orderId: 1, status: 'FILLED' }; },
    getPremiumIndex: async () => ({ markPrice: 250, fundingRate: 0 }),
  } as unknown as BinanceService;
  return { captured, executor: new ExecutorAgent(service) };
}

test('should round quantity down to the step and prices to the tick', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 1, tickSize: 0.05, stepSize: 0.1, minQty: 0, minNotional: 0 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100.03, stopLoss: 94.02, takeProfit: 112.49 }), risk);
  assert.equal(log.level, 'success');
  assert.deepEqual(
    { qty: captured[0].qty, entryPrice: captured[0].entryPrice, stopLoss: captured[0].stopLoss, takeProfit: captured[0].takeProfit, strategy: captured[0].strategy },
    { qty: 9.9, entryPrice: 100.05, stopLoss: 94, takeProfit: 112.5, strategy: 'ADAPTIVE-ST-ζ' },
  );
});

test('should size a funding hedge off the live mark and short it', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 0 });
  const { captured, executor } = stubService();
  await executor.execute(signal({ type: 'OPEN_HEDGE', agent: 'FUNDING-ARB-α' }), risk);
  assert.equal(captured[0].side, 'SELL');
  assert.equal(captured[0].qty, 4);
});

test('should size OPEN_FUNDING_SHORT off the live mark and short it', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 0 });
  const { captured, executor } = stubService();
  await executor.execute(signal({ type: 'OPEN_FUNDING_SHORT', agent: 'FUNDING-ARB-α' }), risk);
  assert.equal(captured[0].side, 'SELL');
  assert.equal(captured[0].qty, 4);
});

test('should refuse symbols outside config.symbols', async () => {
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ symbol: 'BTCUSDTETHUSDT', entry: 30 }), risk);
  assert.equal(log.level, 'error');
  assert.equal(captured.length, 0);
});

test('should refuse an order smaller than one lot', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 0, tickSize: 0.01, stepSize: 1, minQty: 0, minNotional: 0 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 5000 }), risk);
  assert.equal(log.level, 'error');
  assert.equal(captured.length, 0);
});

test('should refuse an order below the symbol minimum quantity', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 20, minNotional: 0 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100 }), risk); // 1000 USDT / 100 = qty 10
  assert.equal(log.level, 'error');
  assert.match(log.msg, /minimum quantity/);
  assert.equal(captured.length, 0);
});

test('should refuse an order below the symbol minimum notional', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 5000 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100 }), risk); // notional 1000
  assert.equal(log.level, 'error');
  assert.match(log.msg, /minimum notional/);
  assert.equal(captured.length, 0);
});

test('should accept an order exactly at the minimum quantity', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 10, minNotional: 0 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100 }), risk); // 1000 USDT / 100 = qty 10
  assert.equal(log.level, 'success');
  assert.equal(captured.length, 1);
});

test('should accept an order exactly at the minimum notional despite float error', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 29 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100 }), { ...risk, positionSizeUsdt: 29 }); // qty 0.29, and 0.29 * 100 = 28.999999999999996
  assert.equal(log.level, 'success');
  assert.equal(captured.length, 1);
});

const failingExecutor = (error: Error) => new ExecutorAgent({ openFuturesPosition: async () => { throw error; } } as unknown as BinanceService);

test('should log ownership, in-flight and venue refusals as warnings, not failures', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 0 });
  for (const refusal of [new OwnershipError('held by another'), new OrderInFlightError('busy'), new VenueUnavailableError('down')]) {
    const log = await failingExecutor(refusal).execute(signal({ entry: 100 }), risk);
    assert.equal(log.level, 'warn', refusal.name);
    assert.match(log.msg, /REFUSED/);
  }
});

test('should keep logging unexpected order errors as failures', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 0 });
  const log = await failingExecutor(new Error('boom')).execute(signal({ entry: 100 }), risk);
  assert.equal(log.level, 'error');
});

test('should start the per-signal cooldown for a refusal and a fill but not for a failure', async () => {
  const refused = await failingExecutor(new OwnershipError('held by another')).execute(signal({ entry: 100 }), risk);
  const failed = await failingExecutor(new Error('boom')).execute(signal({ entry: 100 }), risk);
  const { executor } = stubService();
  const filled = await executor.execute(signal({ entry: 100 }), risk);
  assert.deepEqual([refused, failed, filled].map((log) => startsCooldown(log.level)), [true, false, true]);
});

test('should call a stop server-side only in live mode, because paper exits are decided by the agent', () => {
  assert.equal(stopPlacement('live'), 'server-side ✓');
  assert.equal(stopPlacement('paper'), 'agent-side');
});

test('should word the fill log with the placement of the configured mode', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 0 });
  const { executor } = stubService();
  const log = await executor.execute(signal({ entry: 100, stopLoss: 95 }), risk);
  assert.match(log.msg, new RegExp(`SL=95\\.00 ${stopPlacement(config.mode)}$`));
});

test('should not start the cooldown for a refusal while the venue is degraded or down, so signals are not lost after recovery', () => {
  const started = (venueState?: 'connected' | 'degraded' | 'down') => startsCooldown('warn', venueState);
  assert.deepEqual([started('degraded'), started('down')], [false, false]);
  assert.deepEqual([started('connected'), started(undefined)], [true, true]);
  assert.equal(startsCooldown('success', 'down'), true);
  assert.equal(startsCooldown('error', 'connected'), false);
});
