import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RemoteBroker } from '../src/binance/remoteBroker.js';
import { RemoteStore, type PositionMeta } from '../src/binance/remoteState.js';
import { FakeExchange } from './support/fakeExchange.js';

const ACCOUNT_ID = 'acct';
const INITIAL_MARGIN = 100_000;
const NOW = 2_000;
const OWNED: PositionMeta = { owner: 'MOMENTUM-γ', stopLoss: 64_000, takeProfit: 68_000, initialRisk: 1_000, openedAt: 1_000 };

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

function newStore(): RemoteStore {
  return new RemoteStore(path.join(mkdtempSync(path.join(tmpdir(), 'remote-broker-')), 'remote-state.json'), ACCOUNT_ID);
}

function brokerFor(fake: FakeExchange, store = newStore()): RemoteBroker {
  return new RemoteBroker({ api: fake, store, accountId: ACCOUNT_ID, symbols: ['BTCUSDT', 'ETHUSDT'], initialMargin: INITIAL_MARGIN, now: () => NOW });
}

let orderSeq = 0;
async function openBtcLong(fake: FakeExchange, quantity = 0.1): Promise<void> {
  await fake.submitOrder({ symbol: 'BTCUSDT', side: 'buy', quantity, leverage: 5, executionPrice: 65_000, clientOrderId: `t-${++orderSeq}` });
}

async function ownedBtcLong(meta: PositionMeta = OWNED) {
  const fake = new FakeExchange();
  const store = newStore();
  const broker = brokerFor(fake, store);
  await broker.init();
  await openBtcLong(fake);
  store.setMeta('BTCUSDT', meta);
  await broker.sync();
  return { fake, store, broker };
}

const closeBtcExternally = (fake: FakeExchange, price = 66_000) =>
  fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'sell', quantity: 0.1, executionPrice: price, leverage: 5 });

test('should create the account with the initial margin when none exists', async () => {
  const fake = new FakeExchange();
  await brokerFor(fake).init();
  const account = await fake.getAccount();
  near(account!.margin, INITIAL_MARGIN);
  near(account!.availableBalance, INITIAL_MARGIN);
});

test('should not reset an existing account when init runs again', async () => {
  const fake = new FakeExchange();
  await brokerFor(fake).init();
  await openBtcLong(fake);

  const restarted = brokerFor(fake);
  await restarted.init();

  assert.equal(fake.allRows().length, 1);
  assert.equal(restarted.getPositions().length, 1);
  assert.equal(restarted.getAccount().initialEquity, INITIAL_MARGIN);
});

test('should expose owner, stops, initial risk and liquidation distance of an owned position', async () => {
  const { broker } = await ownedBtcLong();
  const [pos] = broker.getPositions();

  assert.equal(pos.strategy, 'MOMENTUM-γ');
  assert.equal(pos.side, 'LONG');
  assert.equal(pos.serverSl, '64000');
  assert.equal(pos.serverTp, '68000');
  assert.equal(pos.initialRisk, 1_000);
  assert.equal(pos.marginType, 'ISOLATED');
  assert.equal(pos.leverage, 5);
  near(pos.liqDistancePct!, 19.6);
});

test('should report fee-inclusive wallet equity and locked margin like the exchange', async () => {
  const { fake, broker } = await ownedBtcLong();
  near(broker.getAccount().equity, fake.walletEquity());
  near(broker.getAccount().marginUsed, 1_300);
  assert.equal(broker.getAccount().initialEquity, INITIAL_MARGIN);

  await fake.pushMarkPrices({ BTCUSDT: 66_000 });
  await broker.sync();
  near(broker.getAccount().equity, fake.walletEquity());
});

