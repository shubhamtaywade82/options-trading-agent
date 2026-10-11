/**
 * Metrics collector for the research plane — adapted from agent-tui's `supervisor/evals/metrics.ts` pattern.
 *
 * The key adaptation: agent-tui's MetricsCollector is manually fed (callers invoke recordRun, recordToolCall,
 * etc.). The research-plane version is an **EventBus subscriber** — it auto-tracks every event published to the
 * bus. No manual feeding needed; the operator just calls `bus.subscribe(collector.toSubscriber())` and reads
 * `collector.snapshot()` whenever they want the current state.
 *
 * What it tracks:
 *   - Loop-level: iterationsStarted, iterationsCompleted
 *   - Hypothesis-level: hypothesesProposed (split by source: llm / fallback), repairLoopInvocations,
 *     repairLoopSucceeded, repairLoopFailed
 *   - Experiment-level: experimentsStarted, experimentsCompleted (split by verdict: PROMOTE / REJECT /
 *     INSUFFICIENT_DATA)
 *   - Champion-level: championAppointments, challengerStaged, challengerTransitions (split by stage),
 *     championRollbacks
 *   - Spec-level: specsRegistered, specsDeduplicated (when register returns an existing version)
 *   - Latency: avgExperimentDurationMs (computed from experiment_started → experiment_completed pairs)
 *   - Derived: promotionRate (PROMOTE / experimentsCompleted), repairSuccessRate (repaired / repairLoopInvocations)
 *
 * The snapshot is a frozen view of the current state. The collector is not persistent — it lives in memory
 * for the process lifetime. For cross-restart metrics, read `data/research-events.jsonl` and replay it through
 * a fresh collector (the `replayEvents` helper does this).
 */

import type {
  ResearchEvent,
  ResearchEventBus,
} from './Events.js';

/** The metrics snapshot — a frozen view of the collector's current state. */
export interface ResearchMetrics {
  // Loop-level
  iterationsStarted: number;
  iterationsCompleted: number;
  // Hypothesis-level
  hypothesesProposed: number;
  hypothesesFromLlm: number;
  hypothesesFromFallback: number;
  repairLoopInvocations: number;
  repairLoopSucceeded: number;
  repairLoopFailed: number;
  // Model routing
  modelRoutesLocal: number;
  modelRoutesEscalate: number;
  modelRouteAvgScore: number;
  // Experiment-level
  experimentsStarted: number;
  experimentsCompleted: number;
  experimentsPromoted: number;
  experimentsRejected: number;
  experimentsInsufficientData: number;
  // Champion-level
  championAppointments: number;
  challengersStaged: number;
  challengersTransitionedToPaper: number;
  challengersTransitionedToCanary: number;
  challengersTransitionedToPromoted: number;
  challengersTransitionedToRejected: number;
  championRollbacks: number;
  // Spec-level
  specsRegistered: number;
  // Patch-level
  patchesApplied: number;
  patchesSucceeded: number;
  patchesFailed: number;
  // Latency (ms)
  avgExperimentDurationMs: number;
  // Derived rates (0..1)
  promotionRate: number;
  repairSuccessRate: number;
  llmHypothesisRate: number;
}

/** The initial empty metrics state. */
function emptyMetrics(): ResearchMetrics {
  return {
    iterationsStarted: 0,
    iterationsCompleted: 0,
    hypothesesProposed: 0,
    hypothesesFromLlm: 0,
    hypothesesFromFallback: 0,
    repairLoopInvocations: 0,
    repairLoopSucceeded: 0,
    repairLoopFailed: 0,
    modelRoutesLocal: 0,
    modelRoutesEscalate: 0,
    modelRouteAvgScore: 0,
    experimentsStarted: 0,
    experimentsCompleted: 0,
    experimentsPromoted: 0,
    experimentsRejected: 0,
    experimentsInsufficientData: 0,
    championAppointments: 0,
    challengersStaged: 0,
    challengersTransitionedToPaper: 0,
    challengersTransitionedToCanary: 0,
    challengersTransitionedToPromoted: 0,
    challengersTransitionedToRejected: 0,
    championRollbacks: 0,
    specsRegistered: 0,
    patchesApplied: 0,
    patchesSucceeded: 0,
    patchesFailed: 0,
    avgExperimentDurationMs: 0,
    promotionRate: 0,
    repairSuccessRate: 0,
    llmHypothesisRate: 0,
  };
}

