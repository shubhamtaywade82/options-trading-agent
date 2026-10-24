import { MIN_TRADES_TO_JUDGE } from '../ops/performanceReport.js';
import type { ResearchDataset } from './dataset.js';
import { replayDataset, type CostModel, type ReplayConfig, type ReplayTrade } from './replay.js';
import {
  bootstrapMeanR,
  chronologicalSplit,
  groupByDay,
  simulatePaths,
  summarize,
  type BootstrapResult,
  type PathSimulation,
  type SampleSummary,
  type TradeSample,
} from './stats.js';

export interface TimeMachineOptions {
  readonly seed: number;
  /** Bootstrap resamples and Monte Carlo paths. */
  readonly iterations: number;
  readonly horizonDays: number;
  /** Share of days, oldest first, that form the in-sample half of the walk-forward check. */
  readonly splitFraction: number;
  readonly drawdownAlarmInr: number;
  /** Above this share of trades lost to missing premium bars, the sample is not trusted. */
  readonly maxDataGapRate: number;
  readonly minTrades: number;
  readonly minOutOfSampleTrades: number;
}

export const DEFAULT_TIME_MACHINE_OPTIONS: Omit<TimeMachineOptions, 'drawdownAlarmInr'> = {
  seed: 19,
  iterations: 10_000,
  horizonDays: 20,
  splitFraction: 0.6,
  maxDataGapRate: 0.05,
  minTrades: MIN_TRADES_TO_JUDGE,
  minOutOfSampleTrades: 10,
};

/**
 * INSUFFICIENT_EVIDENCE: too few trades or too much missing data to say anything.
 * NO_TRADE: enough data, and it does not support a positive expectancy after costs.
 * EDGE_SUPPORTED: the bootstrap interval of mean net R excludes zero and the out-of-sample days are positive.
 * None of these authorises live trading; the live risk gate is unchanged by any result.
 */
export type TimeMachineVerdict = 'INSUFFICIENT_EVIDENCE' | 'NO_TRADE' | 'EDGE_SUPPORTED';

export interface TimeMachineReport {
  readonly underlying: string;
  readonly fromDate: string | undefined;
  readonly toDate: string | undefined;
  readonly sessions: number;
  readonly costModel: CostModel;
  readonly divergences: readonly string[];
  readonly signals: number;
  readonly drops: Readonly<Record<string, number>>;
  readonly dataGapTrades: number;
  readonly ambiguousBarTrades: number;
  readonly gapThroughStopTrades: number;
  readonly overall: SampleSummary;
  readonly inSample: SampleSummary;
  readonly outOfSample: SampleSummary;
  readonly bootstrap: BootstrapResult | undefined;
  readonly paths: PathSimulation | undefined;
  readonly verdict: TimeMachineVerdict;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly trades: readonly ReplayTrade[];
}

function toSample(trade: ReplayTrade): TradeSample {
  return { date: trade.date, netPnlInr: trade.netPnlInr, r: trade.r, exitReason: trade.exitReason };
}

