import type { AgentId } from '../types.js';
import type { AgentLedger, AgentStats } from './AgentLedger.js';

const MIN_MULTIPLIER = 0.6;
const MAX_MULTIPLIER = 1.2;
const COLD_START = 1.0;
const CONTEXT_MIN_TRADES = 5;
const PRIOR_TRADES = 4;

function selectedStats(agentId: AgentId, ledger: AgentLedger, symbol?: string): AgentStats {
  if (symbol) {
    const contextual = ledger.tradeStats(agentId, symbol);
    if (contextual.trades >= CONTEXT_MIN_TRADES) return contextual;
  }
  return ledger.get(agentId);
}

function learnedEdge(stats: AgentStats): number | null {
  if (stats.trades < 3) return null;
  const posteriorWinRate = (stats.wins + 2) / (stats.trades + 4);
  const avgR = stats.totalR / stats.trades;
  const shrunkAvgR = (avgR * stats.trades) / (stats.trades + PRIOR_TRADES);
  return posteriorWinRate * (1 + Math.max(-1, Math.min(2, shrunkAvgR))) - (1 - posteriorWinRate);
}

/**
 * Adapts signal confidence from realized outcomes.
 * Symbol-specific history is preferred once it has enough observations; otherwise the global agent history is used.
 * The adjustment is deliberately bounded and starts neutral to avoid overfitting early samples.
 */
export function confidenceMultiplier(agentId: AgentId, ledger: AgentLedger, symbol?: string): number {
  const edge = learnedEdge(selectedStats(agentId, ledger, symbol));
  if (edge === null) return COLD_START;
  const multiplier = 1 + edge * (edge > 0 ? MAX_MULTIPLIER - 1 : 1 - MIN_MULTIPLIER);
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, multiplier));
}
