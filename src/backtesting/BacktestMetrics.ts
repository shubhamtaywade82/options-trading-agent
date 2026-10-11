import type { EquityPoint, SimTrade } from './types.js';

export interface MetricsSlice {
  trades: number;
  wins: number;
  winRatePct: number;
  /** Mean realized R-multiple; null when no trade carries an initial risk. */
  expectancyR: number | null;
  netPnl: number;
}

export interface ExcursionStats {
  avg: number;
  p95: number;
}

export interface BacktestMetrics {
  // Headline
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  /** After fees and funding (what the account experienced). */
  netPnl: number;
  /** Price pnl only, before fees and funding. */
  grossPnl: number;
  netReturnPct: number;
  initialEquity: number;
  finalEquity: number;
  profitFactor: number | null;
  expectancyR: number | null;
  expectancyUsd: number | null;
  payoffRatio: number | null;
  // Risk
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  sharpe: number | null;
  sortino: number | null;
  cvar95Pct: number | null;
  maxConsecutiveLosses: number;
  largestWinUsd: number;
  largestLossUsd: number;
  liquidations: number;
  // Behaviour
  avgHoldHours: number | null;
  maxHoldHours: number | null;
  turnover: number;
  timeInMarketPct: number;
  // Friction
  feesPaid: number;
  fundingPaid: number;
  slippagePaid: number;
  // Excursions
  maeR: ExcursionStats | null;
  mfeR: ExcursionStats | null;
  // Research slices
  byStrategy: Record<string, MetricsSlice>;
  bySymbol: Record<string, MetricsSlice>;
  byRegime: Record<string, MetricsSlice>;
  byEvidenceBucket: Record<string, MetricsSlice>;
  period: { from: number; to: number; steps: number; symbols: string[] };
}

/** Evidence buckets from improvements.md §29: does a high setup grade actually earn more? */
const EVIDENCE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '00-50', min: 0, max: 50 },
  { label: '50-70', min: 50, max: 70 },
  { label: '70-88', min: 70, max: 88 },
  { label: '88-100', min: 88, max: 101 },
];

/**
 * Trade pnl in the journal is gross price pnl (spread/slippage already sit inside the fills; fees and funding are
 * booked to the wallet separately). Every trade-level statistic below uses the economics the account actually
 * experienced: price pnl plus funding (negative = paid) minus fees.
 */
const netPnlOf = (trade: SimTrade): number => trade.pnl + trade.funding - trade.fees;

/** R after fees and funding: net dollars over the dollars at risk (qty x initial risk per unit). */
const rMultiple = (trade: SimTrade): number | null => {
  if (!trade.initialRisk || trade.initialRisk <= 0 || !(trade.qty > 0)) return null;
  return netPnlOf(trade) / (trade.qty * trade.initialRisk);
};

const mean = (values: number[]): number | null => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function slice(trades: SimTrade[]): MetricsSlice {
  const rs = trades.map(rMultiple).filter((r): r is number => r !== null);
  return {
    trades: trades.length,
    wins: trades.filter((t) => netPnlOf(t) > 0).length,
    winRatePct: trades.length > 0 ? Number(((trades.filter((t) => netPnlOf(t) > 0).length / trades.length) * 100).toFixed(1)) : 0,
    expectancyR: mean(rs.map((r) => Number(r.toFixed(3)))),
    netPnl: Number(trades.reduce((sum, t) => sum + netPnlOf(t), 0).toFixed(2)),
  };
}

function groupBy(trades: SimTrade[], keyOf: (trade: SimTrade) => string | null): Record<string, MetricsSlice> {
  const groups = new Map<string, SimTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    if (key === null) continue;
    const list = groups.get(key) ?? [];
    list.push(trade);
    groups.set(key, list);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, slice(list)]));
}

/** Annualization factor for 15m equity-curve returns. */
const PERIODS_PER_YEAR = 4 * 24 * 365;

function barReturns(curve: EquityPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const previous = curve[i - 1].equity;
    if (previous > 0) returns.push(curve[i].equity / previous - 1);
  }
  return returns;
}

