# CoinDCX live execution, Binance for market data only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `MODE=live` routes ALL execution (account, positions, leverage, orders, closes) through CoinDCX futures via `@nemesis-oss/coindcx-sdk`, while Binance stays the sole market-data source in every mode; paper trading (`PaperEngine` and `paper_exchange`) is untouched.

**Architecture:** Reuse `RemoteBroker` (already exchange-agnostic: it only talks to the `ExchangeApi` interface) unchanged except generalizing its hardcoded `'paper_exchange'` venue name to a constructor-supplied string. Write one new adapter, `CoinDcxExchangeApi implements ExchangeApi`, that translates CoinDCX's REST surface into the same shape `PaperExchangeClient` already produces. `BinanceService` already checks `if (this.broker) return this.broker.X(...)` first in every execution method — wiring live mode is one factory function change plus one bugfix (`cancelAll` must also skip when a broker is set).

**Tech Stack:** TypeScript ESM, `node:test`, `@nemesis-oss/coindcx-sdk` (new `file:` dependency), no other new packages.

**Spec:** `docs/superpowers/specs/2026-09-22-coindcx-live-execution-design.md`

## Global Constraints
- Functions ≤ 30 lines, files ≤ 300 lines, nesting ≤ 3, params ≤ 4, why-only comments, no `any` in new code.
- Never read `.env` values or print secrets (`COINDCX_API_KEY`/`COINDCX_API_SECRET`). Never contact the real CoinDCX API, Binance, or the paper_exchange from a test. Never touch `data/*.json` from a test (use temp dirs, same pattern as `tests/remoteBroker.*.test.ts`).
- `MODE=live` without `COINDCX_API_KEY`/`COINDCX_API_SECRET` refuses to start (fail-closed) — no silent fallback to the existing raw-Binance live order path, which stays in `client.ts` but must remain provably unreachable once a broker is set.
- Every task's tests run against a FAKE `CoinDCXClient`-shaped object or the SDK's own `paperMode` (which needs no network) — never the real REST client.
- No git commit/add/stash. No new files beyond what each task lists. No subagents dispatched by implementers.

---

### Task 1: Dependency and config

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/config.ts`
- Test: `tests/config.coindcx.test.ts`

**Interfaces:**
- Produces: `config.coindcx: { apiKey: string; apiSecret: string; paperMode: boolean; quotePreference: 'auto' | 'USDT' | 'INR'; maxOrderNotional?: number; maxOrderQuantity?: number; initialBalance: number } | null` — `null` only when `MODE !== 'live'` (paper mode never needs it; the fail-closed check below guarantees it is non-null whenever `MODE === 'live'`).

- [ ] **Step 1: Add the dependency**

In `package.json` `dependencies`, add (alphabetical with the existing entries):
```json
"@nemesis-oss/coindcx-sdk": "file:/home/nemesis/projects/sdks-and-clients/coindcx/coindcx-sdk",
```
Run `npm install` and confirm `node_modules/@nemesis-oss/coindcx-sdk` resolves (a symlink). Do not commit `package-lock.json` changes without the user's later approval — leave the working tree as `npm install` produces it.

- [ ] **Step 2: Write the failing config test**

```ts
// tests/config.coindcx.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Each case re-imports config.ts fresh under mutated env, mirroring tests/config.test.ts's existing pattern.
async function loadConfig(env: Record<string, string>) {
  const prior = { ...process.env };
  Object.assign(process.env, { MODE: 'paper', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's', ...env });
  try {
    return await import(`../src/config.js?t=${Date.now()}-${Math.random()}`);
  } finally {
    process.env = prior;
  }
}

test('MODE=live without CoinDCX credentials refuses to start', async () => {
  await assert.rejects(
    () => loadConfig({ MODE: 'live' }),
    /LIVE mode requires COINDCX_API_KEY and COINDCX_API_SECRET/
  );
});

test('MODE=live with CoinDCX credentials builds config.coindcx', async () => {
  const { config } = await loadConfig({ MODE: 'live', COINDCX_API_KEY: 'a', COINDCX_API_SECRET: 'b' });
  assert.equal(config.coindcx?.apiKey, 'a');
  assert.equal(config.coindcx?.paperMode, true); // default 'on'
  assert.equal(config.coindcx?.quotePreference, 'auto');
  assert.equal(config.coindcx?.initialBalance, 1_150);
});

test('MODE=paper never requires CoinDCX credentials, config.coindcx is null', async () => {
  const { config } = await loadConfig({});
  assert.equal(config.coindcx, null);
});

