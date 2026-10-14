import type { ExitReason, Tick } from '../domain/types.js';
import { calculateTrailingStop, roundDownToTick, roundUpToTick } from '../options/pricing.js';
import type { Logger } from '../ops/logger.js';
import { toPaise, type OpenEntryResult, type PaperOrderRecord, type PaperPositionRecord, type PaperStore } from './paperStore.js';
import type { EntryOrder, ExecutionEvent, ExecutionListener, ExecutionPort, ExitOrder } from './ports.js';

export interface PostgresPaperOptions {
  readonly clientId: string;
  readonly slippageBps: number;
  /** Starting capital, used once, when the wallet is first created. */
  readonly initialCapitalInr: number;
  readonly logger: Logger;
  readonly now?: () => number;
}

interface OpenPosition extends Omit<PaperPositionRecord, 'stopLossPrice'> {
  stopLossPrice: number;
  /** Set while an exit is being recorded, so a stop, a target and an agent exit cannot close the same position twice. */
  exiting: boolean;
  initialStopPrice?: number | undefined;
  highWaterMark?: number | undefined;
  trailingJump?: number | undefined;
  breakevenAtRr?: number | undefined;
  runner?: boolean | undefined;
}

/**
 * Paper venue whose state is durable. Market data is real; orders are simulated; the wallet, orders, positions and
 * P&L are in PostgreSQL, so a restart resumes with the same cash and the same open positions.
 *
 * Ordering rule: the database write happens before the event is emitted. A fill the agent sees is always a fill
 * the database holds. If the write fails, the event is an UNCONFIRMED state, which halts the agent, and nothing
 * is emitted as a fill.
 *
 * Fill model: as the in-memory paper venue, with the same slippage and bracket rules. Queue position, partial
 * fills and exchange freeze limits are not modelled.
 */
export class PostgresPaperExecutionPort implements ExecutionPort {
  readonly mode = 'paper' as const;
  private readonly listeners = new Set<ExecutionListener>();
  private readonly positions = new Map<string, OpenPosition>();
  private readonly now: () => number;
  private opened = false;

