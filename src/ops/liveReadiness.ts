import type { DecisionRecord } from '../decision/DecisionJournal.js';
import type { EvidenceSnapshot } from '../risk/strategyApprovals.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';
export interface Check { area: 'EVIDENCE' | 'FORWARD' | 'RISK' | 'OPS'; id: string; status: CheckStatus; detail: string }

/**
 * Operator policy, not findings from data: how much loss and leverage you are willing to run live. Tighten freely; loosening
 * a limit to make a check pass defeats the point of the check.
 */
export const DEFAULT_POLICY = {
  maxRiskPerTradePct: { pass: 1, fail: 2 },
  maxLeverage: { pass: 5, fail: 10 },
  maxDailyLossPct: { pass: 3, fail: 5 },
  maxDrawdownPct: { pass: 10, fail: 15 },
  evidence: { minTrades: 100, minSpanDays: 150, z: 1.2816 },
  forward: { minTrades: 50, minSpanDays: 30 },
} as const;
export type Policy = typeof DEFAULT_POLICY;

export interface CostRates { feeRate: number; slippageRate: number }

interface NetTrade { at: number; netR: number }

function netTrades(records: readonly DecisionRecord[], strategy: string, costs: CostRates): NetTrade[] {
  const out: NetTrade[] = [];
  for (const r of records) {
    if (r.strategy !== strategy || r.status !== 'EXECUTED' || !r.outcome || r.entry === null || r.stopLoss === null) continue;
    const risk = Math.abs(r.entry - r.stopLoss);
    if (!(risk > 0) || !Number.isFinite(r.outcome.rMultiple)) continue;
    // Journalled R is price-only; the round trip's fees and slippage come on top (slightly conservative for backtests, whose fills already include slippage)
    out.push({ at: r.outcome.closedAt, netR: r.outcome.rMultiple - (r.entry * 2 * (costs.feeRate + costs.slippageRate)) / risk });
  }
  return out.sort((a, b) => a.at - b.at);
}