test('should re-mark equity and unrealized pnl from the latest local mark between syncs', async () => {
  const { fake, broker } = await ownedBtcLong();
  const equityBefore = broker.getAccount().equity;

  broker.setMarks({ BTCUSDT: 67_000 });

  near(broker.getAccount().equity, equityBefore + 200);
  const [pos] = broker.getPositions();
  near(pos.mark, 67_000);
  near(pos.upnl, 200);
  near(pos.upnlPct, (2_000 / 65_000) * 100);
  await fake.pushMarkPrices({ BTCUSDT: 67_000 });
  near(broker.getAccount().equity, fake.walletEquity());
});

test('should ignore marks that are not finite positive prices', async () => {
  const { broker } = await ownedBtcLong();
  broker.setMarks({ BTCUSDT: 66_000 });

  for (const bad of [NaN, 0, -5, Infinity, 'abc' as unknown as number]) {
    broker.setMarks({ BTCUSDT: bad });
    assert.equal(broker.getPositions()[0].mark, 66_000, String(bad));
  }
});

test('should adopt a position with no sidecar entry as external EXECUTOR-ε without stops', async () => {
  const fake = new FakeExchange();
  const store = newStore();
  const broker = brokerFor(fake, store);
  await broker.init();
  await fake.injectExternalOrder({ symbol: 'ETHUSDT', side: 'sell', quantity: 1, executionPrice: 3_000, leverage: 3 });

  await broker.sync();

  const [pos] = broker.getPositions();
  assert.equal(pos.strategy, 'EXECUTOR-ε');
  assert.equal(pos.side, 'SHORT');
  assert.equal(pos.serverSl, '—');
  assert.equal(pos.serverTp, '—');
  assert.equal(pos.initialRisk, undefined);
  assert.equal(store.getMeta('ETHUSDT')?.external, true);
});

test('should journal CLOSE at the last local mark and drop the sidecar when a position vanishes', async () => {
  const { fake, store, broker } = await ownedBtcLong();
  broker.setMarks({ BTCUSDT: 65_500 });
  await closeBtcExternally(fake);

  await broker.sync();

  assert.deepEqual(broker.getTrades(), [
    { symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 65_000, exit: 65_500, qty: 0.1, pnl: 50, reason: 'CLOSE', closedAt: NOW, initialRisk: 1_000 },
  ]);
  assert.equal(broker.getPositions().length, 0);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
});

test('should journal LIQUIDATED at the risk event mark price', async () => {
  const { fake, store, broker } = await ownedBtcLong();
  await fake.pushMarkPrices({ BTCUSDT: 50_000 });

  await broker.sync();

  const [trade] = broker.getTrades();
  assert.equal(trade.reason, 'LIQUIDATED');
  assert.equal(trade.exit, 50_000);
  near(trade.pnl, -1_500);
  assert.equal(trade.strategy, 'MOMENTUM-γ');
  assert.equal(store.getMeta('BTCUSDT'), undefined);
});

test('should ignore a liquidation event older than the position and journal CLOSE instead', async () => {
  const { fake, broker } = await ownedBtcLong({ ...OWNED, openedAt: Date.now() + 60_000 });
  await fake.pushMarkPrices({ BTCUSDT: 50_000 });

  await broker.sync();

  assert.equal(broker.getTrades()[0].reason, 'CLOSE');
  assert.equal(broker.getTrades()[0].exit, 65_000);
});

test('should fetch risk events only when a sidecar position vanished', async () => {
  const { fake, broker } = await ownedBtcLong();
  let riskFetches = 0;
  const original = fake.getRiskEvents.bind(fake);
  fake.getRiskEvents = async () => { riskFetches++; return original(); };

  await broker.sync();
  assert.equal(riskFetches, 0);

  await closeBtcExternally(fake);
  await broker.sync();
  assert.equal(riskFetches, 1);
});

test('should never expose or adopt zero-quantity rows', async () => {
  const fake = new FakeExchange();
  const store = newStore();
  const broker = brokerFor(fake, store);
  await broker.init();
  await openBtcLong(fake);
  await closeBtcExternally(fake);
  fake.getPositions = async () => fake.allRows();
  assert.equal(fake.allRows()[0].netQuantity, 0);

  await broker.sync();

  assert.equal(broker.getPositions().length, 0);
  assert.deepEqual(store.metas(), {});
});

