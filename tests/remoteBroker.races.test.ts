import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OrderInFlightError, RemoteBroker, type OpenParams } from '../src/binance/remoteBroker.js';
import { VenueUnavailableError, type SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { RemoteStore } from '../src/binance/remoteState.js';
import { FakeExchange } from './support/fakeExchange.js';

const ACCOUNT_ID = 'acct';
const START = 2_000;
const EXPECTED_OPEN_TTL_MS = 10 * 60_000;
const BTC_LONG: OpenParams = { symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, leverage: 5, strategy: 'MOMENTUM-γ', stopLoss: 64_000, takeProfit: 68_000, entryPrice: 65_000 };
const NO_LEVELS: OpenParams = { ...BTC_LONG, stopLoss: undefined, takeProfit: undefined };

const tick = () => new Promise((resolve) => setImmediate(resolve));

function gate(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function brokerOn(fake: FakeExchange, file: string, time: { now: number }): RemoteBroker {
  return new RemoteBroker({ api: fake, store: new RemoteStore(file, ACCOUNT_ID), accountId: ACCOUNT_ID, symbols: ['BTCUSDT'], initialMargin: 100_000, now: () => time.now });
}

async function setup() {
  const fake = new FakeExchange();
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'remote-races-')), 'remote-state.json');
  const time = { now: START };
  const sent: SubmitOrderParams[] = [];
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => {
    if (!params.clientOrderId.startsWith('external-')) sent.push(params);
    return original(params);
  };
  const broker = brokerOn(fake, file, time);
  await broker.init();
  const exitOrders = () => sent.filter((p) => p.reduceOnly);
  // Reads what is persisted, i.e. what a restarted process would see.
  const diskStore = () => new RemoteStore(file, ACCOUNT_ID);
  return { fake, file, time, sent, broker, exitOrders, diskStore };
}

/** Holds every non-exit order's response after the exchange applied its fill. */
function holdEntryResponses(fake: FakeExchange): { release: () => void } {
  const hold = gate();
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => {
    const result = await original(params);
    if (!params.reduceOnly) await hold.wait;
    return result;
  };
  return hold;
}

test('should not resurrect a position closed externally when a slower earlier sync applies last', async () => {
  const { fake, diskStore, broker } = await setup();
  await broker.open(BTC_LONG);
  broker.setMarks({ BTCUSDT: 65_500 });
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

  const slowSync = broker.sync();
  await tick();
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'sell', quantity: 0.1, executionPrice: 66_000, leverage: 5 });
  const freshSync = broker.sync();
  await tick();
  hold.release();
  await Promise.all([slowSync, freshSync]);
  await broker.sync();

  assert.equal(broker.getPositions().length, 0);
  assert.equal(diskStore().getMeta('BTCUSDT'), undefined);
  assert.deepEqual(broker.getTrades().map((t) => [t.strategy, t.reason]), [['MOMENTUM-γ', 'CLOSE']]);
});

test('should keep syncing after one sync failed while others were queued behind it', async () => {
  const { fake, broker } = await setup();
  const original = fake.getPositions.bind(fake);
  let failures = 1;
  fake.getPositions = async () => {
    if (failures-- > 0) throw new VenueUnavailableError('blip');
    return original();
  };

  await Promise.all([broker.sync(), broker.sync()]);

  assert.equal(broker.status().state, 'connected');
});

test('should not keep strategy ownership of a position an outsider flipped while the agent was down', async () => {
  const { fake, file, time, sent, broker } = await setup();
  await broker.open(BTC_LONG);
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'sell', quantity: 0.3, executionPrice: 66_000, leverage: 5 });
  const ordersBefore = sent.length;

  const restarted = brokerOn(fake, file, time);
  await restarted.init();
  restarted.markAll({ BTCUSDT: 63_900 });
  await restarted.idle();

  assert.equal(sent.length, ordersBefore);
  const [pos] = restarted.getPositions();
  assert.deepEqual([pos.side, pos.strategy, pos.serverSl, pos.serverTp], ['SHORT', 'EXECUTOR-ε', '—', '—']);
  assert.deepEqual(restarted.getTrades().map((t) => [t.strategy, t.side, t.reason, t.entry, t.exit, t.qty]), [['MOMENTUM-γ', 'LONG', 'CLOSE', 65_000, 65_000, 0.1]]);
});

test('should refuse a manual close while a scale-in for the symbol is in flight, leaving no zombie meta', async () => {
  const { fake, sent, exitOrders, diskStore, broker } = await setup();
  await broker.open(BTC_LONG);
  const pos = broker.getPositions()[0];
  const hold = holdEntryResponses(fake);

  const scaling = broker.open(BTC_LONG);
  await tick();
  await assert.rejects(broker.close(pos, 'CLOSE'), OrderInFlightError);
  hold.release();
  await scaling;
  await broker.sync();

  assert.equal(exitOrders().length, 0);
  assert.equal(sent.length, 2);
  assert.deepEqual(broker.getTrades(), []);
  assert.deepEqual([diskStore().getMeta('BTCUSDT')?.owner, broker.getPositions()[0].qty], ['MOMENTUM-γ', 0.2]);
});

test('should keep levels set by updateStops while a scale-in without new levels is in flight', async () => {
  const { fake, diskStore, broker } = await setup();
  await broker.open(BTC_LONG);
  const hold = holdEntryResponses(fake);

  const scaling = broker.open(NO_LEVELS);
  await tick();
  broker.updateStops('BTCUSDT', 'MOMENTUM-γ', 64_500, 69_000);
  hold.release();
  await scaling;

  assert.deepEqual([diskStore().getMeta('BTCUSDT')?.stopLoss, diskStore().getMeta('BTCUSDT')?.takeProfit], [64_500, 69_000]);
  assert.equal(broker.getPositions()[0].serverSl, '64500');
});

