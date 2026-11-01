import type { Candle } from '../domain/types.js';
import { istParts } from '../time/ist.js';
import type { ReplayResult, ReplayTrade } from './replay.js';
import { bootstrapMeanR, chronologicalSplit, groupByDay, summarize, type Interval, type TradeSample } from './stats.js';

/** Extra per-day tags joined by date, such as the VIX tercile. */
export type DayTags = ReadonlyMap<string, Readonly<Record<string, string>>>;

export interface CellOptions {
  readonly iterations: number;
  readonly seed: number;
  readonly minTrades: number;
  readonly splitFraction: number;
  /** Earlier runs on the same dataset. Each was another look at the same days, so each multiplies the test count. */
  readonly priorRuns: number;
}

export interface Cell {
  /** `strategy | dimension=value`. */
  readonly key: string;
  readonly trades: number;
  readonly meanR: number;
  readonly profitFactor: number | undefined;
  readonly meanRCi95: Interval | undefined;
  readonly probMeanRNonPositive: number;
  readonly outOfSampleMeanR: number;
  readonly verdict: 'INSUFFICIENT_EVIDENCE' | 'NO_TRADE' | 'EDGE_SUPPORTED';
}

export interface CellReport {
  readonly cells: readonly Cell[];
  /** Cells in this report times runs on this dataset: the Bonferroni divisor. */
  readonly testsCounted: number;
  /** One-sided bar on P(mean net R ≤ 0) each cell must clear. */
  readonly threshold: number;
}

/** One-sided, matching the lower bound of the 95% interval the whole-sample verdict uses. */
const FAMILY_ALPHA = 0.025;

function cellValues(trade: ReplayTrade, dayTags: DayTags): Record<string, string> {
  const { regime, trendAlignment, timeBucket, expiryDay } = trade.context;
  return { regime, trendAlignment, timeBucket, expiryDay: String(expiryDay), ...dayTags.get(trade.date) };
}

function groupCells(trades: readonly ReplayTrade[], dayTags: DayTags): Map<string, ReplayTrade[]> {
  const groups = new Map<string, ReplayTrade[]>();
  for (const trade of trades) {
    for (const [dimension, value] of Object.entries(cellValues(trade, dayTags))) {
      const key = `${trade.strategy} | ${dimension}=${value}`;
      groups.set(key, [...(groups.get(key) ?? []), trade]);
    }
  }
  return groups;
}

function judgeCell(key: string, trades: readonly ReplayTrade[], dates: readonly string[], options: CellOptions, threshold: number): Cell {
  const samples: TradeSample[] = trades.map((trade) => ({ date: trade.date, netPnlInr: trade.netPnlInr, r: trade.r, exitReason: trade.exitReason }));
  const days = groupByDay(dates, samples);
  const summary = summarize(samples, days.length);
  const bootstrap = bootstrapMeanR(days, { iterations: options.iterations, seed: options.seed });
  const outOfSample = chronologicalSplit(days, options.splitFraction).outOfSample.flatMap((day) => day.trades);
  const outOfSampleMeanR = summarize(outOfSample, 0).meanR;
  let verdict: Cell['verdict'] = 'NO_TRADE';
  if (trades.length < options.minTrades) {
    verdict = 'INSUFFICIENT_EVIDENCE';
  } else if (bootstrap.probMeanRNonPositive < threshold && outOfSampleMeanR > 0) {
    verdict = 'EDGE_SUPPORTED';
  }
  return {
    key,
    trades: trades.length,
    meanR: summary.meanR,
    profitFactor: summary.profitFactor,
    meanRCi95: bootstrap.meanRCi95,
    probMeanRNonPositive: bootstrap.probMeanRNonPositive,
    outOfSampleMeanR,
    verdict,
  };
}

/**
 * Each strategy's priced trades split by one context dimension at a time. A cell is EDGE_SUPPORTED only when
 * P(mean net R ≤ 0) clears the Bonferroni-corrected bar for every cell and run tested, and its later days hold up.
 */
export function contextCells(result: Pick<ReplayResult, 'trades' | 'dates'>, dayTags: DayTags, options: CellOptions): CellReport {
  const priced = result.trades.filter((trade) => trade.exitReason !== 'DATA_GAP');
  const groups = [...groupCells(priced, dayTags)].sort(([a], [b]) => a.localeCompare(b));
  const testsCounted = Math.max(1, groups.length) * (options.priorRuns + 1);
  const threshold = FAMILY_ALPHA / testsCounted;
  const cells = groups.map(([key, trades]) => judgeCell(key, trades, result.dates, options, threshold));
  return { cells, testsCounted, threshold };
}

/** LOW / MID / HIGH by each date's first VIX bar open, ranked across the given dates. Dates without VIX get no tag. */
export function vixTerciles(vixBars: readonly Candle[], dates: readonly string[]): Map<string, { vix: string }> {
  const wanted = new Set(dates);
  const opens = new Map<string, number>();
  for (const bar of [...vixBars].sort((a, b) => a.time - b.time)) {
    const date = istParts(bar.time).date;
    if (wanted.has(date) && !opens.has(date)) {
      opens.set(date, bar.open);
    }
  }
  const ranked = [...opens].sort(([, a], [, b]) => a - b);
  const labels = ['LOW', 'MID', 'HIGH'];
  return new Map(ranked.map(([date], index) => [date, { vix: labels[Math.floor((3 * index) / ranked.length)] ?? 'HIGH' }]));
}

export function formatCells(report: CellReport): string {
  const lines = [
    `Context cells: ${report.cells.length} cells, ${report.testsCounted} tests counted; a cell needs P(mean net R ≤ 0) < ${report.threshold.toExponential(2)}`,
    'cell | trades | mean net R | 95% CI | P(≤0) | out-of-sample R | PF | verdict',
  ];
  for (const cell of report.cells) {
    const ci = cell.meanRCi95 === undefined ? 'n/a' : `${cell.meanRCi95.low} to ${cell.meanRCi95.high}`;
    lines.push(`${cell.key} | ${cell.trades} | ${cell.meanR} | ${ci} | ${cell.probMeanRNonPositive} | ${cell.outOfSampleMeanR} | ${cell.profitFactor ?? 'n/a'} | ${cell.verdict}`);
  }
  return lines.join('\n');
}
