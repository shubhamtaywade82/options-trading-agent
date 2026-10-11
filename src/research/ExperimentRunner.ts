/**
 * Experiment runner: trains a candidate spec on a train window and tests it on a following test window, then
 * runs a walk-forward over the same data to produce an honest out-of-sample estimate.
 *
 * Key design choice — *re-evaluation, not re-running*:
 *
 * The SetupOutcomeLedger records what every setup would have done, whether or not it was traded. Its features
 * (`sweepDepthAtr`, `sweepDisplacementAtr`, `rr`, `effectiveRr`, `regime`, `volatility`, `htfTrend`, `ltfTrend`)
 * are frozen at setup creation. So a candidate spec whose `minimumRewardRisk` is 1.7 instead of 1.5 doesn't
 * need to re-run the setup engine — its hypothetical trade set is exactly the ledger subset with `rr >= 1.7`.
 *
 * This is exact for entry-threshold mutations (RR floor, sweep depth, sweep displacement, spread) and approximate
 * for sweep-age mutations: a tighter `maxSweepAgeCandles` would have suppressed some setups before they were
 * recorded, so the ledger's older sweeps will over-represent them. We document this in `experimentNotes` so the
 * promotion gate can down-weight sweep-age-only experiments.
 *
 * The runner does NOT touch the live trading core. It is a research-plane computation over historical data.
 */

import type { SetupOutcomeRecord } from '../learning/SetupOutcomeLedger.js';
import type { CostRates } from '../risk/rrProfile.js';
import {
  bootstrapMean,
  utcDay,
  type BootstrapOptions,
  type BootstrapSummary,
} from './Bootstrap.js';
import {
  conditionalMatrix,
  walkForward,
  type Dimension,
  type Observation,
} from './ConditionalEdge.js';
import type { StrategySpec, StructLiqSpecParams } from './StrategySpec.js';

const DAY = 86_400_000;

/** A setup outcome record passing a spec's filters. */
export interface EligibleSetup {
  record: SetupOutcomeRecord;
  /** The net R the spec would have realized on this setup, after round-trip costs. */
  netR: number;
}

/**
 * Applies a STRUCT-LIQ spec's filters to a setup outcome record. A setup passes when every threshold in the spec
 * is satisfied by the record's frozen features; the record's net R is the trade's hypothetical result.
 *
 * The record's `netR` already subtracts round-trip costs (computed by SetupOutcomeLedger using the same CostRates
 * the experiment runner is given), so we return it as-is. Setups that were never touched by the entry are excluded
 * from the trade set — they are observed setups, not observed trades.
 */
export function passesSpecFilters(spec: StrategySpec<StructLiqSpecParams>, r: SetupOutcomeRecord): boolean {
  if (r.rr < spec.params.minimumRewardRisk) return false;
  if (r.features.sweepDepthAtr !== null && r.features.sweepDepthAtr < spec.params.minSweepDepthAtr) return false;
  if (r.features.sweepDisplacementAtr !== null && r.features.sweepDisplacementAtr < spec.params.minSweepDisplacementAtr) return false;
  if (r.effectiveRr !== null && r.effectiveRr < spec.params.minimumRewardRisk) return false;
  // `maxSpreadBps` is a research-plane filter; the ledger does not yet store per-setup spread, so a finite
  // maxSpreadBps produces no exclusions today. Documented in experimentNotes.
  return true;
}

/**
 * The hypothetical trade set of a spec over a time range. Trades are resolved setups (entry touched, outcome
 * known) that pass the spec's filters. The trade's net R is the ledger's `netR` field.
 */
export function hypotheticalTrades(
  spec: StrategySpec<StructLiqSpecParams>,
  ledger: readonly SetupOutcomeRecord[],
  from: number,
  to: number,
): EligibleSetup[] {
  const out: EligibleSetup[] = [];
  for (const r of ledger) {
    if (r.createdAt < from || r.createdAt >= to) continue;
    if (!passesSpecFilters(spec, r)) continue;
    if (r.entryTouchedAt === null) continue;
    if (r.netR === null) continue;
    out.push({ record: r, netR: r.netR });
  }
  return out;
}

export interface WindowStats {
  n: number;
  winRate: number;
  meanNetR: number;
  profitFactor: number;
  maxDrawdownR: number;
  symbols: number;
  regimes: number;
  bootstrap: BootstrapSummary | null;
}

export interface PerSliceStat { key: string; n: number; meanNetR: number }