test('COINDCX_PAPER_MODE=off is honored', async () => {
  const { config } = await loadConfig({ MODE: 'live', COINDCX_API_KEY: 'a', COINDCX_API_SECRET: 'b', COINDCX_PAPER_MODE: 'off' });
  assert.equal(config.coindcx?.paperMode, false);
});
```

Check the existing `tests/config.test.ts` first for the actual re-import pattern used there (dynamic import with a cache-busting query string, or a helper) and match it exactly — do not invent a second pattern.

Run: `npx tsx --test tests/config.coindcx.test.ts` — expect FAIL (`config.coindcx` is undefined, no such env vars).

- [ ] **Step 3: Extend `EnvSchema`**

In `src/config.ts`, add to `EnvSchema` (after `PAPER_EXCHANGE_ACCOUNT_ID`):
```ts
  COINDCX_API_KEY: z.string().default(''),
  COINDCX_API_SECRET: z.string().default(''),
  // Routes through the SDK's own paper engine (no real orders) until explicitly turned off.
  COINDCX_PAPER_MODE: z.enum(['off', 'on']).default('on'),
  COINDCX_QUOTE_PREFERENCE: z.enum(['auto', 'USDT', 'INR']).default('auto'),
  COINDCX_MAX_ORDER_NOTIONAL: z.coerce.number().positive().optional(),
  COINDCX_MAX_ORDER_QUANTITY: z.coerce.number().positive().optional(),
  // Same realistic bankroll as the two paper venues (see src/binance/paperEngine.ts).
  COINDCX_INITIAL_BALANCE: z.coerce.number().positive().default(1_150),
```

- [ ] **Step 4: Build `config.coindcx` and the fail-closed check**

Replace the existing bottom block:
```ts
if (config.mode === 'live' && (!config.binance.apiKey || !config.binance.apiSecret)) {
  throw new Error('LIVE mode requires BINANCE_API_KEY and BINANCE_API_SECRET');
}
```
with (add `coindcx` to the `config` object literal above this block, then keep both checks below it):
```ts
// inside the `config` object literal, alongside `paperExchange`:
  coindcx: env.MODE === 'live' ? {
    apiKey: env.COINDCX_API_KEY,
    apiSecret: env.COINDCX_API_SECRET,
    paperMode: env.COINDCX_PAPER_MODE === 'on',
    quotePreference: env.COINDCX_QUOTE_PREFERENCE,
    maxOrderNotional: env.COINDCX_MAX_ORDER_NOTIONAL,
    maxOrderQuantity: env.COINDCX_MAX_ORDER_QUANTITY,
    initialBalance: env.COINDCX_INITIAL_BALANCE,
  } : null,
