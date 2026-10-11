/**
 * High-level self-improvement loop: OBSERVE → DIAGNOSE → HYPOTHESIZE → MUTATE → BACKTEST → WALK-FORWARD →
 * CHALLENGE → PROMOTE / REJECT.
 *
 * This module is the only thing the CLI / orchestrator needs to call. It composes every research-plane module:
 *   - Reads the champion from ChampionRegistry.
 *   - Computes the champion's conditional-edge matrix from the SetupOutcomeLedger (OBSERVE).
 *   - Asks ResearchAgent to propose hypotheses from the matrix (DIAGNOSE + HYPOTHESIZE).
 *   - For each hypothesis, builds a candidate spec, runs the experiment, evaluates the promotion gate (MUTATE +
 *     BACKTEST + WALK-FORWARD + CHALLENGE).
 *   - Promotes via ChampionRegistry: SHADOW → (manual transition) → PAPER → CANARY → PROMOTED.
 *
 * The loop is intentionally NOT autonomous in its final stage: a candidate that clears the PromotionGate is staged
 * as SHADOW, not auto-promoted. The operator decides when to transition SHADOW → PAPER → CANARY → PROMOTED via
 * the CLI, because those stages involve real money at risk. The loop produces evidence; the operator consumes it.
 */

import type { SetupOutcomeRecord } from '../learning/SetupOutcomeLedger.js';
import type { CostRates } from '../risk/rrProfile.js';
import { ChampionRegistry } from './ChampionRegistry.js';
import { runExperiment, candidateMatrix, type ExperimentConfig } from './ExperimentRunner.js';
import { ExperimentStore, type ExperimentRecord } from './ExperimentStore.js';
import { DEFAULT_PROMOTION_POLICY, evaluatePromotion } from './PromotionGate.js';
import { ResearchAgent, candidateFromHypothesis, type Hypothesis, type ResearchDiagnostics } from './ResearchAgent.js';
import { StrategyRegistry } from './StrategyRegistry.js';
import type { StrategySpec, StructLiqSpecParams } from './StrategySpec.js';
import type { ResearchEventBus } from './Events.js';
import type { ExperimentMemory } from './ExperimentMemory.js';

export interface LoopConfig {
  /** Train window (days). */
  trainDays: number;
  /** Test window (days). */
  testDays: number;
  costs: CostRates;
  /** Maximum hypotheses to evaluate per loop iteration. */
  maxHypothesesPerRun: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  trainDays: 60,
  testDays: 30,
  costs: { feeRate: 0.0004, slippageRate: 0.0002 },
  maxHypothesesPerRun: 3,
};

export interface LoopStepResult {
  /** The hypotheses the ResearchAgent proposed this iteration. */
  hypotheses: Hypothesis[];
  /** The experiments that were run (one per hypothesis). */
  experiments: ExperimentRecord[];
  /** The new champion, if a promotion happened. */
  newChampion?: { id: string; version: number };
  /** Diagnostics that drove this iteration. */
  diagnostics: ResearchDiagnostics;
}

/**
 * The self-improvement loop. One `run()` call = one full iteration of the cycle.
 *
 * Constructed once with persistent registries (StrategyRegistry, ChampionRegistry, ExperimentStore) and a
 * ResearchAgent. Each `run()` reads the current champion, computes diagnostics, asks the agent for hypotheses,
 * runs an experiment per hypothesis, and stages any candidate that clears the PromotionGate as a SHADOW challenger.
 *
 * An optional `ResearchEventBus` makes the loop observable. When supplied, the loop emits
 * `loop_iteration_started`, `hypothesis_proposed`, `experiment_started`, `experiment_completed`, and
 * `loop_iteration_completed` events.
 *
 * An optional `ExperimentMemory` gives the ResearchAgent a memory of past experiments so it doesn't propose
 * the same hypothesis twice. The loop indexes every completed experiment into the memory (best-effort,
 * non-blocking) so the next iteration's ResearchAgent can query it.
 */
export class SelfImprovementLoop {
  constructor(
    private readonly strategies: StrategyRegistry,
    private readonly champions: ChampionRegistry,
    private readonly experiments: ExperimentStore,
    private readonly agent: ResearchAgent,
    private readonly config: LoopConfig = DEFAULT_LOOP_CONFIG,
    private readonly bus: ResearchEventBus | null = null,
    private readonly memory: ExperimentMemory | null = null,
  ) {
    this.strategies.ensureSeeds();
    // Appoint the seed as champion if no champion exists yet.
    for (const id of this.strategies.ids()) {
      if (!this.champions.champion(id)) {
        const seed = this.strategies.latest(id);
        if (seed) this.champions.appoint(seed, 'seed appointment');
      }
    }
  }

