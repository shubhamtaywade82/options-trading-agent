import type { Candle, Tick } from '../domain/types.js';
import { IST_OFFSET_MS } from '../time/ist.js';

/**
 * Ordered, bounded bar history. Re-appending the bar at the same open time
 * replaces it, so a warmup bar that overlaps the live feed never duplicates.
 */
export class BarSeries {
  private readonly bars: Candle[] = [];

  constructor(private readonly capacity = 2_000) {}

  get length(): number {
    return this.bars.length;
  }

  get last(): Candle | undefined {
    return this.bars[this.bars.length - 1];
  }

  all(): readonly Candle[] {
    return this.bars;
  }

  /** Returns false (and changes nothing) when the bar is older than the newest stored bar. */
  upsert(candle: Candle): boolean {
    const last = this.last;
    if (last !== undefined && candle.time < last.time) {
      return false;
    }
    if (last !== undefined && candle.time === last.time) {
      this.bars[this.bars.length - 1] = candle;
      return true;
    }
    this.bars.push(candle);
    if (this.bars.length > this.capacity) {
      this.bars.splice(0, this.bars.length - this.capacity);
    }
    return true;
  }
}

/**
 * Aggregates LTP ticks into closed bars aligned to IST wall-clock boundaries.
 * Ticker-mode feeds carry no per-trade volume, so bar volume is 0 by design and
 * no strategy here depends on it.
 */
export class CandleBuilder {
  private open: { time: number; open: number; high: number; low: number; close: number } | undefined;
  private lateTicks = 0;

  constructor(private readonly barMs: number) {
    if (!Number.isInteger(barMs) || barMs <= 0) {
      throw new RangeError(`bar size must be a positive integer of ms, got ${barMs}`);
    }
  }

  get droppedLateTicks(): number {
    return this.lateTicks;
  }

  bucketStart(epochMs: number): number {
    return Math.floor((epochMs + IST_OFFSET_MS) / this.barMs) * this.barMs - IST_OFFSET_MS;
  }

  /** Feeds one tick; returns the bar that closed because this tick opened a new bucket. */
  onTick(tick: Pick<Tick, 'ltp' | 'ltt'>): Candle | undefined {
    if (!Number.isFinite(tick.ltp) || tick.ltp <= 0 || !Number.isFinite(tick.ltt)) {
      return undefined;
    }
    const bucket = this.bucketStart(tick.ltt);
    if (this.open === undefined) {
      this.open = { time: bucket, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp };
      return undefined;
    }
    if (bucket < this.open.time) {
      this.lateTicks += 1;
      return undefined;
    }
    if (bucket === this.open.time) {
      this.open.high = Math.max(this.open.high, tick.ltp);
      this.open.low = Math.min(this.open.low, tick.ltp);
      this.open.close = tick.ltp;
      return undefined;
    }
    const closed = this.toCandle(this.open);
    this.open = { time: bucket, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp };
    return closed;
  }

  /** Closes the open bar once wall-clock time has passed its end, so quiet markets still produce bars. */
  flush(nowMs: number): Candle | undefined {
    if (this.open === undefined || nowMs < this.open.time + this.barMs) {
      return undefined;
    }
    const closed = this.toCandle(this.open);
    this.open = undefined;
    return closed;
  }

  private toCandle(bar: { time: number; open: number; high: number; low: number; close: number }): Candle {
    return { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0 };
  }
}
