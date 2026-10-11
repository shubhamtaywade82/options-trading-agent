/**
 * Golden task suite for the research plane — adapted from agent-tui's `supervisor/evals/golden.ts` pattern.
 *
 * A fixed set of tasks with known-good expectations, used to detect regressions when the PromotionGate's
 * thresholds, the ExperimentRunner's filter logic, or the SelfImprovementLoop's flow change. Each task
 * supplies a synthetic ledger + a candidate spec, runs the experiment, and asserts on the verdict.
 *
 * Why this matters more than ad-hoc tests:
 *   - The PromotionGate is statistical: a 1-line threshold tweak can flip a verdict from PROMOTE to REJECT
 *     silently. The existing `promotionGate.test.ts` covers each rule in isolation; the golden suite covers
 *     the *combination* of rules on realistic data shapes.
 *   - The SelfImprovementLoop's behavior depends on the interaction of ResearchAgent → ExperimentRunner →
 *     PromotionGate → ChampionRegistry. A unit test of any one cannot catch integration regressions.
 *   - The suite is run by `npm run research:golden` against in-memory registries — no GPU, no LLM, no
 *     network. CI-friendly.
 *
 * Task categories:
 *   - gate-reject  — verifies the gate rejects a candidate for the expected reason (zero delta, single symbol,
 *                    regime collapse, walk-forward negative, insufficient data, profit factor too low, etc.)
 *   - gate-promote — verifies the gate promotes a candidate that genuinely improves on the parent across
 *                    every guard. The hardest task to keep green; if it ever fails, the gate has tightened.
 *   - loop-flow    — verifies the SelfImprovementLoop's full OBSERVE → DIAGNOSE → HYPOTHESIZE → EXPERIMENT
 *                    → CHALLENGE cycle on a known fixture.
 *   - registry     — verifies the StrategyRegistry's dedup + lineage and the ChampionRegistry's transitions.
 *
 * Adding a new task: append to `GOLDEN_TASKS` in `defineGoldenTasks.ts`. Each task gets a stable id; a
 * regression on a task is reported by id so the operator knows exactly what broke.
 */

import type { SetupOutcomeRecord } from '../learning/SetupOutcomeLedger.js';
import { runExperiment, type ExperimentResult } from './ExperimentRunner.js';
import { DEFAULT_PROMOTION_POLICY, evaluatePromotion, type PromotionVerdict, type PromotionDecision } from './PromotionGate.js';
import type { StrategySpec, StructLiqSpecParams } from './StrategySpec.js';

/** A golden task: synthetic scenario + expected outcome. */
export interface GoldenTask {
  /** Stable id, e.g. 'gate-001'. Never reuse an id — append a new one when adding a task. */
  id: string;
  /** One-sentence description of what the task verifies. */
  description: string;
  /** Tags for grouping in the report. */
  tags: string[];
  /** Builds the ledger the task runs against. Lazy so the suite doesn't allocate all ledgers upfront. */
  ledger: () => SetupOutcomeRecord[];
  /** Builds the candidate spec under test. */
  candidate: (seed: StrategySpec<StructLiqSpecParams>) => StrategySpec<StructLiqSpecParams>;
  /** The parent spec the candidate descends from. Defaults to the seed. */
  parent?: (seed: StrategySpec<StructLiqSpecParams>) => StrategySpec<StructLiqSpecParams>;
  /** Optional: train/test window override (days). Defaults to 60/30. */
  trainDays?: number;
  testDays?: number;
  /** Expected verdict from the PromotionGate. */
  expectedDecision: PromotionDecision;
  /** Substrings the verdict's reasons must contain (case-insensitive). Optional. */
  expectedReasonContains?: string[];
  /** Substrings the verdict's reasons must NOT contain. Optional. */
  expectedReasonNotContains?: string[];
  /** Optional: minimum test-window trade count (n). The actual n must be >= this. */
  minTestN?: number;
  /** Optional: minimum walk-forward fold count. */
  minWalkForwardFolds?: number;
}

/** The result of running a single golden task. */
export interface GoldenTaskResult {
  taskId: string;
  description: string;
  pass: boolean;
  /** Wall-clock latency of the task (ms). */
  durationMs: number;
  /** The actual verdict produced. */
  actualDecision: PromotionDecision;
  /** The actual reasons produced. */
  actualReasons: string[];
  /** The actual test-window n. */
  actualTestN: number;
  /** The actual walk-forward fold count. */
  actualWalkForwardFolds: number;
  /** Failure reasons (empty when pass=true). */
  failures: string[];
}

/** The summary of a golden-suite run. */
export interface GoldenSuiteReport {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: GoldenTaskResult[];
}

