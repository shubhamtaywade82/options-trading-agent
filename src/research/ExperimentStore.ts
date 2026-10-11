/**
 * Experiment store: append-only JSONL of every experiment ever run.
 *
 * One line per experiment — the candidate spec, the parent spec, the result, the verdict from the promotion gate,
 * and the timestamp. The store is the audit trail: "what experiments have we run, what did they show, what did we
 * decide about them, and why does v18 exist as a challenger today?"
 *
 * A null path keeps the store in memory (tests, ephemeral research sessions). The store is read by:
 *   - The ResearchAgent (to know what hypotheses have already been tried, so it doesn't propose them again).
 *   - The Optimizer (to seed TPE's elite set with prior results).
 *   - Operators (to answer "why was v18 promoted?": the line with `verdict.decision === 'PROMOTE'` says so).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { StrategySpec, SpecParams } from './StrategySpec.js';
import type { ExperimentResult } from './ExperimentRunner.js';
import type { PromotionVerdict } from './PromotionGate.js';

export interface ExperimentRecord {
  experimentId: string;
  /** ISO timestamp of the experiment. */
  ranAt: number;
  /** The candidate spec under test. */
  candidate: StrategySpec<SpecParams>;
  /** The parent spec it descends from. */
  parent: StrategySpec<SpecParams>;
  /** Computed metrics (train/test/walk-forward/per-symbol/per-regime). */
  result: ExperimentResult;
  /** The promotion gate's verdict. */
  verdict: PromotionVerdict;
}

function isRecord(value: unknown): value is ExperimentRecord {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.experimentId === 'string'
    && typeof r.ranAt === 'number'
    && r.candidate !== null && typeof r.candidate === 'object'
    && r.parent !== null && typeof r.parent === 'object'
    && r.result !== null && typeof r.result === 'object'
    && r.verdict !== null && typeof r.verdict === 'object';
}

/**
 * Append-only JSONL experiment store. `all()` returns records in chronological order; `forCandidate()` filters
 * by (id, version) so the gate and the operator can ask "what experiments have we run on v18?".
 */
export class ExperimentStore {
  private readonly records: ExperimentRecord[] = [];

  constructor(private readonly filePath: string | null = path.resolve('data/experiments.jsonl')) {
    this.load();
  }

  /** Append a single experiment. The verdict is supplied by the caller (PromotionGate) so the store never decides. */
  append(record: ExperimentRecord): void {
    this.records.push(record);
    if (!this.filePath) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // best-effort: research data must never take the trading loop down
    }
  }

  /** All experiments, oldest first. */
  all(): readonly ExperimentRecord[] {
    return this.records;
  }

  /** Every experiment for a given candidate (id, version). */
  forCandidate(id: string, version: number): readonly ExperimentRecord[] {
    return this.records.filter((r) => r.candidate.id === id && r.candidate.version === version);
  }

  /** Every experiment that produced a particular verdict (e.g. all PROMOTED experiments). */
  withVerdict(decision: PromotionVerdict['decision']): readonly ExperimentRecord[] {
    return this.records.filter((r) => r.verdict.decision === decision);
  }

  /** The most recent experiment on a strategy id, regardless of candidate version. */
  latestFor(id: string): ExperimentRecord | undefined {
    return [...this.records].reverse().find((r) => r.candidate.id === id);
  }

  private load(): void {
    try {
      if (this.filePath === null || !existsSync(this.filePath)) return;
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isRecord(parsed)) this.records.push(parsed);
        } catch {
          // a torn final line from a crash is skipped, not fatal
        }
      }
    } catch {
      // best-effort, like every persistence in this codebase
    }
  }
}
