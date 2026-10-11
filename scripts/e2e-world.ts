import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteBroker, type OpenParams } from '../src/binance/remoteBroker.js';
import type { ExchangeApi, PaperExchangePosition, SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { RemoteStore } from '../src/binance/remoteState.js';
import type { FakeExchange } from '../tests/support/fakeExchange.js';

export const INITIAL_MARGIN = 100_000;
export const MOMENTUM = 'MOMENTUM-γ';
export const ADAPTIVE = 'ADAPTIVE-ST-ζ';
export const EXTERNAL = 'EXECUTOR-ε';
const POLL_MS = 200;
const SYNTHETIC_SYMBOL = /^E2E[A-Z0-9]+USDT$/;

/** Raised by a scenario that needs a control only the in-memory fake has. */
export class SkipError extends Error {}

/** Symbol guard violations, kept so the runner can fail even when a background exit swallowed the throw. */
export const violations: string[] = [];

/** The real exchange's mark prices and liquidation scan are shared by every account, so a real symbol would move the live agent's positions. */
export function assertSynthetic(symbol: string): void {
  if (SYNTHETIC_SYMBOL.test(symbol)) return;
  violations.push(symbol);
  throw new Error(`refusing non-synthetic symbol ${symbol}: mark prices on the exchange are shared with the live agent`);
}

/** Only accounts created for this run may ever be written to. */
export function assertThrowaway(accountId: string): void {
  if (!accountId.startsWith('e2e-')) throw new Error(`refusing account ${accountId}: E2E only runs on accounts prefixed e2e-`);
}

export interface Conn {
  /** What the exchange itself says: the broker's own connection, without the broker in between. */
  base: ExchangeApi;
  /** A second client on the same account: manual trades, curl, another process. */
  outsider: ExchangeApi;
  fake: FakeExchange | null;
  /** Rows the exchange keeps with quantity 0 after a close; the client filters them out. */
  zeroRows(symbol: string): Promise<number>;
}

export interface Env {
  backend: 'fake' | 'real';
  accountId: string;
  connect(): Promise<Conn>;
  /** A connection to an account that does not exist yet. */
  blank(): ExchangeApi;
}

export interface Scenario {
  id: string;
  title: string;
  run: (w: World) => Promise<void>;
}

export interface Rig {
  broker: RemoteBroker;
  store: RemoteStore;
  file: string;
  orders: SubmitOrderParams[];
  pushes: Record<string, number>[];
}

const fmt = (value: number): string => String(Number(value.toFixed(6)));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** Records what the broker sends and refuses any symbol that is not synthetic. */
function instrumented(api: ExchangeApi, orders: SubmitOrderParams[], pushes: Record<string, number>[]): ExchangeApi {
  return {
    getAccount: () => api.getAccount(),
    createAccount: (margin) => api.createAccount(margin),
    getPositions: () => api.getPositions(),
    findOrder: (id) => api.findOrder(id),
    getRiskEvents: () => api.getRiskEvents(),
    submitOrder: (params) => { assertSynthetic(params.symbol); orders.push(params); return api.submitOrder(params); },
    pushMarkPrices: (prices) => { Object.keys(prices).forEach(assertSynthetic); pushes.push(prices); return api.pushMarkPrices(prices); },
    pushFundingEvent: (symbol, rate, mark, time) => { assertSynthetic(symbol); return api.pushFundingEvent(symbol, rate, mark, time); },
  };
}

/** One scenario's private view: its own broker and sidecar, its own synthetic symbols, and the assertions that record what they compared. */
export class World {
  rig!: Rig;
  readonly notes: string[] = [];
  private readonly clock = { now: Date.now() };
  private externalSeq = 0;

  constructor(readonly env: Env, readonly conn: Conn, private readonly index: number) {}

  get broker(): RemoteBroker { return this.rig.broker; }
  get store(): RemoteStore { return this.rig.store; }
  get base(): ExchangeApi { return this.conn.base; }
  get fake(): FakeExchange | null { return this.conn.fake; }

  /** A scenario-unique synthetic symbol; `extra` numbers the additional ones. */
  symbol(extra = 0): string {
    return `E2E${String.fromCharCode(65 + this.index)}${extra || ''}USDT`;
  }

  readonly now = (): number => (this.env.backend === 'fake' ? this.clock.now : Date.now());

  /** Moves time forward: instant on the fake's controlled clock, a real wait on the real exchange. */
  async advance(ms: number): Promise<void> {
    if (this.env.backend === 'fake') this.clock.now += ms;
    else await sleep(ms);
  }

  /** Waits for an asynchronous exchange effect; nothing to wait for on the synchronous fake. */
  async settle(ms: number): Promise<void> {
    if (this.env.backend === 'real') await sleep(ms);
  }

  async start(): Promise<void> {
    const leftovers = (await this.base.getPositions()).map((p) => p.symbol);
    if (leftovers.length > 0) throw new Error(`account is not flat at scenario start: ${leftovers.join(',')}`);
    this.rig = await this.newRig(this.base);
  }

  async newRig(api: ExchangeApi, file?: string, isInit = true): Promise<Rig> {
    const sidecar = file ?? path.join(mkdtempSync(path.join(tmpdir(), 'e2e-remote-')), 'remote-state.json');
    const orders: SubmitOrderParams[] = [];
    const pushes: Record<string, number>[] = [];
    const store = new RemoteStore(sidecar, this.env.accountId);
    const broker = new RemoteBroker({ api: instrumented(api, orders, pushes), store, accountId: this.env.accountId, symbols: [this.symbol()], initialMargin: INITIAL_MARGIN, now: this.now });
    if (isInit) await broker.init();
    return { broker, store, file: sidecar, orders, pushes };
  }

  /** A fresh process on the same sidecar and exchange: nothing survives except what is on disk and at the venue. */
  async restart(): Promise<Rig> {
    await this.broker.idle();
    this.rig = await this.newRig(this.base, this.rig.file);
    return this.rig;
  }

  needFake(): FakeExchange {
    if (!this.conn.fake) throw new SkipError('fake-only');
    return this.conn.fake;
  }

  params(over: Partial<OpenParams> = {}): OpenParams {
    return { symbol: this.symbol(), side: 'BUY', qty: 10, leverage: 5, strategy: MOMENTUM, stopLoss: 95, takeProfit: 110, entryPrice: 100, ...over };
  }

  async external(order: Omit<SubmitOrderParams, 'clientOrderId'>): Promise<void> {
    assertSynthetic(order.symbol);
    await this.conn.outsider.submitOrder({ ...order, clientOrderId: `e2e-external-${Date.now()}-${this.index}-${this.externalSeq++}` });
  }

  async pushMark(symbol: string, price: number): Promise<void> {
    assertSynthetic(symbol);
    await this.base.pushMarkPrices({ [symbol]: price });
  }

  async row(symbol = this.symbol()): Promise<PaperExchangePosition> {
    const row = (await this.base.getPositions()).find((p) => p.symbol === symbol);
    if (!row) throw new Error(`the exchange has no ${symbol} position`);
    return row;
  }

  async wallet(): Promise<{ total: number; locked: number; unrealized: number; margin: number; equityField: number }> {
    const account = await this.base.getAccount();
    if (!account) throw new Error(`the exchange has no account ${this.env.accountId}`);
    const { availableBalance, lockedMargin, unrealizedPnl } = account;
    return { total: availableBalance + lockedMargin + unrealizedPnl, locked: lockedMargin, unrealized: unrealizedPnl, margin: account.margin, equityField: account.equity };
  }

  reduceOnlyOrders(): SubmitOrderParams[] {
    return this.rig.orders.filter((order) => order.reduceOnly);
  }

  async eventually(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() >= deadline) return false;
      await sleep(POLL_MS);
    }
    return true;
  }

  /** Closes whatever is left with reduce-only orders straight at the exchange, so the shared account ends flat. */
  async flatten(): Promise<void> {
    if (this.fake) this.fake.down = false;
    await this.broker.idle();
    for (const row of await this.base.getPositions()) {
      assertSynthetic(row.symbol);
      await this.base.submitOrder({
        symbol: row.symbol, side: row.side === 'long' ? 'sell' : 'buy', quantity: row.netQuantity, leverage: row.leverage, marginType: row.marginType,
        reduceOnly: true, executionPrice: row.currentPrice > 0 ? row.currentPrice : row.averagePrice, clientOrderId: `e2e-cleanup-${row.symbol}-${Date.now()}`,
      });
    }
    await this.broker.sync();
    const left = await this.base.getPositions();
    if (left.length > 0) throw new Error(`account not flat after cleanup: ${left.map((p) => p.symbol).join(',')}`);
  }

  /** Strict equality of strings, counts and flags. */
  is(label: string, actual: unknown, expected: unknown): void {
    this.notes.push(`${label}=${String(actual)}`);
    if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }

  /** Numbers compared within a tolerance; the first value is conventionally the agent's, the second the exchange's (or the formula's). */
  near(label: string, agent: number, exchange: number, tolerance = 1e-6): void {
    this.notes.push(`${label} ${fmt(agent)} vs ${fmt(exchange)}`);
    if (!(Math.abs(agent - exchange) <= tolerance)) throw new Error(`${label}: ${fmt(agent)} differs from ${fmt(exchange)} by more than ${tolerance}`);
  }

  ok(label: string, condition: boolean): void {
    this.notes.push(label);
    if (!condition) throw new Error(`${label}: failed`);
  }

  /** The agent's wallet equity must be the exchange's own wallet numbers: available + locked + unrealized. */
  async equityMatches(label: string): Promise<void> {
    this.near(`equity ${label} agent/exch`, this.broker.getAccount().equity, (await this.wallet()).total);
  }

  async rejects<T extends Error>(label: string, attempt: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
    try {
      await attempt;
    } catch (err) {
      if (!(err instanceof type)) throw new Error(`${label}: expected ${type.name}, got ${errorText(err)}`);
      this.notes.push(`${label} -> ${err.name}`);
      return err;
    }
    throw new Error(`${label}: expected ${type.name} but the call succeeded`);
  }
}
