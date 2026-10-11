import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BinanceService } from '../src/binance/client.js';
import { VenueUnavailableError } from '../src/binance/paperExchangeClient.js';
import { OwnershipError, RemoteBroker } from '../src/binance/remoteBroker.js';
import { FundingBoundaryWatcher } from '../src/binance/remoteFunding.js';
import { RemoteStore } from '../src/binance/remoteState.js';
import { FakeExchange } from './support/fakeExchange.js';

const ACCOUNT_ID = 'acct';
const FUNDING_INTERVAL_MS = 8 * 3_600_000;
const BTC_LONG = { symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, leverage: 5, strategy: 'MOMENTUM-γ', stopLoss: 64_000, takeProfit: 68_000, entryPrice: 65_000 } as const;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

async function setup(options: { down?: boolean } = {}) {
  const fake = new FakeExchange();
  fake.down = options.down ?? false;
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'binance-service-')), 'remote-state.json');
  const broker = new RemoteBroker({ api: fake, store: new RemoteStore(file, ACCOUNT_ID), accountId: ACCOUNT_ID, symbols: ['BTCUSDT', 'ETHUSDT'], initialMargin: 100_000, now: () => 2_000 });
  const service = new BinanceService(broker);
  if (!fake.down) await service.initVenue();
  return { fake, broker, service };
}

test('should open through the broker and reflect the fake exchange in positions and fee-inclusive equity', async () => {
  const { fake, service } = await setup();

  const order = await service.openFuturesPosition(BTC_LONG);

  assert.ok(order.orderId);
  const [position] = await service.getPositions();
  assert.deepEqual([position.symbol, position.side, position.qty, position.strategy], ['BTCUSDT', 'LONG', 0.1, 'MOMENTUM-γ']);
  const account = await service.getAccount();
  near(account.equity, fake.walletEquity());
  assert.ok(account.equity < 100_000, 'the entry fee is inside equity');
  assert.deepEqual([account.marginUsed, account.initialEquity], [1_300, 100_000]);
});

test('should return the exit message once a stop is breached', async () => {
  const { broker, service } = await setup();
  await service.openFuturesPosition(BTC_LONG);

  assert.deepEqual(service.markAll({ BTCUSDT: 63_900 }), []);
  await broker.idle();

  assert.match(service.markAll({ BTCUSDT: 63_900 }).join(), /^STOP LOSS BTCUSDT LONG @ 63,900\.00/);
  assert.equal((await service.getPositions()).length, 0);
});

test('should move the stop when updateStops is called', async () => {
  const { service } = await setup();
  await service.openFuturesPosition(BTC_LONG);

  service.updateStops('BTCUSDT', 'MOMENTUM-γ', 64_500, 69_000);

  const [position] = await service.getPositions();
  assert.deepEqual([position.serverSl, position.serverTp], ['64500', '69000']);
});

test('should close a position and journal it as CLOSE', async () => {
  const { service } = await setup();
  await service.openFuturesPosition(BTC_LONG);
  const [position] = await service.getPositions();

  await service.closePosition(position);

  assert.equal((await service.getPositions()).length, 0);
  assert.deepEqual(service.getTrades().map((t) => [t.strategy, t.reason]), [['MOMENTUM-γ', 'CLOSE']]);
});

test('should refuse a second strategy on the same symbol without sending an order', async () => {
  const { fake, service } = await setup();
  await service.openFuturesPosition(BTC_LONG);

  await assert.rejects(service.openFuturesPosition({ ...BTC_LONG, strategy: 'FUNDING-ARB-α' }), OwnershipError);

  assert.equal((await fake.getPositions())[0].netQuantity, 0.1);
});

test('should sync on getPositions but serve the cache for getPositions(false)', async () => {
  const { fake, service } = await setup();
  await fake.injectExternalOrder({ symbol: 'ETHUSDT', side: 'buy', quantity: 1, leverage: 5, executionPrice: 3_000 });

  assert.equal((await service.getPositions(false)).length, 0);
  assert.equal((await service.getPositions()).length, 1);
});

test('should report the venue state and data availability from the broker', async () => {
  const { fake, service } = await setup();
  assert.deepEqual([service.getVenueStatus()?.state, service.hasVenueData()], ['connected', true]);

  fake.down = true;
  await service.getPositions();
  assert.equal(service.getVenueStatus()?.state, 'degraded');
  await service.getPositions();
  await service.getPositions();
  assert.equal(service.getVenueStatus()?.state, 'down');
  assert.equal(service.hasVenueData(), true, 'the cache survives the outage');
});

test('should count a failed init as a venue failure so a startup outage is not reported as connected', async () => {
  const { service } = await setup({ down: true });

  await assert.rejects(service.initVenue(), VenueUnavailableError);

  assert.deepEqual([service.hasVenueData(), service.getVenueStatus()?.state], [false, 'degraded']);
});

test('should have no venue status when there is no broker', () => {
  const service = new BinanceService(null);
  assert.deepEqual([service.getVenueStatus(), service.hasVenueData()], [null, true]);
});