const mean = (xs: readonly number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
function lowerBound(xs: readonly number[], z: number): number {
  if (xs.length < 2) return Number.NEGATIVE_INFINITY;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return m - z * (sd / Math.sqrt(xs.length));
}

export interface StrategyEvidence {
  strategy: string;
  trades: number;
  spanDays: number;
  meanNetR: number;
  lcbNetR: number;
  firstHalfNetR: number;
  secondHalfNetR: number;
  pass: boolean;
  failures: string[];
}

/**
 * Out-of-sample style evidence per strategy, from executed trades with outcomes (pooled backtest windows and/or paper):
 * enough trades over a long enough span, a positive lower confidence bound on net expectancy after costs, and a positive
 * mean in BOTH time halves, so one lucky stretch cannot carry the pooled number.
 */
export function evaluateEvidence(records: readonly DecisionRecord[], costs: CostRates, policy: Policy = DEFAULT_POLICY): StrategyEvidence[] {
  const strategies = [...new Set(records.filter((r) => r.status === 'EXECUTED' && r.outcome).map((r) => r.strategy))].sort();
  return strategies.map((strategy) => {
    const t = netTrades(records, strategy, costs);
    const rs = t.map((x) => x.netR);
    const half = Math.floor(rs.length / 2);
    const first = rs.slice(0, half);
    const second = rs.slice(half);
    const spanDays = t.length > 1 ? (t[t.length - 1].at - t[0].at) / 86_400_000 : 0;
    const lcb = lowerBound(rs, policy.evidence.z);
    const failures: string[] = [];
    if (rs.length < policy.evidence.minTrades) failures.push(`only ${rs.length} trades (need ${policy.evidence.minTrades})`);
    if (spanDays < policy.evidence.minSpanDays) failures.push(`spans ${spanDays.toFixed(0)} days (need ${policy.evidence.minSpanDays})`);
    if (!(lcb > 0)) failures.push(`net expectancy lower bound ${Number.isFinite(lcb) ? lcb.toFixed(3) : 'n/a'}R is not above 0`);
    if (!(mean(first) > 0) || !(mean(second) > 0)) failures.push(`not positive in both halves (${fmt(mean(first))} / ${fmt(mean(second))})`);
    return {
      strategy, trades: rs.length, spanDays, meanNetR: mean(rs), lcbNetR: lcb, firstHalfNetR: mean(first), secondHalfNetR: mean(second),
      pass: failures.length === 0, failures,
    };
  });
}

const fmt = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}R` : 'n/a');

export interface StrategyForward {
  strategy: string;
  trades: number;
  spanDays: number;
  meanNetR: number;
  pass: boolean;
  failures: string[];
}

/** Forward paper evidence: the strategy must also have traded profitably, net of costs, in real time before it risks money. */
export function evaluateForward(paper: readonly DecisionRecord[], costs: CostRates, policy: Policy = DEFAULT_POLICY): StrategyForward[] {
  const strategies = [...new Set(paper.filter((r) => r.status === 'EXECUTED' && r.outcome).map((r) => r.strategy))].sort();
  return strategies.map((strategy) => {
    const t = netTrades(paper, strategy, costs);
    const spanDays = t.length > 1 ? (t[t.length - 1].at - t[0].at) / 86_400_000 : 0;
    const m = mean(t.map((x) => x.netR));
    const failures: string[] = [];
    if (t.length < policy.forward.minTrades) failures.push(`only ${t.length} paper trades (need ${policy.forward.minTrades})`);
    if (spanDays < policy.forward.minSpanDays) failures.push(`paper span ${spanDays.toFixed(0)} days (need ${policy.forward.minSpanDays})`);
    if (!(m > 0)) failures.push(`paper net expectancy ${fmt(m)} is not above 0`);
    return { strategy, trades: t.length, spanDays, meanNetR: m, pass: failures.length === 0, failures };
  });
}

/** A strategy is approved for live only when both the evidence and the forward paper record pass. */
export function approvable(evidence: readonly StrategyEvidence[], forward: readonly StrategyForward[]): { strategy: string; snapshot: EvidenceSnapshot }[] {
  return evidence.filter((e) => e.pass).flatMap((e) => {
    const f = forward.find((x) => x.strategy === e.strategy);
    if (!f || !f.pass) return [];
    return [{ strategy: e.strategy, snapshot: {
      trades: e.trades, meanNetR: e.meanNetR, lcbNetR: e.lcbNetR, firstHalfNetR: e.firstHalfNetR, secondHalfNetR: e.secondHalfNetR,
      forwardTrades: f.trades, forwardMeanNetR: f.meanNetR,
    } }];
  });
}

export interface ConfigFacts {
  mode: 'paper' | 'live';
  riskEngine: 'on' | 'off';
  alerts: 'on' | 'off';
  riskPerTradePct: number;
  maxLeverage: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  killSwitchHalted: boolean;
  /** Positions with no protective stop recorded (symbol + owner). */
  unprotected: readonly { symbol: string; owner: string }[];
}

const band = (value: number, limit: { pass: number; fail: number }): CheckStatus =>
  !(value > 0) || value > limit.fail ? 'FAIL' : value > limit.pass ? 'WARN' : 'PASS';

export function evaluateConfig(f: ConfigFacts, policy: Policy = DEFAULT_POLICY): Check[] {
  const limit = (id: string, label: string, value: number, l: { pass: number; fail: number }, unit: string): Check =>
    ({ area: 'RISK', id, status: band(value, l), detail: `${label} ${value}${unit} (policy pass <= ${l.pass}${unit}, fail > ${l.fail}${unit}; 0 counts as unset)` });
  return [
    { area: 'RISK', id: 'risk-engine', status: f.riskEngine === 'on' ? 'PASS' : 'FAIL', detail: `RISK_ENGINE=${f.riskEngine}` },
    limit('risk-per-trade', 'risk per trade', f.riskPerTradePct, policy.maxRiskPerTradePct, '%'),
    limit('max-leverage', 'max leverage', f.maxLeverage, policy.maxLeverage, 'x'),
    limit('daily-loss', 'daily loss limit', f.maxDailyLossPct, policy.maxDailyLossPct, '%'),
    limit('drawdown', 'drawdown limit', f.maxDrawdownPct, policy.maxDrawdownPct, '%'),
    { area: 'OPS', id: 'alerts', status: f.alerts === 'on' ? 'PASS' : 'FAIL', detail: `ALERTS=${f.alerts}` },
    { area: 'OPS', id: 'kill-switch', status: f.killSwitchHalted ? 'WARN' : 'PASS', detail: f.killSwitchHalted ? 'kill switch is HALTED (entries refused until resumed)' : 'kill switch not halted' },
    {
      area: 'RISK', id: 'protective-stops', status: f.unprotected.length === 0 ? 'PASS' : 'FAIL',
      detail: f.unprotected.length === 0 ? 'no open position lacks a recorded stop' : `no stop recorded on: ${f.unprotected.map((p) => `${p.symbol} (${p.owner})`).join(', ')}`,
    },
  ];
}

export const isReady = (checks: readonly Check[]): boolean => checks.every((c) => c.status !== 'FAIL');

/** Conditions under which the process must not even start in live mode. */
export function liveStartBlockers(f: Pick<ConfigFacts, 'mode' | 'riskEngine' | 'alerts'>): string[] {
  if (f.mode !== 'live') return [];
  const blockers: string[] = [];
  if (f.riskEngine !== 'on') blockers.push('RISK_ENGINE must be on in live mode');
  if (f.alerts !== 'on') blockers.push('ALERTS must be on in live mode: nobody would hear a halt, a crash or an unprotected position');
  return blockers;
}
