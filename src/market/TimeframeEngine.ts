import type { Candle } from '../types.js';
import type { Timeframe } from './types.js';

const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '15m': 15,
  '1h': 60,
  '4h': 240,
};

export function resampleCandles(candles: Candle[], timeframe: Timeframe): Candle[] {
  const intervalMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  if (candles.length === 0) return [];

  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const result: Candle[] = [];

  let bucketStart = Math.floor(sorted[0].openTime / intervalMs) * intervalMs;
  let bucket: Candle | null = null;

  for (const candle of sorted) {
    const nextBucketStart = Math.floor(candle.openTime / intervalMs) * intervalMs;
    if (nextBucketStart !== bucketStart) {
      if (bucket) result.push(bucket);
      bucketStart = nextBucketStart;
      bucket = null;
    }

    if (!bucket) {
      bucket = {
        openTime: bucketStart,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
    } else {
      bucket.high = Math.max(bucket.high, candle.high);
      bucket.low = Math.min(bucket.low, candle.low);
      bucket.close = candle.close;
      bucket.volume += candle.volume;
    }
  }

  if (bucket) result.push(bucket);
  return result;
}

export function closedCandles(candles: Candle[]): Candle[] {
  if (candles.length <= 1) return [];
  return candles.slice(0, -1);
}
