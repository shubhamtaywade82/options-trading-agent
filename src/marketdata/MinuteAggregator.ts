/**
 * Turns raw Binance USD-M stream events into one compact record per symbol per minute: traded flow by aggressor side,
 * liquidations by side, top-of-book spread and imbalance, mark/index/funding, and the latest polled open interest and
 * taker ratio. This is the derivatives/flow history the exchange does not serve, so it has to be recorded going forward.
 */

export type StreamEvent =
  | { kind: 'trade'; symbol: string; time: number; price: number; qty: number; buyerIsMaker: boolean }
  /** `side` is the liquidation ORDER's side: SELL closes a long, BUY closes a short. */
  | { kind: 'liquidation'; symbol: string; time: number; side: 'BUY' | 'SELL'; qty: number; price: number }
  | { kind: 'book'; symbol: string; time: number; bids: readonly (readonly [number, number])[]; asks: readonly (readonly [number, number])[] }
  | { kind: 'mark'; symbol: string; time: number; mark: number; index: number; funding: number }
  | { kind: 'oi'; symbol: string; time: number; openInterest: number }
  | { kind: 'taker'; symbol: string; time: number; ratio: number };

export interface MinuteRecord {
  /** Start of the minute, ms. */
  t: number;
  symbol: string;
  trades: number;
  /** Quantity bought / sold by aggressors (base units) and their quote value. */
  buyQty: number;
  sellQty: number;
  buyQuote: number;
  sellQuote: number;
  /** Liquidated long / short quantity (base units) and number of liquidation orders. */
  liqLongQty: number;
  liqShortQty: number;
  liqCount: number;
  /** Means over the minute's book snapshots; null when none arrived. */
  spreadBps: number | null;
  /** (bid qty - ask qty) / (bid qty + ask qty) over the top levels, in [-1, 1]. */
  bookImbalance: number | null;
  bookSamples: number;
  /** Last known values carried across minutes. */
  mark: number | null;
  index: number | null;
  funding: number | null;
  openInterest: number | null;
  takerRatio: number | null;
}

interface Bucket {
  start: number;
  rec: MinuteRecord;
  spreadSum: number;
  imbalanceSum: number;
}

const MINUTE = 60_000;
const minuteOf = (t: number): number => Math.floor(t / MINUTE) * MINUTE;

const emptyRecord = (symbol: string, t: number, carry?: MinuteRecord): MinuteRecord => ({
  t, symbol, trades: 0, buyQty: 0, sellQty: 0, buyQuote: 0, sellQuote: 0, liqLongQty: 0, liqShortQty: 0, liqCount: 0,
  spreadBps: null, bookImbalance: null, bookSamples: 0,
  mark: carry?.mark ?? null, index: carry?.index ?? null, funding: carry?.funding ?? null,
  openInterest: carry?.openInterest ?? null, takerRatio: carry?.takerRatio ?? null,
});

const finite = (...xs: number[]): boolean => xs.every((x) => Number.isFinite(x));

export class MinuteAggregator {
  private readonly buckets = new Map<string, Bucket>();
  /** Events that arrived for a minute that had already been flushed. */
  late = 0;
  /** Events rejected as malformed (non-finite numbers). */
  rejected = 0;

  /** Feeds one event; returns the minute records it completed (zero or one per call). */
  push(ev: StreamEvent): MinuteRecord[] {
    if (!finite(ev.time)) { this.rejected += 1; return []; }
    const minute = minuteOf(ev.time);
    let bucket = this.buckets.get(ev.symbol);
    const out: MinuteRecord[] = [];
    if (!bucket) {
      bucket = this.open(ev.symbol, minute);
    } else if (minute > bucket.start) {
      out.push(this.close(bucket));
      bucket = this.open(ev.symbol, minute, bucket.rec);
    } else if (minute < bucket.start) {
      this.late += 1;
      return out;
    }
    this.apply(bucket, ev);
    return out;
  }

  /** Closes every bucket whose minute ended before `now` (e.g. on a quiet symbol, or at shutdown). */
  flush(now: number, all = false): MinuteRecord[] {
    const out: MinuteRecord[] = [];
    for (const [symbol, bucket] of [...this.buckets]) {
      if (all || bucket.start + MINUTE <= now) {
        out.push(this.close(bucket));
        this.buckets.delete(symbol);
      }
    }
    return out;
  }

  private open(symbol: string, start: number, carry?: MinuteRecord): Bucket {
    const bucket: Bucket = { start, rec: emptyRecord(symbol, start, carry), spreadSum: 0, imbalanceSum: 0 };
    this.buckets.set(symbol, bucket);
    return bucket;
  }

  private close(b: Bucket): MinuteRecord {
    const rec = { ...b.rec };
    if (rec.bookSamples > 0) {
      rec.spreadBps = b.spreadSum / rec.bookSamples;
      rec.bookImbalance = b.imbalanceSum / rec.bookSamples;
    }
    return rec;
  }

  private apply(b: Bucket, ev: StreamEvent): void {
    const r = b.rec;
    switch (ev.kind) {
      case 'trade': {
        if (!finite(ev.price, ev.qty) || ev.qty < 0) { this.rejected += 1; return; }
        r.trades += 1;
        // buyerIsMaker means the aggressor sold into a resting bid
        if (ev.buyerIsMaker) { r.sellQty += ev.qty; r.sellQuote += ev.qty * ev.price; } else { r.buyQty += ev.qty; r.buyQuote += ev.qty * ev.price; }
        return;
      }
      case 'liquidation': {
        if (!finite(ev.price, ev.qty) || ev.qty < 0) { this.rejected += 1; return; }
        r.liqCount += 1;
        if (ev.side === 'SELL') r.liqLongQty += ev.qty; else r.liqShortQty += ev.qty;
        return;
      }
      case 'book': {
        const bid = ev.bids[0];
        const ask = ev.asks[0];
        if (!bid || !ask || !finite(bid[0], ask[0]) || !(bid[0] > 0) || !(ask[0] >= bid[0])) { this.rejected += 1; return; }
        const bidQty = ev.bids.reduce((s, l) => s + l[1], 0);
        const askQty = ev.asks.reduce((s, l) => s + l[1], 0);
        if (!finite(bidQty, askQty) || bidQty + askQty <= 0) { this.rejected += 1; return; }
        const mid = (bid[0] + ask[0]) / 2;
        b.spreadSum += ((ask[0] - bid[0]) / mid) * 10_000;
        b.imbalanceSum += (bidQty - askQty) / (bidQty + askQty);
        r.bookSamples += 1;
        return;
      }
      case 'mark':
        if (!finite(ev.mark, ev.index, ev.funding)) { this.rejected += 1; return; }
        r.mark = ev.mark; r.index = ev.index; r.funding = ev.funding;
        return;
      case 'oi':
        if (!finite(ev.openInterest)) { this.rejected += 1; return; }
        r.openInterest = ev.openInterest;
        return;
      case 'taker':
        if (!finite(ev.ratio)) { this.rejected += 1; return; }
        r.takerRatio = ev.ratio;
    }
  }
}
