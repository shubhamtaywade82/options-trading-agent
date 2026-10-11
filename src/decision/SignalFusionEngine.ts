import type { Signal } from '../types.js';
import type { MarketState } from '../market/types.js';
import { buildCandidate } from './CandidateBuilder.js';
import type { FusionResult, TradeCandidate } from './types.js';

export interface SignalFusionOptions {
  minimumScore: number;
  minimumRewardRisk: number;
  conflictMargin: number;
  maxSelected: number;
}

export const DEFAULT_SIGNAL_FUSION_OPTIONS: SignalFusionOptions = {
  minimumScore: 55,
  minimumRewardRisk: 1.2,
  conflictMargin: 8,
  maxSelected: 1,
};

export class SignalFusionEngine {
  constructor(private readonly options: SignalFusionOptions = DEFAULT_SIGNAL_FUSION_OPTIONS) {}

  evaluate(
    signals: Signal[],
    marketState: Record<string, MarketState>,
  ): FusionResult {
    const candidates: TradeCandidate[] = [];
    const rejected: FusionResult['rejected'] = [];

    for (const signal of signals) {
      const state = marketState[signal.symbol];
      if (!state) {
        rejected.push({ candidateId: signal.id, reason: 'market state unavailable' });
        continue;
      }

      const candidate = buildCandidate({ signal, state });
      if (!candidate) {
        rejected.push({ candidateId: signal.id, reason: 'signal has invalid trade levels' });
        continue;
      }

      if (candidate.rewardRisk < this.options.minimumRewardRisk) {
        rejected.push({
          candidateId: candidate.candidateId,
          reason: `reward:risk ${candidate.rewardRisk.toFixed(2)} < ${this.options.minimumRewardRisk.toFixed(2)}`,
        });
        continue;
      }

      if (candidate.evidence.total < this.options.minimumScore) {
        rejected.push({
          candidateId: candidate.candidateId,
          reason: `evidence score ${candidate.evidence.total} < ${this.options.minimumScore}`,
        });
        continue;
      }

      candidates.push(candidate);
    }

    const bySymbol = new Map<string, TradeCandidate[]>();
    for (const candidate of candidates) {
      const list = bySymbol.get(candidate.symbol) ?? [];
      list.push(candidate);
      bySymbol.set(candidate.symbol, list);
    }

    const selected: TradeCandidate[] = [];
    const conflicts: FusionResult['conflicts'] = [];

    for (const [symbol, symbolCandidates] of bySymbol) {
      const longs = symbolCandidates.filter((candidate) => candidate.side === 'LONG');
      const shorts = symbolCandidates.filter((candidate) => candidate.side === 'SHORT');

      if (longs.length > 0 && shorts.length > 0) {
        const bestLong = [...longs].sort((a, b) =>
          (b.evidence.total - a.evidence.total) || (b.rewardRisk - a.rewardRisk)
        )[0];
        const bestShort = [...shorts].sort((a, b) =>
          (b.evidence.total - a.evidence.total) || (b.rewardRisk - a.rewardRisk)
        )[0];
        const gap = Math.abs(bestLong.evidence.total - bestShort.evidence.total);

        if (gap < this.options.conflictMargin) {
          conflicts.push({
            symbol,
            candidates: symbolCandidates.map((candidate) => candidate.candidateId),
            reason: `opposite-direction candidates are within ${this.options.conflictMargin} evidence points`,
          });
          continue;
        }

        selected.push(bestLong.evidence.total > bestShort.evidence.total ? bestLong : bestShort);
        continue;
      }

      const best = [...symbolCandidates].sort((a, b) =>
        (b.evidence.total - a.evidence.total) || (b.rewardRisk - a.rewardRisk)
      )[0];

      if (best) selected.push(best);
    }

    selected.sort((a, b) =>
      (b.evidence.total - a.evidence.total) || (b.rewardRisk - a.rewardRisk)
    );

    return {
      candidates,
      selected: selected.slice(0, this.options.maxSelected),
      conflicts,
      rejected,
    };
  }
}
