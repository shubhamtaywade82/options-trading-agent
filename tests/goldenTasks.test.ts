import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runGoldenTask,
  runGoldenSuite,
  formatGoldenReport,
  type GoldenTask,
} from '../src/research/GoldenTasks.js';
import { GOLDEN_TASKS, goldenSeed } from '../src/research/defineGoldenTasks.js';
import { mutateSpec } from '../src/research/StrategySpec.js';
import { makeLedger } from '../src/research/LedgerFixtures.js';

const CONFIG = { trainDays: 60, testDays: 30, costs: { feeRate: 0.0004, slippageRate: 0.0002 } };

test('GOLDEN_TASKS is non-empty and every task has a stable unique id', () => {
  assert.ok(GOLDEN_TASKS.length >= 5, `expected at least 5 golden tasks; got ${GOLDEN_TASKS.length}`);
  const ids = GOLDEN_TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'task ids must be unique');
  for (const t of GOLDEN_TASKS) {
    assert.match(t.id, /^[a-z-]+-\d+$/, `task id ${t.id} should match the category-number pattern`);
    assert.ok(t.tags.length > 0, `task ${t.id} should have at least one tag`);
  }
});

test('runGoldenTask returns a result with pass/fail, actualDecision, and durationMs', () => {
  const seed = goldenSeed();
  const task = GOLDEN_TASKS[0];
  const result = runGoldenTask(task, seed, CONFIG);
  assert.equal(result.taskId, task.id);
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0);
  assert.ok(['PROMOTE', 'REJECT', 'INSUFFICIENT_DATA'].includes(result.actualDecision));
  assert.ok(Array.isArray(result.actualReasons));
  assert.ok(Array.isArray(result.failures));
});

test('runGoldenSuite returns aggregate counts and per-task results', () => {
  const seed = goldenSeed();
  const report = runGoldenSuite(GOLDEN_TASKS, seed, CONFIG);
  assert.equal(report.total, GOLDEN_TASKS.length);
  assert.equal(report.passed + report.failed, report.total);
  assert.equal(report.results.length, GOLDEN_TASKS.length);
  assert.ok(report.durationMs >= 0);
});

test('formatGoldenReport produces a human-readable string with each task id and status', () => {
  const seed = goldenSeed();
  const report = runGoldenSuite(GOLDEN_TASKS, seed, CONFIG);
  const text = formatGoldenReport(report);
  assert.match(text, /Golden task suite:/);
  for (const t of GOLDEN_TASKS) {
    assert.ok(text.includes(t.id), `report should mention task ${t.id}`);
  }
  assert.match(text, /\d+\/\d+ passed/);
});

test('every golden task passes (the suite is green)', () => {
  // This is the actual regression check. If any task fails, the suite is broken and the operator must
  // investigate before merging changes to PromotionGate, ExperimentRunner, or StrategySpec.
  const seed = goldenSeed();
  const report = runGoldenSuite(GOLDEN_TASKS, seed, CONFIG);
  const failures = report.results.filter((r) => !r.pass);
  if (failures.length > 0) {
    const details = failures.map((f) => `${f.taskId}: ${f.failures.join('; ')}`).join('\n  ');
    assert.fail(`Golden suite has ${failures.length} failing task(s):\n  ${details}`);
  }
  assert.equal(report.failed, 0);
});

test('a custom task with a deliberately-wrong expectation fails (sanity check on the runner)', () => {
  // Build a task that expects PROMOTE on a candidate that obviously should REJECT (negative expectancy).
  // The runner must report the failure, not silently pass it.
  const seed = goldenSeed();
  const bogus: GoldenTask = {
    id: 'sanity-001',
    description: 'Sanity: expects PROMOTE on a negative-expectancy ledger (should fail)',
    tags: ['sanity'],
    ledger: () => makeLedger({
      n: 800, meanR: -0.5, noise: 0.2, spacing: 3 * 3_600_000,
      regime: 'TREND_UP', volatility: 'EXPANDED', direction: 'LONG',
      sweepDepthAtr: 0.8, rr: 1.8, seed: 99, idPrefix: 'sanity',
    }),
    candidate: () => mutateSpec(seed, { minimumRewardRisk: 1.5 }, 'seed params', { kind: 'manual', note: 'sanity' }),
    expectedDecision: 'PROMOTE',
  };
  const result = runGoldenTask(bogus, seed, CONFIG);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => /decision: expected PROMOTE, got REJECT/.test(f)));
});

test('a task with minTestN assertion fails when the actual n is below the floor', () => {
  const seed = goldenSeed();
  const task: GoldenTask = {
    id: 'min-n-001',
    description: 'minTestN check: a short ledger should fail the n>=30 floor',
    tags: ['sanity'],
    ledger: () => makeLedger({
      n: 5, meanR: 0.3, noise: 0.2, spacing: 3 * 3_600_000,
      regime: 'TREND_UP', volatility: 'EXPANDED', direction: 'LONG',
      sweepDepthAtr: 0.8, rr: 1.8, seed: 99, idPrefix: 'min-n',
    }),
    candidate: () => mutateSpec(seed, { minimumRewardRisk: 1.5 }, 'seed', { kind: 'manual', note: '' }),
    expectedDecision: 'INSUFFICIENT_DATA',
    minTestN: 30,
  };
  const result = runGoldenTask(task, seed, CONFIG);
  // The ledger is too short for even the train window; n=0, which is < 30, so the minTestN check fires
  // *in addition* to the INSUFFICIENT_DATA decision. The runner should report both.
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => /test n \d+ < min 30/.test(f)));
});
