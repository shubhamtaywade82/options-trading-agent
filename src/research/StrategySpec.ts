/**
 * Versioned strategy specification.
 *
 * The live trading core is code: `StructureLiquidityStrategy`, `MomentumAgent`, etc. A spec is the versioned
 * *parameter record* that drives that code, plus the metadata (parent, hypothesis, provenance) that turns a
 * parameter sweep into a research lineage. The trading loop never reads code; the research loop never reads code.
 * Both read and write specs.
 *
 * Design rules enforced by this file:
 *   1. A spec is immutable once registered. Mutating a registered spec produces a new version.
 *   2. Every non-seed spec carries a `parentVersion`. A lineage is a chain of parent links back to the seed.
 *   3. `params` is a flat record of tunable numbers. The ExperimentRunner applies a spec to the existing
 *      SetupOutcomeLedger by treating each param as a filter (RR floor, sweep depth, etc.) — no re-run of the
 *      setup engine required for entry-threshold mutations. Sweep-age mutations are an approximation documented
 *      in `ExperimentRunner.ts`.
 *   4. `hypothesis` is mandatory and is the audit trail: every change says *why* it was proposed, in plain text,
 *      so a later operator (or the LLM researcher itself) can read why v18 exists.
 */

import type { StructureLiquidityOptions } from '../decision/StructureLiquidityStrategy.js';

/**
 * The families the research plane can evolve. Each family has its own parameter shape; only STRUCT-LIQ is wired
 * today, but the type is open so a future MomentumSpec can sit alongside it without restructuring the registry.
 */
export type StrategyFamily = 'STRUCT-LIQ' | 'MOMENTUM' | 'MEAN-REVERT' | 'CROWDING';

/**
 * A flat record of tunable numbers. The ExperimentRunner treats each entry as a *filter* on the SetupOutcomeLedger:
 * a setup whose `rr` is below `minimumRewardRisk`, or whose `features.sweepDepthAtr` is below `minSweepDepthAtr`,
 * is excluded from that spec's hypothetical trade set. This is what makes a parameter sweep a backtest over the
 * *same* underlying setups rather than a re-run of the setup engine.
 *
 * For STRUCT-LIQ, the spec is a strict superset of `StructureLiquidityOptions`: every existing tunable is here,
 * plus research-plane tunables the live strategy does not read (`minSweepDepthAtr`, `minSweepDisplacementAtr`,
 * `maxSpreadBps`) that the experiment runner applies as post-hoc filters.
 */
export interface StructLiqSpecParams extends StructureLiquidityOptions {
  /** Minimum sweep depth in ATR units. Setups with shallower sweeps are filtered out. */
  minSweepDepthAtr: number;
  /** Minimum displacement after the sweep. Setups with weaker displacement are filtered out. */
  minSweepDisplacementAtr: number;
  /** Maximum acceptable spread in bps. Setups observed at wider spreads are filtered out. */
  maxSpreadBps: number;
}

export type SpecParams = StructLiqSpecParams;

export type SpecProvenance =
  | { kind: 'seed'; note: string }
  | { kind: 'optimizer'; optimizer: 'random' | 'grid' | 'tpe'; iteration: number }
  | { kind: 'researcher'; hypothesisId: string; model: string }
  | { kind: 'manual'; note: string };

/**
 * A versioned strategy specification. See file header for design rules.
 */
export interface StrategySpec<P extends SpecParams = SpecParams> {
  /** Strategy id, e.g. 'STRUCT-LIQ-η'. Stable across versions. */
  id: string;
  /** Monotonically increasing per id; v1 is the seed. */
  version: number;
  /** The version this spec descends from. `null` only on the seed. */
  parentVersion: number | null;
  family: StrategyFamily;
  params: P;
  /** Plain-text justification. Mandatory: "why does v18 exist?" */
  hypothesis: string;
  provenance: SpecProvenance;
  createdAt: number;
  /** Optional list of diagnostic keys that motivated this spec, e.g. cell keys from ConditionalEdge. */
  motivatedBy?: string[];
}

/** Identity for set comparisons and lookups. */
export function specId(spec: Pick<StrategySpec, 'id' | 'version'>): string {
  return `${spec.id}:v${spec.version}`;
}

/** Structural equality of two parameter records — used by the registry to detect no-op mutations. */
export function paramsEqual<P extends SpecParams>(a: P, b: P): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i] as keyof P] !== b[kb[i] as keyof P]) return false;
  }
  return true;
}

/**
 * The seed spec for STRUCT-LIQ-η. Mirrors the current production thresholds (`DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS`)
 * so v1 is a faithful snapshot of what the live bot is running today, not a research fiction.
 *
 * The research-plane filters default to "no additional filter": zero sweep depth, zero displacement, infinite
 * spread. A spec with these values reproduces the seed exactly; tightening them is what produces a candidate.
 */
export function seedStructLiqSpec(): StrategySpec<StructLiqSpecParams> {
  return {
    id: 'STRUCT-LIQ-η',
    version: 1,
    parentVersion: null,
    family: 'STRUCT-LIQ',
    params: {
      maxSweepAgeCandles: 6,
      minBreakDistanceAtr: 0.10,
      stopBufferAtr: 0.15,
      minStopAtr: 0.50,
      maxStopAtr: 4.00,
      minimumRewardRisk: 1.50,
      minSweepDepthAtr: 0,
      minSweepDisplacementAtr: 0,
      maxSpreadBps: Number.POSITIVE_INFINITY,
    },
    hypothesis: 'Seed: mirrors DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS as of repository HEAD. No research-plane filters.',
    provenance: { kind: 'seed', note: 'snapshot of production thresholds' },
    createdAt: Date.parse('2026-01-01T00:00:00Z'),
  };
}

/**
 * A mutation is a partial update to a spec's params that produces a child spec. The child keeps the parent's
 * id and family; its version is parent + 1; its hypothesis is supplied by the caller (researcher or optimizer).
 *
 * Returns the child; never mutates the parent.
 */
export function mutateSpec<P extends SpecParams>(
  parent: StrategySpec<P>,
  changes: Partial<P>,
  hypothesis: string,
  provenance: SpecProvenance,
  motivatedBy?: string[],
): StrategySpec<P> {
  return {
    ...parent,
    version: parent.version + 1,
    parentVersion: parent.version,
    params: { ...parent.params, ...changes },
    hypothesis,
    provenance,
    createdAt: Date.now(),
    motivatedBy,
  };
}