/**
 * Run a single golden task. Pure: builds the ledger + specs, runs the experiment, evaluates the gate, and
 * compares the verdict to the task's expectations. Returns a `GoldenTaskResult` with `failures` populated
 * when any expectation is not met.
 *
 * The runner does NOT touch the registry, the champion state, or the event bus. It is a pure function of
 * (task, seed, config) → result. Side effects (registry writes, event emission) are the caller's responsibility.
 */
export function runGoldenTask(
  task: GoldenTask,
  seed: StrategySpec<StructLiqSpecParams>,
  config: { trainDays?: number; testDays?: number; costs: { feeRate: number; slippageRate: number } },
): GoldenTaskResult {
  const started = Date.now();
  const failures: string[] = [];

  const ledger = task.ledger();
  const candidate = task.candidate(seed);
  const parent = task.parent ? task.parent(seed) : seed;
  const trainDays = task.trainDays ?? config.trainDays ?? 60;
  const testDays = task.testDays ?? config.testDays ?? 30;

  const result: ExperimentResult = runExperiment(candidate, parent, ledger, {
    trainDays,
    testDays,
    costs: config.costs,
    walkForwardTrainDays: 14,
    walkForwardTestDays: 7,
    walkForwardMinN: 10,
    bootstrap: { iterations: 1000, seed: 1, confidence: 0.9 },
  });

  const verdict: PromotionVerdict = evaluatePromotion(result, DEFAULT_PROMOTION_POLICY);

  // 1. Decision match
  if (verdict.decision !== task.expectedDecision) {
    failures.push(`decision: expected ${task.expectedDecision}, got ${verdict.decision}`);
  }

  // 2. Reason contains (case-insensitive substring)
  if (task.expectedReasonContains) {
    const reasonsLower = verdict.reasons.map((r) => r.toLowerCase());
    for (const needle of task.expectedReasonContains) {
      if (!reasonsLower.some((r) => r.includes(needle.toLowerCase()))) {
        failures.push(`reason missing "${needle}"; got: ${verdict.reasons.join(' | ')}`);
      }
    }
  }

  // 3. Reason NOT contains
  if (task.expectedReasonNotContains) {
    const reasonsLower = verdict.reasons.map((r) => r.toLowerCase());
    for (const forbidden of task.expectedReasonNotContains) {
      if (reasonsLower.some((r) => r.includes(forbidden.toLowerCase()))) {
        failures.push(`reason should not contain "${forbidden}"; got: ${verdict.reasons.join(' | ')}`);
      }
    }
  }

  // 4. Minimum test-window n
  if (task.minTestN !== undefined && result.test.n < task.minTestN) {
    failures.push(`test n ${result.test.n} < min ${task.minTestN}`);
  }

  // 5. Minimum walk-forward folds
  if (task.minWalkForwardFolds !== undefined && result.walkForward.folds < task.minWalkForwardFolds) {
    failures.push(`walk-forward folds ${result.walkForward.folds} < min ${task.minWalkForwardFolds}`);
  }

  return {
    taskId: task.id,
    description: task.description,
    pass: failures.length === 0,
    durationMs: Date.now() - started,
    actualDecision: verdict.decision,
    actualReasons: verdict.reasons,
    actualTestN: result.test.n,
    actualWalkForwardFolds: result.walkForward.folds,
    failures,
  };
}

/**
 * Run a full golden suite. Returns a `GoldenSuiteReport` with per-task results and aggregate counts.
 * The report is suitable for printing (CLI) or asserting on (tests).
 */
export function runGoldenSuite(
  tasks: readonly GoldenTask[],
  seed: StrategySpec<StructLiqSpecParams>,
  config: { trainDays?: number; testDays?: number; costs: { feeRate: number; slippageRate: number } },
): GoldenSuiteReport {
  const started = Date.now();
  const results = tasks.map((t) => runGoldenTask(t, seed, config));
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    durationMs: Date.now() - started,
    results,
  };
}

/** Render a `GoldenSuiteReport` as a human-readable string. */
export function formatGoldenReport(report: GoldenSuiteReport): string {
  const lines: string[] = [];
  lines.push(`=== Golden task suite: ${report.passed}/${report.total} passed, ${report.failed} failed (${report.durationMs}ms) ===`);
  lines.push('');
  for (const r of report.results) {
    const status = r.pass ? '✔' : '✖';
    lines.push(`${status} ${r.taskId} — ${r.description} (${r.durationMs}ms)`);
    lines.push(`    verdict: ${r.actualDecision}, n=${r.actualTestN}, wf folds=${r.actualWalkForwardFolds}`);
    if (r.failures.length > 0) {
      lines.push(`    failures:`);
      for (const f of r.failures) lines.push(`      - ${f}`);
    }
  }
  return lines.join('\n');
}
