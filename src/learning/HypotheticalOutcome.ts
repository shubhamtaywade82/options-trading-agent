import type { DecisionRecord } from '../decision/DecisionJournal.js';
import type { Candle } from '../types.js';

export type BracketOutcome = 'TP' | 'SL' | 'TIMEOUT' | 'NO_DATA';

export interface BracketResult {
  outcome: BracketOutcome;
  /** Gross R (price move / initial risk); costs are charged by the calibrator. */
  grossR: number | null;
  mfeR: number | null;
  maeR: number | null;
  exitTime: number | null;
}

export interface BracketInput {
  side: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** Decision time; only candles opening at or after it are considered (no lookback into the past). */
  from: number;
  maxHoldMs: number;
}

/**
 * What a decision's bracket would have done on the real price path. Entry is assumed filled at `entry` (the
 * strategies quote the live mark at decision time). Within one candle, stop and target both inside the range is
 * resolved against us (stop first), because the intrabar order is unknowable. A path that reaches neither within
 * `maxHoldMs` is closed at the last close. Candles must be sorted by openTime.
 */
export function simulateBracket(input: BracketInput, candles: readonly Candle[]): BracketResult {
  const { side, entry, stopLoss, takeProfit, from, maxHoldMs } = input;
  const risk = Math.abs(entry - stopLoss);
  const sign = side === 'LONG' ? 1 : -1;
  const wrongSide = side === 'LONG' ? stopLoss >= entry || takeProfit <= entry : stopLoss <= entry || takeProfit >= entry;
  const NO_DATA: BracketResult = { outcome: 'NO_DATA', grossR: null, mfeR: null, maeR: null, exitTime: null };
  if (!(risk > 0) || wrongSide) return NO_DATA;

  let mfe = 0;
  let mae = 0;
  let last: Candle | undefined;
  for (const c of candles) {
    if (c.openTime < from) continue;
    if (c.openTime - from > maxHoldMs) break;
    last = c;
    const stopHit = side === 'LONG' ? c.low <= stopLoss : c.high >= stopLoss;
    const targetHit = side === 'LONG' ? c.high >= takeProfit : c.low <= takeProfit;
    const favourable = ((side === 'LONG' ? c.high : c.low) - entry) * sign / risk;
    const adverse = ((side === 'LONG' ? c.low : c.high) - entry) * sign / risk;
    if (stopHit) return { outcome: 'SL', grossR: -1, mfeR: mfe, maeR: Math.min(mae, -1), exitTime: c.openTime };
    mfe = Math.max(mfe, favourable);
    mae = Math.min(mae, adverse);
    if (targetHit) return { outcome: 'TP', grossR: Math.abs(takeProfit - entry) / risk, mfeR: Math.max(mfe, Math.abs(takeProfit - entry) / risk), maeR: mae, exitTime: c.openTime };
  }
  if (!last) return NO_DATA;
  return { outcome: 'TIMEOUT', grossR: ((last.close - entry) * sign) / risk, mfeR: mfe, maeR: mae, exitTime: last.openTime };
}

/**
 * One idea re-proposed every cycle is one observation, not forty: keeps the first record of each
 * symbol/strategy/side chain, where a chain continues while the next proposal arrives within `windowMs` of the previous.
 */
export function dedupeProposals(records: readonly DecisionRecord[], windowMs = 60 * 60_000): DecisionRecord[] {
  const lastSeen = new Map<string, number>();
  const kept: DecisionRecord[] = [];
  for (const r of [...records].sort((a, b) => a.timestamp - b.timestamp)) {
    const key = `${r.symbol}:${r.strategy}:${r.side}`;
    const previous = lastSeen.get(key);
    lastSeen.set(key, r.timestamp);
    if (previous === undefined || r.timestamp - previous > windowMs) kept.push(r);
  }
  return kept;
}

/** A synthetic EXECUTED record carrying the hypothetical outcome, so the existing calibrator can consume it unchanged. */
export function asHypotheticalExecuted(record: DecisionRecord, result: BracketResult): DecisionRecord | null {
  if (result.grossR === null || result.exitTime === null) return null;
  return {
    ...record,
    status: 'EXECUTED',
    outcome: { closedAt: result.exitTime, exit: record.entry ?? 0, qty: 0, pnl: 0, rMultiple: result.grossR, reason: `HYPOTHETICAL ${result.outcome}` },
  };
}
