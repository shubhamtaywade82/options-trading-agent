import type { DecisionRecord } from '../decision/DecisionJournal.js';
import { netROf, type CostRates } from '../risk/rrProfile.js';
import { bootstrapMean, holm, utcDay, type BootstrapOptions, type BootstrapSummary } from './Bootstrap.js';

/**
 * Regime-conditional expectancy, and the out-of-sample test that keeps it honest.
 *
 * A pooled MOMENTUM mean of -0.16R can hide a positive TREND_UP slice. Slicing finds such pockets, but slicing 7 strategies
 * x 6 regimes x 5 volatility phases x 2 sides is 420 cells: some will look profitable by chance. Two guards:
 *   1. `conditionalMatrix` reports every cell with a cluster-bootstrap interval and Holm family-wise correction across the
 *      cells it tested, so "significant" means significant after the search, not before it.
 *   2. `walkForward` makes the slice selection itself the thing under test: cells are chosen on a rolling train window only,
 *      and the trades they would then have taken on the NEXT window are pooled. A conditional edge exists only if that pooled
 *      out-of-sample mean is positive; an in-sample matrix alone never approves anything.
 */

export type Dimension = 'strategy' | 'regime' | 'phase' | 'side' | 'symbol';

export interface Observation {
  /** Decision time. */
  t: number;
  /** When the outcome became known; training only uses outcomes known before the train window ends. */
  closedAt: number;
  key: string;
  netR: number;
}

export function keyOf(record: DecisionRecord, dims: readonly Dimension[]): string {
  return dims.map((d) => {
    switch (d) {
      case 'strategy': return record.strategy;
      case 'regime': return record.context?.regime ?? 'UNKNOWN';
      case 'phase': return record.context?.volatilityPhase ?? 'UNKNOWN';
      case 'side': return record.side ?? 'NONE';
      case 'symbol': return record.symbol;
    }
  }).join(' | ');
}

/** Executed (or hypothetically replayed) decisions with a clean outcome, as net-of-cost observations keyed by `dims`. */
export function observationsOf(records: readonly DecisionRecord[], dims: readonly Dimension[], costs: CostRates): Observation[] {
  const out: Observation[] = [];
  for (const record of records) {
    const netR = netROf(record, costs);
    if (netR === undefined || !record.outcome) continue;
    out.push({ t: record.timestamp, closedAt: record.outcome.closedAt, key: keyOf(record, dims), netR });
  }
  return out.sort((a, b) => a.t - b.t);
}

const summarize = (obs: readonly Observation[], options: BootstrapOptions): BootstrapSummary | null =>
  bootstrapMean(obs.map((o) => ({ value: o.netR, cluster: utcDay(o.t) })), options);

export interface CellStat {
  key: string;
  /** Null when the cell is below `minN` and was not tested. */
  stats: BootstrapSummary | null;
  n: number;
  /** Survives Holm correction across every tested cell at `alpha` (one-sided, H0: E[R] <= 0). */
  significant: boolean;
}

export interface MatrixOptions extends BootstrapOptions {
  minN?: number;
  alpha?: number;
}

export interface MatrixReport {
  cells: CellStat[];
  /** Number of cells that met `minN` and entered the multiple-comparison family. */
  tested: number;
  alpha: number;
}

export function conditionalMatrix(obs: readonly Observation[], options: MatrixOptions = {}): MatrixReport {
  const minN = options.minN ?? 30;
  const alpha = options.alpha ?? 0.05;
  const groups = new Map<string, Observation[]>();
  for (const o of obs) {
    const list = groups.get(o.key);
    if (list) list.push(o); else groups.set(o.key, [o]);
  }

  const cells: CellStat[] = [...groups].map(([key, list]) => ({
    key, n: list.length, significant: false, stats: list.length >= minN ? summarize(list, options) : null,
  }));
  const tested = cells.filter((c) => c.stats !== null);
  const rejected = holm(tested.map((c) => c.stats!.pValue), alpha);
  tested.forEach((c, i) => { c.significant = rejected[i]; });
  cells.sort((a, b) => (b.stats?.mean ?? -Infinity) - (a.stats?.mean ?? -Infinity) || b.n - a.n || a.key.localeCompare(b.key));
  return { cells, tested: tested.length, alpha };
}

export interface WalkForwardOptions extends BootstrapOptions {
  trainDays: number;
  testDays: number;
  /** Defaults to testDays, so test windows tile without overlap. */
  stepDays?: number;
  /** Minimum train observations for a cell to be eligible. */
  minN?: number;
}

export interface Fold {
  trainFrom: number;
  trainTo: number;
  testTo: number;
  /** Cells whose train-window bootstrap lower bound was above zero. */
  selected: string[];
  testN: number;
  testMeanR: number | null;
  /** Every observation in the test window, selected or not: what trading the unconditioned fleet would have done. */
  baselineN: number;
  baselineMeanR: number | null;
}

export interface WalkForwardReport {
  folds: Fold[];
  /** Pooled test-window outcomes of the train-selected cells. This is the number that matters. */
  outOfSample: BootstrapSummary | null;
  baseline: BootstrapSummary | null;
}

const DAY = 86_400_000;
const meanOf = (xs: readonly Observation[]): number | null => (xs.length > 0 ? xs.reduce((s, o) => s + o.netR, 0) / xs.length : null);

/**
 * Rolling walk-forward selection. For each fold: pick cells with n >= minN and a bootstrap lower bound > 0 using only
 * decisions made in [trainFrom, trainTo) whose outcome closed before trainTo (no outcome from the future leaks in), then
 * collect every test-window decision in [trainTo, testTo) that falls in a selected cell. Test windows never overlap when
 * stepDays >= testDays, so no test trade is counted twice.
 */
export function walkForward(obs: readonly Observation[], options: WalkForwardOptions): WalkForwardReport {
  const { trainDays, testDays } = options;
  const stepDays = options.stepDays ?? testDays;
  const minN = options.minN ?? 30;
  if (!(trainDays > 0 && testDays > 0 && stepDays > 0)) throw new Error('trainDays, testDays and stepDays must be positive');
  const folds: Fold[] = [];
  const oos: Observation[] = [];
  const baseline: Observation[] = [];
  if (obs.length === 0) return { folds, outOfSample: null, baseline: null };

  const first = obs[0].t;
  const last = obs[obs.length - 1].t;
  for (let trainFrom = first; trainFrom + trainDays * DAY <= last; trainFrom += stepDays * DAY) {
    const trainTo = trainFrom + trainDays * DAY;
    const testTo = trainTo + testDays * DAY;
    const train = obs.filter((o) => o.t >= trainFrom && o.closedAt < trainTo);
    const report = conditionalMatrix(train, { ...options, minN });
    const selected = report.cells.filter((c) => c.stats !== null && c.stats.ciLow > 0).map((c) => c.key);
    const chosen = new Set(selected);
    const test = obs.filter((o) => o.t >= trainTo && o.t < testTo);
    const picked = test.filter((o) => chosen.has(o.key));
    oos.push(...picked);
    baseline.push(...test);
    folds.push({ trainFrom, trainTo, testTo, selected, testN: picked.length, testMeanR: meanOf(picked), baselineN: test.length, baselineMeanR: meanOf(test) });
  }
  return { folds, outOfSample: summarize(oos, options), baseline: summarize(baseline, options) };
}
