/**
 * Research dashboard CLI — renders a single-screen TUI summary of the research plane.
 *
 *   npx tsx scripts/research-dashboard.ts [--width N] [--data-dir PATH]
 *
 * Reads the persistent state files from data/ and prints a formatted dashboard:
 *   - Champion + active challengers panel
 *   - Metrics panel (iterations, experiments, promotion rate, routing)
 *   - Recent experiments table (last 10, with verdicts + deltas)
 *   - Event activity sparkline (events per day)
 *
 * The dashboard is read-only — it renders state, it doesn't drive the loop.
 * Run the loop with `npm run self-improve`; view the results with `npm run research:dashboard`.
 */

import { renderDashboard } from '../src/ui/researchDashboard.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main(): void {
  const width = Number(arg('width', String(process.stdout.columns ?? 120)));
  const dataDir = arg('data-dir', 'data');
  const lines = renderDashboard({ width, dataDir });
  for (const line of lines) console.log(line);
}

main();
