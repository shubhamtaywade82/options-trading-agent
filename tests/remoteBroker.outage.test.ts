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
const RETRY_INTERVAL_MS = 1_000;
const BTC_LONG: OpenParams = { symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, leverage: 5, strategy: 'MOMENTUM-γ', stopLoss: 64_000, takeProfit: 68_000, entryPrice: 65_000 };
const ETH_SHORT: OpenParams = { symbol: 'ETHUSDT', side: 'SELL', qty: 2, leverage: 3, strategy: 'ADAPTIVE-ST-ζ', stopLoss: 3_200, takeProfit: 2_700, entryPrice: 3_000 };

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

async function setup() {
  const fake = new FakeExchange();
  const store = new RemoteStore(path.join(mkdtempSync(path.join(tmpdir(), 'remote-outage-')), 'remote-state.json'), ACCOUNT_ID);
  const time = { now: START };
  const sent: SubmitOrderParams[] = [];
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { sent.push(params); return original(params); };
  const broker = new RemoteBroker({ api: fake, store, accountId: ACCOUNT_ID, symbols: ['BTCUSDT', 'ETHUSDT'], initialMargin: 100_000, now: () => time.now });
  await broker.init();
  const exitOrders = () => sent.filter((p) => p.reduceOnly);
  return { fake, store, broker, time, sent, exitOrders };
}

for (const recovery of ['sync', 'markAll'] as const) {
  test(`should keep a stop pending while down and send one exit at the worse mark once ${recovery} runs after recovery`, async () => {
    const { fake, store, broker, time, exitOrders } = await setup();
    await broker.open(BTC_LONG);
    fake.down = true;

    broker.markAll({ BTCUSDT: 63_900 });
    await broker.idle();
    time.now += RETRY_INTERVAL_MS;
    broker.markAll({ BTCUSDT: 63_800 });
    await broker.idle();

    assert.equal(exitOrders().length, 0);
    assert.deepEqual(broker.getTrades(), []);
    assert.ok(store.getMeta('BTCUSDT'));

    fake.down = false;
    time.now += RETRY_INTERVAL_MS;
    if (recovery === 'sync') await broker.sync();
    else broker.markAll({ BTCUSDT: 63_800 });
    await broker.idle();

    assert.equal(exitOrders().length, 1);
    assert.equal(exitOrders()[0].executionPrice, 63_800);
    assert.deepEqual(broker.getTrades().map((t) => [t.reason, t.exit]), [['STOP LOSS', 63_800]]);
    assert.deepEqual(broker.markAll({ BTCUSDT: 63_800 }), ['STOP LOSS BTCUSDT LONG @ 63,800.00 pnl=-120.00']);
  });
}

test('should send a long stop queued through an outage at the current mark when the market fell further', async () => {
  const { fake, broker, time, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  fake.down = true;
  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();
  broker.markAll({ BTCUSDT: 60_000 });
  await broker.idle();

  fake.down = false;
  time.now += RETRY_INTERVAL_MS;
  await broker.sync();
  await broker.idle();

  assert.equal(exitOrders()[0].executionPrice, 60_000);
  const [trade] = broker.getTrades();
  assert.equal(trade.exit, 60_000);
  near(trade.pnl, -500);
});

test('should send a short stop queued through an outage at the current mark when the market rose further', async () => {
  const { fake, broker, time, exitOrders } = await setup();
  await broker.open(ETH_SHORT);
  fake.down = true;
  broker.markAll({ ETHUSDT: 3_210 });
  await broker.idle();
  broker.markAll({ ETHUSDT: 3_400 });
  await broker.idle();

  fake.down = false;
  time.now += RETRY_INTERVAL_MS;
  await broker.sync();
  await broker.idle();

  assert.equal(exitOrders()[0].executionPrice, 3_400);
  near(broker.getTrades()[0].pnl, -800);
});

test('should keep a take profit at its level when the market moved on during an outage', async () => {
  const { fake, broker, time, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  fake.down = true;
  broker.markAll({ BTCUSDT: 68_500 });
  await broker.idle();
  broker.markAll({ BTCUSDT: 70_000 });
  await broker.idle();

  fake.down = false;
  time.now += RETRY_INTERVAL_MS;
  await broker.sync();
  await broker.idle();

  assert.equal(exitOrders()[0].executionPrice, 68_000);
});

test('should reject a manual close during an outage and not close the position silently after recovery', async () => {
  const { fake, broker, time, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  const pos = broker.getPositions()[0];
  fake.down = true;

  await assert.rejects(broker.close(pos, 'CLOSE'), VenueUnavailableError);
  fake.down = false;
  time.now += RETRY_INTERVAL_MS;
  await broker.sync();
  await broker.idle();

  assert.equal(exitOrders().length, 0);
  assert.deepEqual(broker.getTrades(), []);
  assert.equal(broker.getPositions().length, 1);
});

test('should journal CLOSE, not FLIP, when a flip whose close was deferred completes without its open leg', async () => {
  const { fake, broker, time, sent, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  const original = fake.getPositions.bind(fake);
  let reads = 0;
  fake.getPositions = async () => {
    // The first read is the pre-order refresh; the venue drops before the exit's own read.
    if (++reads === 2) throw new VenueUnavailableError('dropped mid-flip');
    return original();
  };

  await assert.rejects(broker.open({ ...BTC_LONG, side: 'SELL', entryPrice: 66_000 }), VenueUnavailableError);
  time.now += RETRY_INTERVAL_MS;
  await broker.sync();
  await broker.idle();

  assert.deepEqual(broker.getTrades().map((t) => t.reason), ['CLOSE']);
  assert.equal(exitOrders().length, 1);
  assert.equal(sent.filter((p) => !p.reduceOnly).length, 1);
  assert.equal(broker.getPositions().length, 0);
});

test('should retry a pending exit at most once per second per symbol', async () => {
  const { fake, broker, time } = await setup();
  await broker.open(BTC_LONG);
  fake.down = true;
  const original = fake.getPositions.bind(fake);
  let reads = 0;
  fake.getPositions = async () => { reads++; return original(); };

  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();
  time.now += RETRY_INTERVAL_MS / 2;
  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();
  assert.equal(reads, 1);

  time.now += RETRY_INTERVAL_MS / 2;
  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();
  assert.equal(reads, 2);
});

test('should drop the sidecar positions but keep the journal when the account had to be recreated', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'remote-recreated-')), 'remote-state.json');
  const store = new RemoteStore(file, ACCOUNT_ID);
  const past = { symbol: 'SOLUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 110, qty: 1, pnl: 10, reason: 'TAKE PROFIT', closedAt: 1 } as const;
  store.recordClose(past);
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    store.setMeta(symbol, { owner: 'MOMENTUM-γ', stopLoss: 1, takeProfit: 2, initialRisk: 1, openedAt: 1_000, lastSeen: { side: 'LONG', entry: 1.5, qty: 1, mark: 1.5 } });
  }
  const broker = new RemoteBroker({ api: new FakeExchange(), store, accountId: ACCOUNT_ID, symbols: ['BTCUSDT', 'ETHUSDT'], initialMargin: 100_000, now: () => START });

  await broker.init();

  assert.deepEqual(store.metas(), {});
  assert.deepEqual(store.trades(), [past]);
  const reloaded = new RemoteStore(file, ACCOUNT_ID);
  assert.deepEqual([reloaded.metas(), reloaded.trades()], [{}, [past]]);
});
