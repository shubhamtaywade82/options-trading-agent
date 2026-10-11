import type { AgentId, Position, Side } from '../types.js';
import { dec, floorToStep } from '../risk/primitives.js';

/**
 * Deterministic, I/O-free position manager. One PmState per open position; `advance` turns a mark into
 * intents (partial reduces and stop moves) that the orchestrator executes on the venue.
 *
 *   INITIAL --TP1--> PROTECTED --TP2 (RUNNER mode)--> TRAILING ; any --position gone--> CLOSED (store drops it)
 *
 * The initial stop is owned by the entry strategy; the manager only ever ratchets it toward price.
 */
export type PmPhase = 'INITIAL' | 'PROTECTED' | 'TRAILING' | 'CLOSED';
/** RUNNER: no fixed target after TP2, the trail decides. TARGET: the signal's TP stays the final exit. */
export type PmMode = 'RUNNER' | 'TARGET';
export type VolClass = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PmConfig {
  tp1R: number;
  tp1Fraction: number;
  tp2R: number;
  tp2Fraction: number;
  trailAtr: Record<VolClass, number>;
  /** A trail never sits closer than this many ATR to the mark, so a trail update cannot stop the trade out by itself. */
  minTrailGapAtr: number;
  /** Round-trip cost kept above entry once breakeven is armed: 2 x (taker fee + slippage buffer). */
  costBufferRate: number;
  /** Strategies whose final exit is always their own target (mean reversion has no trend to ride). */
  targetOnlyStrategies: readonly AgentId[];
  /** When the stop first moves to entry plus costs: after the TP1 fill (default), after the TP2 fill, or never. */
  breakevenAfter: 'TP1' | 'TP2' | 'NEVER';
  /** The trail only starts once the best price since entry is this many R in profit (0 = as soon as TP1 is taken). */
  trailStartR: number;
}

export const DEFAULT_PM_CONFIG: PmConfig = {
  tp1R: 1, tp1Fraction: 0.35, tp2R: 2, tp2Fraction: 0.3,
  trailAtr: { LOW: 2, MEDIUM: 2.5, HIGH: 3.2 },
  minTrailGapAtr: 0.25,
  costBufferRate: 2 * (0.0004 + 0.0002),
  targetOnlyStrategies: ['MEAN-REVERT-θ'],
  breakevenAfter: 'TP1',
  trailStartR: 0,
};

export interface PmState {
  key: string;
  symbol: string;
  strategy: AgentId;
  side: Side;
  entry: number;
  oneR: number;
  initialQty: number;
  /** Quantity already taken by partials; with `entry` it detects an outside change (scale-in) that invalidates the state. */
  reducedQty: number;
  phase: PmPhase;
  mode: PmMode;
  stop: number;
  target: number | null;
  /** The signal's own TP, kept so a failed TP2 order can restore it. */
  signalTarget: number | null;
  tp1Done: boolean;
  tp2Done: boolean;
  /** Best price since the state was created (high for longs, low for shorts). */
  extreme: number;
  openedAt: number;
  updatedAt: number;
}

export interface LotRules { step: number; minQty: number; minNotional: number }

export interface PmInput {
  mark: number;
  /** Current open quantity on the venue. */
  qty: number;
  atr: number | null;
  vol: VolClass;
  /** Latest protected swing level (long: swing low minus buffer; short: swing high plus buffer). */
  swingStop?: number | null;
  superTrend?: number | null;
  lot: LotRules;
}

export type PmAction =
  | { type: 'REDUCE'; qty: number; reason: 'TP1' | 'TP2' }
  | { type: 'MOVE_STOP'; stop: number; target: number | null; reason: 'BREAKEVEN' | 'TRAIL' | 'STRUCTURE' };

export interface PmResult {
  state: PmState;
  actions: PmAction[];
  /** Human-readable reasons for anything deliberately skipped (e.g. a partial below the lot minimum). */
  notes: string[];
}

const dirOf = (side: Side): 1 | -1 => (side === 'LONG' ? 1 : -1);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
export const pmKey = (symbol: string, strategy: string): string => `${symbol}:${strategy}`;

/** Initial manager state for a position, or null when it has no numeric stop (hedges, adopted/external, live 'server'). */
export function initState(pos: Position, now: number, cfg: PmConfig = DEFAULT_PM_CONFIG): PmState | null {
  const stop = Number(pos.serverSl);
  if (!isNum(stop) || !isNum(pos.entry) || !isNum(pos.qty)) return null;
  const dir = dirOf(pos.side);
  // A stop at or beyond entry means breakeven was already armed (a rebuilt state after a restart or scale-in): the 1R can then
  // only come from the recorded initial risk, and TP1 is not taken a second time
  const lockedIn = (stop - pos.entry) * dir >= 0;
  if (lockedIn && !isNum(pos.initialRisk)) return null;
  const oneR = isNum(pos.initialRisk) ? pos.initialRisk : Math.abs(pos.entry - stop);
  const tp = Number(pos.serverTp);
  const target = isNum(tp) && (tp - pos.entry) * dir > 0 ? tp : null;
  const targetOnly = cfg.targetOnlyStrategies.includes(pos.strategy);
  const mode: PmMode = target !== null && (targetOnly || Math.abs(target - pos.entry) / oneR <= cfg.tp2R) ? 'TARGET' : 'RUNNER';
  return {
    key: pmKey(pos.symbol, pos.strategy), symbol: pos.symbol, strategy: pos.strategy, side: pos.side,
    entry: pos.entry, oneR, initialQty: pos.qty, reducedQty: 0, phase: lockedIn ? 'PROTECTED' : 'INITIAL', mode, stop, target,
    signalTarget: target, tp1Done: lockedIn, tp2Done: false,
    extreme: isNum(pos.mark) ? pos.mark : pos.entry, openedAt: now, updatedAt: now,
  };
}

