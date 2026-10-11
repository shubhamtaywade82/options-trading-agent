import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mutateSpec,
  paramsEqual,
  seedStructLiqSpec,
  specId,
  type StructLiqSpecParams,
} from '../src/research/StrategySpec.js';

test('seedStructLiqSpec produces v1 with no parent and default thresholds', () => {
  const seed = seedStructLiqSpec();
  assert.equal(seed.id, 'STRUCT-LIQ-η');
  assert.equal(seed.version, 1);
  assert.equal(seed.parentVersion, null);
  assert.equal(seed.family, 'STRUCT-LIQ');
  assert.equal(seed.params.minimumRewardRisk, 1.50);
  assert.equal(seed.params.maxSweepAgeCandles, 6);
  assert.equal(seed.params.minSweepDepthAtr, 0);
  assert.equal(seed.provenance.kind, 'seed');
});

test('specId formats id:version pairs', () => {
  assert.equal(specId({ id: 'STRUCT-LIQ-η', version: 17 }), 'STRUCT-LIQ-η:v17');
  assert.equal(specId({ id: 'X', version: 1 }), 'X:v1');
});

test('paramsEqual returns true for identical params and false for any field difference', () => {
  const a = seedStructLiqSpec().params;
  const b = { ...a };
  assert.ok(paramsEqual(a, b));
  const c = { ...a, minimumRewardRisk: 1.75 };
  assert.ok(!paramsEqual(a, c));
  // Different key sets are unequal even if overlapping keys match.
  const d = { minimumRewardRisk: 1.5 } as unknown as StructLiqSpecParams;
  assert.ok(!paramsEqual(a, d));
});

test('mutateSpec produces a child with parent+1 version and parent reference, and does not mutate the parent', () => {
  const parent = seedStructLiqSpec();
  const child = mutateSpec(
    parent,
    { minimumRewardRisk: 1.75, minSweepDepthAtr: 0.5 },
    'Test hypothesis: tighten RR and require deeper sweeps',
    { kind: 'researcher', hypothesisId: 'h-test', model: 'test-model' },
    ['TREND_UP | COMPRESSED | LONG'],
  );
  assert.equal(child.version, parent.version + 1);
  assert.equal(child.parentVersion, parent.version);
  assert.equal(child.params.minimumRewardRisk, 1.75);
  assert.equal(child.params.minSweepDepthAtr, 0.5);
  // Parent is untouched.
  assert.equal(parent.params.minimumRewardRisk, 1.50);
  assert.equal(parent.version, 1);
  assert.deepEqual(child.motivatedBy, ['TREND_UP | COMPRESSED | LONG']);
  assert.equal(child.provenance.kind, 'researcher');
});

test('mutateSpec preserves the parent id and family', () => {
  const parent = seedStructLiqSpec();
  const child = mutateSpec(parent, { minimumRewardRisk: 2.0 }, 'raise RR', { kind: 'manual', note: 'op' });
  assert.equal(child.id, parent.id);
  assert.equal(child.family, parent.family);
});