export function runTimeMachine(
  dataset: ResearchDataset,
  config: ReplayConfig,
  costs: CostModel,
  divergences: readonly string[],
  options: TimeMachineOptions,
): TimeMachineReport {
  const replay = replayDataset(dataset, config, costs, divergences);
  const priced = replay.trades.filter((trade) => trade.exitReason !== 'DATA_GAP');
  const dataGapTrades = replay.trades.length - priced.length;
  const samples = priced.map(toSample);
  const days = groupByDay(replay.dates, samples);
  const split = chronologicalSplit(days, options.splitFraction);
  const flatten = (part: typeof days): TradeSample[] => part.flatMap((day) => day.trades);
  const overall = summarize(samples, days.length);
  const inSample = summarize(flatten(split.inSample), split.inSample.length);
  const outOfSample = summarize(flatten(split.outOfSample), split.outOfSample.length);
  const bootstrap = days.length > 0 && samples.length > 0 ? bootstrapMeanR(days, { iterations: options.iterations, seed: options.seed }) : undefined;
  const paths =
    days.length > 0 && samples.length > 0
      ? simulatePaths(days, { paths: options.iterations, seed: options.seed, horizonDays: options.horizonDays, drawdownAlarmInr: options.drawdownAlarmInr })
      : undefined;

  const reasons: string[] = [];
  const warnings: string[] = [];
  const dataGapRate = replay.trades.length === 0 ? 0 : dataGapTrades / replay.trades.length;
  const ambiguousBarTrades = priced.filter((trade) => trade.ambiguousBar).length;
  if (dataGapRate > options.maxDataGapRate) {
    reasons.push(`${(dataGapRate * 100).toFixed(1)}% of trades hit a missing premium bar (limit ${(options.maxDataGapRate * 100).toFixed(1)}%); fetch more ATM offsets`);
  }
  if (overall.trades < options.minTrades) {
    reasons.push(`${overall.trades} priced trades, below the ${options.minTrades} needed to judge`);
  }
  if (outOfSample.trades < options.minOutOfSampleTrades) {
    reasons.push(`${outOfSample.trades} out-of-sample trades, below the ${options.minOutOfSampleTrades} needed`);
  }
  if (priced.length > 0 && ambiguousBarTrades / priced.length > 0.2) {
    warnings.push(`${ambiguousBarTrades} of ${priced.length} trades had a bar touching both stop and target, all counted as stops: 5-minute bars are too coarse for this bracket`);
  }
  if (dataset.sessions.some((session) => session.expiry === undefined)) {
    warnings.push('sessions without an expiry date skip the expiry-day entry cutoff');
  }

  let verdict: TimeMachineVerdict;
  if (reasons.length > 0) {
    verdict = 'INSUFFICIENT_EVIDENCE';
  } else {
    if (bootstrap === undefined || bootstrap.meanRCi95.low <= 0) {
      reasons.push(`95% interval of mean net R is ${bootstrap?.meanRCi95.low ?? 'n/a'} to ${bootstrap?.meanRCi95.high ?? 'n/a'}: its lower bound is not above zero`);
    }
    if (outOfSample.meanR <= 0) {
      reasons.push(`out-of-sample mean net R is ${outOfSample.meanR}: the later days do not hold up`);
    }
    verdict = reasons.length > 0 ? 'NO_TRADE' : 'EDGE_SUPPORTED';
    if (verdict === 'EDGE_SUPPORTED') {
      reasons.push(`95% interval of mean net R ${bootstrap?.meanRCi95.low} to ${bootstrap?.meanRCi95.high}, out-of-sample mean net R ${outOfSample.meanR}`);
    }
  }

  return {
    underlying: dataset.underlying,
    fromDate: replay.dates[0],
    toDate: replay.dates[replay.dates.length - 1],
    sessions: replay.dates.length,
    costModel: costs,
    divergences: replay.divergences,
    signals: replay.signals,
    drops: replay.drops,
    dataGapTrades,
    ambiguousBarTrades,
    gapThroughStopTrades: priced.filter((trade) => trade.gapThroughStop).length,
    overall,
    inSample,
    outOfSample,
    bootstrap,
    paths,
    verdict,
    reasons,
    warnings,
    trades: replay.trades,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function summaryLines(label: string, summary: SampleSummary): string[] {
  return [
    `${label}: ${summary.trades} trades over ${summary.days} days`,
    `  target first ${pct(summary.targetFirst.rate)} (95% CI ${pct(summary.targetFirst.ci95.low)}–${pct(summary.targetFirst.ci95.high)})`,
    `  stop first   ${pct(summary.stopFirst.rate)} (95% CI ${pct(summary.stopFirst.ci95.low)}–${pct(summary.stopFirst.ci95.high)})`,
    `  unresolved   ${pct(summary.unresolved.rate)} (time, EOD, structure or daily-loss exit)`,
    `  win rate ${pct(summary.winRate)} (95% CI ${pct(summary.winRateCi95.low)}–${pct(summary.winRateCi95.high)}), break-even ${summary.breakevenWinRate === undefined ? 'n/a' : pct(summary.breakevenWinRate)}`,
    `  mean net R ${summary.meanR}, mean net ₹${summary.meanNetInr}, total net ₹${summary.totalNetInr}, profit factor ${summary.profitFactor ?? 'n/a'}, max drawdown ₹${summary.maxDrawdownInr}`,
  ];
}

export function formatReport(report: TimeMachineReport): string {
  const lines: string[] = [
    `Time Machine: ${report.underlying}, ${report.sessions} sessions ${report.fromDate ?? '-'} to ${report.toDate ?? '-'}`,
    `Cost model: half-spread ${report.costModel.halfSpreadPct}%, stop slippage ${report.costModel.stopSlippagePct}%, charges per roundTripChargesInr`,
    `Signals ${report.signals}, drops ${Object.entries(report.drops).map(([code, n]) => `${code} ${n}`).join(', ') || 'none'}`,
    `Data-gap trades excluded ${report.dataGapTrades}; ambiguous bars ${report.ambiguousBarTrades}; gap-through stops ${report.gapThroughStopTrades}`,
    '',
    'Historical replay (one path: what these rules did on these days)',
    ...summaryLines('All days', report.overall),
    ...summaryLines('In-sample (older days)', report.inSample),
    ...summaryLines('Out-of-sample (newer days)', report.outOfSample),
    '',
  ];
  if (report.bootstrap !== undefined) {
    const b = report.bootstrap;
    lines.push(
      `Block bootstrap (${b.iterations} resamples of days, block ${b.blockLength}, seed ${b.seed}): how sure is the mean?`,
      `  mean net R 95% interval ${b.meanRCi95.low} to ${b.meanRCi95.high}; P(mean ≤ 0) ${pct(b.probMeanRNonPositive)}`,
    );
  }
  if (report.paths !== undefined) {
    const p = report.paths;
    lines.push(
      `Monte Carlo paths (${p.paths} × ${p.horizonDays} days, block ${p.blockLength}, seed ${p.seed}): how wide is the next stretch?`,
      `  net ₹ p5 ${p.netInr.p5} / p50 ${p.netInr.p50} / p95 ${p.netInr.p95}; P(loss) ${pct(p.probLoss)}`,
      `  max drawdown ₹ p50 ${p.maxDrawdownInr.p50} / p95 ${p.maxDrawdownInr.p95}; P(drawdown ≥ ₹${p.probDrawdownAtLeast.thresholdInr}) ${pct(p.probDrawdownAtLeast.probability)}`,
    );
  }
  lines.push('', `Verdict: ${report.verdict}`, ...report.reasons.map((reason) => `  - ${reason}`));
  if (report.warnings.length > 0) {
    lines.push('Warnings:', ...report.warnings.map((warning) => `  - ${warning}`));
  }
  if (report.divergences.length > 0) {
    lines.push('Not replayed from the live rules:', ...report.divergences.map((item) => `  - ${item}`));
  }
  lines.push('Historical evidence only. It does not change the live risk gate and does not authorise live trading.');
  return lines.join('\n');
}
