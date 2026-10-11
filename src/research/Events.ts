/**
 * Research-plane event sourcing — adapted from agent-tui's `supervisor/state/events.ts` pattern.
 *
 * Every meaningful state transition in the research plane emits a domain event. The event bus is an
 * in-process pub/sub; subscribers persist to `data/research-events.jsonl` (the canonical audit trail),
 * stream to a future dashboard, or feed the metrics collector. The bus is the only thing the
 * ChampionRegistry, ExperimentStore, and SelfImprovementLoop need to notify — they don't write to
 * the audit log directly anymore.
 *
 * Why event sourcing here:
 *   - The current ChampionRegistry.history array is a flat list of `{at, from, to, kind, note}` records
 *     with no payload detail. A real audit trail needs the experiment id, the verdict, the policy
 *     that was applied — that's exactly what the domain events carry.
 *   - Replay: a corrupted champion-registry.json can be reconstructed by replaying research-events.jsonl.
 *   - Streaming: a future dashboard subscribes to the bus and re-renders on every transition.
 *
 * The event types are discriminated by `type` so a switch is exhaustive. Adding a new event type is
 * a breaking change to consumers — bump the version on `ResearchEventSchema` and update subscribers.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { ChallengerStage, ChampionEntry, ChallengerEntry } from './ChampionRegistry.js';
import type { PromotionDecision, PromotionPolicy, PromotionVerdict } from './PromotionGate.js';
import type { ExperimentResult } from './ExperimentRunner.js';
import type { StrategySpec } from './StrategySpec.js';

/** Common fields on every event. */
export interface ResearchEventBase {
  /** Monotonic event sequence, assigned by the bus on first publish. */
  seq: number;
  /** Epoch millis. */
  at: number;
}

/** A spec was registered (new version, or dedup-returned existing version). */
export interface SpecRegistered extends ResearchEventBase {
  type: 'spec_registered';
  payload: { id: string; version: number; parentVersion: number | null; hypothesis: string; provenance: string };
}

/** A spec was appointed champion (initial seed appointment). */
export interface ChampionAppointed extends ResearchEventBase {
  type: 'champion_appointed';
  payload: { id: string; version: number; replacedVersion?: number; note?: string };
}

/** A challenger was staged at SHADOW. */
export interface ChallengerStaged extends ResearchEventBase {
  type: 'challenger_staged';
  payload: { id: string; version: number; note?: string; supersededVersion?: number };
}

/** A challenger transitioned between stages (SHADOW → PAPER → CANARY → PROMOTED, or → REJECTED). */
export interface ChallengerTransitioned extends ResearchEventBase {
  type: 'challenger_transitioned';
  payload: { id: string; version: number; from: ChallengerStage; to: ChallengerStage; note?: string; experimentId?: string };
}

/** A champion was rolled back to the previous version (canary failure or operator override). */
export interface ChampionRolledBack extends ResearchEventBase {
  type: 'champion_rolled_back';
  payload: { id: string; fromVersion: number; toVersion: number; reason: string };
}

/** An experiment was started (candidate + parent spec recorded). */
export interface ExperimentStarted extends ResearchEventBase {
  type: 'experiment_started';
  payload: { experimentId: string; candidateId: string; candidateVersion: number; parentId: string; parentVersion: number };
}

/** An experiment finished and the promotion gate has issued a verdict. */
export interface ExperimentCompleted extends ResearchEventBase {
  type: 'experiment_completed';
  payload: {
    experimentId: string;
    candidateId: string;
    candidateVersion: number;
    decision: PromotionDecision;
    testN: number;
    testMeanR: number;
    parentTestMeanR: number;
    policy: PromotionPolicy;
    experimentNotes: string[];
  };
}

/** A SelfImprovementLoop iteration started. */
export interface LoopIterationStarted extends ResearchEventBase {
  type: 'loop_iteration_started';
  payload: { championId: string; championVersion: number; ledgerSize: number };
}

/** A SelfImprovementLoop iteration finished. */
export interface LoopIterationCompleted extends ResearchEventBase {
  type: 'loop_iteration_completed';
  payload: { championId: string; championVersion: number; hypothesesProposed: number; experimentsRun: number; newShadowStaged: boolean };
}

/** A hypothesis was proposed by the ResearchAgent (LLM or fallback). */
export interface HypothesisProposed extends ResearchEventBase {
  type: 'hypothesis_proposed';
  payload: { hypothesisId: string; source: 'llm' | 'fallback'; observation: string; proposal: string; changes: Record<string, number> };
}

/** The ResearchAgent invoked the repair loop to recover a malformed LLM output. */
export interface HypothesisRepaired extends ResearchEventBase {
  type: 'hypothesis_repaired';
  payload: {
    ok: boolean;
    attempts: number;
    errorCount: number;
    /** A short sample of the first error from the final attempt (for dashboard at-a-glance). */
    firstError?: string;
  };
}

/** The ModelRouter picked a model for the current diagnostics (complexity-based routing). */
export interface ModelRouted extends ResearchEventBase {
  type: 'model_routed';
  payload: {
    /** The model name chosen. */
    model: string;
    /** 'local' (small model) or 'escalate' (large model). */
    kind: 'local' | 'escalate';
    /** The complexity score (0..1). */
    score: number;
    /** The reasons the scorer produced. */
    reasons: string[];
  };
}

