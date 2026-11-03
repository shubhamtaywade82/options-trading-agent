import {
  ApiResponseError,
  OrderTracker,
  ValidationError,
  type DhanClient,
  type OrderOutcome,
  type OrderState,
} from '@nemesis-oss/dhanhq-sdk';
import type { InstrumentRef, Tick } from '../domain/types.js';
import type { EntryOrder, ExecutionEvent, ExecutionListener, ExecutionPort, ExitOrder } from '../execution/ports.js';
import type { Logger } from '../ops/logger.js';
import { fitsBrokerLimit } from '../execution/brokerIds.js';

export type LiveClient = Pick<DhanClient, 'orders' | 'superOrders' | 'positions' | 'traderControls'> & {
  readonly ws: Pick<DhanClient['ws'], 'orders'>;
};

type PositionRow = Awaited<ReturnType<DhanClient['positions']['list']>>[number];

export interface LiveExecutionOptions {
  /** Which Dhan account the orders reach. Stamped on every event through the port's mode, so a sandbox order is never journalled as live. */
  readonly mode: 'live' | 'sandbox';
  readonly orderTimeoutMs: number;
  readonly reconcileIntervalMs: number;
  readonly logger: Logger;
  readonly now?: () => number;
}

type BracketLeg = 'STOP_LOSS_LEG' | 'TARGET_LEG';

/** One instrument's buy and sell totals for the day, as the broker's position row reports them. */
interface DayTotals {
  readonly buyQty: number;
  readonly buyValue: number;
  readonly sellQty: number;
  readonly sellValue: number;
}

const NO_DAY_TOTALS: DayTotals = { buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0 };

function dayTotals(row: PositionRow | undefined): DayTotals {
  return {
    buyQty: row?.dayBuyQty ?? 0,
    buyValue: row?.dayBuyValue ?? 0,
    sellQty: row?.daySellQty ?? 0,
    sellValue: row?.daySellValue ?? 0,
  };
}

/**
 * What one side traded since `baseline`. Dhan's position row sums the whole day per instrument, so an earlier
 * round trip in the same contract would otherwise blend into this trade's quantity and average price.
 */
export function fillSince(
  row: PositionRow | undefined,
  baseline: DayTotals,
  side: 'BUY' | 'SELL',
): { quantity: number; averagePrice: number } | undefined {
  const totals = dayTotals(row);
  const quantity = side === 'BUY' ? totals.buyQty - baseline.buyQty : totals.sellQty - baseline.sellQty;
  const value = side === 'BUY' ? totals.buyValue - baseline.buyValue : totals.sellValue - baseline.sellValue;
  if (!(quantity > 0) || !(value > 0)) {
    return undefined;
  }
  return { quantity, averagePrice: value / quantity };
}

/** The agent's own row for an instrument. Dhan reports one row per product, and the agent trades INTRADAY only. */
function ownRow(rows: readonly PositionRow[], ref: InstrumentRef): PositionRow | undefined {
  return rows.find(
    (row) =>
      String(row.securityId) === ref.securityId &&
      String(row.exchangeSegment) === ref.exchangeSegment &&
      (row.productType === undefined || String(row.productType) === 'INTRADAY'),
  );
}

interface TrackedPosition {
  readonly positionId: string;
  readonly underlying: string;
  readonly ref: InstrumentRef;
  readonly createdAt: number;
  /** The entry limit. A fill is never above it, so it stands in for a missing buy price. */
  readonly entryReference: number;
  /** The bracket's worst exit. It stands in for a missing sell price, never a whole-premium loss. */
  readonly stopLossPrice: number;
  /** Day totals before the entry was sent, so this trade's fills can be told from earlier ones. */
  readonly baseline: DayTotals;
  quantity: number;
  orderId: string | undefined;
  confirmed: boolean;
  exitInFlight: boolean;
  /**
   * Set before a SELL is written and cleared only by a definitive outcome (a broker rejection, or a no-fill terminal
   * status). While it is set, the SELL may be live at the broker, so no second SELL is sent. Reconciliation still
   * settles the position from the broker.
   */
  exitOutcomeUnknown: boolean;
  mismatchReported: boolean;
  /** Legs whose cancel request the broker accepted. A retry requests only the rest; the order book confirms them. */
  cancelledLegs: Set<BracketLeg>;
}

