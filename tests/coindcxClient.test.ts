import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OrderRejectedError, VenueUnavailableError, type SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { CoinDcxExchangeApi, type CoinDcxExchangeApiDeps, type CoinDcxOrderClient } from '../src/coindcx/coindcxClient.js';

type WalletRow = { currency: string; balance: number; locked_balance: number; available_balance: number };
type PositionRow = {
  id: string | number; pair: string; side: 'long' | 'short'; size: number; entry_price: number;
  mark_price?: number; liquidation_price?: number | null; leverage?: number; margin_type?: 'isolated' | 'cross';
};
type OrderRow = { id: string | number; client_order_id: string | undefined; status: string; filled_quantity: number | undefined; price: number | undefined };
type CreateOrderReq = Parameters<CoinDcxOrderClient['futures']['trading']['createOrder']>[0];

interface FakeOptions {
  wallet?: WalletRow[] | (() => WalletRow[]);
  positions?: PositionRow[];
  markets?: { pair: string; status?: string }[];
  instruments?: Record<string, { lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }>;
  ticker?: { pair?: string; last_price?: string | number }[];
  createOrder?: (req: CreateOrderReq) => Promise<OrderRow>;
  updateLeverage?: () => Promise<unknown>;
  listOrders?: (params: { pair?: string; status?: string; limit?: number }) => Promise<OrderRow[]>;
  getPositions?: () => Promise<PositionRow[]>;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = { createOrder: 0, updateLeverage: 0, getPositions: 0, getWallet: 0, listOrders: 0 };
  const callOrder: string[] = [];
  const client: CoinDcxOrderClient = {
    futures: {
      trading: {
        createOrder: async (req) => {
          calls.createOrder++;
          callOrder.push('createOrder');
          if (opts.createOrder) return opts.createOrder(req);
          return { id: 1, client_order_id: req.client_order_id, status: 'filled', filled_quantity: req.target_quantity, price: req.price };
        },
        listOrders: async (params) => {
          calls.listOrders++;
          return opts.listOrders ? opts.listOrders(params) : [];
        },
      },
      account: {
        updateLeverage: async (params) => {
          calls.updateLeverage++;
          callOrder.push('updateLeverage');
          return opts.updateLeverage ? opts.updateLeverage() : {};
        },
        getPositions: async () => {
          calls.getPositions++;
          if (opts.getPositions) return opts.getPositions();
          return opts.positions ?? [];
        },
        getWallet: async () => {
          calls.getWallet++;
          if (typeof opts.wallet === 'function') return opts.wallet();
          return opts.wallet ?? [{ currency: 'USDT', balance: 1000, locked_balance: 0, available_balance: 1000 }];
        },
      },
      market: {
        getMarketsDetails: async () => opts.markets ?? [{ pair: 'B-BTC_USDT', status: 'active' }],
        getInstrumentDetails: async (pair: string) => opts.instruments?.[pair] ?? { lot_size: 0.001, min_quantity: 0.001, min_price: 1, max_leverage: 20 },
      },
    },
    marketData: { getSpotTicker: async () => opts.ticker ?? [] },
  };
  return { client, calls, callOrder };
}

function tmpBaselinePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'coindcx-'));
  return path.join(dir, 'baseline.json');
}

function makeApi(client: CoinDcxOrderClient, overrides: Partial<CoinDcxExchangeApiDeps> = {}): CoinDcxExchangeApi {
  const deps: CoinDcxExchangeApiDeps = { client, quotePreference: 'auto', baselinePath: tmpBaselinePath(), accountId: 'acct1', ...overrides };
  return new CoinDcxExchangeApi(deps);
}

const orderParams = (over: Partial<SubmitOrderParams> = {}): SubmitOrderParams => ({
  symbol: 'BTCUSDT', side: 'buy', quantity: 0.127, leverage: 5, executionPrice: 50_000, clientOrderId: 'oid-1', ...over,
});

test('getAccount seeds and persists the baseline on first call; a second instance reads it back', async () => {
  const baselinePath = tmpBaselinePath();
  const { client } = fakeClient({ wallet: [{ currency: 'USDT', balance: 1000, locked_balance: 0, available_balance: 1000 }] });
  const api1 = new CoinDcxExchangeApi({ client, quotePreference: 'auto', baselinePath, accountId: 'acct1' });

  const account = await api1.getAccount();
  assert.equal(account?.margin, 1000);
  assert.ok(existsSync(baselinePath));
  const saved = JSON.parse(readFileSync(baselinePath, 'utf8')) as { initialEquity: number };
  assert.equal(saved.initialEquity, 1000);

  const { client: client2 } = fakeClient({ wallet: [{ currency: 'USDT', balance: 1500, locked_balance: 0, available_balance: 1500 }] });
  const api2 = new CoinDcxExchangeApi({ client: client2, quotePreference: 'auto', baselinePath, accountId: 'acct1' });
  const account2 = await api2.getAccount();
  assert.equal(account2?.margin, 1000, 'second instance must read the persisted baseline, not reseed from live wallet');
  assert.equal(account2?.equity, 1500, 'equity itself still reflects the live wallet');
});