```
```ts
if (config.mode === 'live' && (!config.binance.apiKey || !config.binance.apiSecret)) {
  throw new Error('LIVE mode requires BINANCE_API_KEY and BINANCE_API_SECRET');
}
// CoinDCX is the only live execution path (see the 2026-09-22 design doc) — no silent fallback to raw Binance orders.
if (config.mode === 'live' && (!config.coindcx?.apiKey || !config.coindcx.apiSecret)) {
  throw new Error('LIVE mode requires COINDCX_API_KEY and COINDCX_API_SECRET');
}
```

- [ ] **Step 5: Run the test, confirm GREEN.** `npx tsc --noEmit` must stay silent.

- [ ] **Step 6: Commit** (only if the user has approved commits for this session — otherwise leave staged/unstaged per the controller's instructions).

---

### Task 2: `src/coindcx/symbolRouter.ts`

**Files:**
- Create: `src/coindcx/symbolRouter.ts`
- Test: `tests/coindcxSymbolRouter.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure + a minimal client shape it defines itself).
- Produces:
  ```ts
  export const futuresPair = (base: string, quote: 'USDT' | 'INR'): string => `B-${base.toUpperCase()}_${quote}`;
  export const baseAssetOfSymbol = (symbol: string): string; // 'BTCUSDT' -> 'BTC', 'ETHUSDT' -> 'ETH'
  export interface ResolvedPair { readonly symbol: string; readonly base: string; readonly pair: string; readonly quote: 'USDT' | 'INR'; readonly fxRate: number }
  export interface MarketsClient {
    futures: { market: { getMarketsDetails(): Promise<{ pair: string; status?: string }[]> } };
    marketData: { getSpotTicker(): Promise<{ pair?: string; last_price?: string | number }[]> };
  }
  export class SymbolRouter {
    constructor(client: MarketsClient, quotePreference: 'auto' | 'USDT' | 'INR');
    resolve(symbol: string): Promise<ResolvedPair>;
    pairToSymbol(pair: string): string | undefined; // reverse lookup for getPositions/findOrder mapping
  }
  ```
  `MarketsClient` is a minimal structural subset of the real `CoinDCXClient` — Task 4 passes the real client, tests pass a fake object literal (no SDK import needed in this task's test).

- [ ] **Step 1: Write the failing test**

```ts
// tests/coindcxSymbolRouter.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseAssetOfSymbol, futuresPair, SymbolRouter, type MarketsClient } from '../src/coindcx/symbolRouter.js';

function fakeClient(pairs: string[], usdtInr = 87): MarketsClient {
  return {
    futures: { market: { async getMarketsDetails() { return pairs.map((pair) => ({ pair, status: 'active' })); } } },
    marketData: { async getSpotTicker() { return [{ pair: 'USDTINR', last_price: String(usdtInr) }]; } },
  };
}

test('futuresPair formats the CoinDCX convention', () => {
  assert.equal(futuresPair('BTC', 'USDT'), 'B-BTC_USDT');
  assert.equal(futuresPair('sol', 'INR'), 'B-SOL_INR');
});

test('baseAssetOfSymbol strips the quote suffix', () => {
  assert.equal(baseAssetOfSymbol('BTCUSDT'), 'BTC');
  assert.equal(baseAssetOfSymbol('ETHUSDT'), 'ETH');
});

test('prefers USDT when listed', async () => {
  const router = new SymbolRouter(fakeClient(['B-BTC_USDT', 'B-BTC_INR']), 'auto');
  const resolved = await router.resolve('BTCUSDT');
  assert.deepEqual(resolved, { symbol: 'BTCUSDT', base: 'BTC', pair: 'B-BTC_USDT', quote: 'USDT', fxRate: 1 });
});

test('falls back to INR with a live FX rate when USDT is not listed', async () => {
  const router = new SymbolRouter(fakeClient(['B-SOL_INR']), 'auto');
  const resolved = await router.resolve('SOLUSDT');
  assert.deepEqual(resolved, { symbol: 'SOLUSDT', base: 'SOL', pair: 'B-SOL_INR', quote: 'INR', fxRate: 87 });
});

test('COINDCX_QUOTE_PREFERENCE=INR forces INR even when USDT is listed', async () => {
  const router = new SymbolRouter(fakeClient(['B-BTC_USDT', 'B-BTC_INR']), 'INR');
  const resolved = await router.resolve('BTCUSDT');
  assert.equal(resolved.quote, 'INR');
});

test('throws when neither quote is listed', async () => {
  await assert.rejects(() => new SymbolRouter(fakeClient([]), 'auto').resolve('XRPUSDT'), /no CoinDCX futures market for XRPUSDT/);
});

test('pairToSymbol reverses a resolved pair', async () => {
  const router = new SymbolRouter(fakeClient(['B-BTC_USDT']), 'auto');
  await router.resolve('BTCUSDT'); // populates the instrument cache
  assert.equal(router.pairToSymbol('B-BTC_USDT'), 'BTCUSDT');
  assert.equal(router.pairToSymbol('B-UNKNOWN_USDT'), undefined);
});

test('an unusable FX rate throws instead of pricing at a guess', async () => {
  const router = new SymbolRouter(fakeClient(['B-SOL_INR'], NaN), 'auto');
  await assert.rejects(() => router.resolve('SOLUSDT'), /USDTINR rate unavailable/);
});
```

Run: expect FAIL (`Cannot find module '../src/coindcx/symbolRouter.js'`).

- [ ] **Step 2: Implement**

Port `crypto-agent`'s `src/infrastructure/coindcx/pair-mapper.ts` and `symbol-router.ts` (read-only reference), adapted: our `baseAssetOfSymbol` only needs the `USDT` suffix (our `config.symbols` are always `*USDT`, unlike crypto-agent's multi-quote Binance symbols) but keep `BUSD`/`USDC` stripping for robustness; add `pairToSymbol` (not in the reference) as a `Map` populated during `resolve`/`instruments()`; keep the 5-minute instrument cache and the FX freshness policy (fresh < 30 s, stale-usable < 120 s, else throw) from the reference's `FxRateCache` — reimplement inline (≤ 30 lines) rather than porting `domain/portfolio/valuation.ts`'s `FxRateCache` class, since only the freshness policy is needed here, not its full API.

- [ ] **Step 3: Run tests, confirm GREEN. `npx tsc --noEmit` silent. `wc -l src/coindcx/symbolRouter.ts` ≤ 300.**

- [ ] **Step 4: Commit** (if approved).

---

### Task 3: `src/coindcx/contractSpec.ts`