const LEG_CANCEL_ATTEMPTS = 3;
const LEG_CANCEL_BACKOFF_MS = 250;
/** An accepted cancel is not a cancelled leg. The super order book is polled this many times for a terminal status. */
const LEG_STATUS_POLLS = 8;
const LEG_STATUS_POLL_MS = 250;
const TERMINAL_ORDER_STATUSES = new Set(['CANCELLED', 'TRADED', 'REJECTED', 'EXPIRED', 'CLOSED']);

type SuperOrderRow = Awaited<ReturnType<DhanClient['superOrders']['list']>>[number];

/**
 * Bracket legs of `orderId` that could still fire, from the super order book. Undefined when the order is not in
 * the book. A leg missing from `legDetails` counts as live: absence is not proof it was cancelled.
 */
/** True when the super order book shows the entry settled, or never shows it at all. A live order keeps tracking. */
export function entrySettledInBook(book: readonly SuperOrderRow[], orderId: string | undefined, correlationId: string): boolean {
  const order = book.find((row) => (orderId !== undefined && String(row.orderId) === orderId) || row.correlationId === correlationId);
  return order === undefined || TERMINAL_ORDER_STATUSES.has(String(order.orderStatus));
}

export function liveBracketLegs(book: readonly SuperOrderRow[], orderId: string): BracketLeg[] | undefined {
  const order = book.find((row) => String(row.orderId) === orderId);
  if (order === undefined) {
    return undefined;
  }
  // The entry leg is TRADED while its bracket is live, so only a closed or dead parent ends the legs with it.
  if (order.orderStatus !== 'TRADED' && TERMINAL_ORDER_STATUSES.has(String(order.orderStatus))) {
    return [];
  }
  const details = Array.isArray(order['legDetails']) ? (order['legDetails'] as Array<Record<string, unknown>>) : [];
  return (['STOP_LOSS_LEG', 'TARGET_LEG'] as const).filter((leg) => {
    const detail = details.find((row) => row['legName'] === leg);
    return detail === undefined || !TERMINAL_ORDER_STATUSES.has(String(detail['orderStatus']));
  });
}

/**
 * An unconfirmed entry is dropped only after this long, and only once the order book shows it settled or absent.
 * The wait covers an order the broker accepted but has not listed yet.
 */
const UNCONFIRMED_ENTRY_RETENTION_MS = 10 * 60_000;

/**
 * Classifies a failed placement. Only errors that prove the order never reached
 * the matching engine are REJECTED; anything ambiguous (timeouts, 5xx, 429,
 * 401, network) is UNCONFIRMED, which halts trading until the order is resolved.
 */
export function classifyPlacementError(error: unknown): 'REJECTED' | 'UNCONFIRMED' {
  if (error instanceof ValidationError) {
    return 'REJECTED';
  }
  const status = error instanceof ApiResponseError ? error.status : undefined;
  if (status !== undefined && status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
    return 'REJECTED';
  }
  return 'UNCONFIRMED';
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 240) : String(error).slice(0, 240);
}

/**
 * Live venue on DhanHQ. Entries are INTRADAY super orders, so the exchange
 * holds the stop and target legs server-side even if this process dies.
 *
 * Invariants:
 *  - Fills are confirmed from the order-update stream, never assumed from the HTTP response.
 *  - An exit SELL is sent only after the broker reports a net long quantity, and never for more than that.
 *  - Any ambiguous write is reported as UNCONFIRMED and is never replayed.
 *
 * Unverified assumption (flagged in the README): cancelling the STOP_LOSS_LEG
 * and TARGET_LEG of a super order is how a live bracket is detached before a
 * manual exit, and that the super order book lists each leg under `legDetails`
 * with `legName` and `orderStatus`. The SDK types neither, so this path must be
 * validated in a sandbox before live use.
 */
