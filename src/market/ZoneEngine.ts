import type { Candle } from '../types.js';
import type { PriceZone, StructureBreak, Timeframe } from './types.js';

export function detectCauseZone(
  timeframe: Timeframe,
  candles: Candle[],
  structureBreak: StructureBreak | null,
  atrValue: number,
): PriceZone[] {
  if (!structureBreak || structureBreak.index <= 0 || atrValue <= 0) return [];

  const start = Math.max(0, structureBreak.index - 6);
  const end = structureBreak.index;
  let originIndex = -1;

  for (let i = end - 1; i >= start; i--) {
    const candle = candles[i];
    if (!candle) continue;
    const bearish = candle.close < candle.open;
    const bullish = candle.close > candle.open;

    if (structureBreak.direction === 'BULLISH' && bearish) {
      originIndex = i;
      break;
    }

    if (structureBreak.direction === 'BEARISH' && bullish) {
      originIndex = i;
      break;
    }
  }

  if (originIndex < 0) return [];

  const origin = candles[originIndex];
  const zone: PriceZone = structureBreak.direction === 'BULLISH'
    ? {
        type: 'DEMAND',
        timeframe,
        high: Math.max(origin.open, origin.close),
        low: origin.low,
        originTime: origin.openTime,
        causedBreak: structureBreak.type,
        displacementAtr: Math.abs(candles[structureBreak.index].close - origin.high) / atrValue,
        touches: 0,
        fresh: true,
        strength: 0,
      }
    : {
        type: 'SUPPLY',
        timeframe,
        high: origin.high,
        low: Math.min(origin.open, origin.close),
        originTime: origin.openTime,
        causedBreak: structureBreak.type,
        displacementAtr: Math.abs(candles[structureBreak.index].close - origin.low) / atrValue,
        touches: 0,
        fresh: true,
        strength: 0,
      };

  let touches = 0;
  for (let i = originIndex + 1; i < candles.length; i++) {
    const candle = candles[i];
    if (candle.low <= zone.high && candle.high >= zone.low) touches += 1;
  }

  zone.touches = Math.max(0, touches - 1);
  zone.fresh = zone.touches === 0;
  zone.strength = Math.max(
    0,
    Math.min(1, 0.45 + Math.min(1, zone.displacementAtr / 3) * 0.35 + (zone.fresh ? 0.2 : 0)),
  );

  return [zone];
}
