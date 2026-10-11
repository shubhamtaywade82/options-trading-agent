import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OrderInFlightError, OwnershipError, RemoteBroker, type OpenParams } from '../src/binance/remoteBroker.js';
import { OrderRejectedError, VenueUnavailableError, type SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { RemoteStore } from '../src/binance/remoteState.js';
import { FakeExchange } from './support/fakeExchange.js';

const ACCOUNT_ID = 'acct';
const NOW = 2_000;
const BTC_LONG: OpenParams = { symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, leverage: 5, strategy: 'MOMENTUM-γ', stopLoss: 64_000, takeProfit: 68_000, entryPrice: 65_000 };

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

function storeFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'remote-orders-')), 'remote-state.json');
}

async function setup(options: { margin?: number; file?: string; fake?: FakeExchange } = {}) {
  const fake = options.fake ?? new FakeExchange();
  const file = options.file ?? storeFile();
  const store = new RemoteStore(file, ACCOUNT_ID);
  const sent: SubmitOrderParams[] = [];
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { sent.push(params); return original(params); };
  const broker = new RemoteBroker({ api: fake, store, accountId: ACCOUNT_ID, symbols: ['BTCUSDT', 'ETHUSDT'], initialMargin: options.margin ?? 100_000, now: () => NOW });
  await broker.init();
  return { fake, store, broker, sent, file };
}

async function failSyncsUntilDown(broker: RemoteBroker, fake: FakeExchange): Promise<void> {
  fake.down = true;
  for (let i = 0; i < 3; i++) await broker.sync();
  assert.equal(broker.status().state, 'down');
}

test('should expose hasData only after the first successful sync', async () => {
  const fake = new FakeExchange();
  const broker = new RemoteBroker({ api: fake, store: new RemoteStore(storeFile(), ACCOUNT_ID), accountId: ACCOUNT_ID, symbols: [], initialMargin: 1_000 });
  assert.equal(broker.hasData(), false);
  assert.throws(() => broker.getAccount(), /init/);
  await broker.init();
  assert.equal(broker.hasData(), true);
});

test('should open a long: exchange position matches, meta written with initial risk, cache fresh without an extra sync', async () => {
  const { fake, store, broker, sent } = await setup();

  const ack = await broker.open(BTC_LONG);

  assert.equal(ack.status, 'filled');
  assert.equal(typeof ack.orderId, 'string');
  const [row] = fake.allRows();
  assert.deepEqual([row.side, row.netQuantity, row.averagePrice, row.leverage], ['long', 0.1, 65_000, 5]);
  assert.deepEqual(store.getMeta('BTCUSDT'), {
    owner: 'MOMENTUM-γ', stopLoss: 64_000, takeProfit: 68_000, initialRisk: 1_000, openedAt: NOW,
    lastSeen: { side: 'LONG', entry: 65_000, qty: 0.1, mark: 65_000 },
  });
  const [pos] = broker.getPositions();
  assert.deepEqual([pos.strategy, pos.qty, pos.serverSl], ['MOMENTUM-γ', 0.1, '64000']);
  assert.match(sent[0].clientOrderId, /^BTCUSDT-MOMENTUM-γ-OPEN-2000-[a-z0-9]+$/);
  assert.equal(sent[0].executionPrice, 65_000);
  assert.equal(sent[0].reduceOnly, undefined);
  near(broker.getAccount().equity, fake.walletEquity());
});

test('should store null levels and initial risk when the entry has no stop loss', async () => {
  const { store, broker } = await setup();
  await broker.open({ ...BTC_LONG, stopLoss: undefined, takeProfit: undefined });
  assert.deepEqual([store.getMeta('BTCUSDT')?.stopLoss, store.getMeta('BTCUSDT')?.initialRisk], [null, null]);
});

test('should scale in: average entry, SL/TP replaced, initial risk and opening time unchanged', async () => {
  const { fake, store, broker } = await setup();
  await broker.open(BTC_LONG);

  await broker.open({ ...BTC_LONG, entryPrice: 66_000, stopLoss: 65_000, takeProfit: 70_000 });

  const [row] = fake.allRows();
  near(row.netQuantity, 0.2);
  near(row.averagePrice, 65_500);
  const meta = store.getMeta('BTCUSDT');
  assert.deepEqual([meta?.stopLoss, meta?.takeProfit, meta?.initialRisk, meta?.openedAt], [65_000, 70_000, 1_000, NOW]);
  near(broker.getPositions()[0].entry, 65_500);

  await broker.open({ ...BTC_LONG, stopLoss: undefined, takeProfit: undefined });
  assert.deepEqual([store.getMeta('BTCUSDT')?.stopLoss, store.getMeta('BTCUSDT')?.takeProfit], [65_000, 70_000]);
});

