import type { AgentId, ExitReason, Position, TradeRecord } from '../types.js';
import {
  VenueUnavailableError,
  type ExchangeApi,
  type PaperExchangeAccountSnapshot,
  type PaperExchangePosition,
  type SubmitOrderResult,
} from './paperExchangeClient.js';
import { entryMeta, entrySide, errorText, OrderInFlightError, OrderNotFilledError, OwnershipError, RemoteExits, scaledMeta, submitEntry, type OpenParams } from './remoteOrders.js';
import { FundingBoundaryWatcher, type FundingLine, type FundingObservation } from './remoteFunding.js';
import { RemoteReconciler } from './remoteReconcile.js';
import { EXTERNAL_OWNER, sideOf, toPosition, walletEquity, type RemoteStore } from './remoteState.js';
import { findStopExit, isPrice } from './stopRules.js';

export { OrderInFlightError, OrderNotFilledError, OwnershipError, type OpenParams };

export type VenueState = 'connected' | 'degraded' | 'down';

export interface VenueStatus {
  name: 'paper_exchange';
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
  now?: () => number;
}

const DOWN_AFTER_FAILURES = 3;
const MARK_PUSH_INTERVAL_MS = 1_000;

/** Strategy-aware view of the paper_exchange account: the exchange holds the money, the sidecar holds who owns what. */
export class RemoteBroker {
  private account: PaperExchangeAccountSnapshot | null = null;
  private positions: PaperExchangePosition[] = [];
  private readonly marks = new Map<string, number>();
  private readonly lastPushAt = new Map<string, number>();
  private readonly pendingOpens = new Set<string>();
  private readonly exits: RemoteExits;
  private readonly reconciler: RemoteReconciler;
  private readonly funding: FundingBoundaryWatcher;
  private pushInFlight: Promise<void> = Promise.resolve();
  private syncChain: Promise<void> = Promise.resolve();
  // Bumped whenever an order settles: a sync that started before that fetched a snapshot the order already made stale.
  private orderEpoch = 0;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastSyncAt = 0;
  private readonly now: () => number;

  constructor(private readonly deps: RemoteBrokerDeps) {
    this.now = deps.now ?? Date.now;
    this.exits = new RemoteExits({
      api: deps.api,
      store: deps.store,
      now: this.now,
      markOf: (symbol) => this.marks.get(symbol),
      afterOrder: () => this.afterOrder(),
      recordError: (message) => { this.lastError = message; },
    });
    this.funding = new FundingBoundaryWatcher(deps.symbols, (symbol, rate, mark, time) => this.pushFunding(symbol, rate, mark, time));
    this.reconciler = new RemoteReconciler({ store: deps.store, now: this.now, markOf: (symbol) => this.marks.get(symbol), isBusy: (symbol) => this.isBusy(symbol) });
  }

  /** Creates the account only when it does not exist yet — an existing account (and its positions) is never reset. */
  async init(): Promise<void> {
    try {
      const existing = await this.deps.api.getAccount();
      if (existing === null) {
        // A missing account cannot hold positions, so clearing first also survives a crash between the two steps.
        this.deps.store.clearPositions();
        await this.deps.api.createAccount(this.deps.initialMargin);
      }
    } catch (err) {
      // Without this an outage at startup would leave the venue looking connected while it has no data at all.
      if (err instanceof VenueUnavailableError) this.recordFailure(err);
      throw err;
    }
    await this.sync();
  }

  /** Refreshes account and positions, then reconciles them with the sidecar; venue outages only flip the status. */
  async sync(): Promise<void> {
    await this.trySync();
  }

  /** Resolves once background exits and the last mark push have finished (shutdown, tests). */
  async idle(): Promise<void> {
    await this.exits.idle();
    await this.pushInFlight;
  }

  setMarks(prices: Record<string, number>): void {
    for (const [symbol, price] of Object.entries(prices)) {
      if (isPrice(price)) this.marks.set(symbol, price);
    }
  }

  hasData(): boolean {
    return this.account !== null;
  }

  getAccount(): { equity: number; marginUsed: number; initialEquity: number } {
    if (this.account === null) throw new Error('RemoteBroker has no account data yet: call init() first');
    return {
      equity: walletEquity(this.account, this.positions, this.marks),
      marginUsed: this.account.lockedMargin,
      initialEquity: this.account.margin,
    };
  }

  getPositions(): Position[] {
    return this.positions.map((p) => toPosition(p, this.deps.store.getMeta(p.symbol), this.marks.get(p.symbol)));
  }