export interface ExperimentResult {
  /** The spec under test. */
  candidateId: string;
  candidateVersion: number;
  /** The spec it descends from, for delta computation. */
  parentId: string;
  parentVersion: number;
  /** Train window (in-sample) for the candidate. */
  train: WindowStats;
  /** Test window immediately following the train (out-of-sample) for the candidate. */
  test: WindowStats;
  /** Train window for the parent — same data, parent's thresholds. Used by the gate to detect regressions. */
  parentTrain: WindowStats;
  /** Test window for the parent. */
  parentTest: WindowStats;
  /** Walk-forward over the whole evaluation window, using train+test as the rolling selection history. */
  walkForward: { outOfSample: BootstrapSummary | null; baseline: BootstrapSummary | null; folds: number };
  /** Per-symbol stability on the test window — a single-symbol fragility is a promotion blocker. */
  perSymbol: PerSliceStat[];
  /** Per-regime stability on the test window — a regime collapse is a promotion blocker. */
  perRegime: PerSliceStat[];
  /** Honest caveats about what the experiment does and does not measure. */
  experimentNotes: string[];
}

export interface ExperimentConfig {
  trainDays: number;
  testDays: number;
  costs: CostRates;
  /** Bootstrap options for train/test/walk-forward summaries. */
  bootstrap?: BootstrapOptions;
  /** Dimensions for the conditional-edge matrix used by walk-forward. */
  walkForwardDims?: readonly Dimension[];
  /** Walk-forward rolling-window size (days). Defaults to 14 / 7. */
  walkForwardTrainDays?: number;
  walkForwardTestDays?: number;
  /** Minimum observations for a walk-forward cell to enter selection. Default 10. */
  walkForwardMinN?: number;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function windowStats(trades: readonly EligibleSetup[], options: BootstrapOptions = {}): WindowStats {
  const samples = trades.map((t) => ({ value: t.netR, cluster: utcDay(t.record.createdAt) }));
  const bootstrap = samples.length > 0 ? bootstrapMean(samples, options) : null;
  const wins = trades.filter((t) => t.netR > 0);
  const losses = trades.filter((t) => t.netR < 0);
  const grossProfit = sum(wins.map((t) => t.netR));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netR)));

  let peak = 0;
  let dd = 0;
  let cum = 0;
  for (const t of trades) {
    cum += t.netR;
    if (cum > peak) peak = cum;
    const drop = peak - cum;
    if (drop > dd) dd = drop;
  }

  const symbols = new Set(trades.map((t) => t.record.symbol));
  const regimes = new Set(trades.map((t) => t.record.features.regime));

  return {
    n: trades.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    meanNetR: trades.length > 0 ? sum(trades.map((t) => t.netR)) / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
    maxDrawdownR: dd,
    symbols: symbols.size,
    regimes: regimes.size,
    bootstrap,
  };
}

function perSlice(trades: readonly EligibleSetup[], keyOf: (r: SetupOutcomeRecord) => string): PerSliceStat[] {
  const m = new Map<string, number[]>();
  for (const t of trades) {
    const key = keyOf(t.record);
    const list = m.get(key) ?? [];
    list.push(t.netR);
    m.set(key, list);
  }
  return [...m].map(([key, rs]) => ({ key, n: rs.length, meanNetR: sum(rs) / rs.length }))
    .sort((a, b) => b.meanNetR - a.meanNetR);
}

const perSymbol = (trades: readonly EligibleSetup[]): PerSliceStat[] =>
  perSlice(trades, (r) => r.symbol);

const perRegime = (trades: readonly EligibleSetup[]): PerSliceStat[] =>
  perSlice(trades, (r) => `${r.features.regime} | ${r.features.volatility}`);

/**
 * Observations for the walk-forward evaluator. Each eligible setup is keyed by the dims supplied in the config
 * (default: strategy | regime | phase | side), so the walk-forward selector picks regime-conditional edges.
 */
function observationsOf(
  spec: StrategySpec<StructLiqSpecParams>,
  ledger: readonly SetupOutcomeRecord[],
  from: number,
  to: number,
  dims: readonly Dimension[],
): Observation[] {
  const trades = hypotheticalTrades(spec, ledger, from, to);
  return trades.map((t) => ({
    t: t.record.createdAt,
    closedAt: t.record.closedAt ?? t.record.createdAt + DAY,
    key: dims.map((d) => {
      switch (d) {
        case 'strategy': return spec.id;
        case 'regime': return t.record.features.regime;
        case 'phase': return t.record.features.volatility;
        case 'side': return t.record.direction;
        case 'symbol': return t.record.symbol;
      }
    }).join(' | '),
    netR: t.netR,
  })).sort((a, b) => a.t - b.t);
}

/**
 * Run a single experiment. Returns the candidate's metrics and the parent's metrics side-by-side, plus the
 * walk-forward OOS summary, so the promotion gate has everything it needs without recomputing.
 *
 * The runner does not decide whether to promote — it produces the evidence. PromotionGate consumes the result.
 */