/**
 * Metrics collector. Subscribe it to a ResearchEventBus (or feed it events manually) and call `snapshot()`
 * to read the current state. The collector is pure with respect to the bus: it never publishes events,
 * only consumes them.
 *
 * Latency tracking: experiment durations are computed from the `at` timestamps of `experiment_started` →
 * `experiment_completed` event pairs, matched by `experimentId`. The running average is updated incrementally.
 */
export class MetricsCollector {
  private m: ResearchMetrics = emptyMetrics();
  private readonly experimentStartTimes = new Map<string, number>();
  private experimentDurationSum = 0;
  private experimentDurationCount = 0;

  /**
   * Process a single event. Updates the internal counters. Safe to call directly (for replay) or via the
   * bus subscriber.
   */
  record(event: ResearchEvent): void {
    switch (event.type) {
      case 'loop_iteration_started':
        this.m.iterationsStarted += 1;
        break;
      case 'loop_iteration_completed':
        this.m.iterationsCompleted += 1;
        break;
      case 'hypothesis_proposed':
        this.m.hypothesesProposed += 1;
        if (event.payload.source === 'llm') this.m.hypothesesFromLlm += 1;
        else if (event.payload.source === 'fallback') this.m.hypothesesFromFallback += 1;
        break;
      case 'hypothesis_repaired':
        this.m.repairLoopInvocations += 1;
        if (event.payload.ok) this.m.repairLoopSucceeded += 1;
        else this.m.repairLoopFailed += 1;
        break;
      case 'model_routed':
        if (event.payload.kind === 'local') this.m.modelRoutesLocal += 1;
        else if (event.payload.kind === 'escalate') this.m.modelRoutesEscalate += 1;
        // Running average of complexity scores.
        {
          const total = this.m.modelRoutesLocal + this.m.modelRoutesEscalate;
          if (total > 0) {
            this.m.modelRouteAvgScore = (this.m.modelRouteAvgScore * (total - 1) + event.payload.score) / total;
          }
        }
        break;
      case 'experiment_started':
        this.m.experimentsStarted += 1;
        this.experimentStartTimes.set(event.payload.experimentId, event.at);
        break;
      case 'experiment_completed': {
        this.m.experimentsCompleted += 1;
        if (event.payload.decision === 'PROMOTE') this.m.experimentsPromoted += 1;
        else if (event.payload.decision === 'REJECT') this.m.experimentsRejected += 1;
        else if (event.payload.decision === 'INSUFFICIENT_DATA') this.m.experimentsInsufficientData += 1;
        // Latency: match to the experiment_started event by experimentId.
        const startedAt = this.experimentStartTimes.get(event.payload.experimentId);
        if (startedAt !== undefined) {
          const duration = event.at - startedAt;
          if (duration >= 0) {
            this.experimentDurationSum += duration;
            this.experimentDurationCount += 1;
            this.m.avgExperimentDurationMs = this.experimentDurationSum / this.experimentDurationCount;
          }
          this.experimentStartTimes.delete(event.payload.experimentId);
        }
        break;
      }
      case 'champion_appointed':
        this.m.championAppointments += 1;
        break;
      case 'challenger_staged':
        this.m.challengersStaged += 1;
        break;
      case 'challenger_transitioned':
        if (event.payload.to === 'PAPER') this.m.challengersTransitionedToPaper += 1;
        else if (event.payload.to === 'CANARY') this.m.challengersTransitionedToCanary += 1;
        else if (event.payload.to === 'PROMOTED') this.m.challengersTransitionedToPromoted += 1;
        else if (event.payload.to === 'REJECTED') this.m.challengersTransitionedToRejected += 1;
        break;
      case 'champion_rolled_back':
        this.m.championRollbacks += 1;
        break;
      case 'spec_registered':
        this.m.specsRegistered += 1;
        break;
      case 'patch_applied':
        this.m.patchesApplied += 1;
        if (event.payload.ok) this.m.patchesSucceeded += 1;
        else this.m.patchesFailed += 1;
        break;
    }

    // Derived rates — recomputed on every event so the snapshot is always current.
    this.m.promotionRate = this.m.experimentsCompleted > 0 ? this.m.experimentsPromoted / this.m.experimentsCompleted : 0;
    this.m.repairSuccessRate = this.m.repairLoopInvocations > 0 ? this.m.repairLoopSucceeded / this.m.repairLoopInvocations : 0;
    this.m.llmHypothesisRate = this.m.hypothesesProposed > 0 ? this.m.hypothesesFromLlm / this.m.hypothesesProposed : 0;
  }

