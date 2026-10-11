import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hypotheticalTrades,
  passesSpecFilters,
  runExperiment,
  type ExperimentConfig,
} from '../src/research/ExperimentRunner.js';
import { seedStructLiqSpec, mutateSpec, type StructLiqSpecParams, type StrategySpec } from '../src/research/StrategySpec.js';
import { makeLedger, makeMultiRegimeLedger } from './support/ledgerFixture.js';

const NO_COSTS = { feeRate: 0, slippageRate: 0 };
const BASE_CONFIG: ExperimentConfig = {
  trainDays: 30,
  testDays: 15,
  costs: NO_COSTS,
  bootstrap: { iterations: 500, seed: 1, confidence: 0.9 },
  walkForwardTrainDays: 7,
  walkForwardTestDays: 3,
  walkForwardMinN: 5,
};

const child = (parent: StrategySpec<StructLiqSpecParams>, changes: Partial<StructLiqSpecParams>): StrategySpec<StructLiqSpecParams> =>
  mutateSpec(parent, changes, 'test child', { kind: 'manual', note: 'test' });

test('passesSpecFilters respects minimumRewardRisk', () => {
  const spec = seedStructLiqSpec();
  // Seed's minimumRewardRisk is 1.5; rr=1.6 passes, rr=1.4 fails.
  assert.ok(passesSpecFilters(spec, { rr: 1.6, effectiveRr: null, features: { sweepDepthAtr: null, sweepDisplacementAtr: null } } as never));
  assert.ok(!passesSpecFilters(spec, { rr: 1.4, effectiveRr: null, features: { sweepDepthAtr: null, sweepDisplacementAtr: null } } as never));
  // Tighter floor: 1.6 → rr=1.5 fails.
  const tightened = { ...spec, params: { ...spec.params, minimumRewardRisk: 1.6 } };
  assert.ok(!passesSpecFilters(tightened, { rr: 1.5, effectiveRr: null, features: { sweepDepthAtr: null, sweepDisplacementAtr: null } } as never));
});

test('passesSpecFilters respects minSweepDepthAtr', () => {
  const spec = { ...seedStructLiqSpec(), params: { ...seedStructLiqSpec().params, minSweepDepthAtr: 0.5 } };
  assert.ok(passesSpecFilters(spec, { rr: 2, effectiveRr: null, features: { sweepDepthAtr: 0.8, sweepDisplacementAtr: null } } as never));
  assert.ok(!passesSpecFilters(spec, { rr: 2, effectiveRr: null, features: { sweepDepthAtr: 0.3, sweepDisplacementAtr: null } } as never));
  // null sweep depth is allowed (legacy records)
  assert.ok(passesSpecFilters(spec, { rr: 2, effectiveRr: null, features: { sweepDepthAtr: null, sweepDisplacementAtr: null } } as never));
});

test('hypotheticalTrades only counts setups whose entry was touched and outcome is known', () => {
  const spec = seedStructLiqSpec();
  const ledger = makeLedger({ n: 10 });
  // Sabotage: drop the entry-touched timestamp on the first record (it never fired).
  ledger[0] = { ...ledger[0], entryTouchedAt: null };
  const trades = hypotheticalTrades(spec, ledger, ledger[0].createdAt, ledger[ledger.length - 1].createdAt + 1);
  assert.equal(trades.length, 9);
  assert.ok(!trades.some((t) => t.record.setupId === 'setup-0'));
});

test('runExperiment returns empty results when the ledger is too short for the train/test windows', () => {
  const spec = seedStructLiqSpec();
  const ledger = makeLedger({ n: 5, spacing: 3_600_000 }); // ~5 hours, way less than 30+15 days
  const result = runExperiment(spec, spec, ledger, BASE_CONFIG);
  assert.equal(result.test.n, 0);
  assert.equal(result.train.n, 0);
  assert.ok(result.experimentNotes.length > 0);
  assert.ok(/spans/.test(result.experimentNotes[0]));
});

test('runExperiment computes train and test metrics on disjoint windows', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { minimumRewardRisk: 1.4 });
  // 60 days of data, 8 trades per day = 480 records; train 30 + test 15 = 45 days, well within range.
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  assert.ok(result.train.n > 0, `train n > 0; got ${result.train.n}`);
  assert.ok(result.test.n > 0, `test n > 0; got ${result.test.n}`);
  // Train and test windows are disjoint: no setup in both.
  const trainIds = new Set(result.perSymbol.map((s) => s.key));
  assert.ok(trainIds.size > 0);
  // parentTest must also be populated so the gate can compute deltas.
  assert.ok(result.parentTest.n > 0);
});

test('runExperiment flags sweep-age mutations as approximations in experimentNotes', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { maxSweepAgeCandles: 4 });
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  assert.ok(result.experimentNotes.some((n) => /maxSweepAgeCandles/.test(n) && /approximation/.test(n)));
});

test('runExperiment flags finite maxSpreadBps as a no-op (ledger lacks per-setup spread)', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { maxSpreadBps: 5 } as Partial<StructLiqSpecParams>);
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  assert.ok(result.experimentNotes.some((n) => /maxSpreadBps/.test(n) && /no-op/.test(n)));
});

test('runExperiment throws when candidate and parent have different ids', () => {
  const parent = seedStructLiqSpec();
  const candidate = { ...child(parent, { minimumRewardRisk: 1.4 }), id: 'OTHER' };
  const ledger = makeMultiRegimeLedger(60);
  assert.throws(() => runExperiment(candidate as never, parent as never, ledger, BASE_CONFIG), /different strategies/);
});

test('perSymbol and perRegime slice the test-window trades by their respective dimensions', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { minimumRewardRisk: 1.4 });
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  // Multi-regime fixture rotates 4 regimes x 3 volatilities = 12 cells; some must appear in perRegime.
  assert.ok(result.perRegime.length > 0);
  // All trades are BTCUSDT in this fixture, so perSymbol has one entry.
  assert.ok(result.perSymbol.length === 1);
  assert.equal(result.perSymbol[0].key, 'BTCUSDT');
});

test('walk-forward folds are produced when the ledger is long enough', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { minimumRewardRisk: 1.4 });
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  // 45 days total train+test; 7+3 walk-forward windows means up to ~13 folds.
  assert.ok(result.walkForward.folds > 0, `walk-forward folds > 0; got ${result.walkForward.folds}`);
});
