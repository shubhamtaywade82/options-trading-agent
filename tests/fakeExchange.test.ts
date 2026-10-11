import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderRejectedError, VenueUnavailableError, type SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { FakeExchange } from './support/fakeExchange.js';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const rejectsWith = (status: number) => (err: unknown) => err instanceof OrderRejectedError && err.status === status;

let orderSeq = 0;
function order(overrides: Partial<SubmitOrderParams>): SubmitOrderParams {
  return { symbol: 'BTCUSDT', side: 'buy', quantity: 0.1, leverage: 5, executionPrice: 65_000, clientOrderId: `test-${++orderSeq}`, ...overrides };
}

async function freshFake(margin = 10_000): Promise<FakeExchange> {
  const fake = new FakeExchange();
  await fake.createAccount(margin);
  return fake;
}

async function longOpenedAndPartiallyClosed(): Promise<FakeExchange> {
  const fake = await freshFake();
  await fake.submitOrder(order({}));
  await fake.pushMarkPrices({ BTCUSDT: 66_000 });
  await fake.submitOrder(order({ side: 'sell', quantity: 0.04, executionPrice: 66_000 }));
  return fake;
}

test('should return no account until one is created', async () => {
  const fake = new FakeExchange();
  assert.equal(await fake.getAccount(), null);
  await fake.createAccount(10_000);
  near((await fake.getAccount())!.availableBalance, 10_000);
});

test('should lock margin, charge the fee and report the liquidation price when opening a long', async () => {
  const fake = await freshFake();
  const result = await fake.submitOrder(order({}));
  assert.equal(result.status, 'filled');
  const [pos] = await fake.getPositions();
  assert.equal(pos.side, 'long');
  near(pos.netQuantity, 0.1);
  near(pos.averagePrice, 65_000);
  near(pos.currentPrice, 65_000);
  assert.equal(pos.leverage, 5);
  assert.equal(pos.marginType, 'isolated');
  near(pos.liquidationPrice!, 52_260);
  near(pos.unrealizedPnl, 0);
  const account = (await fake.getAccount())!;
  near(account.lockedMargin, 1_300);
  near(account.availableBalance, 8_697.4);
});

test('should use the short liquidation formula when opening a short', async () => {
  const fake = await freshFake();
  await fake.submitOrder(order({ side: 'sell' }));
  const [pos] = await fake.getPositions();
  assert.equal(pos.side, 'short');
  near(pos.liquidationPrice!, 65_000 * (1 + 0.2 - 0.004));
});

test('should include fees and unrealized PnL in wallet equity after a mark push', async () => {
  const fake = await freshFake();
  await fake.submitOrder(order({}));
  await fake.pushMarkPrices({ BTCUSDT: 66_000 });
  near(fake.walletEquity(), 10_097.4);
  const [pos] = await fake.getPositions();
  near(pos.unrealizedPnl, 100);
  near(pos.currentPrice, 66_000);
  near((await fake.getAccount())!.equity, 10_097.4);
});

test('should realize PnL and release proportional margin on a partial close', async () => {
  const fake = await longOpenedAndPartiallyClosed();
  const account = (await fake.getAccount())!;
  near(account.availableBalance, 9_256.344);
  near(account.lockedMargin, 780);
  near((await fake.getPositions())[0].netQuantity, 0.06);
});

test('should flip to a short with the remaining quantity when the opposite order is larger', async () => {
  const fake = await longOpenedAndPartiallyClosed();
  await fake.submitOrder(order({ side: 'sell', quantity: 0.2, executionPrice: 66_000 }));
  const [pos] = await fake.getPositions();
  assert.equal(pos.side, 'short');
  near(pos.netQuantity, 0.14);
  near(pos.averagePrice, 66_000);
  near((await fake.getAccount())!.lockedMargin, 1_848);
});

test('should keep a zero-quantity row that getPositions hides once the position is closed', async () => {
  const fake = await longOpenedAndPartiallyClosed();
  await fake.submitOrder(order({ side: 'sell', quantity: 0.2, executionPrice: 66_000 }));
  await fake.submitOrder(order({ side: 'buy', quantity: 0.14, executionPrice: 66_000 }));
  assert.deepEqual(await fake.getPositions(), []);
  assert.deepEqual(fake.allRows().map((r) => r.netQuantity), [0]);
  const account = (await fake.getAccount())!;
  near(account.availableBalance, 10_087.368);
  near(account.lockedMargin, 0);
  assert.equal(account.positionsCount, 0);
});

test('should average the entry when a fill adds to the same side', async () => {
  const fake = await freshFake();
  await fake.submitOrder(order({}));
  await fake.submitOrder(order({ executionPrice: 67_000 }));
  const [pos] = await fake.getPositions();
  near(pos.netQuantity, 0.2);
  near(pos.averagePrice, 66_000);
  near((await fake.getAccount())!.lockedMargin, 1_300 + 1_340);
});

test('should reject with 402 when available balance is below the required margin', async () => {
  const fake = await freshFake(1_000);
  await assert.rejects(fake.submitOrder(order({})), rejectsWith(402));
  assert.deepEqual(await fake.getPositions(), []);
  near((await fake.getAccount())!.availableBalance, 1_000);
});

test('should reject a non-positive quantity with 422', async () => {
  const fake = await freshFake();
  await assert.rejects(fake.submitOrder(order({ quantity: 0 })), rejectsWith(422));
});