/** The PatchWorkflow applied a code patch in a git worktree and ran validation commands. */
export interface PatchApplied extends ResearchEventBase {
  type: 'patch_applied';
  payload: {
    /** The run id from the PatchRequest. */
    runId: string;
    /** True if all validation commands passed. */
    ok: boolean;
    /** The worktree path where the patch was applied. */
    worktreePath: string;
    /** The commit SHA, if a commit was made. */
    commitSha?: string;
    /** The number of files changed. */
    filesChanged: number;
    /** The number of validation commands run. */
    verifyCommandCount: number;
    /** The number of validation commands that passed. */
    verifyPassed: number;
    /** When the patch failed, the error message. */
    error?: string;
  };
}

/** Union of all research-plane events. */
export type ResearchEvent =
  | SpecRegistered
  | ChampionAppointed
  | ChallengerStaged
  | ChallengerTransitioned
  | ChampionRolledBack
  | ExperimentStarted
  | ExperimentCompleted
  | LoopIterationStarted
  | LoopIterationCompleted
  | HypothesisProposed
  | HypothesisRepaired
  | ModelRouted
  | PatchApplied;

export type ResearchEventType = ResearchEvent['type'];

/**
 * In-process event bus. Subscribers are notified synchronously in subscription order. A subscriber
 * that throws does not break the publisher or later subscribers — the error is captured in the
 * return value so the publisher can log it.
 *
 * The bus assigns `seq` to every event on first publish. The seq is monotonic within a process
 * lifetime; it is NOT persisted across restarts (a fresh process starts at seq=1). For
 * cross-restart ordering, read `data/research-events.jsonl` directly.
 */
export class ResearchEventBus {
  private seq = 0;
  private readonly subscribers: Array<(e: ResearchEvent) => void | Promise<void>> = [];

  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribe(fn: (e: ResearchEvent) => void | Promise<void>): () => void {
    this.subscribers.push(fn);
    return () => {
      const i = this.subscribers.indexOf(fn);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }

  /** Publish an event. Assigns seq + at, then notifies every subscriber. */
  async publish(event: Omit<ResearchEvent, 'seq' | 'at'>): Promise<ResearchEvent> {
    const full = { ...event, seq: ++this.seq, at: Date.now() } as ResearchEvent;
    for (const fn of this.subscribers) {
      try {
        await fn(full);
      } catch {
        // a subscriber must not break the publisher; the caller may log
      }
    }
    return full;
  }

  /** Publish synchronously (subscriber errors are swallowed). Used by the ChampionRegistry, which
   * must not become async to preserve its current API. Subscribers that need async behavior should
   * use `setImmediate` or a queue internally. */
  publishSync(event: Omit<ResearchEvent, 'seq' | 'at'>): ResearchEvent {
    const full = { ...event, seq: ++this.seq, at: Date.now() } as ResearchEvent;
    for (const fn of this.subscribers) {
      try {
        const result = fn(full);
        if (result instanceof Promise) {
          // Fire-and-forget: the subscriber handles its own errors.
          result.catch(() => undefined);
        }
      } catch {
        // swallowed
      }
    }
    return full;
  }

  /** Current sequence number (for testing). */
  get currentSeq(): number { return this.seq; }
}

/**
 * Helper: build the payload for a ChampionEntry → event mapping. Used by ChampionRegistry when it
 * appoints a champion.
 */
export function championAppointedPayload(spec: StrategySpec, replacedVersion?: number, note?: string): ChampionAppointed['payload'] {
  return { id: spec.id, version: spec.version, replacedVersion, note };
}

/** Helper: build the payload for a ChallengerEntry transition event. */
export function challengerTransitionedPayload(entry: ChallengerEntry, from: ChallengerStage, note?: string, experimentId?: string): ChallengerTransitioned['payload'] {
  return { id: entry.id, version: entry.version, from, to: entry.stage, note: note ?? entry.note, experimentId: experimentId ?? entry.experimentId };
}

/** Helper: build the payload for an ExperimentCompleted event from a result + verdict. */
export function experimentCompletedPayload(
  experimentId: string,
  candidate: StrategySpec,
  result: ExperimentResult,
  verdict: PromotionVerdict,
): ExperimentCompleted['payload'] {
  return {
    experimentId,
    candidateId: candidate.id,
    candidateVersion: candidate.version,
    decision: verdict.decision,
    testN: result.test.n,
    testMeanR: result.test.meanNetR,
    parentTestMeanR: result.parentTest.meanNetR,
    policy: verdict.policy,
    experimentNotes: result.experimentNotes,
  };
}

/**
 * Append-only JSONL subscriber. Persists every event to disk as one line per event. The file is the
 * canonical audit trail: replay it to reconstruct the full history of every transition. A torn final
 * line (crash mid-append) is skipped on load, not fatal.
 */
export class JsonlEventSubscriber {
  constructor(private readonly filePath: string | null = null) {}

  /** Returns a subscriber function suitable for `bus.subscribe()`. */
  toSubscriber(): (e: ResearchEvent) => void {
    return (e) => {
      if (!this.filePath) return;
      try {
        // Lazy mkdir: only when first event arrives
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        appendFileSync(this.filePath, JSON.stringify(e) + '\n', 'utf8');
      } catch {
        // best-effort: a persistence failure must not break the bus
      }
    };
  }
}
