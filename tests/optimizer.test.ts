import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  randomSearch,
  gridSearch,
  tpeLike,
  childFromSample,
  STRUCT_LIQ_PARAMETER_SPACE,
  type HistoricalObservation,
} from '../src/research/Optimizer.js';
import { seedStructLiqSpec, type StructLiqSpecParams } from '../src/research/StrategySpec.js';

test('randomSearch produces n samples, each within each parameter range', () => {
  const samples = randomSearch(STRUCT_LIQ_PARAMETER_SPACE, 10, 42);
  assert.equal(samples.length, 10);
  for (const s of samples) {
    for (const space of STRUCT_LIQ_PARAMETER_SPACE) {
      const v = (s.params as Record<string, number>)[space.name];
      assert.ok(v >= space.low && v <= space.high, `${space.name}=${v} out of [${space.low}, ${space.high}]`);
      assert.equal(s.provenance.optimizer, 'random');
    }
  }
});

test('randomSearch is deterministic given the same seed', () => {
  const a = randomSearch(STRUCT_LIQ_PARAMETER_SPACE, 5, 7);
  const b = randomSearch(STRUCT_LIQ_PARAMETER_SPACE, 5, 7);
  assert.deepEqual(a, b);
});

test('gridSearch produces the cartesian product of every parameter grid', () => {
  const small = STRUCT_LIQ_PARAMETER_SPACE.slice(0, 2); // 6 x 5 = 30
  const samples = gridSearch(small);
  assert.equal(samples.length, 30);
  for (const s of samples) {
    assert.equal(s.provenance.optimizer, 'grid');
  }
});

test('gridSearch throws when a parameter lacks a grid', () => {
  const noGrid = [{ name: 'minimumRewardRisk', low: 1, high: 2 } as const];
  assert.throws(() => gridSearch(noGrid as never), /gridSearch requires a discrete grid/);
});

test('tpeLike falls back to uniform random when no history is supplied', () => {
  const samples = tpeLike(STRUCT_LIQ_PARAMETER_SPACE.slice(0, 2), 5, []);
  assert.equal(samples.length, 5);
  for (const s of samples) {
    assert.equal(s.provenance.optimizer, 'tpe');
  }
});

test('tpeLike concentrates samples around the elite set when history is supplied', () => {
  // Seed history with one elite at minimumRewardRisk=2.0 and others scattered.
  const history: HistoricalObservation<StructLiqSpecParams>[] = [
    { params: { minimumRewardRisk: 2.0 }, oosMeanR: 0.5 },
    { params: { minimumRewardRisk: 1.0 }, oosMeanR: -0.5 },
    { params: { minimumRewardRisk: 1.5 }, oosMeanR: 0.0 },
    { params: { minimumRewardRisk: 1.25 }, oosMeanR: -0.2 },
  ];
  const samples = tpeLike(STRUCT_LIQ_PARAMETER_SPACE.slice(0, 1), 50, history, { seed: 1 });
  // The elite (top 25%) is the RR=2.0 sample; TPE should sample around it.
  const values = samples.map((s) => s.params.minimumRewardRisk!);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // Mean should pull toward 2.0, not the population center of 1.4375.
  assert.ok(mean > 1.5, `TPE mean ${mean} should pull toward the elite (2.0)`);
});

test('childFromSample produces a child spec with the sample params layered over the parent', () => {
  const parent = seedStructLiqSpec();
  const sample = { params: { minimumRewardRisk: 1.75 }, provenance: { optimizer: 'random' as const, iteration: 3 } };
  const child = childFromSample(parent, sample, 'random sample at iteration 3');
  assert.equal(child.version, parent.version + 1);
  assert.equal(child.parentVersion, parent.version);
  assert.equal(child.params.minimumRewardRisk, 1.75);
  // Untouched parameters inherit.
  assert.equal(child.params.maxSweepAgeCandles, parent.params.maxSweepAgeCandles);
  assert.equal(child.provenance.kind, 'optimizer');
  assert.equal(child.provenance.optimizer, 'random');
});

test('STRUCT_LIQ_PARAMETER_SPACE covers every tunable StructLiqSpecParams field', () => {
  const tunableNames = new Set(STRUCT_LIQ_PARAMETER_SPACE.map((s) => s.name));
  const expected = ['minimumRewardRisk', 'maxSweepAgeCandles', 'minBreakDistanceAtr', 'stopBufferAtr', 'minStopAtr', 'maxStopAtr', 'minSweepDepthAtr', 'minSweepDisplacementAtr'];
  for (const name of expected) {
    assert.ok(tunableNames.has(name as keyof StructLiqSpecParams & string), `missing tunable: ${name}`);
  }
});
