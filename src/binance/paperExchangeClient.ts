/**
 * Thin HTTP client for the paper_exchange Rails broker.
 *
 * paper_exchange has no market-data connection of its own for crypto
 * symbols — this agent owns that (see its README's "Crypto market data
 * ownership"). This client is the other half of that contract: it pushes
 * mark prices / funding events the broker needs for margin and liquidation
 * math, and submits orders with the price this agent's own feed observed.
 */

export interface PaperExchangeAccountSnapshot {
  accountId: string;
  currency: string;
  margin: number;
  availableBalance: number;
  lockedMargin: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  positionsCount: number;
}

export interface PaperExchangePosition {
  id: number;
  symbol: string;
  side: 'long' | 'short';
  netQuantity: number;
  averagePrice: number;
  currentPrice: number;
  leverage: number;
  marginType: 'cross' | 'isolated';
  liquidationPrice: number | null;
  unrealizedPnl: number;
}

export interface SubmitOrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  leverage: number;
  /** Defaults to 'isolated' so one losing position cannot drain the whole wallet. */
  marginType?: 'cross' | 'isolated';
  /** Broker rejects the order unless it shrinks an existing position, so an exit can never open a new one. */
  reduceOnly?: boolean;
  /** Reference price this fill executes near — the broker has no price of its own for crypto. */
  executionPrice: number;
  /** Idempotency key: a retried submission with the same id replays the original order. */
  clientOrderId: string;
}

export interface SubmitOrderResult {
  orderId: number;
  status: string;
  /** Present when the broker reports it; the journal prefers it over the requested quantity. */
  filledQuantity?: number;
}

export interface ExchangeRiskEvent {
  id: number;
  eventType: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ExchangeApi {
  /** Null when the broker has no account for this id yet. */
  getAccount(): Promise<PaperExchangeAccountSnapshot | null>;
  createAccount(margin: number): Promise<void>;
  getPositions(): Promise<PaperExchangePosition[]>;
  submitOrder(params: SubmitOrderParams): Promise<SubmitOrderResult>;
  findOrder(clientOrderId: string): Promise<SubmitOrderResult | null>;
  getRiskEvents(): Promise<ExchangeRiskEvent[]>;
  pushMarkPrices(prices: Record<string, number>): Promise<void>;
  pushFundingEvent(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<void>;
}

/** The broker could not be reached or kept failing (network, timeout, 5xx) — the request may or may not have been applied. */
export class VenueUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VenueUnavailableError';
  }
}

/** The broker understood the request and refused it (4xx); retrying the same request cannot succeed. */
export class OrderRejectedError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = 'OrderRejectedError';
  }
}

export interface PaperExchangeClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts after the first one. */
  retries?: number;
  /** First backoff delay; doubles on every further retry. */
  backoffMs?: number;
  apiKey?: string;
}

type Raw = Record<string, unknown>;

function toAccount(raw: Raw): PaperExchangeAccountSnapshot {
  return {
    accountId: String(raw.account_id),
    currency: String(raw.currency),
    margin: Number(raw.margin),
    availableBalance: Number(raw.available_balance),
    lockedMargin: Number(raw.locked_margin),
    equity: Number(raw.equity),
    unrealizedPnl: Number(raw.unrealized_pnl),
    realizedPnl: Number(raw.realized_pnl),
    positionsCount: Number(raw.positions_count),
  };
}

function toPosition(p: Raw): PaperExchangePosition {
  return {
    id: Number(p.id),
    symbol: String(p.symbol),
    side: p.side as 'long' | 'short',
    netQuantity: Number(p.net_quantity),
    averagePrice: Number(p.average_price),
    currentPrice: Number(p.current_price),
    leverage: Number(p.leverage),
    marginType: p.margin_type as 'cross' | 'isolated',
    liquidationPrice: p.liquidation_price === null || p.liquidation_price === undefined ? null : Number(p.liquidation_price),
    unrealizedPnl: Number(p.unrealized_pnl),
  };
}

function toOrderResult(raw: Raw): SubmitOrderResult {
  const filled = raw.filled_quantity === null || raw.filled_quantity === undefined ? NaN : Number(raw.filled_quantity);
  return { orderId: Number(raw.id), status: String(raw.status), ...(Number.isFinite(filled) ? { filledQuantity: filled } : {}) };
}

