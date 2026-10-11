import type { Position, Side } from '../types.js';

export function directionOf(side: Side): 1 | -1 {
  return side === 'LONG' ? 1 : -1;
}

/** A usable price: NaN, zero, negatives, Infinity and non-numbers must never become a mark. */
export const isPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export interface StopExit {
  price: number;
  reason: 'STOP LOSS' | 'TAKE PROFIT';
}

/**
 * SL fills at the current mark (a breached stop never fills at a better level),
 * TP at its level; non-numeric labels ('—', 'trail', 'fund', '') never trigger.
 */
export function findStopExit(pos: Pick<Position, 'side' | 'mark' | 'serverSl' | 'serverTp'>): StopExit | null {
  const direction = directionOf(pos.side);
  // Non-numeric labels parse to NaN; coercion with > 0 makes them falsy
  const stopLoss = Number(pos.serverSl);
  const takeProfit = Number(pos.serverTp);

  if (stopLoss > 0 && (pos.mark - stopLoss) * direction <= 0) {
    return { price: pos.mark, reason: 'STOP LOSS' };
  }
  if (takeProfit > 0 && (pos.mark - takeProfit) * direction >= 0) {
    return { price: takeProfit, reason: 'TAKE PROFIT' };
  }
  return null;
}
