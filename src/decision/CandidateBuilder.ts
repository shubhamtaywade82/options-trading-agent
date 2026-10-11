import type { CandidateBuilderInput, TradeCandidate } from './types.js';
import { scoreCandidate } from './CandidateScorer.js';

export function buildCandidate(input: CandidateBuilderInput): TradeCandidate | null {
  const { signal, state } = input;

  if (
    (signal.type !== 'OPEN_LONG' && signal.type !== 'OPEN_SHORT')
    || signal.entry === undefined
    || signal.stopLoss === undefined
    || signal.takeProfit === undefined
    || !Number.isFinite(signal.entry)
    || !Number.isFinite(signal.stopLoss)
    || !Number.isFinite(signal.takeProfit)
  ) {
    return null;
  }

  const riskDistance = Math.abs(signal.entry - signal.stopLoss);
  const rewardDistance = Math.abs(signal.takeProfit - signal.entry);
  if (!(riskDistance > 0) || !(rewardDistance > 0)) return null;

  const rewardRisk = rewardDistance / riskDistance;
  if (!Number.isFinite(rewardRisk)) return null;

  const side = signal.type === 'OPEN_LONG' ? 'LONG' : 'SHORT';
  const evidence = scoreCandidate(side, state, input.executionScore);

  return {
    candidateId: `${signal.id}:${state.generatedAt}`,
    sourceSignalId: signal.id,
    symbol: signal.symbol,
    side,
    strategy: signal.agent,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    rewardRisk,
    marketStateTime: state.generatedAt,
    evidence,
    reason: evidence.reasons.join('; '),
    source: signal,
  };
}