test('should record the first boundary silently, then push once per symbol with the previous boundary on a forward jump', async () => {
  const pushed: [string, number, number, number][] = [];
  const watcher = new FundingBoundaryWatcher(['BTCUSDT', 'ETHUSDT'], async (...event) => { pushed.push(event); return true; });
  const market = (nextFundingTime: number) => ({ nextFundingTime, funding: { BTCUSDT: 0.0001, ETHUSDT: 0.0002 }, marks: { BTCUSDT: 65_000, ETHUSDT: 3_000 } });

  assert.deepEqual(await watcher.observe(market(FUNDING_INTERVAL_MS)), []);
  assert.deepEqual(await watcher.observe(market(FUNDING_INTERVAL_MS)), []);
  assert.equal(pushed.length, 0);

  const lines = await watcher.observe(market(2 * FUNDING_INTERVAL_MS));
  assert.deepEqual(pushed, [['BTCUSDT', 0.0001, 65_000, FUNDING_INTERVAL_MS], ['ETHUSDT', 0.0002, 3_000, FUNDING_INTERVAL_MS]]);
  assert.deepEqual(lines.map((l) => l.isFailure), [false, false]);
  assert.match(lines[0].message, /^Funding settled for BTCUSDT/);

  await watcher.observe(market(2 * FUNDING_INTERVAL_MS));
  assert.equal(pushed.length, 2);
});

test('should report a push the exchange did not accept as a failure line', async () => {
  const watcher = new FundingBoundaryWatcher(['BTCUSDT'], async () => false);
  const market = (nextFundingTime: number) => ({ nextFundingTime, funding: { BTCUSDT: 0.0001 }, marks: { BTCUSDT: 65_000 } });

  await watcher.observe(market(FUNDING_INTERVAL_MS));
  const [line] = await watcher.observe(market(2 * FUNDING_INTERVAL_MS));

  assert.equal(line.isFailure, true);
  assert.match(line.message, /push FAILED/);
});

test('should return false from pushFunding, without throwing, while the exchange is down', async () => {
  const { fake, broker } = await setup();
  fake.down = true;

  assert.equal(await broker.pushFunding('BTCUSDT', 0.0001, 65_000, 1_000), false);
  assert.match(broker.status().lastError ?? '', /funding BTCUSDT/);
});

test('should ignore an unset boundary and skip symbols without a rate or mark', async () => {
  const pushed: string[] = [];
  const watcher = new FundingBoundaryWatcher(['BTCUSDT', 'ETHUSDT'], async (symbol) => { pushed.push(symbol); return true; });

  await watcher.observe({ nextFundingTime: 0, funding: {}, marks: {} });
  await watcher.observe({ nextFundingTime: FUNDING_INTERVAL_MS, funding: {}, marks: {} });
  await watcher.observe({ nextFundingTime: 2 * FUNDING_INTERVAL_MS, funding: { BTCUSDT: 0.0001 }, marks: { BTCUSDT: 65_000 } });

  assert.deepEqual(pushed, ['BTCUSDT']);
});

test('should settle funding on the exchange exactly once per boundary through the service', async () => {
  const { service } = await setup();
  await service.openFuturesPosition({ ...BTC_LONG, side: 'SELL' });
  const observed = (nextFundingTime: number) => ({ nextFundingTime, funding: { BTCUSDT: 0.001, ETHUSDT: 0.001 }, marks: { BTCUSDT: 65_000, ETHUSDT: 3_000 } });
  const before = (await service.getAccount()).equity;

  await service.settleFunding(observed(FUNDING_INTERVAL_MS));
  await service.settleFunding(observed(2 * FUNDING_INTERVAL_MS));
  await service.settleFunding(observed(2 * FUNDING_INTERVAL_MS));

  near((await service.getAccount()).equity, before + 0.1 * 65_000 * 0.001);
});

test('should hand adoption and dropped-entry notices to markAll once instead of writing to the console', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'binance-service-')), 'remote-state.json');
  const store = new RemoteStore(file, ACCOUNT_ID);
  store.setMeta('SOLUSDT', { owner: 'MOMENTUM-γ', stopLoss: null, takeProfit: null, initialRisk: null, openedAt: 1 });
  const fake = new FakeExchange();
  await fake.createAccount(100_000);
  await fake.injectExternalOrder({ symbol: 'ETHUSDT', side: 'sell', quantity: 1, executionPrice: 3_000, leverage: 3 });
  const service = new BinanceService(new RemoteBroker({ api: fake, store, accountId: ACCOUNT_ID, symbols: ['ETHUSDT', 'SOLUSDT'], initialMargin: 100_000, now: () => 2_000 }));

  await service.initVenue();

  const notices = service.markAll({});
  assert.equal(notices.length, 2);
  assert.match(notices.join('\n'), /SOLUSDT vanished while the agent was offline/);
  assert.match(notices.join('\n'), /ETHUSDT has no strategy owner; adopting it as external/);
  assert.deepEqual(service.markAll({}), []);
  assert.equal(warn.mock.calls.length, 0);
});

test('should journal the strategy initial risk on a stop-loss exit and on an off-agent close', async () => {
  const { fake, broker, service } = await setup();
  await service.openFuturesPosition(BTC_LONG);
  service.markAll({ BTCUSDT: 63_900 });
  await broker.idle();
  assert.equal(service.getTrades()[0].initialRisk, 1_000);

  await service.openFuturesPosition({ ...BTC_LONG, entryPrice: 65_000 });
  await fake.injectExternalOrder({ symbol: 'BTCUSDT', side: 'sell', quantity: 0.1, executionPrice: 66_000, leverage: 5 });
  await service.getPositions();
  assert.deepEqual(service.getTrades().map((t) => [t.reason, t.initialRisk]), [['STOP LOSS', 1_000], ['CLOSE', 1_000]]);
});