export function runExperiment(
  candidate: StrategySpec<StructLiqSpecParams>,
  parent: StrategySpec<StructLiqSpecParams>,
  ledger: readonly SetupOutcomeRecord[],
  config: ExperimentConfig,
): ExperimentResult {
  if (candidate.id !== parent.id) throw new Error(`candidate ${candidate.id} and parent ${parent.id} are different strategies`);

  if (ledger.length === 0) {
    return emptyResult(candidate, parent, ['no setup outcomes available — research plane needs more data']);
  }

  const first = Math.min(...ledger.map((r) => r.createdAt));
  const last = Math.max(...ledger.map((r) => r.createdAt));
  const trainFrom = first;
  const trainTo = trainFrom + config.trainDays * DAY;
  const testTo = trainTo + config.testDays * DAY;

  if (trainTo > last || testTo > last + DAY) {
    return emptyResult(candidate, parent, [
      `ledger spans ${((last - first) / DAY).toFixed(1)} days; experiment needs ${config.trainDays}+${config.testDays} days`,
    ]);
  }

  const notes: string[] = [];

  const sweepAgeChanged = candidate.params.maxSweepAgeCandles !== parent.params.maxSweepAgeCandles;
  if (sweepAgeChanged) {
    notes.push(
      `approximation: maxSweepAgeCandles changed (${parent.params.maxSweepAgeCandles} → ${candidate.params.maxSweepAgeCandles}); ` +
      `the ledger cannot reconstruct setups that would have been suppressed, so older sweeps are over-represented.`,
    );
  }

  if (Number.isFinite(candidate.params.maxSpreadBps)) {
    notes.push(
      `maxSpreadBps=${candidate.params.maxSpreadBps} configured but the ledger does not yet store per-setup spread; ` +
      `this filter is a no-op until the ledger records it.`,
    );
  }

  const dims = config.walkForwardDims ?? ['strategy', 'regime', 'phase', 'side'];

  const trainCandidate = hypotheticalTrades(candidate, ledger, trainFrom, trainTo);
  const testCandidate = hypotheticalTrades(candidate, ledger, trainTo, testTo);
  const trainParent = hypotheticalTrades(parent, ledger, trainFrom, trainTo);
  const testParent = hypotheticalTrades(parent, ledger, trainTo, testTo);

  const obs = observationsOf(candidate, ledger, trainFrom, testTo, dims);
  const wf = walkForward(obs, {
    trainDays: config.walkForwardTrainDays ?? 14,
    testDays: config.walkForwardTestDays ?? 7,
    minN: config.walkForwardMinN ?? 10,
    iterations: config.bootstrap?.iterations ?? 1000,
    seed: config.bootstrap?.seed,
  });

  return {
    candidateId: candidate.id,
    candidateVersion: candidate.version,
    parentId: parent.id,
    parentVersion: parent.version,
    train: windowStats(trainCandidate, config.bootstrap),
    test: windowStats(testCandidate, config.bootstrap),
    parentTrain: windowStats(trainParent, config.bootstrap),
    parentTest: windowStats(testParent, config.bootstrap),
    walkForward: { outOfSample: wf.outOfSample, baseline: wf.baseline, folds: wf.folds.length },
    perSymbol: perSymbol(testCandidate),
    perRegime: perRegime(testCandidate),
    experimentNotes: notes,
  };
}

function emptyResult(
  candidate: StrategySpec<StructLiqSpecParams>,
  parent: StrategySpec<StructLiqSpecParams>,
  notes: string[],
): ExperimentResult {
  const empty: WindowStats = {
    n: 0, winRate: 0, meanNetR: 0, profitFactor: 0, maxDrawdownR: 0, symbols: 0, regimes: 0, bootstrap: null,
  };
  return {
    candidateId: candidate.id,
    candidateVersion: candidate.version,
    parentId: parent.id,
    parentVersion: parent.version,
    train: empty,
    test: empty,
    parentTrain: empty,
    parentTest: empty,
    walkForward: { outOfSample: null, baseline: null, folds: 0 },
    perSymbol: [],
    perRegime: [],
    experimentNotes: notes,
  };
}

/**
 * Conditional matrix over a candidate's hypothetical trades — used by the ResearchAgent to diagnose *where*
 * a spec is strong or weak, not just whether it is profitable overall. Re-uses ConditionalEdge.conditionalMatrix
 * with no behavioral change.
 */
export function candidateMatrix(
  spec: StrategySpec<StructLiqSpecParams>,
  ledger: readonly SetupOutcomeRecord[],
  from: number,
  to: number,
  dims: readonly Dimension[] = ['regime', 'phase', 'side'],
  options: { minN?: number; alpha?: number; iterations?: number; seed?: number } = {},
) {
  const obs = observationsOf(spec, ledger, from, to, dims);
  return conditionalMatrix(obs, options);
}