**Files:**
- Create: `src/coindcx/contractSpec.ts`
- Test: `tests/coindcxContractSpec.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 directly (takes a resolved `pair` string, not a `ResolvedPair`, to stay decoupled).
- Produces:
  ```ts
  export interface CoinDcxContractSpec { lotSize: number; minQty: number; minNotional: number; maxLeverage: number }
  export interface InstrumentClient { futures: { market: { getInstrumentDetails(pair: string): Promise<{ lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }> } } }
  export class ContractSpecCache {
    constructor(client: InstrumentClient);
    get(pair: string): Promise<CoinDcxContractSpec>;
  }
  export function floorToLot(qty: number, lotSize: number): number;
  export function roundToTick(price: number, tickSize: number): number;
  ```
  `minNotional` is not directly in `InstrumentResponse` (no such field) — derive it as `minQty * (min_price ?? 0)`, or `0` when `min_price` is absent (CoinDCX instruments do not universally enforce a notional floor the way Binance does; treat an absent floor as `0`, never as `undefined`/`NaN`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/coindcxContractSpec.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractSpecCache, floorToLot, roundToTick, type InstrumentClient } from '../src/coindcx/contractSpec.js';

test('floorToLot rounds down to the step, never up', () => {
  assert.equal(floorToLot(0.1234, 0.001), 0.123);
  assert.equal(floorToLot(1, 0.001), 1); // already aligned
});

test('roundToTick rounds to the nearest tick', () => {
  assert.equal(roundToTick(100.037, 0.01), 100.04);
});

function fakeClient(details: Record<string, { lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }>): InstrumentClient {
  return { futures: { market: { async getInstrumentDetails(pair: string) { return details[pair] ?? {}; } } } };
}

test('maps instrument details into a contract spec, deriving minNotional', async () => {
  const cache = new ContractSpecCache(fakeClient({ 'B-BTC_USDT': { lot_size: 0.001, min_quantity: 0.001, min_price: 10_000, max_leverage: 20 } }));
  assert.deepEqual(await cache.get('B-BTC_USDT'), { lotSize: 0.001, minQty: 0.001, minNotional: 10, maxLeverage: 20 });
});

test('missing fields default safely (never NaN/undefined leaking through)', async () => {
  const cache = new ContractSpecCache(fakeClient({ 'B-XYZ_USDT': {} }));
  assert.deepEqual(await cache.get('B-XYZ_USDT'), { lotSize: 0, minQty: 0, minNotional: 0, maxLeverage: 0 });
});

test('caches per pair — a second get() does not refetch', async () => {
  let calls = 0;
  const client: InstrumentClient = { futures: { market: { async getInstrumentDetails() { calls++; return { lot_size: 1 }; } } } };
  const cache = new ContractSpecCache(client);
  await cache.get('B-BTC_USDT');
  await cache.get('B-BTC_USDT');
  assert.equal(calls, 1);
});
```

Run: expect FAIL.

- [ ] **Step 2: Implement**

```ts
// src/coindcx/contractSpec.ts
export interface CoinDcxContractSpec { lotSize: number; minQty: number; minNotional: number; maxLeverage: number }

export interface InstrumentClient {
  futures: { market: { getInstrumentDetails(pair: string): Promise<InstrumentDetails> } };
}

interface InstrumentDetails { lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }

const num = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function toSpec(details: InstrumentDetails): CoinDcxContractSpec {
  const minQty = num(details.min_quantity);
  return { lotSize: num(details.lot_size), minQty, minNotional: minQty * num(details.min_price), maxLeverage: num(details.max_leverage) };
}

/** Per-pair instrument metadata cache; used only for execution-time rounding — risk/ATR reasoning keeps reading Binance data. */
export class ContractSpecCache {
  private readonly cache = new Map<string, CoinDcxContractSpec>();
  constructor(private readonly client: InstrumentClient) {}

  async get(pair: string): Promise<CoinDcxContractSpec> {
    const cached = this.cache.get(pair);
    if (cached) return cached;
    const spec = toSpec(await this.client.futures.market.getInstrumentDetails(pair));
    this.cache.set(pair, spec);
    return spec;
  }
}

export function floorToLot(qty: number, lotSize: number): number {
  if (lotSize <= 0) return qty;
  return Math.floor(qty / lotSize) * lotSize;
}

export function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
  return Math.round(price / tickSize) * tickSize;
}
```
(Floating-point step math here mirrors `src/binance/symbolRules.ts`'s existing `roundQty`/`roundPrice` style — check that file for its `STEP_EPSILON` handling and match it if plain division/floor proves flaky in the test; the fixtures above use exact multiples so this should not be needed, but the implementer's own tests must pass with whatever approach is used.)

- [ ] **Step 3: Run tests, confirm GREEN. `npx tsc --noEmit` silent.**

- [ ] **Step 4: Commit** (if approved).

---

### Task 4: `src/coindcx/coindcxClient.ts` — the `ExchangeApi` adapter

This is the core translation layer. Read `src/binance/paperExchangeClient.ts` in full first (the `ExchangeApi` interface and all its types this task must satisfy) and `src/binance/remoteBroker.ts` (how `RemoteBroker` calls each method — `init`, `sync`/`refreshOnce`, `open`/`enter`, `close`/exits, `markAll`/`pushMarks`) so the adapter's semantics line up with what the caller expects.

**Files:**
- Create: `src/coindcx/coindcxClient.ts`
- Test: `tests/coindcxClient.test.ts`

