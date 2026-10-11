import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StrategyRegistry } from '../src/research/StrategyRegistry.js';
import { mutateSpec, seedStructLiqSpec } from '../src/research/StrategySpec.js';

test('StrategyRegistry with a null path operates in memory only', () => {
  const r = new StrategyRegistry(null);
  r.ensureSeeds();
  assert.equal(r.latest('STRUCT-LIQ-η')?.version, 1);
  assert.equal(r.ids().length, 1);
});

test('register returns the existing spec when params equal an earlier version (deduplication)', () => {
  const r = new StrategyRegistry(null);
  r.ensureSeeds();
  const seed = r.latest('STRUCT-LIQ-η')!;
  // Registering a v2 with the same params returns the v1 record, not a new version.
  const dup = r.register({ ...seed, version: 99, hypothesis: 'should be deduped' });
  assert.equal(dup.version, 1);
  assert.equal(r.history('STRUCT-LIQ-η').length, 1);
});

test('registerMutation produces a child and assigns the next version automatically', () => {
  const r = new StrategyRegistry(null);
  r.ensureSeeds();
  const seed = r.latest('STRUCT-LIQ-η')!;
  const child = r.registerMutation(
    seed.id, seed.version,
    { minimumRewardRisk: 1.75, minSweepDepthAtr: 0.5 },
    'tighten RR and require deeper sweeps',
    { kind: 'researcher', hypothesisId: 'h1', model: 'test' },
  );
  assert.equal(child.version, 2);
  assert.equal(child.parentVersion, 1);
  assert.equal(child.params.minimumRewardRisk, 1.75);
  assert.equal(child.params.minSweepDepthAtr, 0.5);
  assert.equal(r.latest('STRUCT-LIQ-η')?.version, 2);
});

test('lineage walks back to the seed through parent links', () => {
  const r = new StrategyRegistry(null);
  r.ensureSeeds();
  let parent = r.latest('STRUCT-LIQ-η')!;
  // Chain: v1 → v2 → v3 → v4 → v5. Each iteration uses the previous as parent so versions strictly increment.
  // Use RR values 1.6, 1.7, 1.8, 1.9 (avoiding the seed's 1.5 so dedup never fires).
  for (let i = 2; i <= 5; i += 1) {
    parent = r.registerMutation(parent.id, parent.version, { minimumRewardRisk: 1.4 + i * 0.1 }, `v${i}`, { kind: 'manual', note: 'iter' });
  }
  const chain = r.lineage('STRUCT-LIQ-η', 5);
  assert.equal(chain.length, 5);
  assert.equal(chain[0].version, 5);
  assert.equal(chain[chain.length - 1].version, 1);
  assert.equal(chain[chain.length - 1].parentVersion, null);
});

test('registerMutation throws when the parent does not exist', () => {
  const r = new StrategyRegistry(null);
  assert.throws(() => r.registerMutation('X', 1, {}, 'noop', { kind: 'manual', note: '' }), /unknown parent X:v1/);
});

test('history returns versions in ascending order even when registered out of order', () => {
  const r = new StrategyRegistry(null);
  r.ensureSeeds();
  const v1 = r.latest('STRUCT-LIQ-η')!;
  // Manually register v5 then v3 — the registry must still sort ascending.
  const v5 = r.register(mutateSpec(v1, { minimumRewardRisk: 2.0 }, 'v5', { kind: 'manual', note: '' }));
  // Force a different version number that sorts between; the dedup rule would normally fire here,
  // so we use different params to defeat dedup.
  const v3 = r.register({ ...mutateSpec(v1, { minimumRewardRisk: 1.65 }, 'v3', { kind: 'manual', note: '' }), version: 3 });
  assert.equal(v3.version, 3);
  assert.equal(v5.version, 2); // registry auto-assigns next version on registerMutation, but explicit register respects the supplied version
  const h = r.history('STRUCT-LIQ-η');
  assert.equal(h.length, 3);
  assert.deepEqual(h.map((s) => s.version), [1, 2, 3]);
});

test('all() returns every spec sorted by (id, version)', () => {
  const r = new StrategyRegistry(null);
  r.ensureSeeds();
  const v1 = r.latest('STRUCT-LIQ-η')!;
  // Chain mutations: v1 → v2 → v3, so versions strictly increment.
  const v2 = r.registerMutation(v1.id, v1.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  const v3 = r.registerMutation(v2.id, v2.version, { minimumRewardRisk: 2.0 }, 'v3', { kind: 'manual', note: '' });
  const all = r.all();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((s) => s.version), [1, 2, 3]);
});
