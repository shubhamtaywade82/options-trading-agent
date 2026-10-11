/**
 * Summarises one IST trading day of the journal for review.
 *
 *   npm run journal:summary                 # today's file in EVENT_LOG_DIR
 *   npm run journal:summary -- 2026-10-12   # a specific day
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journalFileName } from '../src/ops/eventLog.js';
import { summarizeJournal } from '../src/ops/journalSummary.js';
import { istParts } from '../src/time/ist.js';

async function main(): Promise<void> {
  const directory = process.env['EVENT_LOG_DIR']?.trim() || 'data/journal';
  const dayKey = process.argv[2] ?? istParts(Date.now()).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw new Error(`day must be YYYY-MM-DD, got "${dayKey}"`);
  }
  const path = join(directory, journalFileName(dayKey));
  const summary = summarizeJournal((await readFile(path, 'utf8')).split('\n'));
  console.log(`journal ${path}`);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.malformed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('fatal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
