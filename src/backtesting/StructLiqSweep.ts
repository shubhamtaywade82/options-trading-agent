import {
  buildStructureLiquiditySignal,
  DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS,
  type StructureLiquidityOptions,
} from '../decision/StructureLiquidityStrategy.js';
import type { MarketState } from '../market/types.js';

/**
 * Parameter-sensitivity harness for the STRUCT-LIQ setup.
 *
 * The setup is highly selective by construction (HTF regime -> LTF sweep -> LTF
 * break confirmation -> untaken liquidity target), and two of its gates are
 * simple thresholds: how old the trigger sweep may be
 * (`maxSweepAgeCandles`) and how much reward the target must offer
 * (`minimumRewardRisk`). This module measures how much each threshold
 * actually moves the firing rate — the strategy itself is never modified.
 *
 * The sweep is a single pass over an iterable of states: every state is
 * evaluated against every cell and then released, so a whole-window sweep on
 * real data runs in bounded memory. Feed it states produced with the same
 * no-lookahead discipline the replay engine uses (closed candles only); this
 * module does not re-derive causality, it only re-evaluates thresholds on
 * states that are already causal.
 */

/** The two axes the sweep probes; every other threshold stays at its default. */
export interface SweepGrid {
  sweepAges: number[];
  rewardRisks: number[];
}

export interface SweepCell {
  maxSweepAgeCandles: number;
  minimumRewardRisk: number;
  /** Bars on which the setup produced a signal (consecutive re-emissions included). */
  emissions: number;
  /** Distinct setups (unique signal ids, keyed by symbol + confirming break) — what cooldowns would turn into trades. */
  distinctSetups: number;
  /** Distinct setups this cell fires that the default thresholds do not. */
  newSetups: number;
  /** Distinct setups the default thresholds fire that this cell does not (tighter-than-default cells only). */
  lostSetups: number;
}

export interface SweepResult {
  cells: SweepCell[][];
  /** Distinct setups fired by the default thresholds — the baseline every cell is compared against. */
  baselineSetups: number;
}

export const DEFAULT_SWEEP_GRID: SweepGrid = {
  // 6 candles = the default 1.5h window; 96 = effectively unconstrained within a day
  sweepAges: [6, 12, 24, 48, 96],
  // 1.5 = the default floor; 0.01 = diagnostic "RR gate off" probe, not a tradable setting
  rewardRisks: [1.5, 1.2, 1.0, 0.8, 0.6, 0.01],
};

interface CellAccumulator {
  maxSweepAgeCandles: number;
  minimumRewardRisk: number;
  options: StructureLiquidityOptions;
  emissions: number;
  ids: Set<string>;
}

/**
 * Evaluates the setup over the full grid, one state at a time.
 *
 * Distinct setups are counted by signal id: the same confirming break
 * re-emits on following bars until a new break supersedes it, and it is the
 * setup — not the re-emission — that a cooldown would let through.
 */
export function sweepStructureLiquidity(states: Iterable<MarketState>, grid: SweepGrid = DEFAULT_SWEEP_GRID): SweepResult {
  const defaults = DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS;
  const cells: CellAccumulator[] = grid.sweepAges.flatMap((maxSweepAgeCandles) =>
    grid.rewardRisks.map((minimumRewardRisk) => ({
      maxSweepAgeCandles,
      minimumRewardRisk,
      options: { ...defaults, maxSweepAgeCandles, minimumRewardRisk },
      emissions: 0,
      ids: new Set<string>(),
    })),
  );

  const baselineIds = new Set<string>();
  for (const state of states) {
    for (const cell of cells) {
      const signal = buildStructureLiquiditySignal(state, cell.options);
      if (!signal) continue;
      cell.emissions += 1;
      cell.ids.add(signal.id);
    }
    const baselineSignal = buildStructureLiquiditySignal(state, defaults);
    if (baselineSignal) baselineIds.add(baselineSignal.id);
  }

  let index = 0;
  const rows: SweepCell[][] = grid.sweepAges.map(() =>
    grid.rewardRisks.map(() => {
      const cell = cells[index++];
      let newSetups = 0;
      let lostSetups = 0;
      for (const id of cell.ids) if (!baselineIds.has(id)) newSetups += 1;
      for (const id of baselineIds) if (!cell.ids.has(id)) lostSetups += 1;
      return {
        maxSweepAgeCandles: cell.maxSweepAgeCandles,
        minimumRewardRisk: cell.minimumRewardRisk,
        emissions: cell.emissions,
        distinctSetups: cell.ids.size,
        newSetups,
        lostSetups,
      };
    }),
  );

  return { cells: rows, baselineSetups: baselineIds.size };
}

/** The marginal view of the matrix: each axis varied alone, the other held at its default value. */
export function marginalAxes(result: SweepResult, grid: SweepGrid = DEFAULT_SWEEP_GRID): { age: SweepCell[]; rewardRisk: SweepCell[] } {
  const flat = result.cells.flat();
  const defaultAge = DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.maxSweepAgeCandles;
  const defaultRewardRisk = DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.minimumRewardRisk;
  const age = grid.sweepAges
    .map((a) => flat.find((c) => c.maxSweepAgeCandles === a && c.minimumRewardRisk === defaultRewardRisk))
    .filter((c): c is SweepCell => c !== undefined);
  const rewardRisk = grid.rewardRisks
    .map((rr) => flat.find((c) => c.minimumRewardRisk === rr && c.maxSweepAgeCandles === defaultAge))
    .filter((c): c is SweepCell => c !== undefined);
  return { age, rewardRisk };
}
