/**
 * Regime-conditional expectancy with an out-of-sample check.
 *
 *   npx tsx scripts/conditional-edge.ts [--decisions data/decisions.jsonl[,more.jsonl]] [--dims strategy,regime,phase]
 *                                       [--min-n 30] [--alpha 0.05] [--train-days 60] [--test-days 15] [--step-days 15]
 *                                       [--iterations 5000] [--seed 1] [--fee 0.0004] [--slippage 0.0002]
 *
 * Input: any decision journal with outcomes — a backtest journal (scripts/backtest.ts --decisions ...) or the hypothetical
 * outcomes of every idea, rejected ones included (scripts/replay-decisions.ts --write-hypothetical ...).
 * Records written before decisions carried a market context group under regime/phase UNKNOWN.
 *
 * Read the walk-forward line first. The in-sample matrix is a map of where to look; only a positive out-of-sample lower
 * bound says that choosing slices by their history would have paid on data the choice never saw.
 */
import { config } from '../src/config.js';
import { loadDecisionFiles } from '../src/decision/loadDecisionFiles.js';
import type { BootstrapSummary } from '../src/research/Bootstrap.js';
import { conditionalMatrix, observationsOf, walkForward, type Dimension } from '../src/research/ConditionalEdge.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const num = (name: string, fallback: number): number => {
  const v = Number(arg(name, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a non-negative number`);
  return v;
};
const DIMENSIONS: readonly Dimension[] = ['strategy', 'regime', 'phase', 'side', 'symbol'];
const dims = arg('dims', 'strategy,regime,phase').split(',').map((d) => d.trim()) as Dimension[];
for (const d of dims) if (!DIMENSIONS.includes(d)) throw new Error(`--dims: unknown dimension "${d}" (use ${DIMENSIONS.join(', ')})`);

const file = arg('decisions', config.decisionsPath);
const costs = { feeRate: num('fee', config.risk.takerFeeRate), slippageRate: num('slippage', config.risk.slippageBufferRate) };
const boot = { iterations: num('iterations', 5000), seed: num('seed', 1), confidence: 0.9 };
const minN = num('min-n', 30);
const alpha = num('alpha', 0.05);

const records = loadDecisionFiles(file);
const obs = observationsOf(records, dims, costs);
const withContext = records.filter((r) => r.context).length;
console.log(`decisions ${records.length} · with outcome ${obs.length} · with market context ${withContext} · dims ${dims.join(' × ')}`);
if (obs.length === 0) { console.log('nothing to analyse: no decision has an outcome'); process.exit(0); }
const days = (obs[obs.length - 1].t - obs[0].t) / 86_400_000;
console.log(`span ${new Date(obs[0].t).toISOString().slice(0, 10)} → ${new Date(obs[obs.length - 1].t).toISOString().slice(0, 10)} (${days.toFixed(0)} days) · costs ${(costs.feeRate * 1e4).toFixed(1)} + ${(costs.slippageRate * 1e4).toFixed(1)} bps per leg\n`);

const f = (x: number | null | undefined, d = 3): string => (x === null || x === undefined || !Number.isFinite(x) ? '   n/a' : x.toFixed(d).padStart(6));
const line = (s: BootstrapSummary): string =>
  `n=${String(s.n).padStart(4)} days=${String(s.clusters).padStart(3)}  mean ${f(s.mean)}R  median ${f(s.median)}R  90% CI [${f(s.ciLow)}, ${f(s.ciHigh)}]  P(E>0) ${f(s.probPositive, 2)}  p ${f(s.pValue, 4)}  tails ${f(s.p05, 2)} / ${f(s.p95, 2)}`;

const matrix = conditionalMatrix(obs, { ...boot, minN, alpha });
console.log(`IN-SAMPLE MATRIX · ${matrix.tested} cells with n >= ${minN} tested · Holm family-wise alpha ${alpha}`);
for (const c of matrix.cells) {
  const label = c.key.padEnd(48);
  if (!c.stats) { console.log(`  ${label} n=${String(c.n).padStart(4)}  (thin, not tested)`); continue; }
  console.log(`  ${label} ${line(c.stats)}${c.significant ? '  ✓ survives Holm' : ''}`);
}

const trainDays = num('train-days', 60);
const testDays = num('test-days', 15);
const wf = walkForward(obs, { ...boot, trainDays, testDays, stepDays: num('step-days', testDays), minN });
console.log(`\nWALK-FORWARD · select cells with train lower bound > 0 on ${trainDays}d, trade them on the next ${testDays}d`);
if (wf.folds.length === 0) console.log(`  no fold fits: the journal spans ${days.toFixed(0)} days, a fold needs more than ${trainDays}`);
for (const fold of wf.folds) {
  const d = (t: number): string => new Date(t).toISOString().slice(0, 10);
  console.log(`  train ${d(fold.trainFrom)}→${d(fold.trainTo)} test →${d(fold.testTo)}  selected ${fold.selected.length ? fold.selected.join('; ') : '—'}  test n=${fold.testN} mean ${f(fold.testMeanR)}R  (all n=${fold.baselineN} mean ${f(fold.baselineMeanR)}R)`);
}
console.log(`  OUT-OF-SAMPLE selected: ${wf.outOfSample ? line(wf.outOfSample) : 'no trades selected'}`);
console.log(`  OUT-OF-SAMPLE all:      ${wf.baseline ? line(wf.baseline) : 'no test trades'}`);
const verdict = wf.outOfSample && wf.outOfSample.n >= minN && wf.outOfSample.ciLow > 0
  ? 'conditional selection held up out of sample — a lead to forward-test, not an approval (see scripts/live-readiness.ts)'
  : 'no conditional edge demonstrated out of sample';
console.log(`\nVERDICT: ${verdict}`);
console.log('Clusters are UTC days (same-day trades resample together). Hypothetical outcomes assume fills at the quoted entry.');
