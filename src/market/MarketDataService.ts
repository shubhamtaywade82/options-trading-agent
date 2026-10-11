import type { USDMClient } from 'binance';
import type { Candle } from '../types.js';
import { config } from '../config.js';
import type { DerivativesSnapshot, MarketDataSnapshot, NativeTimeframe } from './MarketDataTypes.js';

type FuturesMarketClient = Pick<
  USDMClient,
  | 'getKlines'
  | 'getOpenInterest'
  | 'getOpenInterestStatistics'
  | 'getGlobalLongShortAccountRatio'
  | 'getTopTradersLongShortAccountRatio'
  | 'getTopTradersLongShortPositionRatio'
  | 'getTakerBuySellVolume'
  | 'getOrderBook'
  | 'getBasis'
>;

export interface MarketDataServiceOptions {
  candleTtlMs: Record<NativeTimeframe, number>;
  derivativesTtlMs: number;
  klineLimit: number;
  historyLimit: number;
  orderBookDepth: number;
  maxConcurrency: number;
  derivativesPeriod: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d';
  basisEnabled: boolean;
}

interface CacheEntry<T> {
  fetchedAt: number;
  value: T;
}

interface Task {
  key: string;
  run: () => Promise<void>;
}

const TIMEFRAME_MS: Record<NativeTimeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

const KLINE_INTERVALS: NativeTimeframe[] = ['1m', '5m', '15m', '1h', '4h'];

export const DEFAULT_MARKET_DATA_OPTIONS: MarketDataServiceOptions = {
  candleTtlMs: { ...config.marketDataV2.candleTtlMs },
  derivativesTtlMs: config.marketDataV2.derivativesTtlMs,
  klineLimit: config.marketDataV2.klineLimit,
  historyLimit: config.marketDataV2.historyLimit,
  orderBookDepth: config.marketDataV2.orderBookDepth,
  maxConcurrency: config.marketDataV2.maxConcurrency,
  derivativesPeriod: config.marketDataV2.derivativesPeriod,
  basisEnabled: config.marketDataV2.basisEnabled,
};

function asNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function latestFinite(values: number[]): number | null {
  const value = values.at(-1);
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function parseCandles(raw: any[], timeframe: NativeTimeframe, now: number, limit: number): Candle[] {
  const intervalMs = TIMEFRAME_MS[timeframe];
  return (raw as any[])
    .map((k: any[]) => {
      const [openTime, open, high, low, close, volume] = k.map(Number);
      return { openTime, open, high, low, close, volume };
    })
    .filter((c) => Number.isFinite(c.openTime) && c.openTime + intervalMs <= now)
    .slice(-limit);
}

function parseRatioHistory(raw: any[], field: string): number[] {
  return (raw as any[])
    .map((row) => asNumber(row?.[field]))
    .filter((value): value is number => value !== null);
}

function parseTakerHistory(raw: any[]): { ratio: number | null; imbalance: number | null } {
  const latest = (raw as any[]).at(-1);
  if (!latest) return { ratio: null, imbalance: null };

  const ratio = asNumber(latest.buySellRatio);
  const buyVol = asNumber(latest.buyVol);
  const sellVol = asNumber(latest.sellVol);
  const imbalance = buyVol !== null && sellVol !== null && buyVol + sellVol > 0
    ? (buyVol - sellVol) / (buyVol + sellVol)
    : null;

  return { ratio, imbalance };
}

function parseBook(raw: any, depth: number): { imbalance: number | null; spreadBps: number | null } {
  const bids = Array.isArray(raw?.bids) ? raw.bids : [];
  const asks = Array.isArray(raw?.asks) ? raw.asks : [];
  if (!bids.length || !asks.length) return { imbalance: null, spreadBps: null };

  let bidNotional = 0;
  let askNotional = 0;

  for (const row of bids.slice(0, depth)) {
    const price = asNumber(row?.[0]);
    const quantity = asNumber(row?.[1]);
    if (price !== null && quantity !== null) bidNotional += price * quantity;
  }

  for (const row of asks.slice(0, depth)) {
    const price = asNumber(row?.[0]);
    const quantity = asNumber(row?.[1]);
    if (price !== null && quantity !== null) askNotional += price * quantity;
  }

  const bestBid = asNumber(bids[0]?.[0]);
  const bestAsk = asNumber(asks[0]?.[0]);
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = mid !== null && mid > 0 && bestBid !== null && bestAsk !== null
    ? ((bestAsk - bestBid) / mid) * 10_000
    : null;

  const total = bidNotional + askNotional;
  return {
    imbalance: total > 0 ? (bidNotional - askNotional) / total : null,
    spreadBps,
  };
}

function parseBasis(raw: any[]): number | null {
  const row = (raw as any[]).at(-1);
  if (!row) return null;
  const direct = asNumber(row.basisRate ?? row.basis);
  if (direct === null) return null;
  return Math.abs(direct) < 1 ? direct * 100 : direct;
}

async function runWithConcurrency(tasks: Task[], limit: number): Promise<void> {
  if (tasks.length === 0) return;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      try {
        await tasks[index].run();
      } catch {
        // A single public-data endpoint must not invalidate the rest of the market snapshot.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
}

class RequestLimiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class MarketDataService {
  private readonly client: FuturesMarketClient;
  private readonly options: MarketDataServiceOptions;
  private readonly limiter: RequestLimiter;
  private readonly candles = new Map<string, CacheEntry<Candle[]>>();
  private readonly derivative = new Map<string, CacheEntry<DerivativesSnapshot | null>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failureBackoff = new Map<string, number>();

  constructor(client: FuturesMarketClient, options: MarketDataServiceOptions = DEFAULT_MARKET_DATA_OPTIONS) {
    this.client = client;
    this.options = options;
    this.limiter = new RequestLimiter(options.maxConcurrency);
  }

  async snapshot(symbols: string[], now = Date.now()): Promise<Record<string, MarketDataSnapshot>> {
    const tasks: Task[] = [];

    for (const symbol of symbols) {
      for (const timeframe of KLINE_INTERVALS) {
        const key = this.cacheKey(symbol, timeframe);
        if (this.needsRefresh(key, this.options.candleTtlMs[timeframe], now)) {
          tasks.push({ key, run: () => this.refreshCandle(symbol, timeframe, now) });
        }
      }

      const derivativesKey = this.cacheKey(symbol, 'derivatives');
      if (this.needsRefresh(derivativesKey, this.options.derivativesTtlMs, now)) {
        tasks.push({ key: derivativesKey, run: () => this.refreshDerivatives(symbol, now) });
      }
    }

    const inFlightPromises = Array.from(this.inFlight.values());
    await runWithConcurrency(tasks, this.options.maxConcurrency);
    if (inFlightPromises.length > 0) {
      await Promise.allSettled(inFlightPromises);
    }

    const snapshots: Record<string, MarketDataSnapshot> = {};
    for (const symbol of symbols) {
      const candles: Partial<Record<NativeTimeframe, Candle[]>> = {};
      for (const timeframe of KLINE_INTERVALS) {
        const cached = this.candles.get(this.cacheKey(symbol, timeframe));
        if (cached) candles[timeframe] = cached.value;
      }

      const derivatives = this.derivative.get(this.cacheKey(symbol, 'derivatives'))?.value ?? null;
      snapshots[symbol] = {
        symbol,
        generatedAt: now,
        candles,
        derivatives,
      };
    }

    return snapshots;
  }

  private cacheKey(symbol: string, scope: string): string {
    return symbol + ':' + scope;
  }

  private needsRefresh(key: string, ttlMs: number, now: number): boolean {
    const backoffUntil = this.failureBackoff.get(key) ?? 0;
    if (now < backoffUntil) return false;
    const cachedAt = this.candles.get(key)?.fetchedAt ?? this.derivative.get(key)?.fetchedAt ?? 0;
    return now - cachedAt >= ttlMs && !this.inFlight.has(key);
  }

  private async refreshCandle(symbol: string, timeframe: NativeTimeframe, now: number): Promise<void> {
    const key = this.cacheKey(symbol, timeframe);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const raw = await this.limiter.run(() => this.client.getKlines({
          symbol,
          interval: timeframe,
          limit: this.options.klineLimit,
        }));
        this.candles.set(key, {
          fetchedAt: now,
          value: parseCandles(raw as any[], timeframe, now, this.options.klineLimit),
        });
        this.failureBackoff.delete(key);
      } catch (err) {
        this.failureBackoff.set(key, now + 10_000);
        throw err;
      }
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, promise);
    await promise;
  }

  private async refreshDerivatives(symbol: string, now: number): Promise<void> {
    const key = this.cacheKey(symbol, 'derivatives');
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const period = this.options.derivativesPeriod;
      const [
        currentOi,
        oiHistory,
        globalHistory,
        topAccountHistory,
        topPositionHistory,
        takerHistory,
        book,
        basisHistory,
      ] = await Promise.allSettled([
        this.limiter.run(() => this.client.getOpenInterest({ symbol })),
        this.limiter.run(() => this.client.getOpenInterestStatistics({ symbol, period, limit: this.options.historyLimit })),
        this.limiter.run(() => this.client.getGlobalLongShortAccountRatio({ symbol, period, limit: this.options.historyLimit })),
        this.limiter.run(() => this.client.getTopTradersLongShortAccountRatio({ symbol, period, limit: this.options.historyLimit })),
        this.limiter.run(() => this.client.getTopTradersLongShortPositionRatio({ symbol, period, limit: this.options.historyLimit })),
        this.limiter.run(() => this.client.getTakerBuySellVolume({ symbol, period, limit: this.options.historyLimit })),
        this.limiter.run(() => this.client.getOrderBook({ symbol, limit: this.options.orderBookDepth as 5 | 10 | 20 | 50 | 100 | 500 | 1000 | 5000 })),
        this.options.basisEnabled
          ? this.limiter.run(() => this.client.getBasis({
              pair: symbol.replace(/USDT$/, ''),
              contractType: 'PERPETUAL',
              period,
              limit: this.options.historyLimit,
            }))
          : Promise.resolve([]),
      ]);

      const currentOpenInterest = currentOi.status === 'fulfilled'
        ? asNumber((currentOi.value as any)?.openInterest)
        : null;

      const oiValues = oiHistory.status === 'fulfilled'
        ? (oiHistory.value as any[])
            .map((row) => asNumber(row?.sumOpenInterest))
            .filter((value): value is number => value !== null)
        : [];
      const latestOi = latestFinite(oiValues);
      const previousOi = oiValues.length > 1 ? oiValues.at(-2)! : null;

      const globalValues = globalHistory.status === 'fulfilled'
        ? parseRatioHistory(globalHistory.value as any[], 'longShortRatio')
        : [];
      const topAccountValues = topAccountHistory.status === 'fulfilled'
        ? parseRatioHistory(topAccountHistory.value as any[], 'longShortRatio')
        : [];
      const topPositionValues = topPositionHistory.status === 'fulfilled'
        ? parseRatioHistory(topPositionHistory.value as any[], 'longShortRatio')
        : [];

      const taker = takerHistory.status === 'fulfilled'
        ? parseTakerHistory(takerHistory.value as any[])
        : { ratio: null, imbalance: null };

      const bookValues = book.status === 'fulfilled'
        ? parseBook(book.value, this.options.orderBookDepth)
        : { imbalance: null, spreadBps: null };

      const basisPct = basisHistory.status === 'fulfilled'
        ? parseBasis(basisHistory.value as any[])
        : null;

      const snapshot: DerivativesSnapshot = {
        asOf: now,
        openInterest: currentOpenInterest ?? latestOi,
        openInterestChangePct: pctChange(latestOi ?? currentOpenInterest, previousOi),
        globalLongShortRatio: latestFinite(globalValues),
        topTraderAccountLongShortRatio: latestFinite(topAccountValues),
        topTraderPositionLongShortRatio: latestFinite(topPositionValues),
        takerBuySellRatio: taker.ratio,
        takerVolumeImbalance: taker.imbalance,
        orderBookImbalance: bookValues.imbalance,
        spreadBps: bookValues.spreadBps,
        basisPct,
      };

      this.derivative.set(key, { fetchedAt: now, value: snapshot });
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, promise);
    await promise;
  }
}
