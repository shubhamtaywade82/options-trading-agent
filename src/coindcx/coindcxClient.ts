/**
 * `ExchangeApi` adapter over a real CoinDCX futures account.
 *
 * CoinDCX has one real account per API key — there is no create/reset call
 * like paper_exchange's. `initialEquity` (the account's starting balance,
 * used for equity-based reporting) has no server-side concept either, so it
 * is remembered locally in a tiny baseline file, seeded from the first
 * observed wallet total.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  OrderRejectedError,
  VenueUnavailableError,
  type ExchangeApi,
  type ExchangeRiskEvent,
  type PaperExchangeAccountSnapshot,
  type PaperExchangePosition,
  type SubmitOrderParams,
  type SubmitOrderResult,
} from '../binance/paperExchangeClient.js';
import { ContractSpecCache, floorToLot } from './contractSpec.js';
import { SymbolRouter } from './symbolRouter.js';

interface CoinDcxOrderRaw {
  id: string | number;
  client_order_id: string | undefined;
  status: string;
  filled_quantity: number | undefined;
  price: number | undefined;
}

interface CoinDcxPositionRaw {
  id: string | number;
  pair: string;
  side: 'long' | 'short';
  size: number;
  entry_price: number;
  mark_price?: number;
  liquidation_price?: number | null;
  leverage?: number;
  margin_type?: 'isolated' | 'cross';
}

export interface CoinDcxOrderClient {
  futures: {
    trading: {
      createOrder(req: {
        side: 'buy' | 'sell'; order_type: 'market_order'; base_currency: string; quote_currency: string;
        target_quantity: number; price: number | undefined; leverage: number | undefined;
        client_order_id: string | undefined; time_in_force: 'ioc'; margin_type: 'isolated' | 'cross' | undefined;
      }): Promise<CoinDcxOrderRaw>;
      listOrders(params: { pair?: string; status?: string; limit?: number }): Promise<CoinDcxOrderRaw[]>;
    };
    account: {
      updateLeverage(params: { pair: string; leverage: number }): Promise<unknown>;
      getPositions(params: { pair?: string; status?: string }): Promise<CoinDcxPositionRaw[]>;
      getWallet(): Promise<{ currency: string; balance: number; locked_balance: number; available_balance: number }[]>;
      setSafetyLimits?(limits: { maxOrderQuantity?: number; maxOrderNotional?: number }): void;
    };
    market: {
      getMarketsDetails(): Promise<{ pair: string; status?: string }[]>;
      getInstrumentDetails(pair: string): Promise<{ lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }>;
    };
  };
  marketData: { getSpotTicker(): Promise<{ pair?: string; last_price?: string | number }[]> };
}

export interface CoinDcxExchangeApiDeps {
  client: CoinDcxOrderClient;
  quotePreference: 'auto' | 'USDT' | 'INR';
  baselinePath: string;
  /** A local label only — CoinDCX has one real account per API key, not multiple. */
  accountId: string;
  maxOrderNotional?: number;
  maxOrderQuantity?: number;
}

const round8 = (value: number): number => Number(value.toFixed(8));
const sumBy = <T,>(items: T[], pick: (item: T) => number): number => items.reduce((total, item) => total + pick(item), 0);

function toOrderResult(raw: CoinDcxOrderRaw): SubmitOrderResult {
  const filled = typeof raw.filled_quantity === 'number' && raw.filled_quantity > 0 ? raw.filled_quantity : undefined;
  return { orderId: Number(raw.id), status: raw.status, ...(filled !== undefined ? { filledQuantity: filled } : {}) };
}

function toPosition(p: CoinDcxPositionRaw, symbol: string): PaperExchangePosition {
  return {
    id: Number(p.id),
    symbol,
    side: p.side,
    netQuantity: p.size,
    averagePrice: p.entry_price,
    currentPrice: p.mark_price ?? p.entry_price,
    leverage: p.leverage ?? 1,
    marginType: p.margin_type === 'cross' ? 'cross' : 'isolated',
    liquidationPrice: p.liquidation_price ?? null,
    unrealizedPnl: 0,
  };
}

/** Local memory of the account's starting balance; CoinDCX has no server-side concept of one. */
class CoinDcxBaseline {
  private cached: number | undefined;
  constructor(private readonly filePath: string, private readonly accountId: string) {}

