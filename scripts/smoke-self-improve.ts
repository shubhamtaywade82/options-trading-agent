/**
 * Synthetic smoke test for the self-improve CLI: generates a temporary 60-day setup-outcome ledger,
 * then runs the loop with the deterministic fallback proposer. Verifies the CLI runs end-to-end without
 * an LLM and produces the expected output structure.
 *
 *   npx tsx scripts/smoke-self-improve.ts
 */
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { makeMultiRegimeLedger } from '../tests/support/ledgerFixture.js';

const TMP = path.resolve('tmp/smoke');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const ledgerPath = path.join(TMP, 'setup-outcomes.jsonl');
// 100 days so the default 60+30 train/test window fits with room to spare.
const ledger = makeMultiRegimeLedger(100, 8, 7);
writeFileSync(ledgerPath, ledger.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log(`Wrote ${ledger.length} synthetic setup outcomes to ${ledgerPath}`);

// The CLI hardcodes persistence paths under data/. We cd into TMP so the data/ dir lands there.
const out = execSync(`npx tsx ${path.resolve('scripts/self-improve.ts')} --ledger ${ledgerPath} --iters 1`, {
  cwd: TMP,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
console.log('=== CLI output ===');
console.log(out);

const experimentsPath = path.join(TMP, 'data/experiments.jsonl');
const experiments = existsSync(experimentsPath)
  ? readFileSync(experimentsPath, 'utf8').split('\n').filter(Boolean)
  : [];
console.log(`Experiments persisted: ${experiments.length}`);

const registryPath = path.join(TMP, 'data/strategy-registry.jsonl');
const registry = existsSync(registryPath)
  ? readFileSync(registryPath, 'utf8').split('\n').filter(Boolean)
  : [];
console.log(`Specs persisted: ${registry.length}`);

const championsPath = path.join(TMP, 'data/champion-registry.json');
const champions = existsSync(championsPath)
  ? JSON.parse(readFileSync(championsPath, 'utf8'))
  : { champions: [], challengers: [], history: [] };
console.log(`Champion history: ${champions.history?.length ?? 0} transitions`);
console.log(`Active challengers: ${champions.challengers?.filter((c: { stage: string }) => c.stage === 'SHADOW' || c.stage === 'PAPER' || c.stage === 'CANARY').length ?? 0}`);