export function computeMetrics(input: {
  trades: SimTrade[];
  curve: EquityPoint[];
  initialEquity: number;
  /** Steps on which at least one position was open — for time-in-market. */
  investedSteps: number;
  period: { from: number; to: number; steps: number; symbols: string[] };
}): BacktestMetrics {
  const { trades, curve, initialEquity } = input;
  const wins = trades.filter((t) => netPnlOf(t) > 0);
  const losses = trades.filter((t) => netPnlOf(t) <= 0);
  const grossWin = wins.reduce((sum, t) => sum + netPnlOf(t), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + netPnlOf(t), 0));
  const netPnl = grossWin - grossLoss;
  const pricePnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const finalEquity = curve.length > 0 ? curve[curve.length - 1].equity : initialEquity;
  const rs = trades.map(rMultiple).filter((r): r is number => r !== null);

  let peak = curve.length > 0 ? curve[0].equity : initialEquity;
  let maxDrawdownUsd = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - point.equity);
  }

  const returns = barReturns(curve);
  const avgReturn = mean(returns);
  const variance = returns.length > 1 && avgReturn !== null
    ? returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / (returns.length - 1)
    : null;
  const downside = returns.filter((r) => r < 0);
  const downsideVariance = downside.length > 1
    ? downside.reduce((sum, r) => sum + r * r, 0) / downside.length
    : null;

  let consecutive = 0;
  let maxConsecutive = 0;
  for (const trade of trades) {
    if (netPnlOf(trade) <= 0) {
      consecutive += 1;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else {
      consecutive = 0;
    }
  }

  const holds = trades.map((t) => (t.closedAt - t.openedAt) / 3_600_000);
  const maes = trades.map((t) => t.maeR).filter((m): m is number => m !== null);
  const mfes = trades.map((t) => t.mfeR).filter((m): m is number => m !== null);
  const worst = [...returns].sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(returns.length * 0.05)));
  const avgWin = mean(wins.map(netPnlOf));
  const avgLoss = mean(losses.map((t) => Math.abs(netPnlOf(t))));

  return {
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRatePct: trades.length > 0 ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    netPnl: Number(netPnl.toFixed(2)),
    grossPnl: Number(pricePnl.toFixed(2)),
    netReturnPct: initialEquity > 0 ? Number(((netPnl / initialEquity) * 100).toFixed(2)) : 0,
    initialEquity,
    finalEquity: Number(finalEquity.toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? null : 0,
    expectancyR: mean(rs),
    expectancyUsd: mean(trades.map(netPnlOf)),
    payoffRatio: avgWin !== null && avgLoss !== null && avgLoss > 0 ? Number((avgWin / avgLoss).toFixed(2)) : null,
    maxDrawdownPct: peak > 0 ? Number(((maxDrawdownUsd / peak) * 100).toFixed(2)) : 0,
    maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(2)),
    sharpe: variance !== null && variance > 0 && avgReturn !== null ? Number(((avgReturn / Math.sqrt(variance)) * Math.sqrt(PERIODS_PER_YEAR)).toFixed(2)) : null,
    sortino: downsideVariance !== null && downsideVariance > 0 && avgReturn !== null ? Number(((avgReturn / Math.sqrt(downsideVariance)) * Math.sqrt(PERIODS_PER_YEAR)).toFixed(2)) : null,
    cvar95Pct: worst.length > 0 ? Number((mean(worst)! * 100).toFixed(3)) : null,
    maxConsecutiveLosses: maxConsecutive,
    largestWinUsd: wins.length > 0 ? Number(Math.max(...wins.map(netPnlOf)).toFixed(2)) : 0,
    largestLossUsd: losses.length > 0 ? Number(Math.min(...losses.map(netPnlOf)).toFixed(2)) : 0,
    liquidations: trades.filter((t) => t.reason === 'LIQUIDATED').length,
    avgHoldHours: mean(holds) !== null ? Number(mean(holds)!.toFixed(2)) : null,
    maxHoldHours: holds.length > 0 ? Number(Math.max(...holds).toFixed(2)) : null,
    turnover: initialEquity > 0 ? Number((trades.reduce((sum, t) => sum + t.entry * t.qty + t.exit * t.qty, 0) / initialEquity).toFixed(2)) : 0,
    timeInMarketPct: input.period.steps > 0 ? Number(((input.investedSteps / input.period.steps) * 100).toFixed(1)) : 0,
    feesPaid: Number(trades.reduce((sum, t) => sum + t.fees, 0).toFixed(2)),
    fundingPaid: Number(trades.reduce((sum, t) => sum + t.funding, 0).toFixed(2)),
    slippagePaid: Number(trades.reduce((sum, t) => sum + t.slippage, 0).toFixed(2)),
    maeR: maes.length > 0 ? { avg: Number(mean(maes)!.toFixed(3)), p95: Number(percentile(maes, 95).toFixed(3)) } : null,
    mfeR: mfes.length > 0 ? { avg: Number(mean(mfes)!.toFixed(3)), p95: Number(percentile(mfes, 95).toFixed(3)) } : null,
    byStrategy: groupBy(trades, (t) => t.strategy),
    bySymbol: groupBy(trades, (t) => t.symbol),
    byRegime: groupBy(trades, (t) => t.regime),
    byEvidenceBucket: groupBy(trades, (t) => {
      if (t.evidenceScore === null) return null;
      const bucket = EVIDENCE_BUCKETS.find((b) => t.evidenceScore! >= b.min && t.evidenceScore! < b.max);
      return bucket?.label ?? null;
    }),
    period: input.period,
  };
}
