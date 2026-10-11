// Known differences from the real paper_exchange broker; a green test on this fake is not proof about the real one there:
// - Liquidation runs synchronously inside pushMarkPrices and charges no fee; the real broker liquidates asynchronously.
// - Funding ignores the real broker's rule for leverage > 1 and applies to every open row.
// - There is no MAX_POSITIONS gate, so any number of symbols can be open at once.
// - A clientOrderId whose fill was rejected (402/422) is not memoized; the real broker returns the persisted rejected row on replay.

import {
  OrderRejectedError,
  VenueUnavailableError,
  type ExchangeApi,
  type ExchangeRiskEvent,
  type PaperExchangeAccountSnapshot,
  type PaperExchangePosition,
  type SubmitOrderParams,
  type SubmitOrderResult,
} from '../../src/binance/paperExchangeClient.js';

// Measured on the real paper_exchange (see the design spec, "Verified facts").
const TAKER_FEE_RATE = 0.0004;
const LIQUIDATION_BUFFER = 0.004;
// Floating-point dust would otherwise leave a 1e-17 quantity behind after a full close.
const QTY_PRECISION = 1e12;

interface Row {
  id: number;
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entry: number;
  leverage: number;
  marginType: 'cross' | 'isolated';
  margin: number;
}

const roundQty = (qty: number): number => Math.round(qty * QTY_PRECISION) / QTY_PRECISION;
const directionOf = (side: 'long' | 'short'): number => (side === 'long' ? 1 : -1);

function liquidationPrice(row: Row): number {
  const buffer = 1 / row.leverage - LIQUIDATION_BUFFER;
  return row.side === 'long' ? row.entry * (1 - buffer) : row.entry * (1 + buffer);
}

function isLiquidated(row: Row, mark: number): boolean {
  return row.side === 'long' ? mark <= liquidationPrice(row) : mark >= liquidationPrice(row);
}

/** In-memory replica of the paper_exchange accounting, with controls for outage and external-actor scenarios. */
export class FakeExchange implements ExchangeApi {
  down = false;
  failNextPostAfterFill = false;

  private account: { margin: number; available: number; realized: number } | null = null;
  private readonly rows = new Map<string, Row>();
  private readonly marks = new Map<string, number>();
  private readonly orders = new Map<string, SubmitOrderResult>();
  private readonly fundingApplied = new Set<string>();
  private readonly riskEvents: ExchangeRiskEvent[] = [];
  private nextId = 1;

  async getAccount(): Promise<PaperExchangeAccountSnapshot | null> {
    this.assertUp();
    if (!this.account) return null;
    const { margin, realized } = this.account;
    return {
      accountId: 'fake', currency: 'USDT', margin, availableBalance: this.account.available, lockedMargin: this.lockedMargin(),
      equity: this.walletEquity(), unrealizedPnl: this.unrealizedTotal(), realizedPnl: realized, positionsCount: this.openRows().length,
    };
  }

  async createAccount(margin: number): Promise<void> {
    this.assertUp();
    this.rows.clear();
    this.marks.clear();
    this.orders.clear();
    this.fundingApplied.clear();
    this.riskEvents.length = 0;
    this.account = { margin, available: margin, realized: 0 };
  }

  async getPositions(): Promise<PaperExchangePosition[]> {
    this.assertUp();
    return this.allRows().filter((p) => p.netQuantity > 0);
  }

  async submitOrder(params: SubmitOrderParams): Promise<SubmitOrderResult> {
    this.assertUp();
    const replay = this.orders.get(params.clientOrderId);
    if (replay) return replay;
    if (params.quantity <= 0) throw new OrderRejectedError('quantity must be greater than 0', 422, 'quantity must be greater than 0');
    const result: SubmitOrderResult = { orderId: this.nextId++, status: 'filled' };
    this.fill(params);
    this.orders.set(params.clientOrderId, result);
    if (this.failNextPostAfterFill) {
      this.failNextPostAfterFill = false;
      throw new VenueUnavailableError('fake exchange: response lost after fill');
    }
    return result;
  }

  async findOrder(clientOrderId: string): Promise<SubmitOrderResult | null> {
    this.assertUp();
    return this.orders.get(clientOrderId) ?? null;
  }

  async getRiskEvents(): Promise<ExchangeRiskEvent[]> {
    this.assertUp();
    return [...this.riskEvents];
  }

  async pushMarkPrices(prices: Record<string, number>): Promise<void> {
    this.assertUp();
    for (const [symbol, mark] of Object.entries(prices)) {
      this.marks.set(symbol, mark);
      const row = this.rows.get(symbol);
      if (row && row.qty > 0 && isLiquidated(row, mark)) this.liquidate(row, mark);
    }
  }

