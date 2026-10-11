export type Side = 'LONG' | 'SHORT';
export type Mode = 'paper' | 'live';
export type AgentId =
  | 'FUNDING-ARB-α'
  | 'MOMENTUM-γ'
  | 'RISK-MGR-δ'
  | 'EXECUTOR-ε'
  | 'ADAPTIVE-ST-ζ'
  | 'STRUCTURE-TREND-η'
  | 'MEAN-REVERT-θ'
  | 'CROWDING-ι'
  | 'STRUCT-LIQ-η'
  | 'AI-COUNCIL-κ';
export type SignalType = 'OPEN_LONG' | 'OPEN_SHORT' | 'OPEN_HEDGE' | 'OPEN_FUNDING_SHORT' | 'CLOSE' | 'MONITOR' | 'ALERT';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  id: string;
  agent: AgentId;
  symbol: string;
  type: SignalType;
  confidence: number;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  notionalUsdt?: number;
  reason: string;
  ts: number;
}

export interface RiskDecision {
  approved: boolean;
  positionSizeUsdt: number;
  leverage: number;
  marginType: 'ISOLATED' | 'CROSS';
  liqBufferAtr: number;
  reason: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  strategy: AgentId;
  entry: number;
  qty: number;
  mark: number;
  upnl: number;
  upnlPct: number;
  leverage: number;
  marginType: 'ISOLATED' | 'CROSS';
  liqDistancePct: number | null;
  serverSl: string;
  serverTp: string;
  initialRisk?: number; // |entry - first SL| in price units; the 1R used for breakeven trailing
  /** Links the open position back to the DecisionRecord that created it. */
  decisionId?: string;
  posType?: string; // e.g. 'PERP-SHORT' | 'LONG/SHORT' | 'LONG'
}

export type ExitReason = 'CLOSE' | 'FLIP' | 'STOP LOSS' | 'TAKE PROFIT' | 'LIQUIDATED' | 'PARTIAL TP';

export interface TradeRecord {
  symbol: string;
  strategy: AgentId;
  side: Side;
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  reason: ExitReason;
  closedAt: number;
  initialRisk?: number; // the position's 1R in price units, so an exit can be shown as an R multiple
  /** The decision that opened this trade — resolves the evidence the grader scores against. */
  decisionId?: string;
  /** True for a partial take-profit: the position stays open, so this record must not be graded as a finished trade. */
  partial?: boolean;
}

/** What the LLM sees when asked to veto an entry; all numbers come from deterministic code. */
export interface VetoSnapshot {
  symbol: string;
  side: Side;
  regime: 'HIGH' | 'MEDIUM' | 'LOW';
  distanceFromLineAtr: number;
  rsi: number;
  fundingRate: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

export interface LogEntry {
  ts: number;
  agent: AgentId | 'SYSTEM' | 'MANUAL';
  msg: string;
  level: 'info' | 'success' | 'warn' | 'error';
}

export type WsStatus = 'connected' | 'reconnecting' | 'down';

export interface AgentState {
  id: AgentId;
  status: 'RUNNING' | 'PAUSED' | 'WATCHING';
  strategy: string;
  positions: number | null; // null when live mode cannot attribute positions to a strategy
  winRate: number | null;
  pnl: number | null;
  note?: string; // short status suffix for the fleet row, e.g. the risk circuit state; absent when nothing is worth flagging
  edgeMultiplier?: number; // learning multiplier (e.g. 1.15x) from historical edge
}

export interface MarketPriceInfo {
  price: number;
  changePct: number;
  high24h?: number;
  low24h?: number;
  volumeQuote?: number;
  sparkline?: string;
  trend?: string;
}

export interface FundingInfo { rate: number; apr: number } // apr in % (rate × 3 × 365 × 100)

export interface AdaptiveInfo {
  direction: 'BULLISH' | 'BEARISH';
  regime: 'HIGH' | 'MEDIUM' | 'LOW';
  superTrend: number;
  distanceAtr: number;
}

export interface StrategyMetrics {
  fundingBySymbol: Record<string, FundingInfo>;
  nextFundingCountdown: string | null;
  estNextFundingUsd: number | null;
  zscoreBtcEth: number | null;
  atrBySymbol: Record<string, number>;
  adaptive: Record<string, AdaptiveInfo>;
  momentumAboveEma50: { up: number; total: number };
}

export interface AppState {
  mode: Mode;
  equity: number;
  initialEquity: number;
  upnl: number;
  marginUsed: number;
  positions: Position[];
  agents: AgentState[];
  logs: LogEntry[];
  funding: Record<string, number>;
  serverTime: number;
  spotPrices?: Record<string, MarketPriceInfo>;
  strategyMetrics: StrategyMetrics | null;
  totalPnl: number;
  totalPnlPct: number;
  successRate: number | null;
  sharpe: number | null;
  maxDd: number;
  var95: number | null;
  liqEvents: number | null;
  sessionDecisions: number;
  sessionExecuted: number;
  sessionMonitored: number;
  apiWeight: number;
  wsStatus: WsStatus;
  venue: { name: string; state: 'connected' | 'degraded' | 'down' | 'local' };
  exposurePct: number;
  minLiqDistancePct: number | null;
  corrBtcEth: number | null;
  marketIntel?: Record<string, MarketIntelSummary>;
}

/** Flat, display-ready summary of per-symbol market intelligence for the cockpit. */
export interface MarketIntelSummary {
  regime: string;
  htfTrend: string;
  ltfTrend: string;
  volatility: string;
  volatilityPct: number | null;
  premium: boolean;
  discount: boolean;
  positionPct: number;
  fundingApr: number | null;
  fundingPct: number | null;
  openInterestExpansion: boolean | null;
  crowding: string | null;
  spreadBps: number | null;
  lastSweep: string | null;
  strategyStatus: Record<string, 'READY' | 'BLOCKED'>;
}