  getTrades(): TradeRecord[] {
    return this.deps.store.trades();
  }

  status(): VenueStatus {
    const state: VenueState = this.consecutiveFailures === 0 ? 'connected' : this.consecutiveFailures < DOWN_AFTER_FAILURES ? 'degraded' : 'down';
    return { name: 'paper_exchange', accountId: this.deps.accountId, state, lastError: this.lastError, lastSyncAt: this.lastSyncAt };
  }

  /** Opens, scales into or flips a position the strategy owns; refuses symbols owned by anyone else before any order is sent. */
  async open(params: OpenParams): Promise<{ orderId: string; status: string }> {
    const { symbol } = params;
    if (this.status().state === 'down') throw new VenueUnavailableError(`paper_exchange is down: ${params.side} ${symbol} not sent`);
    // Decide from a fresh view: an external trade since the last loop tick must not be netted into by this order.
    if (!(await this.trySync())) throw new VenueUnavailableError(`paper_exchange unreachable (${this.lastError}): ${params.side} ${symbol} not sent`);
    if (this.isBusy(symbol)) throw new OrderInFlightError(`${symbol} already has an order in flight`);
    this.pendingOpens.add(symbol);
    try {
      return await this.placeOpen(params);
    } finally {
      this.pendingOpens.delete(symbol);
    }
  }

  /** Reduce-only close of the whole position; refused while an open for the symbol is in flight, whose fill it would otherwise race. */
  async close(pos: Position, reason: ExitReason): Promise<void> {
    if (this.pendingOpens.has(pos.symbol)) throw new OrderInFlightError(`${pos.symbol} has an open in flight: ${reason} not sent`);
    await this.exits.close(pos.symbol, reason, this.marks.get(pos.symbol) ?? pos.mark);
  }

  /** Reduce-only partial exit of `qty`; refused while an open for the symbol is in flight, like `close`. */
  async reduce(pos: Position, qty: number): Promise<void> {
    if (this.pendingOpens.has(pos.symbol)) throw new OrderInFlightError(`${pos.symbol} has an open in flight: partial not sent`);
    await this.exits.reduce(pos.symbol, qty, this.marks.get(pos.symbol) ?? pos.mark);
  }

  /** Stores marks, pushes them to the exchange, starts exits for breached managed positions; returns exits completed since the last call. */
  markAll(prices: Record<string, number>): string[] {
    this.setMarks(prices);
    this.pushMarks(prices);
    for (const pos of this.getPositions()) this.checkStops(pos, prices);
    this.exits.retryPending();
    return [...this.exits.drainMessages(), ...this.deps.store.drainNotices()];
  }