test('createAccount() throws', async () => {
  const { client } = fakeClient();
  const api = makeApi(client);
  await assert.rejects(() => api.createAccount(100), /CoinDCX accounts are not created via the API/);
});

test('getPositions maps a position to the Binance symbol and skips an unresolvable pair', async () => {
  const { client } = fakeClient({
    markets: [{ pair: 'B-BTC_USDT', status: 'active' }],
    positions: [
      { id: 1, pair: 'B-BTC_USDT', side: 'long', size: 0.5, entry_price: 50_000, mark_price: 51_000, leverage: 5, margin_type: 'isolated' },
      { id: 2, pair: 'B-XYZ_USDT', side: 'long', size: 1, entry_price: 10 },
      { id: 3, pair: 'B-BTC_USDT', side: 'long', size: 0, entry_price: 50_000 },
    ],
  });
  const api = makeApi(client);
  // Priming: only submitOrder() ever calls SymbolRouter.resolve(), which is what populates pairToSymbol.
  await api.submitOrder(orderParams());

  const positions = await api.getPositions();
  assert.equal(positions.length, 1, 'the unresolvable B-XYZ_USDT position and the zero-size row are both dropped');
  assert.deepEqual(positions[0], {
    id: 1, symbol: 'BTCUSDT', side: 'long', netQuantity: 0.5, averagePrice: 50_000, currentPrice: 51_000,
    leverage: 5, marginType: 'isolated', liquidationPrice: null, unrealizedPnl: 0,
  });
});

test('submitOrder for a USDT pair: leverage is set before the order, quantity is floored, status passes through verbatim', async () => {
  const { client, callOrder } = fakeClient({ instruments: { 'B-BTC_USDT': { lot_size: 0.01, min_quantity: 0.01, min_price: 1, max_leverage: 20 } } });
  const api = makeApi(client);

  const result = await api.submitOrder(orderParams({ quantity: 0.127 }));

  assert.deepEqual(callOrder, ['updateLeverage', 'createOrder']);
  assert.equal(result.status, 'filled');
});

test('submitOrder floors the sent quantity to the lot size', async () => {
  let sent: CreateOrderReq | undefined;
  const { client } = fakeClient({
    instruments: { 'B-BTC_USDT': { lot_size: 0.01, min_quantity: 0.01, min_price: 1, max_leverage: 20 } },
    createOrder: async (req) => { sent = req; return { id: 1, client_order_id: req.client_order_id, status: 'filled', filled_quantity: undefined, price: req.price }; },
  });
  const api = makeApi(client);
  await api.submitOrder(orderParams({ quantity: 0.127 }));
  assert.equal(sent?.target_quantity, 0.12);
});

test('submitOrder for an INR-routed symbol converts the sent price by the FX rate', async () => {
  let sent: CreateOrderReq | undefined;
  const { client } = fakeClient({
    markets: [{ pair: 'B-XYZ_INR', status: 'active' }],
    ticker: [{ pair: 'USDTINR', last_price: '87' }],
    instruments: { 'B-XYZ_INR': { lot_size: 0.1, min_quantity: 0.1, min_price: 1, max_leverage: 20 } },
    createOrder: async (req) => { sent = req; return { id: 1, client_order_id: req.client_order_id, status: 'filled', filled_quantity: undefined, price: req.price }; },
  });
  const api = makeApi(client);
  await api.submitOrder(orderParams({ symbol: 'XYZUSDT', quantity: 1, executionPrice: 100 }));
  assert.equal(sent?.price, 8700);
});

test('submitOrder above maxOrderNotional throws OrderRejectedError before any network call', async () => {
  const { client, calls } = fakeClient();
  const api = makeApi(client, { maxOrderNotional: 1000 });
  await assert.rejects(() => api.submitOrder(orderParams({ quantity: 1, executionPrice: 50_000 })), OrderRejectedError);
  assert.equal(calls.createOrder, 0);
  assert.equal(calls.updateLeverage, 0, 'the cap check must run before the leverage-set call, not just before createOrder');
});

test('submitOrder above maxOrderQuantity throws OrderRejectedError before any network call', async () => {
  const { client, calls } = fakeClient();
  const api = makeApi(client, { maxOrderQuantity: 0.01 });
  await assert.rejects(() => api.submitOrder(orderParams({ quantity: 1 })), OrderRejectedError);
  assert.equal(calls.createOrder, 0);
  assert.equal(calls.updateLeverage, 0);
});

test('submitOrder reduce-only: a leverage-set failure does not block the order', async () => {
  const { client, calls } = fakeClient({ updateLeverage: async () => { throw new Error('stale leverage'); } });
  const api = makeApi(client);
  const result = await api.submitOrder(orderParams({ reduceOnly: true }));
  assert.equal(result.status, 'filled');
  assert.equal(calls.createOrder, 1);
});

test('submitOrder non-reduce-only: a leverage-set failure blocks the order', async () => {
  const { client, calls } = fakeClient({ updateLeverage: async () => { throw new Error('stale leverage'); } });
  const api = makeApi(client);
  await assert.rejects(() => api.submitOrder(orderParams({ reduceOnly: false })), VenueUnavailableError);
  assert.equal(calls.createOrder, 0);
});

