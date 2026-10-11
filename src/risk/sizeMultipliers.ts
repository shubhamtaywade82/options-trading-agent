/**
 * Risk-budget multipliers applied on top of the circuit multiplier. Both only ever shrink size
 * (never above 1): the stop distance still sets the money at risk, a hot market or a marginal setup
 * just gets a smaller budget.
 */

export interface SizeScaling {
  volatility: boolean;
  score: boolean;
}

/** Fewer than the proposal's 5 buckets of precision are needed: the percentile is itself a coarse rank. */
export function volatilityMultiplier(atrPercentile: number | undefined): number {
  if (atrPercentile === undefined || !Number.isFinite(atrPercentile)) return 1;
  if (atrPercentile >= 95) return 0.25;
  if (atrPercentile >= 80) return 0.5;
  if (atrPercentile >= 60) return 0.75;
  return 1;
}

/** Evidence score (0-100) -> budget multiplier; capped at 1 so confidence can never lever the risk up. */
export function scoreMultiplier(score: number | undefined): number {
  if (score === undefined || !Number.isFinite(score)) return 1;
  if (score < 65) return 0.5;
  if (score < 75) return 0.75;
  return 1;
}

export function combinedSizeMultiplier(
  scaling: SizeScaling,
  inputs: { atrPercentile?: number; evidenceScore?: number },
): number {
  const vol = scaling.volatility ? volatilityMultiplier(inputs.atrPercentile) : 1;
  const score = scaling.score ? scoreMultiplier(inputs.evidenceScore) : 1;
  return vol * score;
}
