import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RemoteBroker, type OpenParams } from '../src/binance/remoteBroker.js';
import { OrderInFlightError } from '../src/binance/remoteOrders.js';
import type { SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { RemoteStore } from '../src/binance/remoteState.js';
import { FakeExchange } from './support/fakeExchange.js';

const ACCOUNT_ID = 'acct';
const START = 2_000;
const RETRY_INTERVAL_MS = 1_000;
const BTC_LONG: OpenParams = { symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, leverage: 5, strategy: 'MOMENTUM-γ', stopLoss: 64_000, takeProfit: 68_000, entryPrice: 65_000 };

async function setup() {
  const fake = new FakeExchange();
  const store = new RemoteStore(path.join(mkdtempSync(path.join(tmpdir(), 'remote-partial-')), 'remote-state.json'), ACCOUNT_ID);
  const time = { now: START };
  const sent: SubmitOrderParams[] = [];
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { sent.push(params); return original(params); };
  const broker = new RemoteBroker({ api: fake, store, accountId: ACCOUNT_ID, symbols: ['BTCUSDT', 'ETHUSDT'], initialMargin: 100_000, now: () => time.now });
  await broker.init();
  const exitOrders = () => sent.filter((p) => p.reduceOnly);
  return { fake, store, broker, time, exitOrders };
}

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('should reduce only the requested quantity, journal it as a partial and keep the position managed', async () => {
  const { store, broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  const metaBefore = store.getMeta('BTCUSDT')!;
  broker.markAll({ BTCUSDT: 66_000 });

  await broker.reduce(broker.getPositions()[0]!, 0.035);
  await broker.idle();

  const [order] = exitOrders();
  assert.deepEqual([order!.reduceOnly, order!.side, order!.quantity, order!.executionPrice], [true, 'sell', 0.035, 66_000]);
  assert.match(order!.clientOrderId, /EXIT-PARTIAL_TP/);
  const [trade] = broker.getTrades();
  assert.deepEqual([trade!.reason, trade!.partial, trade!.qty], ['PARTIAL TP', true, 0.035]);
  near(trade!.pnl, (66_000 - 65_000) * 0.035);
  const [pos] = broker.getPositions();
  near(pos!.qty, 0.065);
  const metaAfter = store.getMeta('BTCUSDT')!;
  assert.deepEqual([metaAfter.stopLoss, metaAfter.takeProfit, metaAfter.initialRisk, metaAfter.owner, metaAfter.openedAt],
    [metaBefore.stopLoss, metaBefore.takeProfit, metaBefore.initialRisk, metaBefore.owner, metaBefore.openedAt]);
});

test('should close only the residual when the stop is hit after a partial, as a non-partial final record', async () => {
  const { broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  broker.markAll({ BTCUSDT: 66_000 });
  await broker.reduce(broker.getPositions()[0]!, 0.035);
  await broker.idle();

  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();

  assert.equal(exitOrders().length, 2);
  near(exitOrders()[1]!.quantity, 0.065);
  const trades = broker.getTrades();
  assert.deepEqual(trades.map((t) => [t.reason, t.partial ?? false]), [['PARTIAL TP', true], ['STOP LOSS', false]]);
  assert.equal(broker.getPositions().length, 0);
});

test('should keep a partial queued through an outage under one client order id and complete it once after recovery', async () => {
  const { fake, broker, time, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  broker.markAll({ BTCUSDT: 66_000 });
  fake.down = true;

  await broker.reduce(broker.getPositions()[0]!, 0.035); // resolves: the job stays queued
  time.now += RETRY_INTERVAL_MS;
  broker.markAll({ BTCUSDT: 66_100 });
  await broker.idle();
  assert.equal(exitOrders().length, 0);
  assert.deepEqual(broker.getTrades(), []);

  fake.down = false;
  time.now += RETRY_INTERVAL_MS;
  broker.markAll({ BTCUSDT: 66_100 });
  await broker.idle();
  broker.markAll({ BTCUSDT: 66_100 });
  await broker.idle();

  assert.equal(exitOrders().length, 1);
  near(exitOrders()[0]!.quantity, 0.035);
  assert.deepEqual(broker.getTrades().map((t) => [t.reason, t.qty]), [['PARTIAL TP', 0.035]]);
  near(broker.getPositions()[0]!.qty, 0.065);
});

test('should refuse a partial while a stop exit is queued for the symbol', async () => {
  const { fake, broker, time } = await setup();
  await broker.open(BTC_LONG);
  fake.down = true;
  broker.markAll({ BTCUSDT: 63_900 }); // stop exit queued through the outage
  await broker.idle();
  time.now += RETRY_INTERVAL_MS;

  await assert.rejects(broker.reduce(broker.getPositions()[0]!, 0.035), OrderInFlightError);
});

test('should refuse a partial while an open for the symbol is in flight, and the open must not be refused by it', async () => {
  const { fake, broker, exitOrders } = await setup();
  await broker.open(BTC_LONG);
  const position = broker.getPositions()[0]!;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { if (!params.reduceOnly) await held; return original(params); };

  const opening = broker.open({ ...BTC_LONG, qty: 0.01 });
  await new Promise((resolve) => setTimeout(resolve, 20)); // the open has passed its sync and is now waiting on the exchange
  await assert.rejects(broker.reduce(position, 0.035), OrderInFlightError);
  release();
  await opening;
  assert.equal(exitOrders().length, 0);
});
