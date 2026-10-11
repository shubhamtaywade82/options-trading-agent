import type { AgentId, RiskDecision, Signal } from '../types.js';
import type { MarketState } from '../market/types.js';
import { fuseSignals, type TradeIntent } from './SignalFusion.js';
import { applyRouter } from './StrategyRouter.js';
import { scoreCandidate } from './CandidateScorer.js';
import type { DecisionEvidence, DecisionRecord } from './DecisionJournal.js';
import { config } from '../config.js';
import { breakevenWinRate } from '../risk/rrProfile.js';
import { decisionContextOf } from '../market/VolatilityPhase.js';

/** Agents whose candidates resolve through signal fusion; everyone else passes through directly. */
export const FUSION_AGENTS: ReadonlySet<string> = new Set(['STRUCTURE-TREND-η', 'STRUCT-LIQ-η', 'MEAN-REVERT-θ', 'CROWDING-ι']);

export interface RoutedOut {
  agent: string;
  symbol: string;
  regime: string;
}

export interface DecisionFlowResult {
  /** Signals that survive routing and fusion, ready for the risk gate. */
  signals: Signal[];
  /** Winning fusion intents, keyed by `${symbol}:${agent}` — the decision evidence source. */
  intents: Map<string, TradeIntent>;
  routedOut: RoutedOut[];
  /** Candidates dropped by fusion conflict resolution or the evidence floor. */
  fusionFiltered: number;
  /** Candidates dropped before routing for degenerate reward:risk geometry. */
  geometryDropped?: GeometryRejection[];
}

/**
 * The canonical candidate pipeline: regime routing, then fusion for the
 * multi-strategy agents. Both the live orchestrator and the replay engine call
 * this — the same strategy code must run in backtest, paper and live.
 */
export interface GeometryRejection { agent: string; symbol: string; rr: number | null; breakevenWinRate?: number }

/**
 * Sanity floor on planned reward:risk. A target sitting on top of the entry (RR 0.03) is not a scalp, it is an
 * invalid candidate; whatever strategy produced it, it never reaches the risk gate, the journal or the alerts.
 * Hedges carry no stop/target and pass. This is not an edge claim (calibrated floors live in the RR profile).
 */
export function dropDegenerateGeometry(
  signals: Signal[],
  minRr: number = config.candidateMinRr,
  maxBreakeven: number = config.candidateMaxBreakevenWinRate,
  costs = { feeRate: config.risk.takerFeeRate, slippageRate: config.risk.slippageBufferRate },
): { kept: Signal[]; dropped: GeometryRejection[] } {
  const kept: Signal[] = [];
  const dropped: GeometryRejection[] = [];
  for (const s of signals) {
    const { entry, stopLoss, takeProfit } = s;
    if ((minRr <= 0 && maxBreakeven <= 0) || !s.type.startsWith('OPEN_') || entry === undefined || stopLoss === undefined || takeProfit === undefined) { kept.push(s); continue; }
    const risk = Math.abs(entry - stopLoss);
    const rr = risk > 0 ? Math.abs(takeProfit - entry) / risk : null;
    if (rr === null || rr < minRr) { dropped.push({ agent: s.agent, symbol: s.symbol, rr }); continue; }
    const needed = maxBreakeven > 0 ? breakevenWinRate(entry, stopLoss, takeProfit, costs) : 0;
    if (maxBreakeven > 0 && !(needed <= maxBreakeven)) dropped.push({ agent: s.agent, symbol: s.symbol, rr, breakevenWinRate: needed });
    else kept.push(s);
  }
  return { kept, dropped };
}

export function runCandidateFlow(rawSignals: Signal[], states: Record<string, MarketState>): DecisionFlowResult {
  const { kept: raw, dropped } = dropDegenerateGeometry(rawSignals);
  const result = routeAndFuse(raw, states);
  return { ...result, geometryDropped: dropped };
}

function routeAndFuse(raw: Signal[], states: Record<string, MarketState>): DecisionFlowResult {
  const { passed, vetoed } = applyRouter(raw, states);
  const legacy = passed.filter((s) => !FUSION_AGENTS.has(s.agent));
  const candidates = passed.filter((s) => FUSION_AGENTS.has(s.agent));
  if (candidates.length === 0) {
    return { signals: legacy, intents: new Map(), routedOut: vetoed, fusionFiltered: 0 };
  }
  const intents = fuseSignals(candidates, states);
  const fused = intents.flatMap(({ symbol, sourceAgent }) => candidates.filter((s) => s.symbol === symbol && s.agent === sourceAgent));
  return {
    signals: [...legacy, ...fused],
    intents: new Map(intents.map((intent) => [`${intent.symbol}:${intent.sourceAgent}`, intent])),
    routedOut: vetoed,
    fusionFiltered: candidates.length - fused.length,
  };
}

/**
 * Evidence at decision time: the deterministic rubric computed from the
 * MarketState plus the composite that actually drove the decision (fusion
 * evidence when the signal went through fusion, otherwise the rubric total,
 * otherwise confidence).
 */
export function decisionEvidence(signal: Signal, state: MarketState | undefined, intent: TradeIntent | undefined): DecisionEvidence {
  const side = signal.type.includes('SHORT') ? 'SHORT' : 'LONG';
  const breakdown = state ? scoreCandidate(side, state) : null;
  return {
    breakdown,
    score: intent?.evidenceScore ?? breakdown?.total ?? Math.round(signal.confidence * 100),
    factors: intent?.reasons ?? breakdown?.reasons ?? [signal.reason],
  };
}

export interface DecisionRecordInput {
  decisionId: string;
  signal: Signal;
  state: MarketState | undefined;
  decision: RiskDecision;
  evidence: DecisionEvidence;
  now: number;
}

/** Builds the canonical DecisionRecord — one shape for paper, live and replay. */
export function buildDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const { decisionId, signal, state, decision, evidence, now } = input;
  return {
    decisionId,
    timestamp: now,
    symbol: signal.symbol,
    strategy: signal.agent,
    signalType: signal.type,
    side: signal.type === 'OPEN_LONG' ? 'LONG' : signal.type.startsWith('OPEN_') ? 'SHORT' : null,
    signalId: signal.id,
    confidence: signal.confidence,
    marketStateTime: state?.generatedAt ?? null,
    marketStateVersion: state?.version ?? null,
    evidence,
    entry: signal.entry ?? null,
    stopLoss: signal.stopLoss ?? null,
    takeProfit: signal.takeProfit ?? null,
    notionalUsdt: signal.notionalUsdt ?? decision.positionSizeUsdt,
    riskDecision: { approved: decision.approved, size: decision.positionSizeUsdt, leverage: decision.leverage, reason: decision.reason },
    status: decision.approved ? 'EXECUTED' : 'RISK_REJECTED',
    rejectionReason: decision.approved ? null : decision.reason,
    ...(state ? { context: decisionContextOf(state.regime, state.timeframes['15m']) } : {}),
  };
}

export type { AgentId };
