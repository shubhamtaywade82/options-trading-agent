import type { RegimeSnapshot, TimeframeState } from './types.js';

/**
 * Volatility level as its own dimension, independent of the directional regime: TREND_UP can be COMPRESSED (coiled) or
 * EXTREME (late, do not chase). The single `MarketRegime` enum forces a choice between "trend" and "high vol"; this keeps both.
 *
 * Classified from the 15m ATR(14) percentile rank over the analysed window. This is a LEVEL, not a rate of change: it says
 * where volatility sits relative to its own recent history, not whether it is rising. The cut points are descriptive bins,
 * not fitted edges; whether any bin conditions a strategy's expectancy is what `scripts/conditional-edge.ts` tests.
 */
export type VolatilityPhase = 'COMPRESSED' | 'NORMAL' | 'EXPANDING' | 'EXTREME' | 'UNKNOWN';

export const VOLATILITY_PHASE_BINS = { compressedMax: 20, expandingMin: 75, extremeMin: 95 } as const;

export function classifyVolatilityPhase(atrPercentile: number | null | undefined, bins = VOLATILITY_PHASE_BINS): VolatilityPhase {
  if (atrPercentile === null || atrPercentile === undefined || !Number.isFinite(atrPercentile)) return 'UNKNOWN';
  if (atrPercentile >= bins.extremeMin) return 'EXTREME';
  if (atrPercentile >= bins.expandingMin) return 'EXPANDING';
  if (atrPercentile <= bins.compressedMax) return 'COMPRESSED';
  return 'NORMAL';
}

/** Market context journalled with every decision so outcomes can be conditioned on it after the fact. */
export interface DecisionContext {
  regime: RegimeSnapshot['regime'];
  volatilityPhase: VolatilityPhase;
  atrPercentile: number | null;
  adx14: number | null;
}

export function decisionContextOf(regime: RegimeSnapshot, entry: TimeframeState): DecisionContext {
  return {
    regime: regime.regime,
    volatilityPhase: classifyVolatilityPhase(entry.atrPercentile),
    atrPercentile: entry.atrPercentile,
    adx14: entry.adx14,
  };
}
