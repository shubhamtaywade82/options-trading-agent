import type { Candle } from '../types.js';
import type { ProtectionZone, StructureBreak, TrendDirection } from './types.js';

const MAX_BREAK_EVENTS = 50;

function isSwingHigh(candles: Candle[], index: number, strength: number): boolean {
  const price = candles[index]?.high;
  if (price === undefined) return false;
  for (let i = 1; i <= strength; i++) {
    if (price <= candles[index - i]?.high || price <= candles[index + i]?.high) return false;
  }
  return true;
}

function isSwingLow(candles: Candle[], index: number, strength: number): boolean {
  const price = candles[index]?.low;
  if (price === undefined) return false;
  for (let i = 1; i <= strength; i++) {
    if (price >= candles[index - i]?.low || price >= candles[index + i]?.low) return false;
  }
  return true;
}

interface ConfirmedSwing {
  index: number;
  time: number;
  price: number;
}

/**
 * Scans the full candle window for every BOS/CHOCH event, not only the one that
 * happens to land on the last candle (`findLatestBreak` keeps that behaviour for
 * `StructureState.lastBreak`).
 *
 * An event fires on candle i exactly when `findLatestBreak`, run on candles[0..i],
 * would have reported a break: the latest confirmed swing level crossed by a
 * close (previous close on the far side, current close on the near side). This
 * makes the newest log entry and `lastBreak` strictly consistent whenever a
 * break lands on the last candle, and a level that price closed back through can
 * legitimately fire again on the next crossing (a reclaim attempt).
 *
 * Causality contract:
 * - A swing at index p is only *known* at p + strength; it can never influence
 *   break detection or trend classification before that bar.
 * - Core event fields (type, direction, level, index, time, distanceAtr,
 *   protectedLevel, zone geometry) are pure functions of candles up to the break
 *   candle, so appending candles never rewrites them.
 * - Protection-zone `tested`/`violated` flags only accumulate: once observed at
 *   some prefix length they remain true in every longer prefix, and the recorded
 *   timestamps never move.
 */
export function findStructureBreakEvents(
  candles: Candle[],
  atrValue: number,
  strength = 2,
  maxEvents = MAX_BREAK_EVENTS,
): StructureBreak[] {
  if (candles.length < 2 || !(atrValue > 0)) return [];

  const confirmedHighs: ConfirmedSwing[] = [];
  const confirmedLows: ConfirmedSwing[] = [];
  // Latest confirmed swing on each side, as of the current candle.
  let lastHigh: ConfirmedSwing | null = null;
  let lastLow: ConfirmedSwing | null = null;
  const events: StructureBreak[] = [];

  const trendOf = (): TrendDirection => {
    if (confirmedHighs.length < 2 || confirmedLows.length < 2) return 'NEUTRAL';
    const prevHigh = confirmedHighs[confirmedHighs.length - 2];
    const lastHighSwing = confirmedHighs[confirmedHighs.length - 1];
    const prevLow = confirmedLows[confirmedLows.length - 2];
    const lastLowSwing = confirmedLows[confirmedLows.length - 1];
    if (lastHighSwing.price > prevHigh.price && lastLowSwing.price > prevLow.price) return 'BULLISH';
    if (lastHighSwing.price < prevHigh.price && lastLowSwing.price < prevLow.price) return 'BEARISH';
    return 'NEUTRAL';
  };

  for (let i = 1; i < candles.length; i++) {
    // Swing confirmation is processed before break detection on the same candle,
    // matching findSwingPoints/findLatestBreak visibility at the last bar.
    const pivot = i - strength;
    if (pivot >= strength) {
      if (isSwingHigh(candles, pivot, strength)) {
        lastHigh = { index: pivot, time: candles[pivot].openTime, price: candles[pivot].high };
        confirmedHighs.push(lastHigh);
      }
      if (isSwingLow(candles, pivot, strength)) {
        lastLow = { index: pivot, time: candles[pivot].openTime, price: candles[pivot].low };
        confirmedLows.push(lastLow);
      }
    }

    const candle = candles[i];
    const previousClose = candles[i - 1].close;

    const bullish = lastHigh !== null && previousClose <= lastHigh.price && candle.close > lastHigh.price;
    const bearish = lastLow !== null && previousClose >= lastLow.price && candle.close < lastLow.price;
    if (!bullish && !bearish) continue;

    // Matches findLatestBreak: bullish wins the degenerate both-cross candle.
    const direction: 'BULLISH' | 'BEARISH' = bullish ? 'BULLISH' : 'BEARISH';
    const broken = direction === 'BULLISH' ? lastHigh! : lastLow!;
    const protectedSwing = direction === 'BULLISH' ? lastLow : lastHigh;
    const trend = trendOf();

    events.push({
      type: trend === (direction === 'BULLISH' ? 'BEARISH' : 'BULLISH') ? 'CHOCH' : 'BOS',
      direction,
      level: broken.price,
      index: i,
      time: candle.openTime,
      distanceAtr: Math.abs(candle.close - broken.price) / atrValue,
      protectedLevel: protectedSwing?.price,
      protectionZone: protectedSwing
        ? {
            low: Math.min(broken.price, protectedSwing.price),
            high: Math.max(broken.price, protectedSwing.price),
            originLevel: broken.price,
            protectedLevel: protectedSwing.price,
            tested: false,
            testedAt: null,
            violated: false,
            violatedAt: null,
            violatedIndex: null,
          }
        : null,
    });

  }

  // Post-pass: track protection-zone tests/violations using only candles after
  // each break (forward information accumulates monotonically with the window).
  for (const event of events) {
    const zone = event.protectionZone;
    if (!zone) continue;
    for (let i = event.index + 1; i < candles.length; i++) {
      const candle = candles[i];
      if (!zone.tested) {
        const touched = event.direction === 'BULLISH'
          ? candle.low <= zone.high
          : candle.high >= zone.low;
        if (touched) {
          zone.tested = true;
          zone.testedAt = candle.openTime;
        }
      }
      const violated = event.direction === 'BULLISH'
        ? candle.close < zone.protectedLevel
        : candle.close > zone.protectedLevel;
      if (violated) {
        zone.violated = true;
        zone.violatedAt = candle.openTime;
        zone.violatedIndex = i;
        break;
      }
    }
  }

  return events.slice(-maxEvents);
}
