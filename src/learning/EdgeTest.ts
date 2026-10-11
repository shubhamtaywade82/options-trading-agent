import type { DecisionRecord } from '../decision/DecisionJournal.js';

export interface EdgeTest {
  n: number;
  wins: number;
  /** Wins a random entry would be expected to produce with the same brackets: sum of 1 / (1 + planned RR). */
  expectedWins: number;
  z: number | null;
  /** One-sided p that the observed hit rate is at least this good by luck alone (normal approximation). */
  pBetter: number | null;
}

/** Real exits and the price-path replay's hypothetical ones both count as a clean bracket outcome. */
const TARGET_REASONS: ReadonlySet<string> = new Set(['TAKE PROFIT', 'HYPOTHETICAL TP']);
const STOP_REASONS: ReadonlySet<string> = new Set(['STOP LOSS', 'HYPOTHETICAL SL']);

const erf = (x: number): number => {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * Does entry timing beat a coin flip? For a driftless price path, a bracket with planned reward:risk `rr` hits its
 * target before its stop with probability 1 / (1 + rr) whatever the entry. Comparing the observed number of target
 * hits with that expectation tests the *entry signal* alone, before costs. Only trades that ended at their own target
 * or stop are counted (trailing/manual closes have no clean bracket outcome).
 *
 * Caveats: real paths have drift (a long-only strategy in an uptrend beats 1/(1+rr) without any skill), the normal
 * approximation is rough at small n, and a hit rate above chance is necessary for, not proof of, positive expectancy
 * after costs.
 */
export function edgeVsCoinFlip(records: readonly DecisionRecord[]): EdgeTest {
  let n = 0;
  let wins = 0;
  let expected = 0;
  let variance = 0;
  for (const r of records) {
    const { entry, stopLoss, takeProfit, outcome } = r;
    if (r.status !== 'EXECUTED' || !outcome || entry === null || stopLoss === null || takeProfit === null) continue;
    if (!TARGET_REASONS.has(outcome.reason) && !STOP_REASONS.has(outcome.reason)) continue;
    const risk = Math.abs(entry - stopLoss);
    if (!(risk > 0)) continue;
    const p = 1 / (1 + Math.abs(takeProfit - entry) / risk);
    n += 1;
    expected += p;
    variance += p * (1 - p);
    if (TARGET_REASONS.has(outcome.reason)) wins += 1;
  }
  if (n === 0 || !(variance > 0)) return { n, wins, expectedWins: expected, z: null, pBetter: null };
  const z = (wins - expected) / Math.sqrt(variance);
  return { n, wins, expectedWins: expected, z, pBetter: 1 - normalCdf(z) };
}