test('should not fill twice when a clientOrderId is replayed', async () => {
  const fake = await freshFake();
  const params = order({});
  const first = await fake.submitOrder(params);
  const replay = await fake.submitOrder(params);
  assert.deepEqual(replay, first);
  near((await fake.getPositions())[0].netQuantity, 0.1);
  assert.deepEqual(await fake.findOrder(params.clientOrderId), first);
  assert.equal(await fake.findOrder('unknown'), null);
});

test('should reject a reduce-only order with 422 when there is no position or it is the same side', async () => {
  const fake = await freshFake();
  await assert.rejects(fake.submitOrder(order({ side: 'sell', reduceOnly: true })), rejectsWith(422));
  await fake.submitOrder(order({}));
  await assert.rejects(fake.submitOrder(order({ side: 'buy', reduceOnly: true })), rejectsWith(422));
});

test('should clamp a reduce-only order to the position and skip the margin check', async () => {
  const fake = await freshFake();
  await fake.submitOrder(order({}));
  // Leaves too little available balance for any new margin lock.
  await fake.submitOrder(order({ symbol: 'ETHUSDT', quantity: 27, executionPrice: 3_000, leverage: 10 }));
  await fake.submitOrder(order({ side: 'sell', quantity: 5, reduceOnly: true }));
  assert.deepEqual((await fake.getPositions()).map((p) => p.symbol), ['ETHUSDT']);
  assert.equal(fake.allRows().find((r) => r.symbol === 'BTCUSDT')!.netQuantity, 0);
});

test('should fill the order and then throw when failNextPostAfterFill is set', async () => {
  const fake = await freshFake();
  const params = order({});
  fake.failNextPostAfterFill = true;
  await assert.rejects(fake.submitOrder(params), VenueUnavailableError);
  near((await fake.getPositions())[0].netQuantity, 0.1);
  assert.equal((await fake.findOrder(params.clientOrderId))?.status, 'filled');
  await fake.submitOrder(params);
  near((await fake.getPositions())[0].netQuantity, 0.1);
});

test('should throw VenueUnavailableError from every call when down', async () => {
  const fake = await freshFake();
  fake.down = true;
  const calls = [
    () => fake.getAccount(), () => fake.createAccount(1), () => fake.getPositions(), () => fake.submitOrder(order({})),
    () => fake.findOrder('x'), () => fake.getRiskEvents(), () => fake.pushMarkPrices({}), () => fake.pushFundingEvent('BTCUSDT', 0, 1, 1),
  ];
  for (const call of calls) await assert.rejects(call(), VenueUnavailableError);
  fake.down = false;
  assert.notEqual(await fake.getAccount(), null);
});

test('should close a position at the mark and record a risk event when a mark crosses the liquidation price', async () => {
  const fake = await freshFake();
  await fake.submitOrder(order({}));
  await fake.pushMarkPrices({ BTCUSDT: 52_000 });
  assert.deepEqual(await fake.getPositions(), []);
  const account = (await fake.getAccount())!;
  near(account.lockedMargin, 0);
  near(account.availableBalance, 8_697.4 + 1_300 + (52_000 - 65_000) * 0.1);
  const [event] = await fake.getRiskEvents();
  assert.equal(event.eventType, 'POSITION_LIQUIDATED');
  assert.equal(event.details.mark_price, '52000');
  assert.equal(event.details.symbol, 'BTCUSDT');
});

test('should not liquidate while the mark stays above the long liquidation price', async () => {
  const fake = await freshFake();
  await fake.submitOrder(order({}));
  await fake.pushMarkPrices({ BTCUSDT: 52_300 });
  assert.equal((await fake.getPositions()).length, 1);
  assert.deepEqual(await fake.getRiskEvents(), []);
});

test('should credit funding to a short once per fundingTime', async () => {
  const fake = await freshFake();
  await fake.submitOrder(order({ symbol: 'SOLUSDT', side: 'sell', quantity: 10, executionPrice: 100, leverage: 5 }));
  const before = (await fake.getAccount())!.availableBalance;
  await fake.pushFundingEvent('SOLUSDT', 0.001, 100, 1_700_000_000_000);
  near((await fake.getAccount())!.availableBalance, before + 1);
  await fake.pushFundingEvent('SOLUSDT', 0.001, 100, 1_700_000_000_000);
  near((await fake.getAccount())!.availableBalance, before + 1);
  await fake.pushFundingEvent('SOLUSDT', 0.001, 100, 1_700_028_800_000);
  near((await fake.getAccount())!.availableBalance, before + 2);
});

test('should charge funding to a long', async () => {
  const fake = await freshFake();
  await fake.submitOrder(order({ symbol: 'SOLUSDT', quantity: 10, executionPrice: 100 }));
  const before = (await fake.getAccount())!.availableBalance;
  await fake.pushFundingEvent('SOLUSDT', 0.001, 100, 1);
  near((await fake.getAccount())!.availableBalance, before - 1);
});

test('should fill an injected external order like any other order', async () => {
  const fake = await freshFake();
  await fake.injectExternalOrder({ symbol: 'ETHUSDT', side: 'buy', quantity: 1, executionPrice: 3_000, leverage: 10 });
  const [pos] = await fake.getPositions();
  assert.equal(pos.symbol, 'ETHUSDT');
  near(pos.netQuantity, 1);
});
