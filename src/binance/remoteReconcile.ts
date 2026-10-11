import type { ExitReason } from '../types.js';
import type { ExchangeRiskEvent, PaperExchangePosition } from './paperExchangeClient.js';
import { entryMeta, entrySide, type OpenParams } from './remoteOrders.js';
import {
  closedTrade, EXTERNAL_OWNER, liquidationMarkSince, seenFrom, sideOf,
  type LastSeen, type PositionMeta, type RemoteStore,
} from './remoteState.js';

export interface ReconcileHost {
  store: RemoteStore;
  now(): number;
  markOf(symbol: string): number | undefined;
  /** An order in flight makes the position look adopted, vanished or flipped for a moment; that order does its own bookkeeping. */
  isBusy(symbol: string): boolean;
}

// The broker lists only its latest 200 orders, so an order that looked lost may still land much later.
const EXPECTED_OPEN_TTL_MS = 10 * 60_000;

interface ExpectedOpen {
  params: OpenParams;
  sentAt: number;
}

/** Aligns the sidecar with a fresh exchange snapshot: journals positions that ended off-agent and adopts ones nobody owns. */
export class RemoteReconciler {
  private readonly expectedOpens = new Map<string, ExpectedOpen>();

  constructor(private readonly host: ReconcileHost) {}

  /** Remembers an entry whose outcome could not be confirmed, so a late-appearing position is adopted with its levels instead of as external. */
  expectOpen(params: OpenParams): void {
    this.expectedOpens.set(params.symbol, { params, sentAt: this.host.now() });
  }

  forgetOpen(symbol: string): void {
    this.expectedOpens.delete(symbol);
  }

  /** True when a sidecar position is missing from `positions`: only then is the exchange's risk-event list worth fetching. */
  hasVanished(positions: PaperExchangePosition[]): boolean {
    const open = new Set(positions.map((p) => p.symbol));
    return Object.keys(this.host.store.metas()).some((symbol) => !open.has(symbol));
  }

  /** `previous` is the snapshot applied before this one; call with no await between it and the cache swap. */
  apply(previous: PaperExchangePosition[], positions: PaperExchangePosition[], events: ExchangeRiskEvent[]): void {
    this.pruneExpiredOpens();
    const before = new Map(previous.map((p) => [p.symbol, p]));
    const open = new Set(positions.map((p) => p.symbol));
    for (const [symbol, meta] of Object.entries(this.host.store.metas())) {
      if (!open.has(symbol) && !this.host.isBusy(symbol)) this.settleVanished(symbol, meta, before.get(symbol), events);
    }
    for (const current of positions) {
      if (!this.host.isBusy(current.symbol)) this.reconcileOpen(current, before.get(current.symbol));
      this.host.store.updateLastSeen(current.symbol, seenFrom(current, this.host.markOf(current.symbol)));
    }
  }

  private reconcileOpen(current: PaperExchangePosition, before: PaperExchangePosition | undefined): void {
    const meta = this.host.store.getMeta(current.symbol);
    if (!meta) return this.adoptUnowned(current);
    // After a restart there is no in-memory snapshot; the persisted one is what an outsider's flip while offline must be compared to.
    const seen = before ? seenFrom(before, this.host.markOf(before.symbol)) : meta.lastSeen;
    if (seen && seen.side !== sideOf(current)) {
      this.journal(current.symbol, meta, seen, { exit: seen.mark, reason: 'CLOSE' });
      this.adoptUnowned(current);
    }
  }

  private settleVanished(symbol: string, meta: PositionMeta, before: PaperExchangePosition | undefined, events: ExchangeRiskEvent[]): void {
    const seen = before ? seenFrom(before, this.host.markOf(before.symbol)) : meta.lastSeen;
    if (seen === undefined) {
      // No entry/qty to price the close with (sidecar predates lastSeen); the exchange gives no trade history to rebuild it.
      this.host.store.notice(`${symbol} vanished while the agent was offline; dropping its sidecar entry without a journal record`);
      this.host.store.deleteMeta(symbol);
      return;
    }
    const liquidation = liquidationMarkSince(events, symbol, meta.openedAt);
    const exit = liquidation && liquidation.mark > 0 ? liquidation.mark : seen.mark;
    this.journal(symbol, meta, seen, { exit, reason: liquidation ? 'LIQUIDATED' : 'CLOSE' });
  }

  private journal(symbol: string, meta: PositionMeta, seen: LastSeen, outcome: { exit: number; reason: ExitReason }): void {
    const closed = {
      symbol, owner: meta.owner, side: seen.side, entry: seen.entry, qty: seen.qty,
      initialRisk: meta.initialRisk ?? undefined,
      ...(meta.decisionId === undefined ? {} : { decisionId: meta.decisionId }),
    };
    this.host.store.recordClose(closedTrade(closed, outcome.exit, outcome.reason, this.host.now()));
  }

  private pruneExpiredOpens(): void {
    for (const [symbol, expected] of this.expectedOpens) {
      if (this.host.now() - expected.sentAt >= EXPECTED_OPEN_TTL_MS) this.expectedOpens.delete(symbol);
    }
  }

  private adoptUnowned(current: PaperExchangePosition): void {
    const expected = this.expectedOpens.get(current.symbol);
    if (!expected || entrySide(expected.params) !== sideOf(current)) return this.adoptAsExternal(current.symbol);
    this.expectedOpens.delete(current.symbol);
    this.host.store.notice(`${current.symbol} matches an unconfirmed open by ${expected.params.strategy}; adopting it with the requested levels`);
    this.host.store.setMeta(current.symbol, entryMeta(expected.params, expected.sentAt));
  }

  private adoptAsExternal(symbol: string): void {
    this.host.store.notice(`${symbol} has no strategy owner; adopting it as external ${EXTERNAL_OWNER}`);
    this.host.store.setMeta(symbol, { owner: EXTERNAL_OWNER, stopLoss: null, takeProfit: null, initialRisk: null, openedAt: this.host.now(), external: true });
  }
}