test('should refuse another strategy on an owned symbol and send no order', async () => {
  const { broker, sent } = await setup();
  await broker.open(BTC_LONG);
  const ordersBefore = sent.length;
  await assert.rejects(broker.open({ ...BTC_LONG, strategy: 'ADAPTIVE-ST-ζ' }), OwnershipError);
  assert.equal(sent.length, ordersBefore);
  assert.equal(broker.getPositions()[0].strategy, 'MOMENTUM-γ');
});

test('should refuse a strategy entry on an external position without touching it', async () => {
  const { fake, broker, sent } = await setup();
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: 0.5, executionPrice: 65_000, leverage: 3 });
  const ordersBefore = sent.length;

  await assert.rejects(broker.open(BTC_LONG), OwnershipError);

  assert.equal(sent.length, ordersBefore);
  near(fake.allRows()[0].netQuantity, 0.5);
});

test('should flip for the owner: full reduce-only close journaled FLIP, then a new position under the same owner', async () => {
  const { fake, store, broker, sent } = await setup();
  await broker.open(BTC_LONG);

  await broker.open({ ...BTC_LONG, side: 'SELL', qty: 0.05, entryPrice: 66_000, stopLoss: 67_000, takeProfit: 60_000 });

  const [close, reopen] = sent.slice(1);
  assert.match(close.clientOrderId, /^BTCUSDT-MOMENTUM-γ-EXIT-FLIP-2000-[a-z0-9]+$/);
  assert.deepEqual([close.reduceOnly, close.side, close.quantity], [true, 'sell', 0.1]);
  assert.deepEqual([reopen.reduceOnly, reopen.side, reopen.quantity], [undefined, 'sell', 0.05]);
  assert.deepEqual(broker.getTrades(), [
    { symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 65_000, exit: 66_000, qty: 0.1, pnl: 100, reason: 'FLIP', closedAt: NOW, initialRisk: 1_000 },
  ]);
  const [row] = fake.allRows();
  assert.deepEqual([row.side, row.netQuantity, row.averagePrice], ['short', 0.05, 66_000]);
  assert.deepEqual([store.getMeta('BTCUSDT')?.owner, store.getMeta('BTCUSDT')?.initialRisk], ['MOMENTUM-γ', 1_000]);

  await broker.sync();
  await broker.sync();
  assert.equal(broker.getTrades().length, 1);
  assert.equal(broker.getPositions()[0].strategy, 'MOMENTUM-γ');
  assert.equal(store.getMeta('BTCUSDT')?.external, undefined);
});

test('should leave the account flat with no zombie meta when a flip closes but the new open is rejected', async () => {
  const { fake, store, broker } = await setup({ margin: 20_000 });
  await broker.open({ ...BTC_LONG, qty: 0.5 });

  await assert.rejects(broker.open({ ...BTC_LONG, side: 'SELL', qty: 100 }), OrderRejectedError);

  assert.equal(fake.allRows()[0].netQuantity, 0);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
  assert.equal(broker.getPositions().length, 0);
  assert.deepEqual(broker.getTrades().map((t) => t.reason), ['FLIP']);
});

test('should refuse an open with nothing sent while the venue is down', async () => {
  const { fake, store, broker, sent } = await setup();
  await failSyncsUntilDown(broker, fake);

  await assert.rejects(broker.open(BTC_LONG), VenueUnavailableError);

  assert.equal(sent.length, 0);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
});

test('should refuse an open with nothing sent when the pre-order refresh cannot reach the venue', async () => {
  const { fake, broker, sent } = await setup();
  fake.down = true;

  await assert.rejects(broker.open(BTC_LONG), VenueUnavailableError);

  assert.equal(sent.length, 0);
});

test('should resolve a response lost after the fill by lookup: no duplicate order or position', async () => {
  const { fake, store, broker, sent } = await setup();
  fake.failNextPostAfterFill = true;

  const ack = await broker.open(BTC_LONG);

  assert.equal(ack.status, 'filled');
  assert.equal(sent.length, 1);
  assert.equal(fake.allRows().length, 1);
  near(fake.allRows()[0].netQuantity, 0.1);
  assert.equal(store.getMeta('BTCUSDT')?.owner, 'MOMENTUM-γ');
  assert.equal(broker.getPositions().length, 1);
});

test('should fail without meta when the request never reached the exchange', async () => {
  const { fake, store, broker } = await setup();
  fake.submitOrder = async () => { throw new VenueUnavailableError('timeout before the request left'); };

  await assert.rejects(broker.open(BTC_LONG), VenueUnavailableError);

  assert.equal(store.getMeta('BTCUSDT'), undefined);
  assert.equal(fake.allRows().length, 0);
});

test('should surface a 402 with no meta, journal or position change', async () => {
  const { fake, store, broker } = await setup({ margin: 1_000 });

  await assert.rejects(broker.open(BTC_LONG), (err: unknown) => err instanceof OrderRejectedError && err.status === 402);

  assert.deepEqual(store.metas(), {});
  assert.deepEqual(broker.getTrades(), []);
  assert.equal(fake.allRows().length, 0);
});