**Interfaces:**
- Consumes: `SymbolRouter` (Task 2), `ContractSpecCache` (Task 3), the `ExchangeApi`/`PaperExchangeAccountSnapshot`/`PaperExchangePosition`/`SubmitOrderParams`/`SubmitOrderResult`/`ExchangeRiskEvent`/`VenueUnavailableError`/`OrderRejectedError` types from `src/binance/paperExchangeClient.ts` (import, do not redefine).
- Produces:
  ```ts
  export interface CoinDcxOrderClient {
    futures: {
      trading: {
        createOrder(req: {
          side: 'buy' | 'sell'; order_type: 'market_order'; base_currency: string; quote_currency: string;
          target_quantity: number; price: number | undefined; leverage: number | undefined;
          client_order_id: string | undefined; time_in_force: 'ioc'; margin_type: 'isolated' | 'cross' | undefined;
        }): Promise<{ id: string | number; client_order_id: string | undefined; status: string; filled_quantity: number | undefined; price: number | undefined }>;
        listOrders(params: { pair?: string; status?: string; limit?: number }): Promise<{ id: string | number; client_order_id: string | undefined; status: string; filled_quantity: number | undefined; price: number | undefined }[]>;
      };
      account: {
        updateLeverage(params: { pair: string; leverage: number }): Promise<unknown>;
        getPositions(params: { pair?: string; status?: string }): Promise<{ id: string | number; pair: string; side: 'long' | 'short'; size: number; entry_price: number; mark_price?: number; liquidation_price?: number | null; leverage?: number; margin_type?: 'isolated' | 'cross' }[]>;
        getWallet(): Promise<{ currency: string; balance: number; locked_balance: number; available_balance: number }[]>;
        setSafetyLimits?(limits: { maxOrderQuantity?: number; maxOrderNotional?: number }): void;
      };
      market: { getMarketsDetails(): Promise<{ pair: string; status?: string }[]>; getInstrumentDetails(pair: string): Promise<{ lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }> };
    };
    marketData: { getSpotTicker(): Promise<{ pair?: string; last_price?: string | number }[]> };
  }
  export interface CoinDcxExchangeApiDeps {
    client: CoinDcxOrderClient;
    quotePreference: 'auto' | 'USDT' | 'INR';
    baselinePath: string; // e.g. 'data/coindcx-baseline.json'
    accountId: string;    // a local label only — CoinDCX has one real account per API key, not multiple
    maxOrderNotional?: number;
    maxOrderQuantity?: number;
  }
  export class CoinDcxExchangeApi implements ExchangeApi { constructor(deps: CoinDcxExchangeApiDeps); /* ...ExchangeApi methods */ }
  ```
  This interface is deliberately a hand-picked structural subset of the real SDK's `CoinDCXClient` (verified field-for-field against `@nemesis-oss/coindcx-sdk`'s `src/rest/futures.ts` and `src/models/index.ts` `CreateFuturesOrderRequest`/`FuturesOrderResponse`/`PositionResponse`/`FuturesWalletResponse`/`InstrumentResponse`) — a real `CoinDCXClient` instance satisfies it structurally with no adapter-of-an-adapter needed; Task 5 passes the real client straight through.