  async pushFundingEvent(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<void> {
    this.assertUp();
    const row = this.rows.get(symbol);
    if (!row || row.qty === 0 || !this.account) return;
    // The real broker dedupes per position and funding time, so a replay is a no-op.
    const key = `${row.id}:${fundingTime}`;
    if (this.fundingApplied.has(key)) return;
    this.fundingApplied.add(key);
    this.account.available -= directionOf(row.side) * row.qty * markPrice * fundingRate;
  }

  /** Test control: places an order as an outside actor (manual trade, another client). */
  async injectExternalOrder(order: Omit<SubmitOrderParams, 'clientOrderId'>): Promise<SubmitOrderResult> {
    return this.submitOrder({ ...order, clientOrderId: `external-${this.nextId}` });
  }

  /** Test control: wallet equity with fees included, unlike the raw margin + realized + unrealized. */
  walletEquity(): number {
    return (this.account?.available ?? 0) + this.lockedMargin() + this.unrealizedTotal();
  }

  /** Test control: every row including the netQuantity 0 rows the API client filters out. */
  allRows(): PaperExchangePosition[] {
    return [...this.rows.values()].map((row) => this.toPosition(row));
  }

  private assertUp(): void {
    if (this.down) throw new VenueUnavailableError('fake exchange is down');
  }

  private openRows(): Row[] {
    return [...this.rows.values()].filter((row) => row.qty > 0);
  }

  private lockedMargin(): number {
    return this.openRows().reduce((sum, row) => sum + row.margin, 0);
  }

  private unrealizedOf(row: Row): number {
    const mark = this.marks.get(row.symbol) ?? row.entry;
    return directionOf(row.side) * (mark - row.entry) * row.qty;
  }

  private unrealizedTotal(): number {
    return this.openRows().reduce((sum, row) => sum + this.unrealizedOf(row), 0);
  }

  private toPosition(row: Row): PaperExchangePosition {
    return {
      id: row.id, symbol: row.symbol, side: row.side, netQuantity: row.qty, averagePrice: row.entry,
      currentPrice: this.marks.get(row.symbol) ?? row.entry, leverage: row.leverage, marginType: row.marginType,
      liquidationPrice: row.qty > 0 ? liquidationPrice(row) : null, unrealizedPnl: this.unrealizedOf(row),
    };
  }

  private fill(params: SubmitOrderParams): void {
    if (!this.account) throw new OrderRejectedError('account not found', 404, 'account not found');
    const side = params.side === 'buy' ? 'long' : 'short';
    const existing = this.rows.get(params.symbol);
    const opposes = existing !== undefined && existing.qty > 0 && existing.side !== side;
    const quantity = params.reduceOnly ? this.clampReduceOnly(existing, opposes, params.quantity) : params.quantity;
    if (!params.reduceOnly) this.assertMarginAvailable(quantity, params);

    this.account.available -= quantity * params.executionPrice * TAKER_FEE_RATE;
    this.marks.set(params.symbol, params.executionPrice);
    const closedQty = opposes ? Math.min(quantity, existing.qty) : 0;
    if (opposes) this.reduce(existing, closedQty, params.executionPrice);
    const openedQty = roundQty(quantity - closedQty);
    if (openedQty > 0) this.increase(params, side, openedQty);
  }

  private clampReduceOnly(existing: Row | undefined, opposes: boolean, quantity: number): number {
    if (!existing || !opposes) throw new OrderRejectedError('reduce_only order must reduce an open position', 422, 'reduce_only order must reduce an open position');
    return Math.min(quantity, existing.qty);
  }

  // The real broker locks margin for the whole order before netting, so even a closing order needs it.
  private assertMarginAvailable(quantity: number, params: SubmitOrderParams): void {
    const required = (quantity * params.executionPrice) / params.leverage;
    if (this.account!.available >= required) return;
    const message = `insufficient margin: required ${required}, available ${this.account!.available}`;
    throw new OrderRejectedError(message, 402, message);
  }

  private reduce(row: Row, closedQty: number, price: number): void {
    const account = this.account!;
    const pnl = directionOf(row.side) * (price - row.entry) * closedQty;
    const releasedMargin = (row.margin * closedQty) / row.qty;
    account.available += releasedMargin + pnl;
    account.realized += pnl;
    row.margin -= releasedMargin;
    row.qty = roundQty(row.qty - closedQty);
    if (row.qty === 0) row.margin = 0;
  }

  private increase(params: SubmitOrderParams, side: 'long' | 'short', quantity: number): void {
    const lockedNow = (quantity * params.executionPrice) / params.leverage;
    this.account!.available -= lockedNow;
    const row = this.rows.get(params.symbol) ?? this.newRow(params.symbol, side);
    const previousQty = row.qty > 0 ? row.qty : 0;
    row.entry = (row.entry * previousQty + params.executionPrice * quantity) / (previousQty + quantity);
    row.margin = (previousQty > 0 ? row.margin : 0) + lockedNow;
    row.qty = roundQty(previousQty + quantity);
    row.side = side;
    row.leverage = params.leverage;
    row.marginType = params.marginType ?? 'isolated';
  }

  private newRow(symbol: string, side: 'long' | 'short'): Row {
    const row: Row = { id: this.nextId++, symbol, side, qty: 0, entry: 0, leverage: 1, marginType: 'isolated', margin: 0 };
    this.rows.set(symbol, row);
    return row;
  }

  private liquidate(row: Row, mark: number): void {
    const details = {
      position_id: row.id, symbol: row.symbol, side: row.side, quantity: String(row.qty),
      liquidation_price: String(liquidationPrice(row)), mark_price: String(mark),
    };
    this.reduce(row, row.qty, mark);
    this.riskEvents.push({ id: this.nextId++, eventType: 'POSITION_LIQUIDATED', details, createdAt: new Date().toISOString() });
  }
}
