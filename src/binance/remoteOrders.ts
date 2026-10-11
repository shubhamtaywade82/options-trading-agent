import { randomUUID } from 'node:crypto';
import type { AgentId, ExitReason, Side } from '../types.js';
import {
  VenueUnavailableError,
  type ExchangeApi,
  type PaperExchangePosition,
  type SubmitOrderParams,
  type SubmitOrderResult,
} from './paperExchangeClient.js';
import { closedTrade, EXTERNAL_OWNER, sideOf, type ClosedPosition, type PositionMeta, type RemoteStore } from './remoteState.js';
import { formatPrice } from './symbolRules.js';

/** A strategy tried to trade a symbol that another owner holds. */
export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

/** The symbol already has an open or an exit running; the caller may retry once it settled. */
export class OrderInFlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderInFlightError';
  }
}

/** The broker accepted the order but did not report it as filled. */
export class OrderNotFilledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFilledError';
  }
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A venue or ownership rule said no before any order changed the account: a decision to report, not a fault. */
export const isRefusal = (err: unknown): boolean =>
  err instanceof OwnershipError || err instanceof OrderInFlightError || err instanceof VenueUnavailableError;

/** `<symbol>-<owner>-<kind>-<epochMs>-<nonce>`; created once per logical order and reused on every retry so the broker can dedupe. */
export function newClientOrderId(symbol: string, owner: AgentId, kind: string, nowMs: number): string {
  return `${symbol}-${owner}-${kind.replaceAll(' ', '_')}-${nowMs}-${randomUUID().slice(0, 8)}`;
}

/** Submits an order; a lost response is resolved by looking the order up before deciding it failed. */
export async function sendOrder(api: ExchangeApi, params: SubmitOrderParams): Promise<SubmitOrderResult> {
  try {
    return await api.submitOrder(params);
  } catch (err) {
    if (!(err instanceof VenueUnavailableError)) throw err;
    const found = await api.findOrder(params.clientOrderId);
    if (found) return found;
    throw err;
  }
}

export interface OpenParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  leverage: number;
  strategy: AgentId;
  stopLoss?: number;
  takeProfit?: number;
  entryPrice: number;
  decisionId?: string;
}

/** Sends an entry order and requires it to be filled; the price sent is the fill price, the broker has no price of its own. */
export async function submitEntry(api: ExchangeApi, params: OpenParams, nowMs: number): Promise<SubmitOrderResult> {
  const result = await sendOrder(api, {
    symbol: params.symbol,
    side: params.side === 'BUY' ? 'buy' : 'sell',
    quantity: params.qty,
    leverage: params.leverage,
    executionPrice: params.entryPrice,
    clientOrderId: newClientOrderId(params.symbol, params.strategy, 'OPEN', nowMs),
  });
  if (result.status !== 'filled') throw new OrderNotFilledError(`${params.side} ${params.qty} ${params.symbol} came back ${result.status}`);
  return result;
}

export const entrySide = (params: OpenParams): Side => (params.side === 'BUY' ? 'LONG' : 'SHORT');

/** Sidecar entry for a brand new position. */
export function entryMeta(params: OpenParams, nowMs: number): PositionMeta {
  const stopLoss = params.stopLoss ?? null;
  const side = entrySide(params);
  return {
    owner: params.strategy,
    stopLoss,
    takeProfit: params.takeProfit ?? null,
    initialRisk: stopLoss === null ? null : Math.abs(params.entryPrice - stopLoss),
    openedAt: nowMs,
    lastSeen: { side, entry: params.entryPrice, qty: params.qty, mark: params.entryPrice },
    ...(params.decisionId === undefined ? {} : { decisionId: params.decisionId }),
  };
}

/** Same-side add by the owner: new levels replace the old ones when given; the 1R and the opening time stay. */
export function scaledMeta(meta: PositionMeta, params: OpenParams): PositionMeta {
  return { ...meta, stopLoss: params.stopLoss ?? meta.stopLoss, takeProfit: params.takeProfit ?? meta.takeProfit };
}

export interface ExitHost {
  api: ExchangeApi;
  store: RemoteStore;
  now(): number;
  markOf(symbol: string): number | undefined;
  /** Called right after an order changed the account: invalidates in-flight syncs and refreshes the cache. */
  afterOrder(): Promise<void>;
  recordError(message: string): void;
}

interface ExitJob {
  symbol: string;
  reason: ExitReason;
  /** Level that fired the exit; a stop is re-priced from it until its first submission. */
  trigger: number;
  /** Frozen at the first submission: a replayed order fills at its original price, so the journal must use the same one. */
  price: number;
  clientOrderId: string;
  /** Partial exit size; undefined closes the whole position. */
  qty?: number;
  /** What the latest submission was sized from; enough to journal the exit when only a lookup can confirm the fill. */
  sent?: ClosedPosition;
}

