import type { Signal, Side } from '../types.js';
import type { MarketState } from '../market/types.js';

export interface EvidenceBreakdown {
  regime: number;
  structure: number;
  liquidity: number;
  location: number;
  derivatives: number;
  execution: number;
  total: number;
  reasons: string[];
}

export interface TradeCandidate {
  candidateId: string;
  sourceSignalId: string;
  symbol: string;
  side: Side;
  strategy: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rewardRisk: number;
  marketStateTime: number;
  evidence: EvidenceBreakdown;
  reason: string;
  source: Signal;
}

export interface FusionConflict {
  symbol: string;
  candidates: string[];
  reason: string;
}

export interface FusionRejection {
  candidateId: string;
  reason: string;
}

export interface FusionResult {
  candidates: TradeCandidate[];
  selected: TradeCandidate[];
  conflicts: FusionConflict[];
  rejected: FusionRejection[];
}

export interface CandidateBuilderInput {
  signal: Signal;
  state: MarketState;
  executionScore?: number;
}
