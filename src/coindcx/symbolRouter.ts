export const futuresPair = (base: string, quote: 'USDT' | 'INR'): string => `B-${base.toUpperCase()}_${quote}`;

export const baseAssetOfSymbol = (symbol: string): string => {
  // Strip USDT, BUSD, or USDC suffix to get the base asset
  for (const suffix of ['USDT', 'BUSD', 'USDC']) {
    if (symbol.endsWith(suffix)) {
      return symbol.slice(0, -suffix.length);
    }
  }
  return symbol;
};

export interface ResolvedPair {
  readonly symbol: string;
  readonly base: string;
  readonly pair: string;
  readonly quote: 'USDT' | 'INR';
  readonly fxRate: number;
}

export interface MarketsClient {
  futures: { market: { getMarketsDetails(): Promise<{ pair: string; status?: string }[]> } };
  marketData: { getSpotTicker(): Promise<{ pair?: string; last_price?: string | number }[]> };
}

export class SymbolRouter {
  private client: MarketsClient;
  private quotePreference: 'auto' | 'USDT' | 'INR';
  private pairMap: Map<string, string> = new Map(); // pair -> symbol
  private instrumentsCacheTime = 0;
  private instrumentsCache: { pair: string; status?: string }[] = [];
  private fxRateTime = 0;
  private fxRate = 1;

  constructor(client: MarketsClient, quotePreference: 'auto' | 'USDT' | 'INR') {
    this.client = client;
    this.quotePreference = quotePreference;
  }

  async resolve(symbol: string): Promise<ResolvedPair> {
    const base = baseAssetOfSymbol(symbol);
    const now = Date.now();

    // Refresh instruments cache if older than 5 minutes
    if (now - this.instrumentsCacheTime > 5 * 60 * 1000) {
      this.instrumentsCache = await this.client.futures.market.getMarketsDetails();
      this.instrumentsCacheTime = now;
    }

    const { pair, quote, fxRate } = await this.selectQuoteAndPair(base, now);
    // Register both USDT and INR pairs for this base so pairToSymbol works for both
    this.pairMap.set(futuresPair(base, 'USDT'), symbol);
    this.pairMap.set(futuresPair(base, 'INR'), symbol);
    return { symbol, base, pair, quote, fxRate };
  }

  pairToSymbol(pair: string): string | undefined {
    return this.pairMap.get(pair);
  }

  private async selectQuoteAndPair(
    base: string,
    now: number,
  ): Promise<{ pair: string; quote: 'USDT' | 'INR'; fxRate: number }> {
    const preferredQuote = this.quotePreference === 'auto' ? 'USDT' : this.quotePreference;
    const fallbackQuote = preferredQuote === 'USDT' ? 'INR' : 'USDT';
    const preferredPair = futuresPair(base, preferredQuote);
    const fallbackPair = futuresPair(base, fallbackQuote);
    const hasPreferred = this.instrumentsCache.some((m) => m.pair === preferredPair);
    const hasFallback = this.instrumentsCache.some((m) => m.pair === fallbackPair);

    if (hasPreferred) {
      const fxRate = preferredQuote === 'USDT' ? 1 : await this.getFxRate(now);
      return { pair: preferredPair, quote: preferredQuote, fxRate };
    }

    if (hasFallback) {
      const rate = await this.getFxRate(now);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('USDTINR rate unavailable or unusable');
      return { pair: fallbackPair, quote: fallbackQuote, fxRate: rate };
    }

    throw new Error(`no CoinDCX futures market for ${base}USDT`);
  }

  private async getFxRate(now: number): Promise<number> {
    const age = now - this.fxRateTime;
    // Fresh: use cached value without refetch
    if (age < 30 * 1000) return this.fxRate;

    // Wrap only the network call, not validation
    let ticker;
    try {
      ticker = await this.client.marketData.getSpotTicker();
    } catch (err) {
      // Network failure: fall back to stale if within 120s window
      if (age < 120 * 1000) return this.fxRate;
      throw new Error('USDTINR rate unavailable or unusable');
    }

    // Validate result (outside try/catch so validation errors always throw)
    const usdtInr = ticker.find((t) => t.pair === 'USDTINR');
    if (!usdtInr?.last_price) {
      if (age < 120 * 1000) return this.fxRate;
      throw new Error('USDTINR rate unavailable or unusable');
    }

    const parsed = typeof usdtInr.last_price === 'string' ? parseFloat(usdtInr.last_price) : usdtInr.last_price;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('USDTINR rate unavailable or unusable');
    }

    this.fxRate = parsed;
    this.fxRateTime = now;
    return this.fxRate;
  }
}