const ANNOUNCED_REASONS: ExitReason[] = ['STOP LOSS', 'TAKE PROFIT', 'PARTIAL TP'];
const RETRY_INTERVAL_MS = 1_000;

/** Reduce-only exits: one job per symbol, retried through outages under a single client order id. */
export class RemoteExits {
  private readonly jobs = new Map<string, ExitJob>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly announcements: string[] = [];

  constructor(private readonly host: ExitHost) {}

  /** While a job exists the sync must not journal or adopt the symbol: this exit owns its bookkeeping. */
  isActive(symbol: string): boolean {
    return this.jobs.has(symbol);
  }

  /** Autonomous exit: ignored when the symbol already has one queued or in flight. */
  trigger(symbol: string, reason: ExitReason, price: number): void {
    if (this.jobs.has(symbol)) return;
    this.enqueue(symbol, reason, price);
    this.runInBackground(symbol);
  }

  /** Resolves once the position is closed; a venue outage rejects, and only a plain manual close is then dropped instead of queued. */
  async close(symbol: string, reason: ExitReason, price: number): Promise<void> {
    if (!this.jobs.has(symbol)) this.enqueue(symbol, reason, price);
    try {
      await this.drive(symbol);
    } catch (err) {
      // The caller was told it failed; completing later would close a position the strategy may have re-decided about.
      if (err instanceof VenueUnavailableError && this.jobs.get(symbol)?.reason === 'CLOSE') this.jobs.delete(symbol);
      throw err;
    }
  }

  /**
   * Reduce-only partial exit. Refused while another exit job exists for the symbol. Through an outage the job stays queued
   * under its single client order id (the order may already have landed, so re-deciding with a new id could reduce twice);
   * retryPending completes it after recovery and this call returns as if sent. Any other failure drops the job and rejects.
   */
  async reduce(symbol: string, qty: number, price: number): Promise<void> {
    if (this.jobs.has(symbol)) throw new OrderInFlightError(`${symbol} already has an exit in flight: partial not sent`);
    this.enqueue(symbol, 'PARTIAL TP', price, qty);
    try {
      await this.drive(symbol);
    } catch (err) {
      if (!(err instanceof VenueUnavailableError)) throw err;
    }
  }

  /** Renames a queued job, e.g. a flip's close that lost its open leg. */
  retag(symbol: string, reason: ExitReason): void {
    const job = this.jobs.get(symbol);
    if (job) job.reason = reason;
  }

  /** Re-attempts queued exits, at most once per RETRY_INTERVAL_MS per symbol so an outage is not hammered on every tick. */
  retryPending(): void {
    for (const symbol of this.jobs.keys()) {
      const isDue = this.host.now() - (this.lastAttemptAt.get(symbol) ?? -Infinity) >= RETRY_INTERVAL_MS;
      if (!this.running.has(symbol) && isDue) this.runInBackground(symbol);
    }
  }