  getOrSeed(observedEquity: number): number {
    if (this.cached !== undefined) return this.cached;
    const persisted = this.read();
    if (persisted !== undefined) {
      this.cached = persisted;
      return this.cached;
    }
    // A non-positive first observation (e.g. an all-INR wallet with no USDT rows yet) must not be seeded permanently:
    // initialEquity=0 would divide-by-zero every pnl%/drawdown/sharpe stat downstream. Leave uncached so the next
    // getAccount() call retries seeding once a real balance is observed.
    if (!(observedEquity > 0)) return 0;
    this.cached = this.seed(observedEquity);
    return this.cached;
  }

  private read(): number | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as { initialEquity?: unknown };
      return typeof raw.initialEquity === 'number' ? raw.initialEquity : undefined;
    } catch {
      return undefined;
    }
  }

  // Same atomic write pattern as RemoteStore: write to .tmp, then rename, so a crash mid-write cannot corrupt the file.
  private seed(initialEquity: number): number {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ accountId: this.accountId, initialEquity }, null, 2));
    renameSync(tmpPath, this.filePath);
    return initialEquity;
  }
}

export class CoinDcxExchangeApi implements ExchangeApi {
  private readonly router: SymbolRouter;
  private readonly specs: ContractSpecCache;
  private readonly baseline: CoinDcxBaseline;
  private readonly warnedPairs = new Set<string>();

  constructor(private readonly deps: CoinDcxExchangeApiDeps) {
    this.router = new SymbolRouter(deps.client, deps.quotePreference);
    this.specs = new ContractSpecCache(deps.client);
    this.baseline = new CoinDcxBaseline(deps.baselinePath, deps.accountId);
  }

  // getPositions() only maps a pair back to a symbol via router.pairToSymbol, which is empty until resolve() has run
  // for that symbol (only submitOrder() calls resolve()). On a cold restart with open positions already on CoinDCX,
  // every one of them would be unresolved and silently dropped — the caller (Task 5) must call this once at startup,
  // for every configured symbol, before the first sync(). An unresolvable symbol is skipped, not thrown.
  async warmSymbols(symbols: string[]): Promise<void> {
    await Promise.all(symbols.map((symbol) => this.router.resolve(symbol).catch(() => {})));
  }

  async getAccount(): Promise<PaperExchangeAccountSnapshot | null> {
    return this.guarded(async () => {
      const wallets = (await this.deps.client.futures.account.getWallet()).filter((w) => w.currency === 'USDT');
      const equity = sumBy(wallets, (w) => w.balance);
      const positions = await this.getPositions();
      return {
        accountId: this.deps.accountId,
        currency: 'USDT',
        margin: this.baseline.getOrSeed(equity),
        availableBalance: sumBy(wallets, (w) => w.available_balance),
        lockedMargin: sumBy(wallets, (w) => w.locked_balance),
        equity,
        unrealizedPnl: 0,
        realizedPnl: 0,
        positionsCount: positions.length,
      };
    });
  }

  // A valid CoinDCX API key always has an account; RemoteBroker only calls createAccount() when getAccount() returned
  // null, which never happens here — deliberately NOT routed through guarded(): this is a permanent misconfiguration,
  // not a transient venue outage, and must not be mistaken for one (VenueUnavailableError drives retry/degraded-state logic).
  async createAccount(_margin: number): Promise<void> {
    throw new Error('CoinDCX accounts are not created via the API — configure COINDCX_API_KEY for an existing account');
  }

  async getPositions(): Promise<PaperExchangePosition[]> {
    return this.guarded(async () => {
      const raw = await this.deps.client.futures.account.getPositions({ status: 'open' });
      const positions: PaperExchangePosition[] = [];
      for (const p of raw) {
        if (!(p.size > 0)) continue;
        const symbol = this.router.pairToSymbol(p.pair);
        if (!symbol) {
          this.warnUnresolved(p.pair);
          continue;
        }
        positions.push(toPosition(p, symbol));
      }
      return positions;
    });
  }

