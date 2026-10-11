import type { DecisionRecord } from '../decision/DecisionJournal.js';
import { classifyRiskRefusal } from '../decision/NoTrade.js';

export interface CapacityContext {
  strategy: string;
  /** Capacity refusals for this strategy. */
  refused: number;
  /** Of those, how many arrived while an executed position on the same symbol was still open. */
  whileSymbolHeld: number;
  /** Which limit the refusal text named (a refusal can name several). */
  limits: Record<'symbol' | 'gross' | 'cluster' | 'notional' | 'position_count' | 'legacy_gross' | 'other', number>;
}

const heldAt = (executed: readonly DecisionRecord[], symbol: string, at: number): boolean =>
  executed.some((e) => e.symbol === symbol && e.timestamp <= at && (e.outcome?.closedAt ?? Number.POSITIVE_INFINITY) > at);

/**
 * Splits capacity refusals into "already positioned in this symbol" and everything else, and names the limit that was hit.
 * A strategy refused only while a same-symbol position is open is waiting its turn; one refused with nothing open is
 * being blocked by something else (a cap that an empty book already breaches, a circuit, a config mismatch).
 */
export function capacityContext(records: readonly DecisionRecord[]): CapacityContext[] {
  const executed = records.filter((r) => r.status === 'EXECUTED');
  const byStrategy = new Map<string, CapacityContext>();
  for (const r of records) {
    if (r.status !== 'RISK_REJECTED' || classifyRiskRefusal(r.rejectionReason ?? '') !== 'PORTFOLIO_CAPACITY') continue;
    const row = byStrategy.get(r.strategy) ?? {
      strategy: r.strategy, refused: 0, whileSymbolHeld: 0,
      limits: { symbol: 0, gross: 0, cluster: 0, notional: 0, position_count: 0, legacy_gross: 0, other: 0 },
    };
    row.refused += 1;
    if (heldAt(executed, r.symbol, r.timestamp)) row.whileSymbolHeld += 1;
    const text = r.rejectionReason ?? '';
    let named = false;
    const hit = (key: keyof CapacityContext['limits'], re: RegExp): void => { if (re.test(text)) { row.limits[key] += 1; named = true; } };
    hit('symbol', /\bsymbol [\d.]+%/);
    hit('gross', /\bgross [\d.]+%/);
    hit('cluster', /\bcluster \w+ [\d.]+%/);
    hit('notional', /\bnotional [\d.]+ \(max/);
    hit('position_count', /position_count|max concurrent positions/);
    hit('legacy_gross', /max gross exposure reached/);
    if (!named) row.limits.other += 1;
    byStrategy.set(r.strategy, row);
  }
  return [...byStrategy.values()].sort((a, b) => b.refused - a.refused);
}

export interface SizingConstraints {
  /** Risk budget per trade, % of equity. */
  riskPerTradePct: number;
  /** Per-symbol (and gross, for one symbol) exposure cap, % of equity. */
  maxSymbolExposurePct: number;
  /** One-way taker fee + slippage, as a fraction. */
  legRate: number;
}

/**
 * Sizing is qty = riskBudget / (stopDistance + roundTripCosts) and the engine *refuses* (it does not shrink) a trade whose
 * notional breaches the exposure cap. So notional/equity = risk / (stop% + cost%), and a trade can only fit the cap when
 * stop% >= risk / cap - cost%. Returns that minimum stop distance, in % of price.
 */
export function minStopPctToFitCap(c: SizingConstraints): number {
  const costPct = 2 * c.legRate * 100;
  return c.riskPerTradePct / (c.maxSymbolExposurePct / 100) - costPct;
}

export interface StopFeasibility {
  strategy: string;
  proposals: number;
  p10: number;
  median: number;
  p90: number;
  /** Proposals whose stop is wide enough to fit the cap with an empty book. */
  feasible: number;
  executedOfFeasible: number;
  executedOfInfeasible: number;
}

const quantile = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** Stop width (% of price) per strategy against the width the exposure cap implies. */
export function stopFeasibility(records: readonly DecisionRecord[], minStopPct: number): StopFeasibility[] {
  const by = new Map<string, DecisionRecord[]>();
  for (const r of records) by.set(r.strategy, [...(by.get(r.strategy) ?? []), r]);
  const rows: StopFeasibility[] = [];
  for (const [strategy, list] of by) {
    const widths = list
      .filter((r) => r.entry !== null && r.stopLoss !== null && r.entry > 0)
      .map((r) => ({ r, pct: (Math.abs(r.entry! - r.stopLoss!) / r.entry!) * 100 }));
    if (widths.length === 0) continue;
    const sorted = widths.map((w) => w.pct).sort((a, b) => a - b);
    const feasible = widths.filter((w) => w.pct >= minStopPct);
    const infeasible = widths.filter((w) => w.pct < minStopPct);
    rows.push({
      strategy, proposals: widths.length, p10: quantile(sorted, 0.1), median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9),
      feasible: feasible.length,
      executedOfFeasible: feasible.filter((w) => w.r.status === 'EXECUTED').length,
      executedOfInfeasible: infeasible.filter((w) => w.r.status === 'EXECUTED').length,
    });
  }
  return rows.sort((a, b) => b.proposals - a.proposals);
}
