import type { TradeRecord } from '../types.js';

export interface StrategyPerformance { closed: number; wins: number; pnl: number }
export interface PerformanceSummary {
  totalPnl: number; totalPnlPct: number; closedTrades: number;
  winRate: number | null; maxDrawdownPct: number; sharpe: number | null;
  var95: number | null; liquidations: number;
  byStrategy: Record<string, StrategyPerformance>;
}

const DAY_MS = 86_400_000;
const MIN_SHARPE_DAYS = 5;
const MIN_VAR_TRADES = 20;
const MIN_CORRELATION_PAIRS = 30;
const VAR_TAIL_FRACTION = 0.05;
const TRADING_DAYS_PER_YEAR = 365;

const utcDay = (timestamp: number): number => Math.floor(timestamp / DAY_MS);
const mean = (xs: number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const isFlat = (xs: number[]): boolean => xs.every((x) => x === xs[0]);

function groupByStrategy(trades: TradeRecord[]): Record<string, StrategyPerformance> {
  const byStrategy: Record<string, StrategyPerformance> = {};
  for (const t of trades) {
    const stats = (byStrategy[t.strategy] ??= { closed: 0, wins: 0, pnl: 0 });
    stats.closed += 1;
    stats.pnl += t.pnl;
    if (t.pnl > 0) stats.wins += 1;
  }
  return byStrategy;
}

function maxDrawdownPct(sorted: TradeRecord[], initialEquity: number, currentEquity: number): number {
  let equity = initialEquity;
  let peak = initialEquity;
  let worst = 0;
  const points = [...sorted.map((t) => (equity += t.pnl)), currentEquity];
  for (const point of points) {
    peak = Math.max(peak, point);
    worst = Math.min(worst, ((point - peak) / peak) * 100);
  }
  return worst;
}

function dailyReturns(sorted: TradeRecord[], initialEquity: number, now: number): number[] {
  if (sorted.length === 0) return [];
  const pnlByDay = new Map<number, number>();
  for (const t of sorted) pnlByDay.set(utcDay(t.closedAt), (pnlByDay.get(utcDay(t.closedAt)) ?? 0) + t.pnl);
  const firstDay = utcDay(sorted[0].closedAt);
  const lastDay = Math.max(utcDay(now), utcDay(sorted[sorted.length - 1].closedAt));
  const returns: number[] = [];
  let equity = initialEquity;
  for (let day = firstDay; day <= lastDay; day++) {
    const pnl = pnlByDay.get(day) ?? 0;
    returns.push(equity > 0 ? pnl / equity : 0);
    equity += pnl;
  }
  return returns;
}

function annualizedSharpe(sorted: TradeRecord[], initialEquity: number, now: number): number | null {
  const returns = dailyReturns(sorted, initialEquity, now);
  if (returns.length < MIN_SHARPE_DAYS || isFlat(returns)) return null;
  const avg = mean(returns);
  const variance = returns.reduce((sum, r) => sum + (r - avg) ** 2, 0) / (returns.length - 1);
  return (avg / Math.sqrt(variance)) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function valueAtRisk95(sorted: TradeRecord[]): number | null {
  if (sorted.length < MIN_VAR_TRADES) return null;
  const pnls = sorted.map((t) => t.pnl).sort((a, b) => a - b);
  return Math.min(0, pnls[Math.floor(VAR_TAIL_FRACTION * pnls.length)]);
}

/** Aggregates the closed-trade journal into headline statistics; pure, no I/O. */
export function summarizePerformance(trades: TradeRecord[], initialEquity: number, currentEquity: number, now: number): PerformanceSummary {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const wins = sorted.filter((t) => t.pnl > 0).length;
  const totalPnl = currentEquity - initialEquity;
  return {
    totalPnl,
    totalPnlPct: (totalPnl / initialEquity) * 100,
    closedTrades: sorted.length,
    winRate: sorted.length === 0 ? null : (wins / sorted.length) * 100,
    maxDrawdownPct: maxDrawdownPct(sorted, initialEquity, currentEquity),
    sharpe: annualizedSharpe(sorted, initialEquity, now),
    var95: valueAtRisk95(sorted),
    liquidations: sorted.filter((t) => t.reason === 'LIQUIDATED').length,
    byStrategy: groupByStrategy(sorted),
  };
}

/** Close-to-close simple returns: (c[i] - c[i-1]) / c[i-1]. */
export function simpleReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  return returns;
}

/** Pearson correlation over the aligned tails of two series; null under 30 pairs or with zero variance. */
export function correlation(a: number[], b: number[]): number | null {
  const pairs = Math.min(a.length, b.length);
  if (pairs < MIN_CORRELATION_PAIRS) return null;
  const xs = a.slice(a.length - pairs);
  const ys = b.slice(b.length - pairs);
  if (isFlat(xs) || isFlat(ys)) return null;
  const meanX = mean(xs);
  const meanY = mean(ys);
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < pairs; i++) {
    covariance += (xs[i] - meanX) * (ys[i] - meanY);
    varianceX += (xs[i] - meanX) ** 2;
    varianceY += (ys[i] - meanY) ** 2;
  }
  return covariance / Math.sqrt(varianceX * varianceY);
}
