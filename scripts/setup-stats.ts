/**
 * What did every setup actually do? Reads data/setup-outcomes.jsonl (written by the running agent, including
 * setups that were never traded) and reports hit-rate and net expectancy by kind, flow state, verdict and RR bucket.
 *
 * Run locally where the file lives:  npx tsx scripts/setup-stats.ts [--file data/setup-outcomes.jsonl] [--min 10]
 */
import path from 'node:path';
import { config } from '../src/config.js';
import { readFileSync, existsSync } from 'node:fs';
import { summarizeSetupOutcomes, type OutcomeGroup, type SetupOutcomeRecord } from '../src/learning/SetupOutcomeLedger.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const file = path.resolve(arg('file', config.setupOutcomesPath));
const minResolved = Number(arg('min', '10'));
const rows: SetupOutcomeRecord[] = [];
if (existsSync(file)) {
  const latest = new Map<string, SetupOutcomeRecord>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as SetupOutcomeRecord; if (r.setupId) latest.set(r.setupId, r); } catch { /* torn line */ }
  }
  rows.push(...latest.values());
}

const rrBucket = (r: SetupOutcomeRecord): string => {
  const v = r.effectiveRr ?? r.rr;
  return v < 1 ? '<1.0' : v < 1.5 ? '1.0-1.5' : v < 2 ? '1.5-2.0' : v < 3 ? '2.0-3.0' : '3.0+';
};

const cuts: [string, (r: SetupOutcomeRecord) => string][] = [
  ['kind', (r) => r.kind],
  ['kind × flow quadrant', (r) => `${r.kind} | ${r.features.quadrant ?? 'n/a'}`],
  ['verdict at creation', (r) => r.features.verdictAtCreation ?? 'n/a'],
  ['cost-adjusted RR bucket', rrBucket],
  ['kind × entry location', (r) => `${r.kind} | ${r.features.locationAtEntry ?? 'n/a'}`],
];

const fmt = (v: number | null, d = 2): string => (v === null ? '  —  ' : v.toFixed(d).padStart(6));
const print = (g: OutcomeGroup): void => {
  const flag = g.resolved < minResolved ? '  (thin)' : g.lcbNetR !== null && g.lcbNetR > 0 ? '  ✓ positive lower bound' : '';
  console.log(`  ${g.key.padEnd(40)} created ${String(g.created).padStart(4)}  filled ${String(g.filled).padStart(4)}  TP1 ${g.tp1Rate === null ? '  — ' : (g.tp1Rate * 100).toFixed(0).padStart(3) + '%'}  netR ${fmt(g.meanNetR)}  lcb ${fmt(g.lcbNetR)}${flag}`);
};

console.log(`setups: ${rows.length} · open/unresolved: ${rows.filter((r) => r.outcome === 'OPEN' || r.outcome === 'UNRESOLVED').length} · file: ${file}`);
for (const [title, keyOf] of cuts) {
  console.log(`\n${title}`);
  for (const g of summarizeSetupOutcomes(rows, keyOf)) print(g);
}
console.log('\nHypothetical outcomes use one mark per cycle (not tick data) against a conservative fill; treat as a screen, then confirm in paper.');
