import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChampionRegistry } from '../src/research/ChampionRegistry.js';
import { StrategyRegistry } from '../src/research/StrategyRegistry.js';
import { mutateSpec, seedStructLiqSpec, type StructLiqSpecParams } from '../src/research/StrategySpec.js';

function fixture() {
  const strategies = new StrategyRegistry(null);
  strategies.ensureSeeds();
  const champions = new ChampionRegistry(null);
  return { strategies, champions };
}

test('appoint sets a champion; champion() resolves it', () => {
  const { strategies, champions } = fixture();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed, 'seed appointment');
  const champion = champions.champion('STRUCT-LIQ-η');
  assert.equal(champion?.version, 1);
  assert.equal(champion?.note, 'seed appointment');
});

test('stageChallenger adds a SHADOW challenger; transition walks SHADOW → PAPER → CANARY → PROMOTED', () => {
  const { strategies, champions } = fixture();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  const candidate = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  champions.stageChallenger(candidate);
  assert.equal(champions.challengersFor('STRUCT-LIQ-η').length, 1);
  assert.equal(champions.challengersFor('STRUCT-LIQ-η')[0].stage, 'SHADOW');

  champions.transition('STRUCT-LIQ-η', candidate.version, 'PAPER');
  assert.equal(champions.challengersFor('STRUCT-LIQ-η')[0].stage, 'PAPER');

  champions.transition('STRUCT-LIQ-η', candidate.version, 'CANARY');
  assert.equal(champions.challengersFor('STRUCT-LIQ-η')[0].stage, 'CANARY');

  champions.transition('STRUCT-LIQ-η', candidate.version, 'PROMOTED', 'experiment promoted', 'exp-1');
  assert.equal(champions.champion('STRUCT-LIQ-η')?.version, candidate.version);
  assert.equal(champions.champion('STRUCT-LIQ-η')?.promotedBy, 'exp-1');
  // Prior champion is now FORMER.
  const former = champions.snapshot().challengers.find((c) => c.stage === 'FORMER');
  assert.equal(former?.version, 1);
});

test('transition rejects skips (SHADOW → CANARY is not allowed)', () => {
  const { strategies, champions } = fixture();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  const candidate = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  champions.stageChallenger(candidate);
  assert.throws(() => champions.transition('STRUCT-LIQ-η', candidate.version, 'CANARY'), /Illegal challenger transition: SHADOW → CANARY/);
});

test('stageChallenger auto-REJECTS the previous SHADOW challenger when a new one is staged', () => {
  const { strategies, champions } = fixture();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  const v2 = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  champions.stageChallenger(v2);
  const v3 = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 2.0 }, 'v3', { kind: 'manual', note: '' });
  champions.stageChallenger(v3);
  const active = champions.challengersFor('STRUCT-LIQ-η');
  assert.equal(active.length, 1);
  assert.equal(active[0].version, v3.version);
  // v2 is preserved in the challenger list as REJECTED.
  const rejected = champions.snapshot().challengers.find((c) => c.id === 'STRUCT-LIQ-η' && c.version === v2.version);
  assert.equal(rejected?.stage, 'REJECTED');
});

test('rollback restores the previous champion and marks the failed one REJECTED', () => {
  const { strategies, champions } = fixture();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  const candidate = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  champions.stageChallenger(candidate);
  champions.transition('STRUCT-LIQ-η', candidate.version, 'PAPER');
  champions.transition('STRUCT-LIQ-η', candidate.version, 'CANARY');
  champions.transition('STRUCT-LIQ-η', candidate.version, 'PROMOTED');
  assert.equal(champions.champion('STRUCT-LIQ-η')?.version, candidate.version);

  const restored = champions.rollback('STRUCT-LIQ-η', 'canary failed');
  assert.equal(restored?.version, 1);
  assert.equal(champions.champion('STRUCT-LIQ-η')?.version, 1);
  const rejected = champions.snapshot().challengers.find((c) => c.id === 'STRUCT-LIQ-η' && c.version === candidate.version);
  assert.equal(rejected?.stage, 'REJECTED');
});

test('rollback returns undefined when there is no prior champion to restore', () => {
  const { strategies, champions } = fixture();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  assert.equal(champions.rollback('STRUCT-LIQ-η', 'nothing to roll back to'), undefined);
});

test('auditTrail records every transition in chronological order', () => {
  const { strategies, champions } = fixture();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  const candidate = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  champions.stageChallenger(candidate);
  champions.transition('STRUCT-LIQ-η', candidate.version, 'PROMOTED');
  const trail = champions.auditTrail();
  // Appoint, Stage, Promote.
  assert.ok(trail.length >= 3);
  assert.deepEqual(trail.map((t) => t.kind), ['APPOINT', 'STAGE', 'PROMOTE']);
});

test('championSpec resolves the spec from a StrategyRegistry', () => {
  const { strategies, champions } = fixture();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  const spec = champions.championSpec<StructLiqSpecParams>('STRUCT-LIQ-η', strategies);
  assert.equal(spec?.version, 1);
  assert.equal(spec?.family, 'STRUCT-LIQ');
});
