import type { Candle, ExitReason, Side, TradeRecord } from '../types.js';
import type { NativeTimeframe } from '../market/MarketDataTypes.js';
import type { MarketRegime } from '../market/types.js';
import type { RiskLimits } from '../risk/riskConfig.js';

/** Historical market data for one replay: candles per symbol, keyed by native timeframe (15m mandatory). */
export type ReplayData = Record<string, Partial<Record<NativeTimeframe, Candle[]>>>;

/** Per-symbol funding history; the last observation at or before the step time applies. */
export interface FundingPoint {
  time: number;
  rate: number;
}

export interface ReplayCosts {
  /** Taker fee per fill, in basis points of notional (default matches config.risk.takerFeeRate). */
  takerFeeBps: number;
  /** Half-spread applied against the taker on each fill. */
  spreadBps: number;
  /** Flat slippage estimate applied on each fill. */
  slippageBps: number;
}

export interface ReplayFundingConfig {
  /** Apply periodic funding payments to held positions. */
  enabled: boolean;
  /** Funding interval in hours (Binance default: 8). */
  intervalHours: number;
  /** Constant rate per interval when no per-symbol series is supplied (longs pay positive rates). */
  rate: number;
  /** Optional per-symbol funding history; overrides `rate`. */
  series?: Record<string, FundingPoint[]>;
}

export interface ReplayConfig {
  initialEquity: number;
  /** 15m bars skipped before the first decision so indicators and structure have history. */
  warmupBars: number;
  costs: ReplayCosts;
  funding: ReplayFundingConfig;
  /** Formal risk engine path (Decimal sizer + circuit breaker) — the recommended replay default. */
  riskEngine: 'on' | 'off';
  riskLimits?: RiskLimits;
  /** Where the decision journal is written; null keeps the lineage in memory only. */
  decisionsPath: string | null;
  /**
   * Feed closed trades into the learning ledger's per-agent stats and adjust
   * collected signal confidence from them, exactly like the orchestrator's
   * cycle (default). Off restores the pre-learning replay for A/B runs; the
   * ledger is in-memory either way, so one replay never trains another.
   */
  learning: boolean;
  /**
   * Manage open positions with the production position manager (TP1/TP2 partials, breakeven + cost buffer, chandelier and
   * structure trail). Undefined follows config.positionManager.enabled; false restores the fixed stop/target replay for A/B runs.
   */
  positionManager?: boolean;
  /** Scored regime with hysteresis: options to use it, null for the original classifier, undefined to follow REGIME_MODEL. */
  regime?: Partial<import('../market/RegimeScoring.js').RegimeOptions> | null;
  /** Overrides the manager parameters derived from the environment. */
  pm?: import('../position/PositionManager.js').PmConfig;
}

/** A closed trade with the replay-only research fields the production TradeRecord cannot carry. */
export interface SimTrade extends TradeRecord {
  openedAt: number;
  /** Groups the partial legs and the final close of one position; absent on records from before partial exits existed. */
  positionId?: string;
  /** Market regime at entry — the slice the strategy router keys on. */
  regime: MarketRegime;
  /** Evidence score of the decision that opened the trade, when known. */
  evidenceScore: number | null;
  /** Max adverse excursion in R units (adverse price distance / initial risk). */
  maeR: number | null;
  /** Max favorable excursion in R units. */
  mfeR: number | null;
  /** Round-trip taker fees paid. */
  fees: number;
  /** Funding paid over the hold (negative = paid). */
  funding: number;
  /** Friction versus the mid price across both fills. */
  slippage: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface ExitEvaluation {
  price: number;
  reason: ExitReason;
}

export const FIFTEEN_MINUTES_MS = 15 * 60_000;

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  initialEquity: 1_150,
  warmupBars: 300,
  costs: { takerFeeBps: 4, spreadBps: 2, slippageBps: 3 },
  funding: { enabled: false, intervalHours: 8, rate: 0 },
  riskEngine: 'on',
  decisionsPath: null,
  learning: true,
};

export type { Candle, Side };