**Design points (binding, from the spec doc):**
1. **`getAccount()`**: never returns `null` (a valid API key always has an account). Wallet totals come from `getWallet()`, summed across all currencies whose `currency === 'USDT'` (ignore other currencies — INR-margined balances settle back to the same USDT-denominated wallet on CoinDCX futures; confirm this against `getWallet()`'s actual shape in Task 4's own manual check against the SDK, and if a `currency: 'INR'` entry with nonzero balance appears in practice, note it in the report as a residual risk rather than guessing a conversion here). `initialEquity` is read from a tiny local JSON baseline file (`{ accountId, initialEquity }`) at `deps.baselinePath`: if the file is missing, seed it with the first observed wallet total and persist it (mirrors `RemoteStore`'s atomic write pattern: write to `.tmp`, then rename); every later `getAccount()` reads the persisted value. `margin` in the returned `PaperExchangeAccountSnapshot` is set to that `initialEquity` (matches `RemoteBroker.getAccount()`'s `initialEquity: this.account.margin` read). `unrealizedPnl`/`realizedPnl`/`positionsCount` can be `0`/`0`/computed from a fresh `getPositions()` call — they are not read by `RemoteBroker` today (only `margin`, `availableBalance`, `lockedMargin` are), so keep them cheap and correct-enough rather than exact.
2. **`createAccount()`**: throws (`Error('CoinDCX accounts are not created via the API — configure COINDCX_API_KEY for an existing account')`); `RemoteBroker.init()` only calls this when `getAccount()` returned `null`, which never happens here.
3. **`getPositions()`**: `client.futures.account.getPositions({ status: 'open' })`, filter `size > 0`, map each `pair` back to a Binance symbol via `SymbolRouter.pairToSymbol` (skip/warn-log positions on pairs the router has never resolved — i.e., instruments outside `config.symbols`; do not throw). Map fields: `netQuantity: size`, `averagePrice: entry_price`, `currentPrice: mark_price ?? entry_price`, `leverage: leverage ?? 1`, `marginType: margin_type === 'cross' ? 'cross' : 'isolated'`, `liquidationPrice: liquidation_price ?? null`, `unrealizedPnl: 0` (recomputed locally by `RemoteBroker`/`toPosition` from live marks, same as `paper_exchange`'s path — this field is not read either, but keep it typed correctly).
4. **`submitOrder(params)`**: resolve `params.symbol` via `SymbolRouter.resolve`; call `updateLeverage({ pair, leverage: params.leverage })` first (every entry order — cheap, avoids a stale-leverage rejection; wrap in try/catch and ignore a failure here only if `params.reduceOnly` is true, since a reduce-only close must never be blocked by a leverage-set failure — log via a thrown-and-caught pattern that still lets the order attempt proceed); round `params.quantity` down to `ContractSpecCache.get(pair).lotSize` via `floorToLot`; if the resolved quote is `INR`, convert `params.executionPrice` via `resolved.fxRate` before sending `price` (still send `order_type: 'market_order'`, `time_in_force: 'ioc'` — `price` on a market order is advisory context only per the reference broker, not a limit); enforce `deps.maxOrderNotional`/`maxOrderQuantity` (if configured) by throwing an `OrderRejectedError` BEFORE calling `createOrder` when the rounded quantity or `quantity * executionPrice` exceeds the configured cap (client-side hard stop, never reaches the network) — do not rely on the SDK's own `setSafetyLimits` for this (it is optional/best-effort in the fake; enforce directly). Call `createOrder`, map the response status verbatim (CoinDCX's raw string — `'filled'`, `'open'`, etc. — passed straight through as `SubmitOrderResult.status`, no enum translation), `filledQuantity` from `filled_quantity` when present and `> 0` else omitted (same optionality as `paperExchangeClient.ts`'s `toOrderResult`).
5. **`findOrder(clientOrderId)`**: `listOrders({ limit: 100 })` then `listOrders({ status: 'open', limit: 100 })`, first match on `client_order_id`, same two-pass pattern as the reference broker's `lookupOrder` — but return `null` (not a `LOOKUP_FAILED` variant; our `ExchangeApi.findOrder` returns `SubmitOrderResult | null`) and let a network failure surface as `VenueUnavailableError` from the shared `request`-style wrapper (Step 2 below) rather than swallowing it — `sendOrder` in `remoteOrders.ts` already only calls `findOrder` after catching a `VenueUnavailableError`, so a further failure here should propagate, not hide.
6. **`getRiskEvents()`**: returns `[]` always. **Known, documented limitation**: a position that vanishes from CoinDCX (e.g., a real liquidation) will be journaled as a generic `CLOSE` at the last known mark rather than `LIQUIDATED`, because `RemoteReconciler` only labels a vanished position `LIQUIDATED` when `getRiskEvents()` returns a matching `POSITION_LIQUIDATED` event. State this in the task report; do not attempt to synthesize a fake event.
7. **`pushMarkPrices()` / `pushFundingEvent()`**: both no-ops (`async () => {}`) — CoinDCX is a real exchange with its own live prices and its own liquidation/funding engine; these calls exist only for `paper_exchange`, which has neither.
8. All network-shaped errors (anything the fake client's method rejects with, or a real fetch failure once wired to the true SDK) must be wrapped as `VenueUnavailableError` before reaching `RemoteBroker`, exactly like `paperExchangeClient.ts`'s `send()` does — write a small private `guarded<T>(fn: () => Promise<T>): Promise<T>` helper (≤ 15 lines) that every public method routes through, catching and rethrowing as `VenueUnavailableError` unless the error is already one of `VenueUnavailableError`/`OrderRejectedError` (a client-side reject from Design point 4's caps check throws `OrderRejectedError` directly and must pass through unwrapped).

- [ ] **Step 1: Write the failing tests**

Cover, with a fully in-memory fake `CoinDcxOrderClient` (no network, deterministic):
- `getAccount()` seeds and persists the baseline on first call (assert the temp `baselinePath` file now exists and holds the seeded value), returns the same `initialEquity` on a second instance pointed at the same file.
- `createAccount()` throws.
- `getPositions()` maps a CoinDCX position to `PaperExchangePosition`, reverse-mapping the pair to the Binance symbol; a position on an unresolvable pair is skipped, not thrown.
- `submitOrder()` for a USDT pair: leverage is set before the order, quantity is floored to the lot size, status passes through verbatim (`'filled'` → `status: 'filled'`).
- `submitOrder()` for an INR-routed symbol: the sent price is FX-converted (assert the fake `createOrder`'s received `price` equals `executionPrice * fxRate`).
- `submitOrder()` above `maxOrderNotional`: throws `OrderRejectedError` and the fake `createOrder` was never called (assert a call counter is `0`).
- `submitOrder()` reduce-only: a leverage-set failure does not block the order (fake `updateLeverage` rejects; the order still calls `createOrder`); a leverage-set failure on a non-reduce-only order surfaces (does block).
- `findOrder()` finds a match in the open-orders pass when the recent pass misses it; returns `null` when neither pass has it.
- `getRiskEvents()` returns `[]`.
- `pushMarkPrices()`/`pushFundingEvent()` resolve without calling anything on the fake client (assert no method on the fake was invoked).
- A fake client method that rejects with a generic `Error` surfaces from `getPositions()`/`submitOrder()` as a `VenueUnavailableError` (assert `instanceof`).

Run: expect FAIL (module does not exist).

- [ ] **Step 2: Implement** per the eight design points above. Keep the file ≤ 300 lines — if the eight `ExchangeApi` methods plus the `guarded` helper and the baseline-file read/write push it over, split the baseline persistence into a small private class in the same file (still one file) rather than a new file not listed in this task.

- [ ] **Step 3: Run tests, confirm GREEN. `npx tsc --noEmit` silent. Function-length audit (every function ≤ 30 lines).**

- [ ] **Step 4: Commit** (if approved).

---

### Task 5: Wiring — generalize `RemoteBroker`'s venue name, add the live factory, fix `cancelAll`

**Files:**
- Modify: `src/binance/remoteBroker.ts` (2-line generalization)
- Modify: `src/binance/client.ts`
- Test: `tests/binanceService.coindcx.test.ts`
- Additive test: extend `tests/remoteBroker.*.test.ts` call sites only if they construct `RemoteBrokerDeps` directly (grep first; add the new required field to every literal).

**Interfaces:**
- Consumes: `CoinDcxExchangeApi` (Task 4), `SymbolRouter`/`ContractSpecCache` (Tasks 2–3, constructed inside `CoinDcxExchangeApi` itself per Task 4 — `client.ts` only constructs the top-level `CoinDcxExchangeApi`).
- Produces: `BinanceService`'s live-mode broker wiring; no public API change (the constructor seam `broker: RemoteBroker | null` is unchanged in shape).

- [ ] **Step 1: Generalize the hardcoded venue name**

In `src/binance/remoteBroker.ts`:
```ts
export interface VenueStatus {
  name: string; // was the literal 'paper_exchange'
  accountId: string;
  state: VenueState;
  lastError: string | null;
  lastSyncAt: number;
}

export interface RemoteBrokerDeps {
  api: ExchangeApi;
  store: RemoteStore;
  accountId: string;
  symbols: string[];
  initialMargin: number;
  venueName: string; // new, required — 'paper_exchange' or 'CoinDCX'
  now?: () => number;
}
```
And in `status()`:
```ts
  status(): VenueStatus {
    const state: VenueState = this.consecutiveFailures === 0 ? 'connected' : this.consecutiveFailures < DOWN_AFTER_FAILURES ? 'degraded' : 'down';
    return { name: this.deps.venueName, accountId: this.deps.accountId, state, lastError: this.lastError, lastSyncAt: this.lastSyncAt };
  }
```
`src/runtime/telemetry.ts`'s `venueInfo` already renders `${status.name} (${status.accountId})` generically — confirm no change needed there (it takes `VenueStatus | null` and `status.name` was already read as a plain string at the call site, so widening the type from a literal to `string` is source-compatible).

- [ ] **Step 2: Find and update every `RemoteBrokerDeps` literal**

`grep -rn "new RemoteBroker(" src tests` and add `venueName: 'paper_exchange'` to every existing paper_exchange construction site (production `client.ts` and any test that builds one directly). This must not change `RemoteBroker`'s observable behavior for paper_exchange — golden/regression check in Task 7 confirms this.

- [ ] **Step 3: Write the failing wiring test**

```ts
// tests/binanceService.coindcx.test.ts
// Constructs BinanceService with an injected broker the way tests/binanceService.remote.test.ts already does,
// asserting: (a) a RemoteBroker wrapping a CoinDcxExchangeApi-shaped fake reports venue name 'CoinDCX' through
// getVenueStatus(); (b) BinanceService.cancelAll() in MODE=live with a broker set never calls the raw
// futures.cancelAllOpenOrders (inject a fake USDMClient-shaped object whose method throws if called).
```
Read `tests/binanceService.remote.test.ts` first and mirror its injection pattern exactly (same constructor seam) rather than inventing a new one.

- [ ] **Step 4: Fix `cancelAll`**

In `src/binance/client.ts`:
```ts
  async cancelAll(symbol: string): Promise<void> {
    // Paper fills are instant and a broker (paper_exchange or CoinDCX) tracks its own exits — never reaches raw Binance here.
    if (config.mode === 'paper' || this.broker) return;
    await this.futures.cancelAllOpenOrders({ symbol });
  }
```

- [ ] **Step 5: Add the live factory and select it in the constructor**

Rename `remoteBrokerFromConfig` to `brokerFromConfig` and branch on mode; add a private `coinDcxBrokerFromConfig`:
```ts
import { CoinDcxExchangeApi } from '../coindcx/coindcxClient.js';

const COINDCX_STATE_FILE = 'data/coindcx-state.json';
const COINDCX_BASELINE_FILE = 'data/coindcx-baseline.json';

function coinDcxBrokerFromConfig(): RemoteBroker | null {
  const cx = config.coindcx;
  if (config.mode !== 'live' || !cx) return null;
  const api = new CoinDcxExchangeApi({
    client: new CoinDCXClient({ apiKey: cx.apiKey, apiSecret: cx.apiSecret, paperMode: cx.paperMode }),
    quotePreference: cx.quotePreference,
    baselinePath: COINDCX_BASELINE_FILE,
    accountId: 'coindcx',
    maxOrderNotional: cx.maxOrderNotional,
    maxOrderQuantity: cx.maxOrderQuantity,
  });
  return new RemoteBroker({
    api, store: new RemoteStore(COINDCX_STATE_FILE, 'coindcx'), accountId: 'coindcx',
    symbols: config.symbols, initialMargin: cx.initialBalance, venueName: 'CoinDCX',
  });
}

function brokerFromConfig(): RemoteBroker | null {
  return remoteBrokerFromConfig() ?? coinDcxBrokerFromConfig();
}
```
(Keep `remoteBrokerFromConfig` as its own named function — both already mode-gated so they are mutually exclusive — and change the constructor default from `remoteBrokerFromConfig()` to `brokerFromConfig()`.) Import `CoinDCXClient` from `@nemesis-oss/coindcx-sdk`. Confirm the exact constructor-options field names (`apiKey`/`apiSecret`/`paperMode`) against the SDK's `CoinDCXSDKOptions` type in `node_modules/@nemesis-oss/coindcx-sdk` before finalizing — Task 1 already added the dependency so it is resolvable.

Update the stale comment on `updateStops` ("Paper only: live keeps exchange-side protection orders...") — it is now wrong for CoinDCX live (which goes through `this.broker` and DOES support dynamic stops, same as paper_exchange); replace with: `// Live-Binance-direct only lacks this: paper_exchange and CoinDCX both route through this.broker above.`

- [ ] **Step 6: Run tests, confirm GREEN. `npx tsc --noEmit` silent. `wc -l src/binance/client.ts` ≤ 300 (it was 295 before this task; this adds ~15 lines — if it crosses 300, extract `coinDcxBrokerFromConfig` into a new `src/coindcx/brokerFactory.ts` instead of trimming unrelated code).**

- [ ] **Step 7: Full regression** — `npm test` (baseline count from before this task; must still all pass, including every `remoteBroker.*.test.ts` and `paperExchangeClient.test.ts` file, proving the `venueName` generalization changed nothing observable for paper_exchange).

- [ ] **Step 8: Commit** (if approved).

---

### Task 6: Docs and `.env.example`

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1:** Add a "Live execution: CoinDCX" section to `README.md` next to the existing paper_exchange section: what `MODE=live` now requires (`BINANCE_API_KEY`/`SECRET` for market data, `COINDCX_API_KEY`/`SECRET` for execution — both, or the process refuses to start), `COINDCX_PAPER_MODE=on` default safety (routes through the SDK's own paper engine, zero real orders, flip to `off` only when ready), `COINDCX_QUOTE_PREFERENCE`, the two safety-cap env vars, and the documented liquidation-labeling limitation from Task 4 point 6 (a CoinDCX liquidation journals as `CLOSE`, not `LIQUIDATED`, until the exchange exposes a risk-events feed we can poll).
- [ ] **Step 2:** Add commented placeholders to `.env.example` (no real values):
  ```
  # CoinDCX live execution (MODE=live only; both required or the process refuses to start)
  # COINDCX_API_KEY=
  # COINDCX_API_SECRET=
  # COINDCX_PAPER_MODE=on
  # COINDCX_QUOTE_PREFERENCE=auto
  # COINDCX_MAX_ORDER_NOTIONAL=
  # COINDCX_MAX_ORDER_QUANTITY=
  # COINDCX_INITIAL_BALANCE=1150
  ```
- [ ] **Step 3: Commit** (if approved).

---

### Task 7: Verification and final review (controller)

- [ ] `npx tsc --noEmit` silent. `npm test` — record the baseline count from immediately before Task 1 and confirm the same count plus every new test, all passing (no regressions, especially in `remoteBroker.*.test.ts`, `paperExchangeClient.test.ts`, `binanceService.remote.test.ts`).
- [ ] `npm run build`. Cockpit tests unchanged at both sizes (`npx tsx --test tests/cockpit.test.ts`, and with `SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT`).
- [ ] `E2E_BACKEND=fake npm run e2e:paper-exchange` (24/24) — proves the `venueName` generalization did not disturb the paper_exchange path.
- [ ] A new scratch integration check (in the scratchpad dir, not the repo): construct a real `CoinDCXClient` with `paperMode: true` (no network — the SDK routes internally to its own `PaperTradingEngine`) and drive `CoinDcxExchangeApi` through open → sync → exit end to end, proving the adapter works against the REAL SDK shape, not just Task 4's hand-written fake. Include this in the task-7 report.
- [ ] File/function-length audit on every file touched or created in Tasks 1–6.
- [ ] Final whole-change review on the strongest model available (same process as the risk-core-and-ops plan: package the diff, dispatch, one fix wave, one scoped re-review). Pay particular attention to: the `getAccount()` baseline-seeding race (two processes starting simultaneously), the `submitOrder` cap-check-before-network-call ordering, whether a rejected (not unavailable) CoinDCX order is ever misclassified as `VenueUnavailableError` and retried when it should not be, and the `updateLeverage`-before-`createOrder` ordering under a slow/failing leverage call for a non-reduce-only order.
- [ ] Report to the user: exactly what to paste into `.env` (`COINDCX_API_KEY`, `COINDCX_API_SECRET`) and confirm `COINDCX_PAPER_MODE=on` is the safe default before they ever flip it to `off`.
