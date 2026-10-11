/**
 * Resets the drawdown baseline after the account has been more than MAX_DRAWDOWN_PCT below its stored peak
 * (every entry is refused with "drawdown kill-switch" until it recovers).
 *
 *   npx tsx scripts/reset-risk-hwm.ts                       # dry run for MODE (default paper)
 *   npx tsx scripts/reset-risk-hwm.ts --confirm             # back up data/risk-hwm.json and reset
 *   npx tsx scripts/reset-risk-hwm.ts --mode live --confirm --allow-live
 *   npx tsx scripts/reset-risk-hwm.ts --file path/to/risk-hwm.json
 *
 * Stop the agent first: it keeps the peak in memory and would write it back. This does not touch the trade journal
 * or the daily-loss / loss-streak limits.
 */
import path from 'node:path';
import { resetRiskBaseline } from '../src/risk/hwmReset.js';
import type { Mode } from '../src/types.js';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1]!.startsWith('--') ? args[index + 1]! : fallback;
};

const mode = value('mode', process.env.MODE ?? 'paper');
if (mode !== 'paper' && mode !== 'live') {
  console.error(`--mode must be paper or live (got "${mode}")`);
  process.exit(2);
}

const report = resetRiskBaseline({
  filePath: path.resolve(value('file', 'data/risk-hwm.json')),
  mode: mode as Mode,
  confirm: flag('confirm'),
  allowLive: flag('allow-live'),
});
for (const line of report.lines) console.log(line);
process.exit(report.status === 'REFUSED' ? 1 : 0);