  /** Persists new levels in the sidecar only; ignored unless `strategy` manages the symbol. */
  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number | null): void {
    const meta = this.deps.store.getMeta(symbol);
    if (!meta || meta.external || meta.owner !== strategy) return;
    this.deps.store.setMeta(symbol, { ...meta, stopLoss, takeProfit });
  }

  /** Forwards one funding settlement (the exchange dedupes on `fundingTime`); false when it was not accepted. Failures are recorded, never thrown into the loop. */
  async pushFunding(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<boolean> {
    let isPushed = false;
    try {
      await this.deps.api.pushFundingEvent(symbol, fundingRate, markPrice, fundingTime);
      isPushed = true;
      await this.trySync();
    } catch (err) {
      this.lastError = `funding ${symbol}: ${errorText(err)}`;
    }
    return isPushed;
  }

  /** Settles funding for a boundary that just passed (once) and returns log lines; failures are recorded, never thrown. */
  observeFunding(market: FundingObservation): Promise<FundingLine[]> {
    return this.funding.observe(market);
  }

  private async trySync(): Promise<boolean> {
    try {
      await this.refreshAndReconcile();
    } catch (err) {
      if (!(err instanceof VenueUnavailableError)) throw err;
      this.recordFailure(err);
      return false;
    }
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastSyncAt = this.now();
    this.exits.retryPending();
    return true;
  }

  private recordFailure(err: VenueUnavailableError): void {
    this.consecutiveFailures++;
    this.lastError = err.message;
  }

  private afterOrder(): Promise<void> {
    this.orderEpoch++;
    return this.trySync().then(() => undefined);
  }

  private isBusy(symbol: string): boolean {
    return this.pendingOpens.has(symbol) || this.exits.isActive(symbol);
  }

  private async placeOpen(params: OpenParams): Promise<{ orderId: string; status: string }> {
    const { symbol, strategy } = params;
    const held = this.positions.find((p) => p.symbol === symbol);
    if (!held) return this.enter(params, false);
    const meta = this.deps.store.getMeta(symbol);
    if (!meta || meta.external || meta.owner !== strategy) {
      throw new OwnershipError(`${symbol} is held by ${meta?.owner ?? EXTERNAL_OWNER}; ${strategy} may not trade it`);
    }
    if (sideOf(held) === entrySide(params)) return this.enter(params, true);
    await this.closeForFlip(symbol, params.entryPrice);
    return this.enter(params, false);
  }

  private async closeForFlip(symbol: string, price: number): Promise<void> {
    try {
      await this.exits.close(symbol, 'FLIP', price);
    } catch (err) {
      // A close that did not finish here never gets its new position, so it must not be journaled as a flip when it completes later.
      this.exits.retag(symbol, 'CLOSE');
      throw err;
    }
  }

  private async enter(params: OpenParams, isScaleIn: boolean): Promise<{ orderId: string; status: string }> {
    let result: SubmitOrderResult;
    try {
      result = await submitEntry(this.deps.api, params, this.now());
    } catch (err) {
      if (err instanceof VenueUnavailableError && !isScaleIn) this.reconciler.expectOpen(params);
      // A lost or unfilled order may have changed the account; a 4xx rejection changed nothing, so it skips the refresh.
      if (err instanceof VenueUnavailableError || err instanceof OrderNotFilledError) await this.afterOrder();
      throw err;
    }
    this.reconciler.forgetOpen(params.symbol);
    this.writeEntryMeta(params, isScaleIn);
    await this.afterOrder();
    return { orderId: String(result.orderId), status: result.status };
  }

  // Meta goes in before the refresh: a crash or failed refresh must never leave a filled position without its owner.
  private writeEntryMeta(params: OpenParams, isScaleIn: boolean): void {
    // Re-read after the await: updateStops or a sync may have changed the meta while the order was in flight.
    const current = this.deps.store.getMeta(params.symbol);
    this.deps.store.setMeta(params.symbol, isScaleIn && current ? scaledMeta(current, params) : entryMeta(params, this.now()));
  }

  private pushMarks(prices: Record<string, number>): void {
    const isDue = (symbol: string): boolean => prices[symbol] > 0 && this.now() - (this.lastPushAt.get(symbol) ?? -Infinity) >= MARK_PUSH_INTERVAL_MS;
    const due = this.positions.map((p) => p.symbol).filter(isDue);
    if (due.length === 0) return;
    for (const symbol of due) this.lastPushAt.set(symbol, this.now());
    this.pushInFlight = this.deps.api.pushMarkPrices(Object.fromEntries(due.map((s) => [s, prices[s]]))).catch((err: unknown) => {
      this.lastError = `mark push: ${errorText(err)}`;
    });
  }

  private checkStops(pos: Position, prices: Record<string, number>): void {
    const meta = this.deps.store.getMeta(pos.symbol);
    if (!(prices[pos.symbol] > 0) || !meta || meta.external || this.pendingOpens.has(pos.symbol)) return;
    const stop = findStopExit(pos);
    if (stop) this.exits.trigger(pos.symbol, stop.reason, stop.price);
  }

  // One sync at a time: a slower earlier sync applying after a newer one would restore a stale snapshot and double-journal.
  private refreshAndReconcile(): Promise<void> {
    const run = this.syncChain.then(() => this.refreshOnce());
    this.syncChain = run.catch(() => undefined);
    return run;
  }

  private async refreshOnce(): Promise<void> {
    const epoch = this.orderEpoch;
    const [account, fetched] = await Promise.all([this.deps.api.getAccount(), this.deps.api.getPositions()]);
    if (account === null) throw new Error(`paper_exchange account ${this.deps.accountId} does not exist`);
    const positions = fetched.filter((p) => p.netQuantity > 0);
    const events = this.reconciler.hasVanished(positions) ? await this.deps.api.getRiskEvents() : [];
    // The order that bumped the epoch refreshes the cache itself; applying this older snapshot would undo or misjournal it.
    if (epoch !== this.orderEpoch) return;
    // No await from here to the cache swap: reconcile journals from the previous cache, and an overlapping sync must not see it half-updated.
    this.reconciler.apply(this.positions, positions, events);
    this.account = account;
    this.positions = positions;
  }
}