test('findOrder finds a match in the open-orders pass when the recent pass misses it', async () => {
  const match: OrderRow = { id: 9, client_order_id: 'oid-9', status: 'open', filled_quantity: undefined, price: 100 };
  const { client } = fakeClient({
    listOrders: async (params) => (params.status === 'open' ? [match] : []),
  });
  const api = makeApi(client);
  const found = await api.findOrder('oid-9');
  assert.equal(found?.orderId, 9);
});

test('findOrder returns null when neither pass has it', async () => {
  const { client } = fakeClient({ listOrders: async () => [] });
  const api = makeApi(client);
  assert.equal(await api.findOrder('missing'), null);
});

test('getRiskEvents returns []', async () => {
  const { client } = fakeClient();
  const api = makeApi(client);
  assert.deepEqual(await api.getRiskEvents(), []);
});

test('pushMarkPrices and pushFundingEvent are no-ops that touch nothing on the client', async () => {
  const { client, calls } = fakeClient();
  const api = makeApi(client);
  await api.pushMarkPrices({ BTCUSDT: 50_000 });
  await api.pushFundingEvent('BTCUSDT', 0.0001, 50_000, Date.now());
  assert.deepEqual(calls, { createOrder: 0, updateLeverage: 0, getPositions: 0, getWallet: 0, listOrders: 0 });
});

test('a generic Error from getPositions surfaces as VenueUnavailableError', async () => {
  const { client } = fakeClient({ getPositions: async () => { throw new Error('boom'); } });
  const api = makeApi(client);
  await assert.rejects(() => api.getPositions(), VenueUnavailableError);
});

test('a generic Error from createOrder surfaces from submitOrder as VenueUnavailableError', async () => {
  const { client } = fakeClient({ createOrder: async () => { throw new Error('boom'); } });
  const api = makeApi(client);
  await assert.rejects(() => api.submitOrder(orderParams()), VenueUnavailableError);
});

test('getAccount does not permanently seed the baseline from a non-positive first observation; it seeds on a later positive one', async () => {
  const baselinePath = tmpBaselinePath();
  let wallet: WalletRow[] = [{ currency: 'INR', balance: 500, locked_balance: 0, available_balance: 500 }]; // no USDT rows -> equity 0
  const { client } = fakeClient({ wallet: () => wallet });
  const api = new CoinDcxExchangeApi({ client, quotePreference: 'auto', baselinePath, accountId: 'acct1' });

  const first = await api.getAccount();
  assert.equal(first?.margin, 0);
  assert.ok(!existsSync(baselinePath), 'a zero observation must not create the baseline file');

  wallet = [{ currency: 'USDT', balance: 2000, locked_balance: 0, available_balance: 2000 }];
  const second = await api.getAccount();
  assert.equal(second?.margin, 2000, 'the baseline seeds from the first positive observation');
  assert.ok(existsSync(baselinePath));
  const saved = JSON.parse(readFileSync(baselinePath, 'utf8')) as { initialEquity: number };
  assert.equal(saved.initialEquity, 2000);
});

test('warmSymbols resolves symbols up front so a fresh getPositions() (no prior submitOrder) can map them', async () => {
  const { client } = fakeClient({
    markets: [{ pair: 'B-BTC_USDT', status: 'active' }],
    positions: [{ id: 1, pair: 'B-BTC_USDT', side: 'long', size: 0.5, entry_price: 50_000, mark_price: 51_000, leverage: 5, margin_type: 'isolated' }],
  });
  const api = makeApi(client);
  await api.warmSymbols(['BTCUSDT']);
  const positions = await api.getPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].symbol, 'BTCUSDT');
});

test('warmSymbols swallows an unresolvable symbol instead of throwing', async () => {
  const { client } = fakeClient({ markets: [] });
  const api = makeApi(client);
  await api.warmSymbols(['NOPEUSDT']);
});

test('submitOrder above maxOrderNotional (INR-routed): the cap is checked against the pre-FX USDT notional', async () => {
  const { client, calls } = fakeClient({
    markets: [{ pair: 'B-XYZ_INR', status: 'active' }],
    ticker: [{ pair: 'USDTINR', last_price: '87' }],
    instruments: { 'B-XYZ_INR': { lot_size: 0.1, min_quantity: 0.1, min_price: 1, max_leverage: 20 } },
  });
  const api = makeApi(client, { maxOrderNotional: 1500 });
  // quantity(1) * executionPrice(2000 USDT, pre-FX) = 2000 > 1500 -> must reject even though the FX-converted
  // INR price alone is a different number; a cap checked post-conversion or against the wrong operand could
  // wrongly let this through or wrongly reject a within-budget order.
  await assert.rejects(
    () => api.submitOrder(orderParams({ symbol: 'XYZUSDT', quantity: 1, executionPrice: 2000 })),
    OrderRejectedError,
  );
  assert.equal(calls.createOrder, 0);
});
