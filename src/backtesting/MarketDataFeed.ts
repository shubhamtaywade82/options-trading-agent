import type { Candle } from '../types.js';
import type { NativeTimeframe } from '../market/MarketDataTypes.js';
import { FIFTEEN_MINUTES_MS, type ReplayData } from './types.js';

const INTERVAL_MS: Record<NativeTimeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': FIFTEEN_MINUTES_MS,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

/**
 * No-lookahead historical data feed. Every read is anchored to a step time (the
 * close of a 15m bar) and only ever returns candles that had fully closed by
 * then; fills for decisions taken at step `i` are quoted from the open of bar
 * `i + 1`, which the decision could not have seen.
 *
 * The step grid comes from the first symbol's 15m bars — Binance symbols share
 * the 15m grid, and `closedCandles` tolerates shorter histories on other
 * symbols by simply returning what closed by the step time.
 */
export class MarketDataFeed {
  private readonly grid: number[] = [];
  private readonly symbols: string[];

  constructor(private readonly data: ReplayData) {
    this.symbols = Object.keys(data);
    if (this.symbols.length === 0) throw new Error('MarketDataFeed requires at least one symbol');
    for (const symbol of this.symbols) {
      const bars = data[symbol]['15m'];
      if (!bars || bars.length === 0) throw new Error(`MarketDataFeed requires 15m candles for ${symbol}`);
    }
    for (const bar of data[this.symbols[0]]['15m']!) {
      this.grid.push(bar.openTime + FIFTEEN_MINUTES_MS);
    }
  }

  get stepCount(): number {
    return this.grid.length;
  }

  /** Close time of step `index` (the moment the 15m bar `index` finished). */
  stepTime(index: number): number {
    return this.grid[index];
  }

  /** The 15m bar that closes at step `index`, on the grid symbol. */
  bar(index: number): Candle {
    return this.data[this.symbols[0]]['15m']![index];
  }

  /** The 15m bar that closes at step `index` for `symbol`, when it has one at that slot. */
  barFor(symbol: string, index: number): Candle | undefined {
    return this.data[symbol]['15m']?.[index];
  }

  /** Open of the bar AFTER step `index` — the fill price anchor for decisions taken at step `index`. */
  nextOpen(index: number): number | undefined {
    const bars = this.data[this.symbols[0]]['15m']!;
    return index + 1 < bars.length ? bars[index + 1].open : undefined;
  }

  /** All candles of `timeframe` for `symbol` that had fully closed by `closeTime`. */
  closedCandles(symbol: string, timeframe: NativeTimeframe, closeTime: number): Candle[] {
    const bars = this.data[symbol][timeframe] ?? [];
    // Binary search: first bar that is NOT fully closed by closeTime
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bars[mid].openTime + INTERVAL_MS[timeframe] <= closeTime) lo = mid + 1;
      else hi = mid;
    }
    return bars.slice(0, lo);
  }

  /** The last 15m close of `symbol` at or before `closeTime`, when one exists. */
  lastClose(symbol: string, closeTime: number): number | undefined {
    const bars = this.closedCandles(symbol, '15m', closeTime);
    return bars.length > 0 ? bars[bars.length - 1].close : undefined;
  }

  get universe(): string[] {
    return [...this.symbols];
  }
}
