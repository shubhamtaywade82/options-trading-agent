import type { TrendDirection, VolatilityRegime } from '../market/types.js';
import type { FlowContext } from '../market/FlowTracker.js';
import type { EntryLocation, SweepEvidence } from './SetupEvidence.js';
import type { NoTradeReason } from './NoTrade.js';

export type SetupDirection = 'LONG' | 'SHORT';
export type SetupKind = 'BREAKOUT_RETEST' | 'PULLBACK_RETEST' | 'LIQUIDITY_SWEEP';
/**
 * FORMING: structure/liquidity identified, level not yet taken/retested.
 * ARMED: level taken (or zone retested / sweep reclaimed) but the lower-timeframe
 * confirming break has not printed yet — one confirmation candle from TRIGGERED.
 * TRIGGERED: confirming break printed in the setup's direction. INVALIDATED is a
 * terminal state scenarios pass through but are never returned in (dead setups
 * are dropped, not surfaced). NO_TRADE is map-level only: no admissible scenario.
 */
export type SetupState = 'FORMING' | 'ARMED' | 'TRIGGERED' | 'INVALIDATED' | 'NO_TRADE';

export interface ExpectedMoveWindow {
  minMinutes: number;
  maxMinutes: number;
  thesisExpiryMinutes: number;
  distanceAtr: number;
}

export interface SetupScenario {
  id: string;
  kind: SetupKind;
  direction: SetupDirection;
  state: Exclude<SetupState, 'NO_TRADE' | 'INVALIDATED'>;
  timeframe: '15m' | '1h' | '4h';
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  trigger: string;
  invalidation: string;
  flowHypothesis: string;
  expectedMove: ExpectedMoveWindow;
  sourceTime: number;
  rewardRisk: number;
  /** Stamped by SetupLedger: stable identity and lifecycle, fixed at first sight. */
  lifecycle?: SetupLifecycle;
  /** Where the planned entry sits in the dealing range (distinct from where price is now). */
  locationAtEntry?: { location: EntryLocation; pct: number };
  evidence?: SweepEvidence;
  quality?: SetupQuality;
  /** Set by ThesisController: only AUTHORITATIVE scenarios may become execution candidates. */
  thesisRole?: 'AUTHORITATIVE' | 'COMPETING';
}

export type CheckResult = 'PASS' | 'WEAK' | 'FAIL';
export type SetupVerdict = 'ENTRY_ELIGIBLE' | 'WATCH' | 'NO_TRADE';

/** Deterministic quality gate output. The LLM may explain it; it may not override it. */
export interface SetupQuality {
  verdict: SetupVerdict;
  checks: Record<'structure' | 'location' | 'trigger' | 'evidence' | 'flow' | 'rr' | 'freshness', CheckResult>;
  /** Cost-adjusted RR the rr check was computed on. */
  effectiveRr: number;
  reasons: NoTradeReason[];
}

export interface ThesisTransition {
  from: SetupDirection;
  to: SetupDirection;
  reason: 'INVALIDATION_BREACHED' | 'THESIS_EXPIRED' | 'OPPOSING_TRIGGER';
  at: number;
}

/**
 * Immutable-origin lifecycle. `expiresAt` is fixed from the originating structural event
 * (`sourceTime` + thesis window at first sight) and is never extended; a new structural
 * event yields a new scenario id and therefore a new setup.
 */
export interface SetupLifecycle {
  setupId: string;
  version: number;
  createdAt: number;
  expiresAt: number;
  /** Highest state ever reached; states only advance while the setup lives. */
  highestState: Exclude<SetupState, 'NO_TRADE' | 'INVALIDATED'>;
  /** Trigger confirmed does not mean the entry is executable; the entry zone may still be ahead. */
  entryState: 'WAITING_ENTRY' | 'IN_ENTRY_ZONE' | 'ENTRY_MISSED';
  /** Cycles the engine failed to re-derive this setup without a structural kill; reset when it reappears. */
  missedCycles: number;
}

export interface SetupMap {
  symbol: string;
  generatedAt: number;
  mark: number;
  state: SetupState;
  bias: TrendDirection;
  regime: string;
  volatility: VolatilityRegime;
  positionPct: number;
  location: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  htfTrend: TrendDirection;
  ltfTrend: TrendDirection;
  lastBreak: {
    type: 'BOS' | 'CHOCH';
    direction: TrendDirection;
    level: number;
    time: number;
    distanceAtr: number;
  } | null;
  nearestUpperLiquidity: number | null;
  nearestLowerLiquidity: number | null;
  crowding: string | null;
  openInterestExpansion: boolean | null;
  takerAggressionRatio: number | null;
  scenarios: SetupScenario[];
  /** Scenario ids whose thesis was structurally killed this cycle (as opposed to merely not admissible). */
  invalidatedIds?: string[];
  /** Flow deltas at map time (OI vs price, taker z-score); absent when no derivatives history exists. */
  flow?: FlowContext;
  thesisTransition?: ThesisTransition;
  /** Scenarios withheld because they compete with the authoritative thesis. */
  withheldIds?: string[];
  noTradeReasons: string[];
}
