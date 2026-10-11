import type { Position } from '../types.js';
import { TP_ATR_MULTIPLE, type AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';

export interface StopLevels {
  stopLoss: number;
  takeProfit: number;
}

export interface TrailState {
  assignedAtr: number;
  regime?: 'LOW' | 'MEDIUM' | 'HIGH';
  superTrend?: number;
}

// Extend the TP once price is within this many assigned ATRs of it, by TP_EXTENSION_ATR.
// The LOW-regime cap reuses it as hysteresis so tick noise cannot re-tighten the TP every loop
const TP_TRIGGER_ATR = 0.5;
const TP_EXTENSION_ATR = 1;

interface TierParams {
  stopLoss: number;
  entry: number;
  mark: number;
  direction: 1 | -1;
  oneR: number;
  atr: number;
}

function applyProfitTiers({ stopLoss, entry, mark, direction, oneR, atr }: TierParams): number {
  const tighter = (a: number, b: number) => (direction === 1 ? Math.max(a, b) : Math.min(a, b));
  const gain = (mark - entry) * direction;
  if (oneR <= 0 || gain < oneR) return stopLoss;

  let sl = tighter(stopLoss, entry);
  if (gain >= 1.5 * oneR) sl = tighter(sl, entry + direction * 0.5 * oneR);
  if (gain >= 2.0 * oneR) {
    sl = tighter(sl, entry + direction * 1.0 * oneR);
    sl = tighter(sl, mark - direction * 1.5 * atr);
  }
  if (gain >= 3.0 * oneR) sl = tighter(sl, entry + direction * 2.0 * oneR);
  return sl;
}

interface TargetParams {
  stopLoss: number;
  takeProfit: number;
  mark: number;
  direction: 1 | -1;
  atr: number;
  regime?: string;
  gain: number;
}

function applyTargetExtensions(p: TargetParams): { stopLoss: number; takeProfit: number } {
  const tighter = (a: number, b: number) => (p.direction === 1 ? Math.max(a, b) : Math.min(a, b));
  let sl = p.stopLoss;
  let tp = p.takeProfit;

  if ((tp - p.mark) * p.direction <= TP_TRIGGER_ATR * p.atr) {
    sl = tighter(sl, tp - p.direction * p.atr);
    tp += p.direction * TP_EXTENSION_ATR * p.atr;
  }

  if (p.regime === 'LOW' && p.gain > 0) {
    const cap = p.mark + p.direction * TP_ATR_MULTIPLE.LOW * p.atr;
    if ((tp - cap) * p.direction > TP_TRIGGER_ATR * p.atr) tp = cap;
  }

  return { stopLoss: sl, takeProfit: tp };
}

/**
 * Universal trailing stops and profit protection for fleet positions.
 * Locks breakeven at 1R, locks tiered profit at 1.5R/2R/3R, and extends TP near targets.
 */
export function nextStops(position: Position, state: TrailState): StopLevels | null {
  const currentStop = Number(position.serverSl);
  const currentTarget = Number(position.serverTp);
  if (!(currentStop > 0) || !(currentTarget > 0)) return null;

  const direction = position.side === 'LONG' ? 1 : -1;
  const tighter = (a: number, b: number) => (direction === 1 ? Math.max(a, b) : Math.min(a, b));
  const { mark, entry } = position;
  const atr = state.assignedAtr;

  const baseSl = state.superTrend !== undefined ? tighter(currentStop, state.superTrend) : currentStop;
  const oneR = position.initialRisk ?? Math.abs(entry - currentStop);

  const tieredSl = applyProfitTiers({ stopLoss: baseSl, entry, mark, direction, oneR, atr });
  const gain = (mark - entry) * direction;
  const { stopLoss, takeProfit } = applyTargetExtensions({
    stopLoss: tieredSl, takeProfit: currentTarget, mark, direction, atr, regime: state.regime, gain,
  });

  return stopLoss === currentStop && takeProfit === currentTarget ? null : { stopLoss, takeProfit };
}