test('should journal the old position CLOSE and adopt the new one when the side flips externally', async () => {
  const { fake, store, broker } = await ownedBtcLong();
  broker.setMarks({ BTCUSDT: 65_200 });
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'sell', quantity: 0.2, executionPrice: 66_000, leverage: 5 });

  await broker.sync();

  const [trade] = broker.getTrades();
  assert.equal(trade.reason, 'CLOSE');
  assert.equal(trade.strategy, 'MOMENTUM-γ');
  assert.equal(trade.side, 'LONG');
  near(trade.exit, 65_200);
  const [pos] = broker.getPositions();
  assert.equal(pos.side, 'SHORT');
  assert.equal(pos.strategy, 'EXECUTOR-ε');
  assert.equal(pos.serverSl, '—');
  assert.equal(store.getMeta('BTCUSDT')?.external, true);
});

test('should go degraded then down while the venue is unreachable, keep cached data, and recover on success', async () => {
  const { fake, broker } = await ownedBtcLong();
  assert.equal(broker.status().state, 'connected');
  fake.down = true;

  const states: string[] = [];
  for (let i = 0; i < 3; i++) {
    await broker.sync();
    states.push(broker.status().state);
  }

  assert.deepEqual(states, ['degraded', 'degraded', 'down']);
  assert.match(broker.status().lastError ?? '', /down/);
  assert.equal(broker.getPositions()[0].strategy, 'MOMENTUM-γ');
  near(broker.getAccount().marginUsed, 1_300);

  fake.down = false;
  await broker.sync();
  const status = broker.status();
  assert.deepEqual([status.state, status.lastError, status.lastSyncAt, status.accountId, status.name], ['connected', null, NOW, ACCOUNT_ID, 'paper_exchange']);
});

test('should not journal or drop anything while the venue is down', async () => {
  const { fake, store, broker } = await ownedBtcLong();
  fake.down = true;

  await broker.sync();

  assert.equal(broker.getTrades().length, 0);
  assert.ok(store.getMeta('BTCUSDT'));
});

test('should drop a sidecar entry without journaling when no last known position exists after a restart', async () => {
  const fake = new FakeExchange();
  const store = newStore();
  store.setMeta('BTCUSDT', OWNED);
  const broker = brokerFor(fake, store);

  await broker.init();

  assert.deepEqual(broker.getTrades(), []);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
});

test('should journal CLOSE from lastSeen when a fresh process finds the position gone', async () => {
  const fake = new FakeExchange();
  await fake.createAccount(INITIAL_MARGIN);
  const store = newStore();
  store.setMeta('BTCUSDT', { ...OWNED, lastSeen: { side: 'LONG', entry: 65_000, qty: 0.1, mark: 65_500 } });
  const broker = brokerFor(fake, store);
  await broker.init();
  assert.deepEqual(broker.getTrades(), [
    { symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 65_000, exit: 65_500, qty: 0.1, pnl: 50, reason: 'CLOSE', closedAt: NOW, initialRisk: 1_000 },
  ]);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
});

test('should journal LIQUIDATED from lastSeen when the position was liquidated while the agent was offline', async () => {
  const { fake, store } = await ownedBtcLong({ ...OWNED, lastSeen: { side: 'LONG', entry: 65_000, qty: 0.1, mark: 65_000 } });
  await fake.pushMarkPrices({ BTCUSDT: 50_000 });
  const restarted = brokerFor(fake, store);
  await restarted.init();
  const trades = restarted.getTrades();
  assert.equal(trades.length, 1);
  assert.deepEqual([trades[0].reason, trades[0].exit], ['LIQUIDATED', 50_000]);
  assert.equal(store.getMeta('BTCUSDT'), undefined);
});