  /**
   * Run one iteration of the loop. Reads the SetupOutcomeLedger (supplied by the caller — the loop does not
   * own the data plane), computes diagnostics, proposes hypotheses, runs experiments, stages promotions.
   */
  async run(ledger: readonly SetupOutcomeRecord[]): Promise<LoopStepResult> {
    if (ledger.length === 0) {
      return { hypotheses: [], experiments: [], diagnostics: emptyDiagnostics() };
    }

    const championEntry = this.champions.champion('STRUCT-LIQ-η');
    if (!championEntry) throw new Error('no champion appointed for STRUCT-LIQ-η');
    const champion = this.strategies.get<StructLiqSpecParams>('STRUCT-LIQ-η', championEntry.version);
    if (!champion) throw new Error(`champion spec STRUCT-LIQ-η:v${championEntry.version} not in registry`);

    this.emit({
      type: 'loop_iteration_started',
      payload: { championId: champion.id, championVersion: champion.version, ledgerSize: ledger.length },
    });

    const first = Math.min(...ledger.map((r) => r.createdAt));
    const last = Math.max(...ledger.map((r) => r.createdAt));
    const from = first;
    const to = last;

    const matrix = candidateMatrix(champion, ledger, from, to, ['regime', 'phase', 'side'], { minN: 10, alpha: 0.05, iterations: 1000 });
    const lastExperiment = this.experiments.latestFor(champion.id);

    const diagnostics: ResearchDiagnostics = {
      championId: champion.id,
      championVersion: champion.version,
      worstCells: [...matrix.cells].sort((a, b) => (a.stats?.mean ?? Infinity) - (b.stats?.mean ?? Infinity)).slice(0, 8),
      bestCells: [...matrix.cells].sort((a, b) => (b.stats?.mean ?? -Infinity) - (a.stats?.mean ?? -Infinity)).slice(0, 8),
      lastExperiment: lastExperiment?.result,
      currentParams: champion.params,
    };

    const hypotheses = (await this.agent.propose(diagnostics)).slice(0, this.config.maxHypothesesPerRun);

    for (const h of hypotheses) {
      this.emit({
        type: 'hypothesis_proposed',
        payload: {
          hypothesisId: h.id,
          source: h.source,
          observation: h.observation,
          proposal: h.proposal,
          changes: h.changes as Record<string, number>,
        },
      });
    }

    const experiments: ExperimentRecord[] = [];

    const experimentConfig: ExperimentConfig = {
      trainDays: this.config.trainDays,
      testDays: this.config.testDays,
      costs: this.config.costs,
      walkForwardTrainDays: 14,
      walkForwardTestDays: 7,
      walkForwardMinN: 10,
      bootstrap: { iterations: 1000, seed: 1, confidence: 0.9 },
    };

    let newChampion: { id: string; version: number } | undefined;

    for (const h of hypotheses) {
      const candidate = this.strategies.register(candidateFromHypothesis(champion, h));
      const parent = this.strategies.get<StructLiqSpecParams>(champion.id, champion.version)!;

      const experimentId = `exp-${Date.now()}-${experiments.length + 1}`;
      this.emit({
        type: 'experiment_started',
        payload: {
          experimentId,
          candidateId: candidate.id,
          candidateVersion: candidate.version,
          parentId: parent.id,
          parentVersion: parent.version,
        },
      });

      const result = runExperiment(candidate, parent, ledger, experimentConfig);
      const verdict = evaluatePromotion(result, DEFAULT_PROMOTION_POLICY);
      const record: ExperimentRecord = {
        experimentId,
        ranAt: Date.now(),
        candidate,
        parent,
        result,
        verdict,
      };
      this.experiments.append(record);
      experiments.push(record);

      // Index the completed experiment into the memory (best-effort, non-blocking) so the next iteration's
      // ResearchAgent can query "have we already tried this?" before proposing.
      if (this.memory) {
        try {
          await this.memory.index(record);
        } catch {
          // memory indexing must never break the loop — best-effort
        }
      }

      this.emit({
        type: 'experiment_completed',
        payload: {
          experimentId,
          candidateId: candidate.id,
          candidateVersion: candidate.version,
          decision: verdict.decision,
          testN: result.test.n,
          testMeanR: result.test.meanNetR,
          parentTestMeanR: result.parentTest.meanNetR,
          policy: verdict.policy,
          experimentNotes: result.experimentNotes,
        },
      });

      if (verdict.decision === 'PROMOTE') {
        // Stage the candidate as a SHADOW challenger. The operator decides when to transition to PAPER/CANARY/PROMOTED.
        this.champions.stageChallenger(candidate, `PROMOTED by gate: ${verdict.reasons.join('; ')}`);
        newChampion = { id: candidate.id, version: candidate.version };
      }
    }

    this.emit({
      type: 'loop_iteration_completed',
      payload: {
        championId: champion.id,
        championVersion: champion.version,
        hypothesesProposed: hypotheses.length,
        experimentsRun: experiments.length,
        newShadowStaged: newChampion !== undefined,
      },
    });

    return { hypotheses, experiments, newChampion, diagnostics };
  }

  /**
   * Convenience: promotes the SHADOW challenger for an id through the next stage. The operator calls this when
   * they are satisfied that a shadow challenger is behaving correctly on divergence metrics.
   */
  advanceChallenger(id: string, to: 'SHADOW' | 'PAPER' | 'CANARY' | 'PROMOTED', note?: string, experimentId?: string): void {
    const challengers = this.champions.challengersFor(id);
    if (challengers.length === 0) throw new Error(`no active challenger for ${id}`);
    // Pick the highest-stage active challenger.
    const challenger = challengers.sort((a, b) => stageRank(b.stage) - stageRank(a.stage))[0];
    this.champions.transition(id, challenger.version, to, note, experimentId);
  }

  /** Emit an event via the bus if one is configured. */
  private emit(event: { type: string; payload: unknown }): void {
    if (!this.bus) return;
    this.bus.publishSync(event as never);
  }
}

function stageRank(s: string): number {
  switch (s) {
    case 'SHADOW': return 1;
    case 'PAPER': return 2;
    case 'CANARY': return 3;
    case 'PROMOTED': return 4;
    default: return 0;
  }
}

function emptyDiagnostics(): ResearchDiagnostics {
  return {
    championId: 'STRUCT-LIQ-η',
    championVersion: 1,
    worstCells: [],
    bestCells: [],
    currentParams: {
      maxSweepAgeCandles: 6, minBreakDistanceAtr: 0.10, stopBufferAtr: 0.15,
      minStopAtr: 0.50, maxStopAtr: 4.00, minimumRewardRisk: 1.50,
      minSweepDepthAtr: 0, minSweepDisplacementAtr: 0, maxSpreadBps: Number.POSITIVE_INFINITY,
    },
  };
}