export class PaperExchangeClient implements ExchangeApi {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly apiKey?: string;

  constructor(
    private readonly baseUrl: string,
    private readonly accountId: string,
    opts: PaperExchangeClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 250;
    this.apiKey = opts.apiKey ?? process.env.PAPER_EXCHANGE_API_KEY;
  }

  async getAccount(): Promise<PaperExchangeAccountSnapshot | null> {
    try {
      return toAccount(await this.request<Raw>('GET', '/api/account'));
    } catch (err) {
      if (err instanceof OrderRejectedError && err.status === 404) return null;
      throw err;
    }
  }

  async createAccount(margin: number): Promise<void> {
    await this.request('POST', `/api/account/reset?margin=${margin}`);
  }

  async getPositions(): Promise<PaperExchangePosition[]> {
    const raw = await this.request<Raw[]>('GET', '/api/positions');
    // The broker keeps a row with net_quantity 0 after a position is closed.
    return raw.map(toPosition).filter((p) => p.netQuantity > 0);
  }

  async submitOrder(params: SubmitOrderParams): Promise<SubmitOrderResult> {
    const raw = await this.request<Raw>('POST', '/api/orders', {
      order: {
        symbol: params.symbol,
        side: params.side,
        quantity: params.quantity,
        order_type: 'market',
        instrument_type: 'CRYPTO_PERPETUAL',
        leverage: params.leverage,
        margin_type: params.marginType ?? 'isolated',
        execution_price: params.executionPrice,
        client_order_id: params.clientOrderId,
        ...(params.reduceOnly ? { reduce_only: true } : {}),
      },
    });
    return toOrderResult(raw);
  }

  /** Recovers the outcome of a submission whose response was lost; the broker lists only its latest 200 orders. */
  async findOrder(clientOrderId: string): Promise<SubmitOrderResult | null> {
    const orders = await this.request<Raw[]>('GET', '/api/orders');
    const match = orders.find((o) => o.client_order_id === clientOrderId);
    return match ? toOrderResult(match) : null;
  }

  async getRiskEvents(): Promise<ExchangeRiskEvent[]> {
    const raw = await this.request<Raw[]>('GET', '/api/risk_events');
    return raw.map((e) => ({
      id: Number(e.id),
      eventType: String(e.event_type),
      details: (e.details ?? {}) as Record<string, unknown>,
      createdAt: String(e.created_at),
    }));
  }

  /** Bulk mark-price push — drives the broker's liquidation checks. Safe to call repeatedly (idempotent per symbol). */
  async pushMarkPrices(prices: Record<string, number>): Promise<void> {
    await this.request('POST', '/api/mark_prices', { prices });
  }

  /** The broker dedupes funding on (position, funding_time), which is what makes the retry in `request` safe. */
  async pushFundingEvent(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<void> {
    await this.request('POST', '/api/funding_events', {
      symbol,
      funding_rate: fundingRate,
      mark_price: markPrice,
      // The broker stores a datetime column; a bare epoch number would not parse and would silently disable the dedupe.
      funding_time: new Date(fundingTime).toISOString(),
    });
  }

  /** Retries only VenueUnavailableError. POSTs are safe to repeat because each carries a client_order_id or funding_time the broker dedupes. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastFailure: VenueUnavailableError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs * 2 ** (attempt - 1));
      try {
        return await this.send<T>(method, path, body);
      } catch (err) {
        if (!(err instanceof VenueUnavailableError)) throw err;
        lastFailure = err;
      }
    }
    throw lastFailure;
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let status: number;
    let text: string;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Account-Id': this.accountId,
      };
      if (this.apiKey) headers['X-API-Key'] = this.apiKey;
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw new VenueUnavailableError(`paper_exchange ${method} ${path} unreachable: ${(err as Error).message}`, { cause: err });
    }
    if (status >= 200 && status < 300) return (text ? JSON.parse(text) : undefined) as T;
    const message = `paper_exchange ${method} ${path} -> ${status}: ${text}`;
    if (status >= 500) throw new VenueUnavailableError(message);
    throw new OrderRejectedError(message, status, text);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