export class LiveExecutionPort implements ExecutionPort {
  readonly mode: 'live' | 'sandbox';
  private readonly listeners = new Set<ExecutionListener>();
  private readonly tracker = new OrderTracker();
  private readonly tracked = new Map<string, TrackedPosition>();
  private readonly terminalEmitted = new Set<string>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly client: LiveClient,
    private readonly options: LiveExecutionOptions,
  ) {
    this.mode = options.mode;
    this.now = options.now ?? Date.now;
    client.ws.orders.on('order', (state: OrderState) => this.tracker.onOrderUpdate(state));
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.reconcile();
    }, this.options.reconcileIntervalMs);
    this.timer.unref?.();
  }

  onEvent(listener: ExecutionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Live stops are enforced by the exchange; option ticks do not drive fills here. */
  onOptionTick(_tick: Tick): void {
    return;
  }

  async submitEntry(order: EntryOrder): Promise<void> {
    const cid = order.correlationId;
    if (!fitsBrokerLimit(cid)) {
      this.emit({ kind: 'ENTRY_REJECTED', correlationId: cid, underlying: order.underlying, reason: `correlation id of ${cid.length} characters exceeds the broker limit; not sent` });
      return;
    }
    const baseline = await this.dayTotalsBefore(order);
    const waiter = this.tracker.waitFor(cid, { timeoutMs: this.options.orderTimeoutMs });
    waiter.catch(() => undefined);

    let orderId: string | undefined;
    try {
      const placed = await this.client.superOrders.place({
        correlationId: cid,
        transactionType: 'BUY',
        exchangeSegment: order.contract.exchangeSegment,
        productType: 'INTRADAY',
        // A marketable limit: the stop and target are fixed prices sized off this one, so a fill above it
        // would widen the risk past the budget.
        orderType: 'LIMIT',
        price: order.entryReference,
        quantity: order.quantity,
        securityId: order.contract.securityId,
        targetPrice: order.targetPrice,
        stopLossPrice: order.stopLossPrice,
        ...(order.trailingJump !== undefined && order.trailingJump > 0 ? { trailingJump: order.trailingJump } : {}),
      });
      orderId = placed.data.orderId;
    } catch (error) {
      const verdict = classifyPlacementError(error);
      const reason = describeError(error);
      this.options.logger.error('entry placement failed', { cid, verdict, reason });
      if (verdict === 'UNCONFIRMED') {
        this.track(order, undefined, baseline);
        this.emitTerminal(`entry:${cid}`, { kind: 'ENTRY_UNCONFIRMED', correlationId: cid, underlying: order.underlying, reason });
      } else {
        this.emitTerminal(`entry:${cid}`, { kind: 'ENTRY_REJECTED', correlationId: cid, underlying: order.underlying, reason });
      }
      return;
    }

    this.track(order, orderId, baseline);
    void this.awaitEntry(order, this.settleUnfilledEntry(order, orderId, waiter));
  }

  /**
   * A limit entry that has not reached a terminal status in time is cancelled, and its final status is awaited.
   * The second waiter is registered before the cancel, so the CANCELLED update cannot slip past it.
   * If the cancel fails, the outcome stays unknown and the waiter's rejection reports it as UNCONFIRMED.
   */
  private async settleUnfilledEntry(order: EntryOrder, orderId: string, waiter: Promise<OrderOutcome>): Promise<OrderOutcome> {
    try {
      return await waiter;
    } catch (timeout) {
      const settled = this.tracker.waitFor(order.correlationId, { timeoutMs: this.options.orderTimeoutMs });
      settled.catch(() => undefined);
      try {
        await this.client.superOrders.cancel({ orderId, orderLeg: 'ENTRY_LEG' });
      } catch (error) {
        this.options.logger.error('unfilled entry cancel failed', { cid: order.correlationId, error: describeError(error) });
        throw timeout;
      }
      return settled;
    }
  }

  async submitExit(order: ExitOrder): Promise<void> {
    if (!fitsBrokerLimit(order.correlationId)) {
      this.emit({
        kind: 'EXIT_REJECTED',
        correlationId: order.correlationId,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: `correlation id of ${order.correlationId.length} characters exceeds the broker limit; not sent`,
      });
      return;
    }
    const tracked = this.tracked.get(order.positionId);
    if (tracked === undefined) {
      this.emit({
        kind: 'EXIT_REJECTED',
        correlationId: order.correlationId,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: 'no tracked live position with this id',
      });
      return;
    }

    tracked.exitInFlight = true;
    let handedOff = false;
    try {
      // Order matters. Read first: if the position cannot be read, nothing is cancelled and the stop keeps protecting it.
      const first = await this.brokerPosition(tracked.ref);
      if (first === undefined) {
        this.emit({
          kind: 'EXIT_UNCONFIRMED',
          correlationId: order.correlationId,
          underlying: order.underlying,
          positionId: order.positionId,
          reason: 'broker positions unavailable; nothing cancelled, the position keeps its protective legs',
        });
        return;
      }
      if (first.netQty < 0) {
        this.reportMismatch(tracked, `broker shows net short ${first.netQty}; refusing to send exit`);
        return;
      }
      if (first.netQty === 0) {
        this.reportFlatAtBroker(tracked, first.row);
        return;
      }

      // A SELL whose outcome is unknown may still be live. A second one could sell the same quantity twice.
      if (tracked.exitOutcomeUnknown) {
        this.emit({
          kind: 'EXIT_UNCONFIRMED',
          correlationId: order.correlationId,
          underlying: order.underlying,
          positionId: order.positionId,
          reason: 'an earlier SELL for this position has no known outcome; not resent. Reconciliation settles it from the broker position',
        });
        return;
      }

      // A SELL is never sent while a leg could still fire. A cancel that errors may mean the leg already traded,
      // so the order book decides, not the cancel response.
      await this.cancelBracketLegsWithRetry(tracked);
      if (!(await this.awaitLegsTerminal(tracked))) {
        this.emit({
          kind: 'EXIT_UNCONFIRMED',
          correlationId: order.correlationId,
          underlying: order.underlying,
          positionId: order.positionId,
          reason: 'protective legs not confirmed terminal by the broker; exit not sent',
        });
        return;
      }

      // A leg may have filled while it was being cancelled. The position is read again, and the SELL is sized to what is still held.
      const broker = await this.brokerPosition(tracked.ref);
      if (broker === undefined) {
        this.emit({
          kind: 'EXIT_UNCONFIRMED',
          correlationId: order.correlationId,
          underlying: order.underlying,
          positionId: order.positionId,
          reason: 'broker positions unavailable after cancelling the legs; exit not sent',
        });
        return;
      }
      if (broker.netQty < 0) {
        this.reportMismatch(tracked, `broker shows net short ${broker.netQty} after cancelling the legs; refusing to send exit`);
        return;
      }
      if (broker.netQty === 0) {
        this.reportFlatAtBroker(tracked, broker.row);
        return;
      }

      const quantity = Math.min(order.quantity, broker.netQty);
      const waiter = this.tracker.waitFor(order.correlationId, { timeoutMs: this.options.orderTimeoutMs });
      waiter.catch(() => undefined);
      // Set before the write. From here until a definitive outcome, the SELL may be live at the broker.
      tracked.exitOutcomeUnknown = true;
      await this.client.orders.place({
        correlationId: order.correlationId,
        transactionType: 'SELL',
        exchangeSegment: order.contract.exchangeSegment,
        productType: 'INTRADAY',
        orderType: 'MARKET',
        validity: 'DAY',
        quantity,
        securityId: order.contract.securityId,
      });
      handedOff = true;
      void this.awaitExit(order, tracked, quantity, waiter);
    } catch (error) {
      const verdict = classifyPlacementError(error);
      this.options.logger.error('exit placement failed', { cid: order.correlationId, verdict, reason: describeError(error) });
      // A definitive rejection means the SELL never reached the matching engine, so nothing is outstanding.
      if (verdict === 'REJECTED') {
        tracked.exitOutcomeUnknown = false;
      }
      this.emit({
        kind: verdict === 'REJECTED' ? 'EXIT_REJECTED' : 'EXIT_UNCONFIRMED',
        correlationId: order.correlationId,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: describeError(error),
      });
    } finally {
      if (!handedOff) {
        tracked.exitInFlight = false;
      }
    }
  }

  /**
   * Disengages all trading for the day at the broker, and reads the switch back. Rejects unless the broker
   * reports it active, so the caller can retry: a request Dhan accepted is not proof the switch is on.
   */
  async engageBrokerKillSwitch(reason: string): Promise<void> {
    await this.client.traderControls.setKillSwitch('ACTIVATE');
    const status = (await this.client.traderControls.getKillSwitchStatus()).killSwitchStatus;
    if (status !== 'ACTIVATE') {
      throw new Error(`kill switch status read back ${status ?? 'missing'} after ACTIVATE`);
    }
    this.options.logger.warn('broker kill switch activated', { reason });
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.tracker.clear();
    this.listeners.clear();
  }

  /**
   * The instrument's day totals before the entry. A failed read is not a reason to skip the entry: it falls back
   * to zero, which is exact unless this contract was already traded today.
   */
  private async dayTotalsBefore(order: EntryOrder): Promise<DayTotals> {
    try {
      const rows = await this.client.positions.list();
      return dayTotals(ownRow(rows, { exchangeSegment: order.contract.exchangeSegment, securityId: order.contract.securityId }));
    } catch (error) {
      this.options.logger.warn('positions read before entry failed; fills are read from whole-day totals', {
        cid: order.correlationId,
        error: describeError(error),
      });
      return NO_DAY_TOTALS;
    }
  }

  private track(order: EntryOrder, orderId: string | undefined, baseline: DayTotals): void {
    this.tracked.set(order.correlationId, {
      positionId: order.correlationId,
      underlying: order.underlying,
      ref: { exchangeSegment: order.contract.exchangeSegment, securityId: order.contract.securityId },
      createdAt: this.now(),
      entryReference: order.entryReference,
      stopLossPrice: order.stopLossPrice,
      baseline,
      quantity: order.quantity,
      orderId,
      confirmed: false,
      exitInFlight: false,
      exitOutcomeUnknown: false,
      mismatchReported: false,
      cancelledLegs: new Set(),
    });
  }

  private async awaitEntry(order: EntryOrder, waiter: Promise<OrderOutcome>): Promise<void> {
    const cid = order.correlationId;
    try {
      const outcome = await waiter;
      if (outcome.filledQuantity > 0) {
        const tracked = this.tracked.get(cid);
        if (tracked !== undefined) {
          tracked.confirmed = true;
          tracked.quantity = outcome.filledQuantity;
        }
        this.emitTerminal(`entry:${cid}`, {
          kind: 'ENTRY_FILLED',
          correlationId: cid,
          underlying: order.underlying,
          quantity: outcome.filledQuantity,
          averagePrice: outcome.averagePrice ?? order.entryReference,
          at: this.now(),
        });
        return;
      }
      this.tracked.delete(cid);
      this.emitTerminal(`entry:${cid}`, {
        kind: 'ENTRY_REJECTED',
        correlationId: cid,
        underlying: order.underlying,
        reason: `order ${outcome.status} with no fill`,
      });
    } catch (error) {
      this.emitTerminal(`entry:${cid}`, {
        kind: 'ENTRY_UNCONFIRMED',
        correlationId: cid,
        underlying: order.underlying,
        reason: describeError(error),
      });
    }
  }

  private async awaitExit(
    order: ExitOrder,
    tracked: TrackedPosition,
    quantity: number,
    waiter: Promise<OrderOutcome>,
  ): Promise<void> {
    const cid = order.correlationId;
    try {
      const outcome = await waiter;
      if (outcome.status === 'TRADED' && outcome.filledQuantity >= quantity) {
        this.tracked.delete(order.positionId);
        this.emitTerminal(`exit:${cid}`, {
          kind: 'EXIT_FILLED',
          correlationId: cid,
          underlying: order.underlying,
          positionId: order.positionId,
          quantity: outcome.filledQuantity,
          averagePrice: outcome.averagePrice ?? order.referencePrice,
          reason: order.reason,
          at: this.now(),
        });
        return;
      }
      tracked.exitInFlight = false;
      if (outcome.filledQuantity > 0) {
        this.emitTerminal(`exit:${cid}`, {
          kind: 'EXIT_UNCONFIRMED',
          correlationId: cid,
          underlying: order.underlying,
          positionId: order.positionId,
          reason: `partial exit ${outcome.filledQuantity}/${quantity}; remaining position needs manual review`,
        });
        return;
      }
      // A terminal status with no fill is definitive: the SELL is no longer live, so a retry is safe.
      tracked.exitOutcomeUnknown = false;
      this.emitTerminal(`exit:${cid}`, {
        kind: 'EXIT_REJECTED',
        correlationId: cid,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: `exit order ${outcome.status} with no fill`,
      });
    } catch (error) {
      tracked.exitInFlight = false;
      this.emitTerminal(`exit:${cid}`, {
        kind: 'EXIT_UNCONFIRMED',
        correlationId: cid,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: describeError(error),
      });
    }
  }

  /** True once the super order book shows no bracket leg that could still fire. False on timeout or unreadable book. */
  private async awaitLegsTerminal(tracked: TrackedPosition): Promise<boolean> {
    const orderId = tracked.orderId;
    if (orderId === undefined) {
      return false;
    }
    let live: BracketLeg[] | undefined;
    for (let poll = 1; poll <= LEG_STATUS_POLLS; poll += 1) {
      try {
        live = liveBracketLegs(await this.client.superOrders.list(), orderId);
        if (live?.length === 0) {
          return true;
        }
      } catch (error) {
        this.options.logger.warn('super order book read failed', { positionId: tracked.positionId, error: describeError(error) });
      }
      if (poll < LEG_STATUS_POLLS) {
        await new Promise((resolve) => setTimeout(resolve, LEG_STATUS_POLL_MS));
      }
    }
    this.options.logger.error('protective legs not terminal at the broker', { positionId: tracked.positionId, orderId, live: live ?? 'order not in book' });
    return false;
  }

  /** Requests a cancel for every leg not yet accepted. True when every request was accepted, which is not a cancelled leg. */
  private async cancelBracketLegs(tracked: TrackedPosition): Promise<boolean> {
    if (tracked.orderId === undefined) {
      return false;
    }
    let allCancelled = true;
    for (const orderLeg of ['STOP_LOSS_LEG', 'TARGET_LEG'] as const) {
      if (tracked.cancelledLegs.has(orderLeg)) {
        continue;
      }
      try {
        await this.client.superOrders.cancel({ orderId: tracked.orderId, orderLeg });
        tracked.cancelledLegs.add(orderLeg);
      } catch (error) {
        allCancelled = false;
        this.options.logger.warn('protective leg cancel did not succeed', {
          positionId: tracked.positionId,
          orderLeg,
          error: describeError(error),
        });
      }
    }
    return allCancelled;
  }

  private async cancelBracketLegsWithRetry(tracked: TrackedPosition): Promise<void> {
    for (let attempt = 1; attempt <= LEG_CANCEL_ATTEMPTS; attempt += 1) {
      if (await this.cancelBracketLegs(tracked)) {
        return;
      }
      if (attempt < LEG_CANCEL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, LEG_CANCEL_BACKOFF_MS * attempt));
      }
    }
  }

  /** The broker shows no position: the bracket or an earlier exit closed it. Reported as a protective exit. */
  private reportFlatAtBroker(tracked: TrackedPosition, row: PositionRow | undefined): void {
    const sold = fillSince(row, tracked.baseline, 'SELL');
    if (sold === undefined) {
      this.options.logger.warn('closing sell not visible in day totals; booked at the stop price', { positionId: tracked.positionId });
    }
    this.tracked.delete(tracked.positionId);
    this.emitTerminal(`protective:${tracked.positionId}`, {
      kind: 'PROTECTIVE_EXIT_FILLED',
      underlying: tracked.underlying,
      positionId: tracked.positionId,
      quantity: sold?.quantity ?? tracked.quantity,
      averagePrice: sold?.averagePrice ?? tracked.stopLossPrice,
      reason: 'EXTERNAL',
      at: this.now(),
    });
  }

  /** Broker's view of one instrument. Undefined when the read fails or the row is incomplete. */
  private async brokerPosition(ref: InstrumentRef): Promise<{ netQty: number; row: PositionRow | undefined } | undefined> {
    let rows: PositionRow[];
    try {
      rows = await this.client.positions.list();
    } catch (error) {
      this.options.logger.error('positions read failed', { error: describeError(error) });
      return undefined;
    }
    const row = ownRow(rows, ref);
    if (row === undefined) {
      return { netQty: 0, row };
    }
    if (row.netQty === undefined) {
      return undefined;
    }
    return { netQty: row.netQty, row };
  }

  private async reconcile(): Promise<void> {
    if (this.tracked.size === 0) {
      return;
    }
    let rows: PositionRow[];
    try {
      rows = await this.client.positions.list();
    } catch (error) {
      this.options.logger.warn('reconciliation read failed; will retry', { error: describeError(error) });
      return;
    }
    let book: SuperOrderRow[] | undefined;
    for (const tracked of [...this.tracked.values()]) {
      if (tracked.exitInFlight) {
        continue;
      }
      const row = ownRow(rows, tracked.ref);
      const netQty = row?.netQty ?? 0;

      if (netQty < 0) {
        this.reportMismatch(tracked, `reconciliation found net short ${netQty}`);
        continue;
      }
      if (!tracked.confirmed && netQty > 0) {
        tracked.confirmed = true;
        tracked.quantity = netQty;
        this.emitTerminal(`late-fill:${tracked.positionId}`, {
          kind: 'ENTRY_FILLED',
          correlationId: tracked.positionId,
          underlying: tracked.underlying,
          quantity: netQty,
          averagePrice: fillSince(row, tracked.baseline, 'BUY')?.averagePrice ?? tracked.entryReference,
          at: this.now(),
        });
        continue;
      }
      if (tracked.confirmed && netQty === 0) {
        this.reportFlatAtBroker(tracked, row);
        continue;
      }
      if (!tracked.confirmed && this.now() - tracked.createdAt > UNCONFIRMED_ENTRY_RETENTION_MS) {
        book ??= await this.superOrderBook();
        if (book !== undefined && entrySettledInBook(book, tracked.orderId, tracked.positionId)) {
          this.options.logger.warn('unconfirmed entry settled or absent at the broker; tracking dropped', { positionId: tracked.positionId });
          this.tracked.delete(tracked.positionId);
        }
      }
    }
  }

  /** The super order book, or undefined when it cannot be read. */
  private async superOrderBook(): Promise<SuperOrderRow[] | undefined> {
    try {
      return await this.client.superOrders.list();
    } catch (error) {
      this.options.logger.warn('super order book read failed; unconfirmed entries stay tracked', { error: describeError(error) });
      return undefined;
    }
  }

  private reportMismatch(tracked: TrackedPosition, reason: string): void {
    if (tracked.mismatchReported) {
      return;
    }
    tracked.mismatchReported = true;
    this.options.logger.error('broker/local mismatch', { positionId: tracked.positionId, reason });
    this.emit({
      kind: 'BROKER_MISMATCH',
      underlying: tracked.underlying,
      positionId: tracked.positionId,
      reason,
    });
  }

  /** Emits at most one terminal outcome per correlation id, so a late duplicate can never re-drive the FSM. */
  private emitTerminal(key: string, event: ExecutionEvent): void {
    if (this.terminalEmitted.has(key)) {
      return;
    }
    this.terminalEmitted.add(key);
    this.emit(event);
  }

  private emit(event: ExecutionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
