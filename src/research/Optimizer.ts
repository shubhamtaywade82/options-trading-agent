/**
 * Parameter optimizer for the research plane.
 *
 * The optimizer searches the parameter space of a strategy family for parameter combinations that improve on
 * the current champion's OOS expectancy. It is *mathematical first, LLM second*: the optimizer finds the best
 * parameter combination; the ResearchAgent (LLM) only proposes *which parameter to mutate* and *in which
 * direction* given diagnostics. The two compose — the LLM proposes a slice of the space to explore, the
 * optimizer searches that slice.
 *
 * Three strategies are provided:
 *   - `gridSearch`: exhaustive over a discrete grid. Use only when the grid is small (<= 1k combinations).
 *   - `randomSearch`: uniform sampling over the continuous space. The default; converges slowly but never gets
 *     stuck, and parallelizes trivially.
 *   - `tpeLike`: tree-structured Parzen estimator approximation. Maintains an elite set (top 25% of evaluated
 *     combinations) and samples near elites with adaptive variance. Converges faster than random search on
 *     smooth surfaces, never gets stuck on a plateau (the prior is uniform).
 *
 * The optimizer is *stateless*: it does not persist results. The ExperimentStore is the canonical record;
 * the optimizer reads from it (to seed TPE's elite set) and writes experiments to it via the ExperimentRunner.
 */

import { mulberry32 } from './Bootstrap.js';
import type { StructLiqSpecParams, StrategySpec } from './StrategySpec.js';

/** A single tunable parameter: name, range, and optional discrete grid. */
export interface ParameterSpace<P> {
  readonly name: keyof P & string;
  readonly low: number;
  readonly high: number;
  /** If supplied, the optimizer only samples these values (grid mode) or near them (TPE mode). */
  readonly grid?: readonly number[];
}

/** A single candidate parameter set produced by the optimizer. */
export interface CandidateSample<P> {
  params: Partial<P>;
  /** The optimizer's source (random / grid / tpe) and iteration index, for provenance. */
  provenance: { optimizer: 'random' | 'grid' | 'tpe'; iteration: number };
}

/** A historical observation: parameter set + the OOS mean R it produced. Used by TPE to seed its elite set. */
export interface HistoricalObservation<P> {
  params: Partial<P>;
  oosMeanR: number;
}

/** Uniformly samples a value from the parameter's range, honoring a discrete grid if supplied. */
function sample<P>(space: ParameterSpace<P>, rand: () => number): number {
  if (space.grid && space.grid.length > 0) {
    return space.grid[Math.floor(rand() * space.grid.length)];
  }
  return space.low + rand() * (space.high - space.low);
}

/** Gaussian sample around a mean, clipped to the parameter's range. */
function sampleAround<P>(space: ParameterSpace<P>, mean: number, sigma: number, rand: () => number): number {
  // Box-Muller
  const u = Math.max(1e-12, Math.min(1 - 1e-12, rand()));
  const v = Math.max(1e-12, Math.min(1 - 1e-12, rand()));
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const value = mean + sigma * z;
  if (space.grid && space.grid.length > 0) {
    // Snap to the nearest grid point
    return space.grid.reduce((best, g) => (Math.abs(g - value) < Math.abs(best - value) ? g : best), space.grid[0]);
  }
  return Math.max(space.low, Math.min(space.high, value));
}

/**
 * Random search. Produces `n` parameter sets sampled uniformly from each parameter's range (or grid).
 */
export function randomSearch<P>(
  spaces: readonly ParameterSpace<P>[],
  n: number,
  seed = 1,
): CandidateSample<P>[] {
  const rand = mulberry32(seed);
  const out: CandidateSample<P>[] = [];
  for (let i = 0; i < n; i += 1) {
    const params: Partial<P> = {};
    for (const space of spaces) {
      (params as Record<string, number>)[space.name] = sample(space, rand);
    }
    out.push({ params, provenance: { optimizer: 'random', iteration: i } });
  }
  return out;
}

/**
 * Grid search. Produces the cartesian product of every parameter's grid. Throws if any parameter lacks a grid
 * (the search would be infinite).
 */
export function gridSearch<P>(spaces: readonly ParameterSpace<P>[]): CandidateSample<P>[] {
  for (const s of spaces) {
    if (!s.grid || s.grid.length === 0) throw new Error(`gridSearch requires a discrete grid for ${s.name}; got none`);
  }
  const out: CandidateSample<P>[] = [];
  let iteration = 0;
  const recurse = (idx: number, acc: Partial<P>) => {
    if (idx === spaces.length) {
      out.push({ params: { ...acc }, provenance: { optimizer: 'grid', iteration: iteration++ } });
      return;
    }
    const space = spaces[idx];
    for (const value of space.grid!) {
      (acc as Record<string, number>)[space.name] = value;
      recurse(idx + 1, acc);
    }
  };
  recurse(0, {});
  return out;
}

