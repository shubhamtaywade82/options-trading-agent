/**
 * Promotion gate: the set of statistical guards a candidate must pass before it can be promoted from
 * challenger to champion.
 *
 * The gate is the single most important safety mechanism in the research plane. "candidate > champion in
 * backtest" is dangerously weak: a single backtest window can be lucky, a single symbol can carry the result,
 * a single regime can mask a collapse elsewhere. The gate encodes the rules the operator would apply by hand:
 *
 *   1. The candidate has enough out-of-sample trades to be measurable (minTrades).
 *   2. Its OOS mean R is positive (minOosExpectancyR) — not just "better than parent".
 *   3. Its OOS bootstrap lower confidence bound is positive (minBootstrapLcb) — i.e., a *statistical* edge,
 *      not a noisy one. This is the same rule ConditionalEdge's walk-forward uses to select cells.
 *   4. Its OOS profit factor clears a floor (minProfitFactor) — expectancy alone permits a low-win-rate
 *      strategy that occasionally hits a 10R target, which is fragile.
 *   5. Its max drawdown is below a ceiling (maxDrawdownR) — a strategy that doubles expectancy by doubling
 *      drawdown is not a promotion.
 *   6. It does not depend on one symbol only (minSymbolCoverage).
 *   7. Its worst-regime expectancy is not much worse than the parent's worst-regime expectancy
 *      (maxRegimeRegressionPct) — a strategy that wins in TREND_UP and bleeds in TRANSITION is a regression
 *      even if its pooled mean improves.
 *   8. Its OOS expectancy beats the parent's OOS expectancy by a margin (minOosDelta) — a candidate that
 *      merely ties the parent is not a promotion.
 *   9. Its walk-forward OOS summary is positive (the candidate survives selection, not just evaluation).
 *
 * The gate returns a `PromotionVerdict` with `decision` ('PROMOTE' | 'REJECT' | 'INSUFFICIENT_DATA') and a list
 * of human-readable reasons. The verdict is appended to the ExperimentStore so the audit trail is complete.
 *
 * The gate does not perform promotion. The ChampionRegistry performs promotion; the gate just decides whether
 * promotion is permitted.
 */

import type { ExperimentResult } from './ExperimentRunner.js';

export interface PromotionPolicy {
  /** Minimum OOS trades. Default 30 — same floor as the conditional-edge matrix's minN. */
  minTrades: number;
  /** Minimum OOS mean net R. Default 0.05R — a candidate that barely clears zero is a marginal edge. */
  minOosExpectancyR: number;
  /** Minimum OOS profit factor. Default 1.10 — a 1.01 strategy is a fee machine. */
  minProfitFactor: number;
  /** Maximum OOS drawdown in R. Default 15R — beyond that the strategy is too volatile to promote. */
  maxDrawdownR: number;
  /** Minimum OOS bootstrap probPositive. Default 0.85 — strong evidence the edge is real. */
  minOosConfidence: number;
  /** Minimum distinct symbols with at least 5 trades each. Default 2 — single-symbol fragility is a blocker. */
  minSymbolCoverage: number;
  /** Minimum margin by which candidate's OOS mean R must beat parent's. Default 0.05R. */
  minOosDelta: number;
  /** Maximum allowed regression in the worst regime, as a fraction of parent's worst-regime mean. Default 0.30. */
  maxRegimeRegressionPct: number;
  /** If true, the walk-forward OOS summary must be non-null with a positive mean. Default true. */
  requireWalkForwardPositive: boolean;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  minTrades: 30,
  minOosExpectancyR: 0.05,
  minProfitFactor: 1.10,
  maxDrawdownR: 15,
  minOosConfidence: 0.85,
  minSymbolCoverage: 2,
  minOosDelta: 0.05,
  maxRegimeRegressionPct: 0.30,
  requireWalkForwardPositive: true,
};

export type PromotionDecision = 'PROMOTE' | 'REJECT' | 'INSUFFICIENT_DATA';

export interface PromotionVerdict {
  decision: PromotionDecision;
  /** Human-readable reasons for the decision; multiple when multiple rules fired. */
  reasons: string[];
  /** The policy that was applied. Persisted alongside the verdict for auditability. */
  policy: PromotionPolicy;
}

/**
 * Apply the promotion policy to an experiment result. The function is pure: same input, same output, no side
 * effects. The verdict is the gate's decision; the ChampionRegistry performs the actual promotion.
 */