/** True when the venue position no longer matches the state (scale-in, flip, manual change) and the state must be rebuilt. */
export function isStale(state: PmState, pos: Position): boolean {
  if (pos.side !== state.side) return true;
  if (Math.abs(pos.entry - state.entry) / state.entry > 1e-4) return true;
  const expected = state.initialQty - state.reducedQty;
  return pos.qty > expected * (1 + 1e-6);
}

/** Undoes the optimistic flag of a partial whose order failed, so the next tick retries it. */
export function revertReduce(state: PmState, reason: 'TP1' | 'TP2', qty: number): PmState {
  return {
    ...state,
    reducedQty: Math.max(0, dec(state.reducedQty).minus(qty).toNumber()),
    tp1Done: reason === 'TP1' ? false : state.tp1Done,
    tp2Done: reason === 'TP2' ? false : state.tp2Done,
    phase: reason === 'TP1' ? 'INITIAL' : 'PROTECTED',
    target: reason === 'TP2' ? state.signalTarget : state.target,
  };
}

function partialQty(fraction: number, state: PmState, remaining: number, mark: number, lot: LotRules): number | string {
  const qty = floorToStep(dec(state.initialQty * fraction), dec(lot.step)).toNumber();
  if (!(qty > 0) || qty < lot.minQty) return `partial ${qty} below min lot ${lot.minQty}`;
  if (qty * mark < lot.minNotional) return `partial notional ${(qty * mark).toFixed(2)} below min ${lot.minNotional}`;
  const left = remaining - qty;
  if (left < lot.minQty || left * mark < lot.minNotional) return 'remainder would fall below the exchange minimum';
  return qty;
}

interface StopCandidate { level: number; reason: 'BREAKEVEN' | 'TRAIL' | 'STRUCTURE' }

function stopCandidates(state: PmState, input: PmInput, cfg: PmConfig): StopCandidate[] {
  const dir = dirOf(state.side);
  const out: StopCandidate[] = [];
  const beyondMark = (level: number): boolean => (input.mark - level) * dir > 0;
  const breakevenArmed = cfg.breakevenAfter === 'TP1' ? state.tp1Done : cfg.breakevenAfter === 'TP2' ? state.tp2Done : false;
  if (breakevenArmed) {
    const be = state.entry + dir * state.entry * cfg.costBufferRate;
    if (beyondMark(be)) out.push({ level: be, reason: 'BREAKEVEN' });
  }
  const excursionR = ((state.extreme - state.entry) * dir) / state.oneR;
  if (state.phase === 'INITIAL' || excursionR < cfg.trailStartR || input.atr === null || !(input.atr > 0)) return out;
  const gap = cfg.minTrailGapAtr * input.atr;
  const clamp = (level: number): number => (dir === 1 ? Math.min(level, input.mark - gap) : Math.max(level, input.mark + gap));
  out.push({ level: clamp(state.extreme - dir * cfg.trailAtr[input.vol] * input.atr), reason: 'TRAIL' });
  for (const structural of [input.swingStop, input.superTrend]) {
    if (typeof structural === 'number' && isNum(structural) && beyondMark(structural)) out.push({ level: clamp(structural), reason: 'STRUCTURE' });
  }
  return out;
}

/** One step of the manager. Pure: returns a new state, never mutates the input. */
export function advance(prev: PmState, input: PmInput, cfg: PmConfig, now: number): PmResult {
  const notes: string[] = [];
  if (!isNum(input.mark) || !isNum(input.qty)) return { state: prev, actions: [], notes: ['invalid mark or quantity'] };
  const dir = dirOf(prev.side);
  const state: PmState = { ...prev, extreme: dir === 1 ? Math.max(prev.extreme, input.mark) : Math.min(prev.extreme, input.mark), updatedAt: now };
  const actions: PmAction[] = [];
  const gainR = ((input.mark - state.entry) * dir) / state.oneR;
  let remaining = input.qty;

  if (!state.tp1Done && gainR >= cfg.tp1R) {
    const qty = partialQty(cfg.tp1Fraction, state, remaining, input.mark, input.lot);
    state.tp1Done = true;
    state.phase = 'PROTECTED';
    if (typeof qty === 'number') {
      actions.push({ type: 'REDUCE', qty, reason: 'TP1' });
      state.reducedQty = dec(state.reducedQty).plus(qty).toNumber();
      remaining = dec(remaining).minus(qty).toNumber();
    } else notes.push(`TP1 partial skipped: ${qty}`);
  }
  if (state.mode === 'RUNNER' && !state.tp2Done && gainR >= cfg.tp2R) {
    const qty = partialQty(cfg.tp2Fraction, state, remaining, input.mark, input.lot);
    state.tp2Done = true;
    state.phase = 'TRAILING';
    state.target = null; // from here the trail is the only exit besides the stop
    if (typeof qty === 'number') {
      actions.push({ type: 'REDUCE', qty, reason: 'TP2' });
      state.reducedQty = dec(state.reducedQty).plus(qty).toNumber();
    } else notes.push(`TP2 partial skipped: ${qty}`);
  }

  const best = stopCandidates(state, input, cfg).reduce<StopCandidate | null>(
    (acc, c) => (acc === null || (c.level - acc.level) * dir > 0 ? c : acc), null);
  const targetChanged = state.target !== prev.target;
  if (best && (best.level - state.stop) * dir > 0) {
    state.stop = best.level;
    actions.push({ type: 'MOVE_STOP', stop: best.level, target: state.target, reason: best.reason });
  } else if (targetChanged) {
    actions.push({ type: 'MOVE_STOP', stop: state.stop, target: state.target, reason: 'TRAIL' });
  }
  return { state, actions, notes };
}