  async submitOrder(params: SubmitOrderParams): Promise<SubmitOrderResult> {
    return this.guarded(async () => {
      const resolved = await this.router.resolve(params.symbol);
      const spec = await this.specs.get(resolved.pair);
      const quantity = round8(floorToLot(params.quantity, spec.lotSize));
      // Client-side hard stop before any order-mutating call — including the leverage set below.
      this.enforceCaps(quantity, params.executionPrice);
      await this.setLeverage(resolved.pair, params.leverage, params.reduceOnly ?? false);
      const price = round8(resolved.quote === 'INR' ? params.executionPrice * resolved.fxRate : params.executionPrice);
      const raw = await this.deps.client.futures.trading.createOrder({
        side: params.side,
        order_type: 'market_order',
        base_currency: resolved.base,
        quote_currency: resolved.quote,
        target_quantity: quantity,
        price,
        leverage: params.leverage,
        client_order_id: params.clientOrderId,
        time_in_force: 'ioc',
        margin_type: params.marginType ?? 'isolated',
      });
      return toOrderResult(raw);
    });
  }

  async findOrder(clientOrderId: string): Promise<SubmitOrderResult | null> {
    return this.guarded(async () => {
      const recent = await this.deps.client.futures.trading.listOrders({ limit: 100 });
      const found = recent.find((o) => o.client_order_id === clientOrderId) ?? (await this.findOpen(clientOrderId));
      return found ? toOrderResult(found) : null;
    });
  }

  // CoinDCX runs its own risk engine; this agent has no channel to it yet. Known limitation (documented in the task
  // report): a real liquidation is journaled as a generic CLOSE rather than LIQUIDATED until this is wired up.
  async getRiskEvents(): Promise<ExchangeRiskEvent[]> {
    return this.guarded(async () => []);
  }

  // CoinDCX is a real exchange with its own live prices and its own liquidation/funding engine; these calls exist
  // only for paper_exchange, which has neither.
  async pushMarkPrices(_prices: Record<string, number>): Promise<void> {
    return this.guarded(async () => {});
  }

  async pushFundingEvent(_symbol: string, _fundingRate: number, _markPrice: number, _fundingTime: number): Promise<void> {
    return this.guarded(async () => {});
  }

  private async findOpen(clientOrderId: string): Promise<CoinDcxOrderRaw | undefined> {
    const open = await this.deps.client.futures.trading.listOrders({ status: 'open', limit: 100 });
    return open.find((o) => o.client_order_id === clientOrderId);
  }

  private async setLeverage(pair: string, leverage: number, reduceOnly: boolean): Promise<void> {
    try {
      await this.deps.client.futures.account.updateLeverage({ pair, leverage });
    } catch (err) {
      // A reduce-only close must never be blocked by a stale-leverage rejection; it only shrinks the existing position.
      if (!reduceOnly) throw err;
    }
  }

  private enforceCaps(quantity: number, executionPrice: number): void {
    const { maxOrderQuantity, maxOrderNotional } = this.deps;
    if (maxOrderQuantity !== undefined && quantity > maxOrderQuantity) {
      throw new OrderRejectedError(`order quantity ${quantity} exceeds maxOrderQuantity ${maxOrderQuantity}`, 400, '');
    }
    const notional = quantity * executionPrice;
    if (maxOrderNotional !== undefined && notional > maxOrderNotional) {
      throw new OrderRejectedError(`order notional ${notional} exceeds maxOrderNotional ${maxOrderNotional}`, 400, '');
    }
  }

  private warnUnresolved(pair: string): void {
    if (this.warnedPairs.has(pair)) return;
    this.warnedPairs.add(pair);
    console.warn(`coindcx: skipping position on unresolved pair ${pair} (outside configured symbols)`);
  }

  // Every public method (except createAccount(), see its own comment) routes through this. Note: CoinDcxOrderClient
  // doesn't distinguish a genuine CoinDCX 4xx (invalid leverage, insufficient margin) from a real network failure —
  // the fake/real client just rejects the promise either way — so both surface as VenueUnavailableError here, even
  // though a 4xx is a permanent rejection RemoteBroker should arguably not retry. Task 5's wiring to the real SDK
  // should revisit this if the SDK exposes typed errors that let it distinguish the two.
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VenueUnavailableError || err instanceof OrderRejectedError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new VenueUnavailableError(`CoinDCX request failed: ${message}`, { cause: err });
    }
  }
}
