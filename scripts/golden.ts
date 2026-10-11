/**
 * Golden task suite CLI — runs the regression suite and prints the report.
 *
 *   npx tsx scripts/golden.ts [--tag <tag>] [--task <id>] [--json]
 *
 * Flags:
 *   --tag <tag>   Only run tasks with this tag (e.g. 'gate', 'reject', 'promote', 'thin').
 *   --task <id>   Only run the task with this id (e.g. 'gate-promote-001').
 *   --json        Output the report as JSON instead of human-readable text.
 *
 * Exit code: 0 if all tasks pass, 1 if any fail. CI-friendly.
 *
 * The suite is pure: no registry writes, no event emission, no LLM calls. It runs the in-memory
 * ExperimentRunner + PromotionGate against synthetic ledgers. Total runtime ~100ms.
 */

import { GOLDEN_TASKS, goldenSeed } from '../src/research/defineGoldenTasks.js';
import { runGoldenSuite, formatGoldenReport, type GoldenSuiteReport } from '../src/research/GoldenTasks.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main(): void {
  const tagFilter = arg('tag', '');
  const taskFilter = arg('task', '');
  const json = flag('json');

  let tasks = GOLDEN_TASKS;
  if (tagFilter) tasks = tasks.filter((t) => t.tags.includes(tagFilter));
  if (taskFilter) tasks = tasks.filter((t) => t.id === taskFilter);

  if (tasks.length === 0) {
    console.error(`No golden tasks matched (tag=${tagFilter || '∅'}, task=${taskFilter || '∅'}).`);
    console.error(`Available tags: ${[...new Set(GOLDEN_TASKS.flatMap((t) => t.tags))].sort().join(', ')}`);
    console.error(`Available ids: ${GOLDEN_TASKS.map((t) => t.id).join(', ')}`);
    process.exit(2);
  }

  const seed = goldenSeed();
  const config = { trainDays: 60, testDays: 30, costs: { feeRate: 0.0004, slippageRate: 0.0002 } };
  const report: GoldenSuiteReport = runGoldenSuite(tasks, seed, config);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatGoldenReport(report));
  }

  process.exit(report.failed > 0 ? 1 : 0);
}

main();
