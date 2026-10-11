import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RemoteBroker, type OpenParams } from '../src/binance/remoteBroker.js';
import { VenueUnavailableError, type SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { RemoteStore } from '../src/binance/remoteState.js';
import { FakeExchange } from './support/fakeExchange.js';

const ACCOUNT_ID = 'acct';
const START = 2_000;
const BTC_LONG: OpenParams = { symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, leverage: 5, strategy: 'MOMENTUM-γ', stopLoss: 64_000, takeProfit: 68_000, entryPrice: 65_000 };
const ETH_SHORT: OpenParams = { symbol: 'ETHUSDT', side: 'SELL', qty: 2, leverage: 3, strategy: 'ADAPTIVE-ST-ζ', stopLoss: 3_200, takeProfit: 2_700, entryPrice: 3_000 };
const SL_MESSAGE = 'STOP LOSS BTCUSDT LONG @ 63,900.00 pnl=-110.00';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

async function setup() {
  const fake = new FakeExchange();
  const store = new RemoteStore(path.join(mkdtempSync(path.join(tmpdir(), 'remote-exits-')), 'remote-state.json'), ACCOUNT_ID);
  const time = { now: START };
  const sent: SubmitOrderParams[] = [];
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { sent.push(params); return original(params); };
  const broker = new RemoteBroker({ api: fake, store, accountId: ACCOUNT_ID, symbols: ['BTCUSDT', 'ETHUSDT'], initialMargin: 100_000, now: () => time.now });
  await broker.init();
  const exitOrders = () => sent.filter((p) => p.reduceOnly);
  return { fake, store, broker, time, sent, exitOrders };
}

function gate(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

test('should exit a long at the mark on a stop loss breach and return the message exactly once', async () => {
  const { fake, store, broker, sent } = await setup();
  await broker.open(BTC_LONG);
  assert.deepEqual(broker.markAll({ BTCUSDT: 66_000 }), []);
  await broker.idle();
  assert.equal(sent.length, 1);

  assert.deepEqual(broker.markAll({ BTCUSDT: 63_900 }), []);
  await broker.idle();

  const exit = sent[1];
  assert.deepEqual([exit.reduceOnly, exit.side, exit.quantity, exit.executionPrice], [true, 'sell', 0.1, 63_900]);
  assert.match(exit.clientOrderId, /^BTCUSDT-MOMENTUM-γ-EXIT-STOP_LOSS-2000-[a-z0-9]+$/);
  const [trade] = broker.getTrades();
  assert.deepEqual([trade.reason, trade.exit, trade.qty, trade.entry, trade.strategy, trade.side], ['STOP LOSS', 63_900, 0.1, 65_000, 'MOMENTUM-γ', 'LONG']);
  near(trade.pnl, -110);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
  assert.equal(fake.allRows()[0].netQuantity, 0);
  assert.equal(broker.getPositions().length, 0);
  assert.deepEqual(broker.markAll({ BTCUSDT: 63_900 }), [SL_MESSAGE]);
  assert.deepEqual(broker.markAll({ BTCUSDT: 63_900 }), []);
  assert.equal(broker.getTrades().length, 1);
});

test('should exit at the take profit level, not at the overshooting mark', async () => {
  const { broker } = await setup();
  await broker.open(BTC_LONG);

  broker.markAll({ BTCUSDT: 68_500 });
  await broker.idle();

  const [trade] = broker.getTrades();
  assert.deepEqual([trade.reason, trade.exit], ['TAKE PROFIT', 68_000]);
  assert.deepEqual(broker.markAll({ BTCUSDT: 68_500 }), ['TAKE PROFIT BTCUSDT LONG @ 68,000.00 pnl=300.00']);
});

test('should exit only the breached symbol when two symbols are held', async () => {
  const { fake, broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  await broker.open(ETH_SHORT);

  broker.markAll({ BTCUSDT: 63_900, ETHUSDT: 3_050 });
  await broker.idle();

  assert.deepEqual(exitOrders().map((o) => o.symbol), ['BTCUSDT']);
  assert.deepEqual(broker.getPositions().map((p) => p.symbol), ['ETHUSDT']);
  assert.equal(fake.allRows().find((r) => r.symbol === 'ETHUSDT')?.netQuantity, 2);
});

test('should never exit an external position, even at any price', async () => {
  const { fake, broker, exitOrders } = await setup();
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: 0.5, executionPrice: 65_000, leverage: 3 });
  await broker.sync();

  broker.markAll({ BTCUSDT: 60_000 });
  broker.markAll({ BTCUSDT: 70_000 });
  await broker.idle();

  assert.equal(exitOrders().length, 0);
  assert.equal(broker.getPositions().length, 1);
});

test('should journal a manual close at the latest local mark, delete the meta and announce nothing', async () => {
  const { store, broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  broker.setMarks({ BTCUSDT: 65_500 });

  await broker.close(broker.getPositions()[0], 'CLOSE');

  const [trade] = broker.getTrades();
  assert.deepEqual([trade.reason, trade.exit, trade.qty], ['CLOSE', 65_500, 0.1]);
  near(trade.pnl, 50);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
  assert.equal(broker.getPositions().length, 0);
  assert.match(exitOrders()[0].clientOrderId, /^BTCUSDT-MOMENTUM-γ-EXIT-CLOSE-2000-[a-z0-9]+$/);
  assert.deepEqual(broker.markAll({}), []);
});

test('should send no order and let the sync journal it when the position already ended off-agent', async () => {
  const { fake, broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  const pos = broker.getPositions()[0];
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'sell', quantity: 0.1, executionPrice: 66_000, leverage: 5 });

  await broker.close(pos, 'CLOSE');

  assert.equal(exitOrders().length, 0);
  assert.deepEqual(broker.getTrades().map((t) => t.reason), ['CLOSE']);
});

test('should resolve an exit whose response was lost by lookup and journal the exit reason, not a plain CLOSE', async () => {
  const { fake, broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  fake.failNextPostAfterFill = true;

  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();

  assert.equal(exitOrders().length, 1);
  assert.deepEqual(broker.getTrades().map((t) => t.reason), ['STOP LOSS']);
  assert.equal(broker.getPositions().length, 0);
});

test('should reuse the pending exit id and resolve by lookup when the venue dropped right after the fill', async () => {
  const { fake, broker, time, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => {
    if (!params.reduceOnly) return original(params);
    await original(params);
    fake.down = true;
    throw new VenueUnavailableError('response lost and venue gone');
  };

  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();
  assert.deepEqual(broker.getTrades(), []);
  fake.down = false;
  time.now += 1_000;
  await broker.sync();
  await broker.idle();

  assert.equal(exitOrders().length, 1);
  assert.deepEqual(broker.getTrades().map((t) => [t.reason, t.exit, t.qty]), [['STOP LOSS', 63_900, 0.1]]);
  assert.equal(broker.getPositions().length, 0);
});

test('should size the exit from a fresh read when the quantity changed externally (S23)', async () => {
  const { fake, store, broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: 0.05, executionPrice: 65_000, leverage: 5 });

  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();

  near(exitOrders()[0].quantity, 0.15);
  assert.equal(fake.allRows()[0].netQuantity, 0);
  const [trade] = broker.getTrades();
  near(trade.qty, 0.15);
  near(trade.entry, 65_000);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
});

test('should send one exit order for ten breached markAll calls while the exit is in flight (S24)', async () => {
  const { fake, broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  const hold = gate();
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { if (params.reduceOnly) await hold.wait; return original(params); };

  const messages: string[] = [];
  for (let i = 0; i < 10; i++) messages.push(...broker.markAll({ BTCUSDT: 63_900 - i }));
  await new Promise((resolve) => setImmediate(resolve));
  messages.push(...broker.markAll({ BTCUSDT: 63_800 }));
  hold.release();
  await broker.idle();
  messages.push(...broker.markAll({ BTCUSDT: 63_800 }));

  assert.equal(exitOrders().length, 1);
  // The exit is first sent after all ten ticks, so the stop fills at the lowest mark seen, not at the first breach.
  assert.deepEqual(messages, ['STOP LOSS BTCUSDT LONG @ 63,891.00 pnl=-110.90']);
  assert.equal(broker.getTrades().length, 1);
});

test('should not journal a close twice when a sync overlaps the exit fill', async () => {
  const { fake, store, broker } = await setup();
  await broker.open(BTC_LONG);
  const hold = gate();
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { const result = await original(params); if (params.reduceOnly) await hold.wait; return result; };

  broker.markAll({ BTCUSDT: 63_900 });
  await new Promise((resolve) => setImmediate(resolve));
  await broker.sync();
  assert.deepEqual(broker.getTrades(), []);
  assert.ok(store.getMeta('BTCUSDT'));
  hold.release();
  await broker.idle();

  assert.deepEqual(broker.getTrades().map((t) => t.reason), ['STOP LOSS']);
});

test('should discard a sync snapshot taken before an exit completed instead of adopting the closed position', async () => {
  const { fake, store, broker } = await setup();
  await broker.open(BTC_LONG);
  const hold = gate();
  const original = fake.getPositions.bind(fake);
  let armed = true;
  fake.getPositions = async () => {
    const snapshot = await original();
    if (!armed) return snapshot;
    armed = false;
    await hold.wait;
    return snapshot;
  };

  const staleSync = broker.sync();
  broker.markAll({ BTCUSDT: 63_900 });
  // The exit's refresh queues behind the slow sync, so the gate opens before idle() can resolve.
  await new Promise((resolve) => setImmediate(resolve));
  hold.release();
  await staleSync;
  await broker.idle();

  assert.equal(store.getMeta('BTCUSDT'), undefined);
  assert.equal(broker.getPositions().length, 0);
  assert.deepEqual(broker.getTrades().map((t) => t.reason), ['STOP LOSS']);
});

test('should push marks only for symbols with a position, at most once per second per symbol', async () => {
  const { fake, broker, time } = await setup();
  const pushes: Record<string, number>[] = [];
  const original = fake.pushMarkPrices.bind(fake);
  fake.pushMarkPrices = async (prices) => { pushes.push({ ...prices }); return original(prices); };
  await broker.open(BTC_LONG);

  broker.markAll({ BTCUSDT: 65_100, ETHUSDT: 3_000 });
  await broker.open(ETH_SHORT);
  time.now += 300;
  broker.markAll({ BTCUSDT: 65_150, ETHUSDT: 3_001 });
  time.now += 300;
  broker.markAll({ BTCUSDT: 65_200, ETHUSDT: 3_002 });
  time.now += 700;
  broker.markAll({ BTCUSDT: 65_300, ETHUSDT: 3_003 });
  await broker.idle();

  assert.deepEqual(pushes, [{ BTCUSDT: 65_100 }, { ETHUSDT: 3_001 }, { BTCUSDT: 65_300, ETHUSDT: 3_003 }]);
});

test('should record a failed mark push in the status without changing the venue state or throwing', async () => {
  const { fake, broker } = await setup();
  await broker.open(BTC_LONG);
  fake.pushMarkPrices = async () => { throw new VenueUnavailableError('push boom'); };

  assert.doesNotThrow(() => broker.markAll({ BTCUSDT: 65_100 }));
  await broker.idle();

  assert.match(broker.status().lastError ?? '', /push boom/);
  assert.equal(broker.status().state, 'connected');
});

test('should journal the quantity the exchange reports as filled instead of the sized one', async () => {
  const { fake, broker } = await setup();
  await broker.open(BTC_LONG);
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => {
    const result = await original(params);
    const reported = { ...result, filledQuantity: 0.06 };
    return params.reduceOnly ? reported : result;
  };

  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();

  assert.equal(broker.getTrades()[0].qty, 0.06);
});
