/**
 * Calibrate per-strategy reward:risk floors from your own decision journal.
 *
 * Run locally where data/decisions.jsonl lives (--decisions accepts comma-separated files to pool, e.g. two backtest windows):
 *   npx tsx scripts/calibrate-rr.ts [--decisions data/decisions.jsonl] [--out data/rr-profile.json]
 *                                   [--min-samples 30] [--fee 0.0004] [--slippage 0.0002] [--write]
 *
 * Without --write it only prints the report. With --write it saves the profile that RR_PROFILE_PATH loads.
 * Nothing leaves your machine; share only the printed report if you want a second opinion.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { loadDecisionFiles } from '../src/decision/loadDecisionFiles.js';
import { calibrateRrFloors } from '../src/risk/rrProfile.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const number = (name: string, fallback: number): number => {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return value;
};

const decisionsPath = arg('decisions', config.decisionsPath);
const outPath = path.resolve(arg('out', 'data/rr-profile.json'));
const records = loadDecisionFiles(decisionsPath);
const report = calibrateRrFloors(records, {
  feeRate: number('fee', config.risk.takerFeeRate),
  slippageRate: number('slippage', config.risk.slippageBufferRate),
  minSamples: number('min-samples', 30),
});

const withOutcome = records.filter((r) => r.outcome).length;
console.log(`decisions: ${records.length} · executed with outcome: ${withOutcome} · file: ${decisionsPath}`);
for (const v of report.verdicts) {
  if (v.status === 'CALIBRATED') {
    console.log(`${v.strategy.padEnd(22)} CALIBRATED  minRr ${v.floor.minRr}  n=${v.floor.n}  netR ${v.floor.meanNetR.toFixed(3)}  lcb ${v.floor.lcbNetR.toFixed(3)}`);
  } else {
    const best = v.best ? `  best floor ${v.best.minRr}: n=${v.best.n} netR ${v.best.meanNetR.toFixed(3)} lcb ${v.best.lcbNetR.toFixed(3)}` : '';
    console.log(`${v.strategy.padEnd(22)} ${v.status}  sample=${v.sample}${best}`);
  }
}
console.log('\nOnly executed trades are observed; treat floors as candidates to paper-test, not proof.');

if (process.argv.includes('--write')) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report.profile, null, 2));
  console.log(`wrote ${outPath} — enable with RR_PROFILE_PATH=${outPath}`);
}