  drainMessages(): string[] {
    return this.announcements.splice(0);
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  private enqueue(symbol: string, reason: ExitReason, price: number, qty?: number): void {
    const owner = this.host.store.getMeta(symbol)?.owner ?? EXTERNAL_OWNER;
    const clientOrderId = newClientOrderId(symbol, owner, `EXIT-${reason}`, this.host.now());
    this.jobs.set(symbol, { symbol, reason, trigger: price, price, clientOrderId, ...(qty === undefined ? {} : { qty }) });
  }

  private runInBackground(symbol: string): void {
    this.drive(symbol).catch((err: unknown) => this.host.recordError(`exit ${symbol}: ${errorText(err)}`));
  }

  private drive(symbol: string): Promise<void> {
    const inFlight = this.running.get(symbol);
    const job = this.jobs.get(symbol);
    if (inFlight) return inFlight;
    if (!job) return Promise.resolve();
    this.lastAttemptAt.set(symbol, this.host.now());
    const run = this.attempt(job).finally(() => this.running.delete(symbol));
    this.running.set(symbol, run);
    return run;
  }

  private async attempt(job: ExitJob): Promise<void> {
    try {
      await this.execute(job);
    } catch (err) {
      // An outage leaves the job queued: the order may or may not have landed, and the same client id makes the retry safe.
      if (err instanceof VenueUnavailableError) throw err;
      this.jobs.delete(job.symbol);
      await this.host.afterOrder();
      throw err;
    }
  }

  private async execute(job: ExitJob): Promise<void> {
    const { api } = this.host;
    if (job.sent) {
      const found = await api.findOrder(job.clientOrderId);
      if (found?.status === 'filled') return this.complete(job, job.sent, found);
    }
    const fresh = (await api.getPositions()).find((p) => p.symbol === job.symbol && p.netQuantity > 0);
    if (!fresh) return this.dropAlreadyFlat(job);
    const closed = this.closedFrom(fresh, job.qty);
    if (!job.sent) job.price = repricedStop(job, fresh.side, this.host.markOf(job.symbol));
    job.sent = closed;
    const result = await sendOrder(api, exitOrder(job, fresh));
    if (result.status !== 'filled') throw new OrderNotFilledError(`${job.reason} exit of ${job.symbol} came back ${result.status}`);
    return this.complete(job, closed, result);
  }

  private closedFrom(position: PaperExchangePosition, cap?: number): ClosedPosition {
    const meta = this.host.store.getMeta(position.symbol);
    const initialRisk = meta?.initialRisk ?? undefined;
    return {
      symbol: position.symbol, owner: meta?.owner ?? EXTERNAL_OWNER, side: sideOf(position),
      entry: position.averagePrice, qty: cap === undefined ? position.netQuantity : Math.min(cap, position.netQuantity), initialRisk,
      ...(meta?.decisionId === undefined ? {} : { decisionId: meta.decisionId }),
    };
  }

  private async dropAlreadyFlat(job: ExitJob): Promise<void> {
    this.jobs.delete(job.symbol);
    await this.host.afterOrder();
  }

  private async complete(job: ExitJob, sized: ClosedPosition, result: SubmitOrderResult): Promise<void> {
    const closed = { ...sized, qty: filledQuantity(result) ?? sized.qty };
    const trade = closedTrade(closed, job.price, job.reason, this.host.now());
    const meta = this.host.store.getMeta(job.symbol);
    if (job.reason === 'PARTIAL TP') this.host.store.recordPartial(trade);
    else this.host.store.recordClose(trade);
    if (ANNOUNCED_REASONS.includes(job.reason)) {
      this.announcements.push(`${job.reason} ${job.symbol} ${closed.side} @ ${formatPrice(job.symbol, job.price)} pnl=${trade.pnl.toFixed(2)}`);
    }
    if (job.reason !== 'PARTIAL TP') await this.keepResidualManaged(closed, meta);
    try {
      await this.host.afterOrder();
    } finally {
      this.jobs.delete(job.symbol);
    }
  }

  /** An outsider can add to the position between the exit's read and its fill; the exit closes only its own size and the rest keeps its owner and levels. */
  private async keepResidualManaged(closed: ClosedPosition, meta: PositionMeta | undefined): Promise<void> {
    if (!meta || meta.external) return;
    try {
      const positions = await this.host.api.getPositions();
      const isHeld = positions.some((p) => p.symbol === closed.symbol && p.netQuantity > 0 && sideOf(p) === closed.side);
      // No lastSeen: the next sync fills it from the real residual instead of the pre-exit size.
      if (isHeld) this.host.store.setMeta(closed.symbol, {
        owner: meta.owner, stopLoss: meta.stopLoss, takeProfit: meta.takeProfit,
        initialRisk: meta.initialRisk, openedAt: this.host.now(),
        ...(meta.decisionId === undefined ? {} : { decisionId: meta.decisionId }),
      });
    } catch (err) {
      // Restoring a meta for a position that may be gone would journal a phantom close; an unverified residual is adopted as external instead.
      this.host.recordError(`exit ${closed.symbol}: residual check failed: ${errorText(err)}`);
    }
  }
}

/** A stop that was never sent must not fill at a better price than the market has since moved to. */
function repricedStop(job: ExitJob, side: 'long' | 'short', mark: number | undefined): number {
  if (job.reason !== 'STOP LOSS' || mark === undefined || !(mark > 0)) return job.trigger;
  return side === 'long' ? Math.min(job.trigger, mark) : Math.max(job.trigger, mark);
}

const filledQuantity = (result: SubmitOrderResult): number | undefined =>
  'filledQuantity' in result && typeof result.filledQuantity === 'number' && result.filledQuantity > 0 ? result.filledQuantity : undefined;

function exitOrder(job: ExitJob, position: PaperExchangePosition): SubmitOrderParams {
  return {
    symbol: job.symbol,
    side: position.side === 'long' ? 'sell' : 'buy',
    quantity: job.qty === undefined ? position.netQuantity : Math.min(job.qty, position.netQuantity),
    leverage: position.leverage,
    marginType: position.marginType,
    reduceOnly: true,
    executionPrice: job.price,
    clientOrderId: job.clientOrderId,
  };
}