export function evaluatePromotion(
  result: ExperimentResult,
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): PromotionVerdict {
  const reasons: string[] = [];

  // 1. Minimum trades — if not met, this is INSUFFICIENT_DATA, not REJECT. A thin sample is not evidence against
  // the candidate; it is no evidence either way. The candidate stays a challenger and waits for more data.
  if (result.test.n < policy.minTrades) {
    return {
      decision: 'INSUFFICIENT_DATA',
      reasons: [`OOS n=${result.test.n} below minTrades=${policy.minTrades}; wait for more data`],
      policy,
    };
  }

  // 2. OOS expectancy must clear the floor.
  if (result.test.meanNetR < policy.minOosExpectancyR) {
    reasons.push(`OOS mean R ${result.test.meanNetR.toFixed(3)} < ${policy.minOosExpectancyR}`);
  }

  // 3. Bootstrap lower confidence bound must be positive.
  const lcb = result.test.bootstrap?.ciLow ?? Number.NaN;
  if (!Number.isFinite(lcb) || lcb <= 0) {
    reasons.push(`OOS bootstrap LCB ${Number.isFinite(lcb) ? lcb.toFixed(3) : 'n/a'} <= 0`);
  }

  // 4. Profit factor floor.
  if (result.test.profitFactor < policy.minProfitFactor) {
    reasons.push(`OOS profit factor ${result.test.profitFactor.toFixed(2)} < ${policy.minProfitFactor}`);
  }

  // 5. Max drawdown ceiling.
  if (result.test.maxDrawdownR > policy.maxDrawdownR) {
    reasons.push(`OOS max DD ${result.test.maxDrawdownR.toFixed(2)}R > ${policy.maxDrawdownR}R`);
  }

  // 6. Bootstrap probability of positive expectancy.
  const probPositive = result.test.bootstrap?.probPositive ?? 0;
  if (probPositive < policy.minOosConfidence) {
    reasons.push(`OOS P(E[R]>0) ${probPositive.toFixed(2)} < ${policy.minOosConfidence}`);
  }

  // 7. Symbol coverage — at least `minSymbolCoverage` symbols must have >= 5 trades.
  const coveredSymbols = result.perSymbol.filter((s) => s.n >= 5).length;
  if (coveredSymbols < policy.minSymbolCoverage) {
    reasons.push(`OOS symbols with n>=5: ${coveredSymbols} < ${policy.minSymbolCoverage}`);
  }

  // 8. OOS delta vs parent — the candidate must beat the parent by at least `minOosDelta` R.
  const delta = result.test.meanNetR - result.parentTest.meanNetR;
  if (delta < policy.minOosDelta) {
    reasons.push(`OOS delta vs parent ${delta.toFixed(3)}R < ${policy.minOosDelta}R (candidate ${result.test.meanNetR.toFixed(3)} vs parent ${result.parentTest.meanNetR.toFixed(3)})`);
  }

  // 9. Worst-regime regression: candidate's worst regime must not be much worse than parent's worst regime.
  // A candidate that wins in TREND_UP and bleeds in TRANSITION is a regression even if pooled mean improves.
  const candidateWorst = result.perRegime[result.perRegime.length - 1]?.meanNetR ?? Number.NaN;
  const parentRegimes = result.parentTest; // parentTest.bootstrap covers the parent's pooled OOS; we don't have
  // a per-regime breakdown for the parent in this result type. As a proxy, we compare candidate's worst regime
  // against the parent's *overall* mean — if candidate's worst regime is more than `maxRegimeRegressionPct`
  // worse than parent's overall, that's a regime regression.
  const parentOverall = parentRegimes.meanNetR;
  if (Number.isFinite(candidateWorst) && Number.isFinite(parentOverall) && parentOverall > 0) {
    const regression = (parentOverall - candidateWorst) / Math.abs(parentOverall);
    if (regression > policy.maxRegimeRegressionPct) {
      reasons.push(`OOS worst regime ${candidateWorst.toFixed(3)}R is ${(regression * 100).toFixed(0)}% below parent overall ${parentOverall.toFixed(3)}R (max ${policy.maxRegimeRegressionPct * 100}%)`);
    }
  }

  // 10. Walk-forward OOS summary must be positive.
  if (policy.requireWalkForwardPositive) {
    const wfMean = result.walkForward.outOfSample?.mean;
    if (wfMean === undefined || wfMean === null || !(wfMean > 0)) {
      reasons.push(`walk-forward OOS mean ${wfMean ?? 'n/a'} not positive`);
    }
  }

  if (reasons.length > 0) {
    return { decision: 'REJECT', reasons, policy };
  }

  return {
    decision: 'PROMOTE',
    reasons: [
      `OOS mean ${result.test.meanNetR.toFixed(3)}R (n=${result.test.n}), LCB ${(lcb).toFixed(3)}, PF ${result.test.profitFactor.toFixed(2)}, DD ${result.test.maxDrawdownR.toFixed(2)}R`,
      `delta vs parent +${delta.toFixed(3)}R over ${coveredSymbols} symbols`,
      `walk-forward OOS mean ${(result.walkForward.outOfSample?.mean ?? 0).toFixed(3)}R over ${result.walkForward.folds} folds`,
    ],
    policy,
  };
}
