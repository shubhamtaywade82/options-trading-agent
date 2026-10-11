import { existsSync, readFileSync } from 'node:fs';
import type { DecisionRecord } from '../decision/DecisionJournal.js';

/** Per-strategy reward:risk floors calibrated from realised, cost-adjusted outcomes. */
export interface RrFloor {
  minRr: number;
  /** Trades at or above the floor that the decision rests on. */
  n: number;
  /** Mean net R at or above the floor, after fees and slippage. */
  meanNetR: number;
  /** One-sided lower confidence bound on meanNetR; > 0 is what qualified the floor. */
  lcbNetR: number;
}

export interface RrProfile {
  version: 1;
  generatedAt: number;
  floors: Record<string, RrFloor>;
}

export interface CostRates { feeRate: number; slippageRate: number }

export type Side = 'LONG' | 'SHORT';

/**
 * Reward:risk after round-trip costs. Both legs pay fee + slippage on entry and exit; costs add to the
 * risk and subtract from the reward. Funding is signed from the position's view (positive = paid) per
 * interval and applied `fundingIntervals` times.
 */
export function costAdjustedRr(
  input: { entry: number; stopLoss: number; takeProfit: number; side: Side; fundingRate?: number; fundingIntervals?: number },
  costs: CostRates,
): number {
  const { entry, stopLoss, takeProfit, side } = input;
  const risk = Math.abs(entry - stopLoss);
  if (!(entry > 0) || !(risk > 0)) return Number.NaN;
  const funding = (side === 'LONG' ? 1 : -1) * (input.fundingRate ?? 0) * (input.fundingIntervals ?? 0);
  const cost = entry * (2 * (costs.feeRate + costs.slippageRate) + Math.max(0, funding));
  const reward = Math.abs(takeProfit - entry) - cost;
  return reward / (risk + cost);
}

/**
 * Cost of a round trip expressed in R (multiples of the stop distance). A 0.15% stop with 0.12% round-trip costs
 * spends 0.8R before the market does anything.
 */
export function costInR(entry: number, stopLoss: number, costs: CostRates): number {
  const risk = Math.abs(entry - stopLoss);
  return risk > 0 && entry > 0 ? (entry * 2 * (costs.feeRate + costs.slippageRate)) / risk : Number.NaN;
}

/**
 * Win rate a bracket needs just to break even after costs: p(rr - c) = (1 - p)(1 + c)  =>  p = (1 + c) / (1 + rr).
 * Above 1 the bracket cannot break even at any hit rate.
 */
export function breakevenWinRate(entry: number, stopLoss: number, takeProfit: number, costs: CostRates): number {
  const risk = Math.abs(entry - stopLoss);
  if (!(risk > 0)) return Number.NaN;
  const rr = Math.abs(takeProfit - entry) / risk;
  return (1 + costInR(entry, stopLoss, costs)) / (1 + rr);
}

export function minRrFor(profile: RrProfile | undefined, strategy: string, fallback: number): number {
  return profile?.floors[strategy]?.minRr ?? fallback;
}

/** Missing or unreadable file means "no profile": the caller keeps the global floor. */
export function loadRrProfile(path: string): RrProfile | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RrProfile;
    return parsed.version === 1 && parsed.floors && typeof parsed.floors === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface CalibrationOptions extends CostRates {
  candidateFloors?: readonly number[];
  minSamples?: number;
  /** One-sided z for the lower bound; 1.2816 is 90%. */
  z?: number;
}

export type StrategyVerdict =
  | { strategy: string; status: 'CALIBRATED'; floor: RrFloor; sample: number }
  | { strategy: string; status: 'INSUFFICIENT_DATA' | 'NO_PROVEN_EDGE'; sample: number; best?: { minRr: number; n: number; meanNetR: number; lcbNetR: number } };

export interface CalibrationReport { profile: RrProfile; verdicts: StrategyVerdict[] }

const DEFAULT_FLOORS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

interface Sample { plannedRr: number; netR: number }

/**
 * Net R of an executed (or hypothetically replayed) decision after round-trip fees and slippage; undefined when the
 * record has no clean outcome. The journalled R is price-only; the round trip's costs are paid on top of it.
 */
export function netROf(record: DecisionRecord, costs: CostRates): number | undefined {
  const { entry, stopLoss, outcome } = record;
  if (record.status !== 'EXECUTED' || !outcome || entry === null || stopLoss === null) return undefined;
  const risk = Math.abs(entry - stopLoss);
  if (!(risk > 0) || !Number.isFinite(outcome.rMultiple)) return undefined;
  return outcome.rMultiple - (entry * 2 * (costs.feeRate + costs.slippageRate)) / risk;
}

function toSample(record: DecisionRecord, costs: CostRates): Sample | undefined {
  const netR = netROf(record, costs);
  if (netR === undefined || record.takeProfit === null) return undefined;
  return { plannedRr: Math.abs(record.takeProfit - record.entry!) / Math.abs(record.entry! - record.stopLoss!), netR };
}

function stats(samples: readonly Sample[], z: number) {
  const n = samples.length;
  const mean = samples.reduce((sum, s) => sum + s.netR, 0) / n;
  const variance = n > 1 ? samples.reduce((sum, s) => sum + (s.netR - mean) ** 2, 0) / (n - 1) : Number.POSITIVE_INFINITY;
  return { n, meanNetR: mean, lcbNetR: mean - z * Math.sqrt(variance / n) };
}

/**
 * Lowest floor whose "RR >= floor" cohort has at least `minSamples` trades and a positive lower confidence
 * bound on net expectancy. Cohorts are cumulative (floor and above), so a higher floor never hides trades
 * a lower one kept.
 *
 * Caveats a reader must keep in mind: only executed trades with outcomes are observed (rejected candidates
 * have no outcome), scanning several floors is a multiple-comparison, and the sample must span regimes.
 * Treat the result as a floor to paper-test, not as proof.
 */
export function calibrateRrFloors(records: readonly DecisionRecord[], options: CalibrationOptions): CalibrationReport {
  const floors = options.candidateFloors ?? DEFAULT_FLOORS;
  const minSamples = options.minSamples ?? 30;
  const z = options.z ?? 1.2816;
  const byStrategy = new Map<string, Sample[]>();
  for (const record of records) {
    const sample = toSample(record, options);
    if (sample) byStrategy.set(record.strategy, [...(byStrategy.get(record.strategy) ?? []), sample]);
  }

  const profile: RrProfile = { version: 1, generatedAt: Date.now(), floors: {} };
  const verdicts: StrategyVerdict[] = [];
  for (const [strategy, samples] of [...byStrategy].sort(([a], [b]) => a.localeCompare(b))) {
    const cohorts = floors
      .map((minRr) => ({ minRr, ...stats(samples.filter((s) => s.plannedRr >= minRr), z) }))
      .filter((c) => c.n > 0);
    const qualified = cohorts.filter((c) => c.n >= minSamples);
    const winner = qualified.find((c) => c.lcbNetR > 0);
    if (winner) {
      const floor: RrFloor = { minRr: winner.minRr, n: winner.n, meanNetR: winner.meanNetR, lcbNetR: winner.lcbNetR };
      profile.floors[strategy] = floor;
      verdicts.push({ strategy, status: 'CALIBRATED', floor, sample: samples.length });
      continue;
    }
    const best = [...qualified].sort((a, b) => b.lcbNetR - a.lcbNetR)[0];
    verdicts.push({
      strategy, sample: samples.length, best,
      status: qualified.length === 0 ? 'INSUFFICIENT_DATA' : 'NO_PROVEN_EDGE',
    });
  }
  return { profile, verdicts };
}