test('should send no exit for a stop breach while an open for the symbol is in flight', async () => {
  const { fake, exitOrders, broker } = await setup();
  await broker.open(BTC_LONG);
  const hold = holdEntryResponses(fake);

  const scaling = broker.open(BTC_LONG);
  await tick();
  broker.markAll({ BTCUSDT: 63_900 });
  await broker.idle();
  assert.equal(exitOrders().length, 0);
  hold.release();
  await scaling;

  assert.deepEqual(broker.getTrades(), []);
});

async function ambiguousOpen(fake: FakeExchange, broker: RemoteBroker): Promise<void> {
  const original = fake.submitOrder;
  fake.submitOrder = async () => { throw new VenueUnavailableError('request timed out'); };
  await assert.rejects(broker.open(BTC_LONG), VenueUnavailableError);
  fake.submitOrder = original;
}

const lateFill = (fake: FakeExchange) => fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: 0.1, executionPrice: 65_000, leverage: 5 });

test('should adopt a late-applied ambiguous open as owned with the requested levels, not as external', async () => {
  const { fake, time, broker, diskStore } = await setup();
  await ambiguousOpen(fake, broker);
  await lateFill(fake);
  time.now += 60_000;

  await broker.sync();

  const [pos] = broker.getPositions();
  assert.deepEqual([pos.strategy, pos.serverSl, pos.serverTp, pos.initialRisk], ['MOMENTUM-γ', '64000', '68000', 1_000]);
  assert.equal(diskStore().getMeta('BTCUSDT')?.external, undefined);
  assert.match(broker.markAll({}).join(), /BTCUSDT matches an unconfirmed open by MOMENTUM-γ/);
});

test('should adopt an unrelated position as external once the expected open has expired', async () => {
  const { fake, time, broker, diskStore } = await setup();
  await ambiguousOpen(fake, broker);
  time.now += EXPECTED_OPEN_TTL_MS + 1;
  await lateFill(fake);

  await broker.sync();

  assert.equal(broker.getPositions()[0].strategy, 'EXECUTOR-ε');
  assert.equal(diskStore().getMeta('BTCUSDT')?.external, true);
});

test('should not rewrite the sidecar on idle syncs, only on a real change or a 0.5 % mark move', async () => {
  const { file, broker, diskStore } = await setup();
  await broker.open(BTC_LONG);
  const persisted = readFileSync(file, 'utf8');

  for (const mark of [65_000, 65_050, 65_100]) {
    broker.setMarks({ BTCUSDT: mark });
    await broker.sync();
  }
  assert.equal(readFileSync(file, 'utf8'), persisted);

  broker.setMarks({ BTCUSDT: 65_400 });
  await broker.sync();
  assert.notEqual(readFileSync(file, 'utf8'), persisted);
  assert.equal(diskStore().getMeta('BTCUSDT')?.lastSeen?.mark, 65_400);
});

test('should keep managing what is left when an outsider added to the position while its exit was in flight', async () => {
  const { fake, exitOrders, diskStore, broker } = await setup();
  await broker.open(BTC_LONG);
  const hold = gate();
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => {
    if (params.reduceOnly) await hold.wait;
    return original(params);
  };

  broker.markAll({ BTCUSDT: 63_900 });
  await tick();
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: 0.1, executionPrice: 65_000, leverage: 5 });
  hold.release();
  await broker.idle();

  const [pos] = broker.getPositions();
  assert.deepEqual([pos.qty, pos.strategy, pos.serverSl, pos.serverTp, pos.initialRisk], [0.1, 'MOMENTUM-γ', '64000', '68000', 1_000]);
  assert.deepEqual(broker.getTrades().map((t) => [t.reason, t.qty]), [['STOP LOSS', 0.1]]);
  assert.deepEqual([diskStore().getMeta('BTCUSDT')?.owner, diskStore().getMeta('BTCUSDT')?.external], ['MOMENTUM-γ', undefined]);

  broker.markAll({ BTCUSDT: 63_800 });
  await broker.idle();
  assert.equal(exitOrders().length, 2);
  assert.deepEqual(broker.getTrades().map((t) => [t.reason, t.qty]), [['STOP LOSS', 0.1], ['STOP LOSS', 0.1]]);
  assert.equal(broker.getPositions().length, 0);
  assert.equal(diskStore().getMeta('BTCUSDT'), undefined);
});

test('should not stamp the sidecar with a snapshot that was read before an order settled', async () => {
  const { fake, diskStore, broker } = await setup();
  await broker.open(BTC_LONG);
  const exitHold = gate();
  const submit = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => {
    if (params.reduceOnly) await exitHold.wait;
    return submit(params);
  };
  broker.markAll({ BTCUSDT: 63_900 });
  await tick();

  // This read predates both the outsider's add and the exit's fill; its apply is queued in front of the exit's own refresh.
  const readHold = gate();
  const read = fake.getPositions.bind(fake);
  let isFirstRead = true;
  fake.getPositions = async () => {
    const snapshot = await read();
    if (isFirstRead) {
      isFirstRead = false;
      await readHold.wait;
    }
    return snapshot;
  };
  const staleSync = broker.sync();
  await tick();
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: 0.1, executionPrice: 66_000, leverage: 5 });
  exitHold.release();
  await tick();
  fake.down = true;
  readHold.release();
  await staleSync;
  await broker.idle();

  assert.equal(diskStore().getMeta('BTCUSDT')?.lastSeen, undefined);
  fake.down = false;
  await broker.sync();
  assert.deepEqual([diskStore().getMeta('BTCUSDT')?.lastSeen?.entry, diskStore().getMeta('BTCUSDT')?.lastSeen?.qty], [65_500, 0.1]);
});
