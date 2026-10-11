import type { Candle } from '../types.js';
import { detectCauseZone } from './ZoneEngine.js';
import type { StructureBreak, Timeframe, ZoneRecord } from './types.js';

const MAX_ZONE_RECORDS = 40;
const DEFAULT_ZONE_EXPIRY_BARS = 96;

const STATE_RANK: Record<ZoneRecord['state'], number> = {
  FRESH: 0,
  TESTED: 1,
  MITIGATED: 2,
  INVALIDATED: 3,
  EXPIRED: 0,
};

/**
 * Tracks every break's cause zone through its lifecycle instead of keeping only
 * the zone of the most recent break:
 *
 * - FRESH   — created, not yet revisited.
 * - TESTED  — first candle after the break re-entered the zone.
 * - MITIGATED — a candle closed past the zone midpoint after entering it
 *   (half the zone consumed; still tradeable as a faded level, not pristine).
 * - INVALIDATED — a candle closed through the far boundary; the zone thesis is
 *   dead. Terminal.
 * - EXPIRED — still FRESH when the age budget elapsed without any retest.
 *   Terminal.
 *
 * Transitions are monotonic and append-stable: recomputing over a longer candle
 * window never moves a recorded timestamp or lowers a state.
 */
export function buildZoneLedger(
  timeframe: Timeframe,
  candles: Candle[],
  atrValue: number,
  breaks: StructureBreak[],
  opts: { expiryBars?: number; maxRecords?: number } = {},
): ZoneRecord[] {
  if (!(atrValue > 0) || breaks.length === 0) return [];

  const expiryBars = opts.expiryBars ?? DEFAULT_ZONE_EXPIRY_BARS;
  const maxRecords = opts.maxRecords ?? MAX_ZONE_RECORDS;
  const records: ZoneRecord[] = [];

  for (const breakEvent of breaks) {
    const zone = detectCauseZone(timeframe, candles, breakEvent, atrValue)[0];
    if (!zone) continue;

    const record: ZoneRecord = {
      ...zone,
      state: 'FRESH',
      testedAt: null,
      mitigatedAt: null,
      invalidatedAt: null,
      invalidatedIndex: null,
      expiredAt: null,
      breakIndex: breakEvent.index,
      breakTime: breakEvent.time,
      ageBars: Math.max(0, candles.length - 1 - breakEvent.index),
    };

    const midpoint = (zone.high + zone.low) / 2;
    // A zone expires when it is still FRESH through candle breakIndex+expiryBars
    // (inclusive); expiry is an event, not a snapshot rule, so it is append-stable.
    const expiryIndex = breakEvent.index + expiryBars + 1;

    for (let i = breakEvent.index + 1; i < candles.length; i++) {
      const candle = candles[i];
      const overlaps = candle.low <= zone.high && candle.high >= zone.low;

      // Invalidation takes precedence over any softer transition on this candle.
      const invalidated = zone.type === 'DEMAND'
        ? candle.close < zone.low
        : candle.close > zone.high;
      if (invalidated) {
        record.state = 'INVALIDATED';
        record.invalidatedAt = candle.openTime;
        record.invalidatedIndex = i;
        break;
      }

      if (record.state === 'FRESH' && overlaps) {
        record.state = 'TESTED';
        record.testedAt = candle.openTime;
      }

      const mitigated = zone.type === 'DEMAND'
        ? candle.close < midpoint
        : candle.close > midpoint;
      if (record.state === 'TESTED' && mitigated) {
        record.state = 'MITIGATED';
        record.mitigatedAt = candle.openTime;
      }

      if (record.state === 'FRESH' && i >= expiryIndex) {
        record.state = 'EXPIRED';
        record.expiredAt = candle.openTime;
        break;
      }
    }

    records.push(record);
  }

  return records.slice(-maxRecords);
}

export function zoneStateRank(state: ZoneRecord['state']): number {
  return STATE_RANK[state];
}