test('should surface a 422 for a zero quantity without touching the sidecar', async () => {
  const { store, broker } = await setup();
  await assert.rejects(broker.open({ ...BTC_LONG, qty: 0 }), (err: unknown) => err instanceof OrderRejectedError && err.status === 422);
  assert.deepEqual(store.metas(), {});
});

test('should hold positions on two symbols at once, each with its own owner', async () => {
  const { store, broker } = await setup();
  await broker.open(BTC_LONG);
  await broker.open({ symbol: 'ETHUSDT', side: 'SELL', qty: 2, leverage: 3, strategy: 'ADAPTIVE-ST-ζ', stopLoss: 3_200, takeProfit: 2_700, entryPrice: 3_000 });

  const bySymbol = new Map(broker.getPositions().map((p) => [p.symbol, p]));
  assert.deepEqual([bySymbol.get('BTCUSDT')?.strategy, bySymbol.get('BTCUSDT')?.side], ['MOMENTUM-γ', 'LONG']);
  assert.deepEqual([bySymbol.get('ETHUSDT')?.strategy, bySymbol.get('ETHUSDT')?.side], ['ADAPTIVE-ST-ζ', 'SHORT']);
  assert.equal(store.getMeta('ETHUSDT')?.initialRisk, 200);
});

test('should never adopt or misjournal a symbol while its open is in flight', async () => {
  const { fake, store, broker } = await setup();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let filled: () => void = () => undefined;
  const fillApplied = new Promise<void>((resolve) => { filled = resolve; });
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { const result = await original(params); filled(); await gate; return result; };

  const opening = broker.open(BTC_LONG);
  await fillApplied;
  await broker.sync();

  assert.equal(store.getMeta('BTCUSDT'), undefined);
  assert.deepEqual(broker.getTrades(), []);
  release();
  await opening;

  assert.equal(store.getMeta('BTCUSDT')?.owner, 'MOMENTUM-γ');
  assert.equal(broker.getPositions()[0].strategy, 'MOMENTUM-γ');
  assert.deepEqual(broker.getTrades(), []);
});

test('should refuse a second open on a symbol while one is already in flight', async () => {
  const { fake, broker, sent } = await setup();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = fake.submitOrder.bind(fake);
  fake.submitOrder = async (params) => { await gate; return original(params); };

  const first = broker.open(BTC_LONG);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(broker.open({ ...BTC_LONG, strategy: 'ADAPTIVE-ST-ζ' }), OrderInFlightError);
  release();
  await first;

  assert.equal(sent.length, 1);
});

test('should persist updateStops and show it after a restart on the same store file; the restart sends no order', async () => {
  const { fake, broker, file, sent } = await setup();
  await broker.open(BTC_LONG);
  broker.updateStops('BTCUSDT', 'MOMENTUM-γ', 64_500, 69_000);
  const ordersBefore = sent.length;

  const restarted = new RemoteBroker({ api: fake, store: new RemoteStore(file, ACCOUNT_ID), accountId: ACCOUNT_ID, symbols: ['BTCUSDT'], initialMargin: 100_000, now: () => NOW });
  await restarted.init();

  const [pos] = restarted.getPositions();
  assert.deepEqual([pos.strategy, pos.serverSl, pos.serverTp, pos.initialRisk], ['MOMENTUM-γ', '64500', '69000', 1_000]);
  assert.equal(sent.length, ordersBefore);
  assert.deepEqual(restarted.getTrades(), []);
});

test('should ignore updateStops from another strategy, for an external position or for no position', async () => {
  const { fake, store, broker } = await setup();
  await broker.open(BTC_LONG);
  await fake.injectExternalOrder({ symbol: 'ETHUSDT', side: 'buy', quantity: 1, executionPrice: 3_000, leverage: 3 });
  await broker.sync();

  broker.updateStops('BTCUSDT', 'ADAPTIVE-ST-ζ', 1, 2);
  broker.updateStops('ETHUSDT', 'MOMENTUM-γ', 1, 2);
  broker.updateStops('SOLUSDT', 'MOMENTUM-γ', 1, 2);

  assert.deepEqual([store.getMeta('BTCUSDT')?.stopLoss, store.getMeta('ETHUSDT')?.stopLoss, store.getMeta('SOLUSDT')], [64_000, null, undefined]);
});

test('should apply a funding event once, reflect it in equity, and not throw when the venue is down', async () => {
  const { fake, broker } = await setup();
  await broker.open(BTC_LONG);
  const before = broker.getAccount().equity;

  await broker.pushFunding('BTCUSDT', 0.0001, 65_000, 1_000);
  await broker.pushFunding('BTCUSDT', 0.0001, 65_000, 1_000);

  near(broker.getAccount().equity, before - 0.65);
  near(broker.getAccount().equity, fake.walletEquity());

  fake.down = true;
  await broker.pushFunding('BTCUSDT', 0.0001, 65_000, 2_000);
  assert.match(broker.status().lastError ?? '', /down/);
});