  constructor(
    private readonly store: PaperStore,
    private readonly options: PostgresPaperOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Creates the wallet if needed and loads the open positions. Must complete before any order. */
  async open(): Promise<void> {
    await this.store.ensureWallet(this.options.clientId, this.options.initialCapitalInr);
    for (const position of await this.store.openPositions(this.options.clientId)) {
      this.positions.set(position.positionId, { ...position, exiting: false });
    }
    this.opened = true;
    this.options.logger.info('paper venue ready', {
      clientId: this.options.clientId,
      openPositions: this.positions.size,
      cashInr: await this.store.balance(this.options.clientId),
    });
  }

  /** Cash in the wallet. The entry sizing and the funds check read this. */
  cash(): Promise<number> {
    return this.store.balance(this.options.clientId);
  }

  /** Open positions the venue holds. */
  openPositionCount(): number {
    return this.positions.size;
  }

  /** Read-only snapshot of open positions held by the venue, used to adopt on startup. */
  getOpenPositions(): readonly PaperPositionRecord[] {
    return [...this.positions.values()];
  }

  onEvent(listener: ExecutionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async submitEntry(order: EntryOrder): Promise<void> {
    this.assertOpened();
    const at = this.now();
    const price = roundUpToTick(order.entryReference * (1 + this.options.slippageBps / 10_000), order.contract.tickSize);
    const position: PaperPositionRecord = {
      positionId: order.correlationId,
      clientId: this.options.clientId,
      underlying: order.underlying,
      securityId: order.contract.securityId,
      exchangeSegment: order.contract.exchangeSegment,
      tickSize: order.contract.tickSize,
      quantity: order.quantity,
      averagePrice: price,
      stopLossPrice: order.stopLossPrice,
      targetPrice: order.targetPrice,
      openedAt: at,
    };
    const record: PaperOrderRecord = {
      correlationId: order.correlationId,
      positionId: order.correlationId,
      kind: 'ENTRY',
      side: 'BUY',
      quantity: order.quantity,
      price,
      reason: undefined,
      at,
    };

    let outcome: OpenEntryResult;
    try {
      outcome = await this.store.openPosition({ position, order: record, debitInr: debitOf(position) });
    } catch (error) {
      this.emit({
        kind: 'ENTRY_UNCONFIRMED',
        correlationId: order.correlationId,
        underlying: order.underlying,
        reason: `paper venue could not record the entry: ${describe(error)}`,
      });
      return;
    }
    if (outcome === 'INSUFFICIENT_CASH') {
      this.emit({ kind: 'ENTRY_REJECTED', correlationId: order.correlationId, underlying: order.underlying, reason: 'insufficient paper cash' });
      return;
    }
    if (outcome === 'DUPLICATE') {
      this.emit({ kind: 'ENTRY_REJECTED', correlationId: order.correlationId, underlying: order.underlying, reason: 'duplicate correlation id' });
      return;
    }
    this.positions.set(position.positionId, {
      ...position,
      initialStopPrice: order.stopLossPrice,
      highWaterMark: price,
      trailingJump: order.trailingJump,
      breakevenAtRr: order.breakevenAtRr,
      runner: order.runner,
      exiting: false,
    });
    this.emit({
      kind: 'ENTRY_FILLED',
      correlationId: order.correlationId,
      underlying: order.underlying,
      quantity: order.quantity,
      averagePrice: price,
      at,
    });
  }

  async submitExit(order: ExitOrder): Promise<void> {
    this.assertOpened();
    const position = this.positions.get(order.positionId);
    if (position === undefined) {
      this.emit({
        kind: 'EXIT_REJECTED',
        correlationId: order.correlationId,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: 'no open paper position with this id',
      });
      return;
    }
    if (position.exiting) {
      this.emit({
        kind: 'EXIT_REJECTED',
        correlationId: order.correlationId,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: 'an exit for this position is already being recorded',
      });
      return;
    }
    if (order.quantity < position.quantity) {
      this.emit({
        kind: 'EXIT_REJECTED',
        correlationId: order.correlationId,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: 'partial paper exits are not modelled; the position closes whole',
      });
      return;
    }
    position.exiting = true;
    const price = roundDownToTick(order.referencePrice * (1 - this.options.slippageBps / 10_000), position.tickSize);
    const at = this.now();
    try {
      await this.recordClose(position, {
        correlationId: order.correlationId,
        positionId: position.positionId,
        kind: 'EXIT',
        side: 'SELL',
        quantity: position.quantity,
        price,
        reason: order.reason,
        at,
      }, price, order.reason);
    } catch (error) {
      position.exiting = false;
      this.emit({
        kind: 'EXIT_UNCONFIRMED',
        correlationId: order.correlationId,
        underlying: order.underlying,
        positionId: order.positionId,
        reason: `paper venue could not record the exit: ${describe(error)}`,
      });
      return;
    }
    this.emit({
      kind: 'EXIT_FILLED',
      correlationId: order.correlationId,
      underlying: order.underlying,
      positionId: order.positionId,
      quantity: position.quantity,
      averagePrice: price,
      reason: order.reason,
      at,
    });
  }

  /** Stop and target are enforced against the option's live LTP, as the in-memory paper venue does. */
  onOptionTick(tick: Tick): void {
    for (const position of [...this.positions.values()]) {
      if (position.exiting || position.securityId !== tick.securityId || position.exchangeSegment !== tick.exchangeSegment) {
        continue;
      }
      if (position.trailingJump !== undefined && position.trailingJump > 0) {
        position.highWaterMark = Math.max(position.highWaterMark ?? position.averagePrice, tick.ltp);
        position.stopLossPrice = calculateTrailingStop({
          entryPrice: position.averagePrice,
          initialStopPrice: position.initialStopPrice ?? position.stopLossPrice,
          currentStopPrice: position.stopLossPrice,
          highWaterMark: position.highWaterMark,
          trailingJump: position.trailingJump,
          breakevenAtRr: position.breakevenAtRr,
          tickSize: Number(position.tickSize),
        });
      }
      let reason: ExitReason | undefined;
      let fill = 0;
      if (tick.ltp <= position.stopLossPrice) {
        reason = 'STOP_LOSS';
        fill = Math.min(tick.ltp, position.stopLossPrice);
      } else if (!position.runner && tick.ltp >= position.targetPrice) {
        reason = 'TARGET';
        fill = position.targetPrice;
      }
      if (reason === undefined) {
        continue;
      }
      position.exiting = true;
      const at = tick.ltt;
      const exitReason = reason;
      this.recordClose(position, {
        correlationId: `${position.positionId}:${exitReason}`,
        positionId: position.positionId,
        kind: 'PROTECTIVE_EXIT',
        side: 'SELL',
        quantity: position.quantity,
        price: fill,
        reason: exitReason,
        at,
      }, fill, exitReason)
        .then(() => {
          this.emit({
            kind: 'PROTECTIVE_EXIT_FILLED',
            underlying: position.underlying,
            positionId: position.positionId,
            quantity: position.quantity,
            averagePrice: fill,
            reason: exitReason,
            at,
          });
        })
        .catch((error: unknown) => {
          position.exiting = false;
          this.emit({
            kind: 'BROKER_MISMATCH',
            underlying: position.underlying,
            positionId: position.positionId,
            reason: `paper venue could not record a ${exitReason} exit; the position is still open in the database: ${describe(error)}`,
          });
        });
    }
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.positions.clear();
  }

  /**
   * Writes the close and updates the in-memory position only after the database accepted it. A NOT_OPEN answer
   * means another path already closed the position, which must not happen silently, so it is an error.
   */
  private async recordClose(position: OpenPosition, order: PaperOrderRecord, price: number, reason: string): Promise<void> {
    const credit = toPaise(price * position.quantity);
    const debit = debitOf(position);
    const outcome = await this.store.closePosition({
      clientId: this.options.clientId,
      positionId: position.positionId,
      order,
      creditInr: credit,
      exitPrice: price,
      exitReason: reason,
      realizedPnlInr: toPaise(credit - debit),
      at: order.at,
    });
    if (outcome !== 'CLOSED') {
      throw new Error('the position was already closed in the database');
    }
    this.positions.delete(position.positionId);
  }

  private assertOpened(): void {
    if (!this.opened) {
      throw new Error('paper venue used before open(); the wallet and positions are not loaded');
    }
  }

  /** Emits outside the caller's stack so the agent never re-enters its own transition in progress. */
  private emit(event: ExecutionEvent): void {
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener(event);
      }
    });
  }
}

/** What the entry cost in rupees. Recomputed from the stored average price, so the close credits the same amount it debited. */
function debitOf(position: Pick<PaperPositionRecord, 'averagePrice' | 'quantity'>): number {
  return toPaise(position.averagePrice * position.quantity);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
}