  /** Returns a frozen snapshot of the current metrics. The caller may serialize it to JSON. */
  snapshot(): Readonly<ResearchMetrics> {
    return { ...this.m };
  }

  /** Resets all counters to zero. Useful for tests or for partitioning metrics by time window. */
  reset(): void {
    this.m = emptyMetrics();
    this.experimentStartTimes.clear();
    this.experimentDurationSum = 0;
    this.experimentDurationCount = 0;
  }

  /** Returns a subscriber function suitable for `bus.subscribe()`. */
  toSubscriber(): (e: ResearchEvent) => void {
    return (e) => this.record(e);
  }
}

/**
 * Replay a sequence of events through a fresh collector. Used to reconstruct metrics from the persisted
 * event log (`data/research-events.jsonl`): load the file, parse each line, feed to a fresh collector.
 *
 * The collector must be fresh (reset or newly constructed) — otherwise the replayed events are double-counted.
 */
export function replayEvents(events: readonly ResearchEvent[]): ResearchMetrics {
  const collector = new MetricsCollector();
  for (const e of events) collector.record(e);
  return collector.snapshot();
}

/**
 * Subscribe a collector to a bus. Convenience wrapper for `bus.subscribe(collector.toSubscriber())`.
 * Returns the unsubscribe function.
 */
export function attachCollector(bus: ResearchEventBus, collector: MetricsCollector): () => void {
  return bus.subscribe(collector.toSubscriber());
}

/** Render a metrics snapshot as a human-readable multi-line string. */
export function formatMetrics(m: Readonly<ResearchMetrics>): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('=== Research-plane metrics ===');
  lines.push('');
  lines.push('Loop:');
  lines.push(`  iterations started/completed: ${m.iterationsStarted}/${m.iterationsCompleted}`);
  lines.push('');
  lines.push('Hypotheses:');
  lines.push(`  proposed: ${m.hypothesesProposed} (LLM: ${m.hypothesesFromLlm}, fallback: ${m.hypothesesFromFallback})`);
  lines.push(`  LLM hypothesis rate: ${pct(m.llmHypothesisRate)}`);
  lines.push(`  repair loop: ${m.repairLoopInvocations} invoked, ${m.repairLoopSucceeded} succeeded, ${m.repairLoopFailed} failed (success rate: ${pct(m.repairSuccessRate)})`);
  lines.push('');
  lines.push('Model routing:');
  lines.push(`  local/escalate: ${m.modelRoutesLocal}/${m.modelRoutesEscalate}`);
  lines.push(`  avg complexity score: ${m.modelRouteAvgScore.toFixed(3)}`);
  lines.push('');
  lines.push('Experiments:');
  lines.push(`  started/completed: ${m.experimentsStarted}/${m.experimentsCompleted}`);
  lines.push(`  verdicts: PROMOTE=${m.experimentsPromoted}, REJECT=${m.experimentsRejected}, INSUFFICIENT_DATA=${m.experimentsInsufficientData}`);
  lines.push(`  promotion rate: ${pct(m.promotionRate)}`);
  lines.push(`  avg experiment duration: ${m.avgExperimentDurationMs.toFixed(0)}ms`);
  lines.push('');
  lines.push('Champions / challengers:');
  lines.push(`  appointments: ${m.championAppointments}`);
  lines.push(`  challengers staged: ${m.challengersStaged}`);
  lines.push(`  transitions: PAPER=${m.challengersTransitionedToPaper}, CANARY=${m.challengersTransitionedToCanary}, PROMOTED=${m.challengersTransitionedToPromoted}, REJECTED=${m.challengersTransitionedToRejected}`);
  lines.push(`  rollbacks: ${m.championRollbacks}`);
  lines.push('');
  lines.push('Specs:');
  lines.push(`  registered: ${m.specsRegistered}`);
  if (m.patchesApplied > 0) {
    lines.push('');
    lines.push('Patches:');
    lines.push(`  applied: ${m.patchesApplied} (succeeded: ${m.patchesSucceeded}, failed: ${m.patchesFailed})`);
  }
  return lines.join('\n');
}