/**
 * TPE-like adaptive search. Maintains an elite set (top `eliteFraction` of historical observations by OOS mean R)
 * and samples around each elite's mean with adaptive variance (shrinks as the elite set concentrates).
 *
 * If no history is supplied, falls back to uniform random for the first `n` samples — TPE needs warmup data.
 */
export function tpeLike<P>(
  spaces: readonly ParameterSpace<P>[],
  n: number,
  history: readonly HistoricalObservation<P>[],
  options: { seed?: number; eliteFraction?: number; minSigma?: number } = {},
): CandidateSample<P>[] {
  const rand = mulberry32(options.seed ?? 1);
  const eliteFraction = options.eliteFraction ?? 0.25;
  const minSigma = options.minSigma ?? 0.05;

  const sorted = [...history].filter((h) => Number.isFinite(h.oosMeanR)).sort((a, b) => b.oosMeanR - a.oosMeanR);
  const eliteCount = Math.max(1, Math.floor(sorted.length * eliteFraction));
  const elite = sorted.slice(0, eliteCount);

  // No history yet — fall back to random.
  if (elite.length === 0) {
    return randomSearch(spaces, n, options.seed ?? 1).map((s) => ({ ...s, provenance: { optimizer: 'tpe', iteration: s.provenance.iteration } }));
  }

  const out: CandidateSample<P>[] = [];
  for (let i = 0; i < n; i += 1) {
    const eliteIdx = Math.floor(rand() * elite.length);
    const eliteParams = elite[eliteIdx].params;
    const params: Partial<P> = {};
    for (const space of spaces) {
      const eliteVal = (eliteParams as Record<string, number | undefined>)[space.name];
      // Sigma is a fraction of the parameter's range, shrinking as i grows (the longer TPE runs, the narrower it
      // samples — eventually only mutations of the current elite survive).
      const range = space.high - space.low;
      const sigma = Math.max(minSigma * range, range * (0.30 - 0.20 * Math.min(1, i / Math.max(1, n))));
      const mean = eliteVal !== undefined ? eliteVal : (space.low + space.high) / 2;
      (params as Record<string, number>)[space.name] = sampleAround(space, mean, sigma, rand);
    }
    out.push({ params, provenance: { optimizer: 'tpe', iteration: i } });
  }
  return out;
}

/**
 * The default parameter space for STRUCT-LIQ. Each entry corresponds to a tunable in StructLiqSpecParams.
 *
 * The ranges are conservative — they cover the values the existing parameter sweep already explored (see
 * scripts/struct-liq-sweep.ts) and a small region around them, not the entire plausible space. Widening the
 * space is an operator decision; the defaults are designed so a sweep produces a small, comparable candidate set.
 */
export const STRUCT_LIQ_PARAMETER_SPACE: readonly ParameterSpace<StructLiqSpecParams>[] = [
  { name: 'minimumRewardRisk', low: 0.8, high: 2.5, grid: [1.0, 1.25, 1.5, 1.75, 2.0, 2.5] },
  { name: 'maxSweepAgeCandles', low: 2, high: 12, grid: [3, 4, 6, 8, 10] },
  { name: 'minBreakDistanceAtr', low: 0.05, high: 0.30, grid: [0.05, 0.10, 0.15, 0.20, 0.30] },
  { name: 'stopBufferAtr', low: 0.05, high: 0.30, grid: [0.05, 0.10, 0.15, 0.20, 0.30] },
  { name: 'minStopAtr', low: 0.30, high: 1.00, grid: [0.30, 0.50, 0.75, 1.00] },
  { name: 'maxStopAtr', low: 2.00, high: 6.00, grid: [2.0, 3.0, 4.0, 5.0, 6.0] },
  { name: 'minSweepDepthAtr', low: 0, high: 1.5, grid: [0, 0.25, 0.5, 0.75, 1.0, 1.5] },
  { name: 'minSweepDisplacementAtr', low: 0, high: 1.5, grid: [0, 0.25, 0.5, 0.75, 1.0, 1.5] },
];

/**
 * Build a child spec from a parent and a candidate sample. The sample's params are layered over the parent's
 * (untouched parameters inherit), producing a complete StructLiqSpecParams record.
 *
 * The hypothesis is supplied by the caller — the optimizer does not write hypotheses (it is math, not narrative).
 */
export function childFromSample(
  parent: StrategySpec<StructLiqSpecParams>,
  sample: CandidateSample<StructLiqSpecParams>,
  hypothesis: string,
): StrategySpec<StructLiqSpecParams> {
  return {
    ...parent,
    version: parent.version + 1,
    parentVersion: parent.version,
    params: { ...parent.params, ...sample.params },
    hypothesis,
    provenance: { kind: 'optimizer', optimizer: sample.provenance.optimizer, iteration: sample.provenance.iteration },
    createdAt: Date.now(),
  };
}
