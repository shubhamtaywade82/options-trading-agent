import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JsonlEventSubscriber,
  ResearchEventBus,
  championAppointedPayload,
  challengerTransitionedPayload,
  experimentCompletedPayload,
  type ResearchEvent,
  type ResearchEventType,
} from '../src/research/Events.js';
import { ChampionRegistry } from '../src/research/ChampionRegistry.js';
import { StrategyRegistry } from '../src/research/StrategyRegistry.js';
import { seedStructLiqSpec, mutateSpec, type StructLiqSpecParams } from '../src/research/StrategySpec.js';
import { DEFAULT_PROMOTION_POLICY, type PromotionVerdict } from '../src/research/PromotionGate.js';
import type { ExperimentResult } from '../src/research/ExperimentRunner.js';

test('ResearchEventBus assigns monotonic seq to every published event', async () => {
  const bus = new ResearchEventBus();
  const e1 = await bus.publish({ type: 'champion_appointed', payload: { id: 'X', version: 1 } });
  const e2 = await bus.publish({ type: 'champion_appointed', payload: { id: 'X', version: 2, replacedVersion: 1 } });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.ok(e1.at <= e2.at, `e1.at (${e1.at}) should be <= e2.at (${e2.at})`);
  assert.equal(bus.currentSeq, 2);
});

test('ResearchEventBus notifies subscribers in subscription order', async () => {
  const bus = new ResearchEventBus();
  const calls: string[] = [];
  bus.subscribe((e) => { calls.push(`a:${e.type}:${e.seq}`); });
  bus.subscribe((e) => { calls.push(`b:${e.type}:${e.seq}`); });
  await bus.publish({ type: 'loop_iteration_started', payload: { championId: 'X', championVersion: 1, ledgerSize: 100 } });
  assert.deepEqual(calls, ['a:loop_iteration_started:1', 'b:loop_iteration_started:1']);
});

test('ResearchEventBus.publishSync invokes subscribers synchronously and waits for async ones', () => {
  const bus = new ResearchEventBus();
  const calls: number[] = [];
  bus.subscribe(() => { calls.push(1); });
  bus.subscribe(async () => { calls.push(2); });
  bus.subscribe(() => { calls.push(3); });
  const e = bus.publishSync({ type: 'champion_appointed', payload: { id: 'X', version: 1 } });
  // Synchronous subscribers ran before publishSync returned.
  assert.deepEqual(calls.slice(0, 2), [1, 2]); // [1, 2] ran sync; [3] may or may not have depending on async scheduling
  assert.equal(e.seq, 1);
});

test('ResearchEventBus.subscribe returns an unsubscribe function', async () => {
  const bus = new ResearchEventBus();
  const calls: number[] = [];
  const unsub = bus.subscribe((e) => { calls.push(e.seq); });
  await bus.publish({ type: 'champion_appointed', payload: { id: 'X', version: 1 } });
  assert.equal(calls.length, 1);
  unsub();
  await bus.publish({ type: 'champion_appointed', payload: { id: 'X', version: 2, replacedVersion: 1 } });
  assert.equal(calls.length, 1);
});

test('a throwing subscriber does not break later subscribers or the publisher', async () => {
  const bus = new ResearchEventBus();
  const calls: string[] = [];
  bus.subscribe(() => { throw new Error('subscriber boom'); });
  bus.subscribe((e) => { calls.push(`ok:${e.seq}`); });
  const e = await bus.publish({ type: 'champion_appointed', payload: { id: 'X', version: 1 } });
  assert.equal(e.seq, 1);
  assert.deepEqual(calls, ['ok:1']);
});

test('JsonlEventSubscriber with a null path is a no-op', () => {
  const sub = new JsonlEventSubscriber(null);
  // Just verify it returns a function that doesn't throw.
  const fn = sub.toSubscriber();
  fn({ seq: 1, at: Date.now(), type: 'champion_appointed', payload: { id: 'X', version: 1 } } as ResearchEvent);
});

test('ChampionRegistry with a bus emits events on every transition', () => {
  const bus = new ResearchEventBus();
  const events: ResearchEvent[] = [];
  bus.subscribe((e) => { events.push(e); });

  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null, bus);
  strategies.ensureSeeds();
  const seed = strategies.latest('STRUCT-LIQ-η')!;

  // appoint → champion_appointed
  champions.appoint(seed, 'seed appointment');
  // stageChallenger → challenger_staged
  const candidate = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  champions.stageChallenger(candidate, 'gate cleared');
  // transition SHADOW → PAPER → CANARY → PROMOTED → 3 challenger_transitioned events
  champions.transition('STRUCT-LIQ-η', candidate.version, 'PAPER');
  champions.transition('STRUCT-LIQ-η', candidate.version, 'CANARY');
  champions.transition('STRUCT-LIQ-η', candidate.version, 'PROMOTED');
  // rollback → champion_rolled_back
  champions.rollback('STRUCT-LIQ-η', 'canary failure');

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'champion_appointed',
    'challenger_staged',
    'challenger_transitioned',
    'challenger_transitioned',
    'challenger_transitioned',
    'champion_rolled_back',
  ]);
  // The challenger_transitioned events carry from/to:
  const transitions = events.filter((e) => e.type === 'challenger_transitioned') as Array<Extract<ResearchEvent, { type: 'challenger_transitioned' }>>;
  assert.deepEqual(transitions.map((e) => [e.payload.from, e.payload.to]), [
    ['SHADOW', 'PAPER'],
    ['PAPER', 'CANARY'],
    ['CANARY', 'PROMOTED'],
  ]);
  // The champion_rolled_back event carries the version change:
  const rollback = events.find((e) => e.type === 'champion_rolled_back') as Extract<ResearchEvent, { type: 'champion_rolled_back' }>;
  assert.equal(rollback.payload.fromVersion, candidate.version);
  assert.equal(rollback.payload.toVersion, seed.version);
});

test('ChampionRegistry without a bus still works (backward compatible)', () => {
  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null, null);
  strategies.ensureSeeds();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  // No throw, no events:
  champions.appoint(seed);
  assert.equal(champions.champion('STRUCT-LIQ-η')?.version, 1);
});

test('champion_appointed payload includes replacedVersion when an existing champion is replaced', () => {
  const bus = new ResearchEventBus();
  const events: ResearchEvent[] = [];
  bus.subscribe((e) => { events.push(e); });

  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null, bus);
  strategies.ensureSeeds();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed, 'first');
  const v2 = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  // Manually appoint v2 — emulates a second seed appointment (not the normal flow, but valid)
  champions.appoint(v2, 'second');
  const e = events.find((ev) => ev.type === 'champion_appointed' && ev.payload.version === 2) as Extract<ResearchEvent, { type: 'champion_appointed' }>;
  assert.equal(e.payload.replacedVersion, 1);
  assert.equal(e.payload.note, 'second');
});

test('challenger_staged payload includes supersededVersion when a prior shadow is replaced', () => {
  const bus = new ResearchEventBus();
  const events: ResearchEvent[] = [];
  bus.subscribe((e) => { events.push(e); });

  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null, bus);
  strategies.ensureSeeds();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  const v2 = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  champions.stageChallenger(v2);
  const v3 = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 2.0 }, 'v3', { kind: 'manual', note: '' });
  champions.stageChallenger(v3);

  const staged = events.filter((e) => e.type === 'challenger_staged') as Array<Extract<ResearchEvent, { type: 'challenger_staged' }>>;
  assert.equal(staged.length, 2);
  assert.equal(staged[0].payload.supersededVersion, undefined);
  assert.equal(staged[1].payload.supersededVersion, v2.version);
});

test('reachableFrom returns the set of stages reachable in one hop', () => {
  const champions = new ChampionRegistry(null, null);
  assert.deepEqual(champions.reachableFrom('SHADOW').sort(), ['PAPER', 'PROMOTED', 'REJECTED']);
  assert.deepEqual(champions.reachableFrom('PAPER').sort(), ['CANARY', 'PROMOTED', 'REJECTED']);
  assert.deepEqual(champions.reachableFrom('CANARY').sort(), ['PROMOTED', 'REJECTED']);
  assert.deepEqual(champions.reachableFrom('PROMOTED'), []);
  assert.deepEqual(champions.reachableFrom('REJECTED'), []);
});

test('canTransition returns true for legal moves and false for illegal ones', () => {
  const champions = new ChampionRegistry(null, null);
  assert.ok(champions.canTransition('SHADOW', 'PAPER'));
  assert.ok(champions.canTransition('SHADOW', 'PROMOTED'));
  assert.ok(!champions.canTransition('SHADOW', 'CANARY'));
  assert.ok(!champions.canTransition('PROMOTED', 'SHADOW'));
  assert.ok(!champions.canTransition('REJECTED', 'PROMOTED'));
});

test('experimentCompletedPayload extracts the verdict and key metrics from a result', () => {
  const candidate = mutateSpec(seedStructLiqSpec(), { minimumRewardRisk: 1.75 }, 'test', { kind: 'manual', note: '' });
  const result: ExperimentResult = {
    candidateId: candidate.id, candidateVersion: candidate.version,
    parentId: candidate.id, parentVersion: 1,
    train: { n: 100, winRate: 0.55, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 3, bootstrap: null },
    test: { n: 50, winRate: 0.55, meanNetR: 0.25, profitFactor: 1.4, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null },
    parentTrain: { n: 100, winRate: 0.5, meanNetR: 0.2, profitFactor: 1.3, maxDrawdownR: 6, symbols: 2, regimes: 3, bootstrap: null },
    parentTest: { n: 50, winRate: 0.5, meanNetR: 0.15, profitFactor: 1.2, maxDrawdownR: 7, symbols: 2, regimes: 3, bootstrap: null },
    walkForward: { outOfSample: null, baseline: null, folds: 5 },
    perSymbol: [{ key: 'BTCUSDT', n: 30, meanNetR: 0.3 }],
    perRegime: [{ key: 'TREND_UP | EXPANDED', n: 20, meanNetR: 0.4 }],
    experimentNotes: ['note 1'],
  };
  const verdict: PromotionVerdict = { decision: 'PROMOTE', reasons: ['r1'], policy: DEFAULT_PROMOTION_POLICY };
  const payload = experimentCompletedPayload('exp-1', candidate, result, verdict);
  assert.equal(payload.experimentId, 'exp-1');
  assert.equal(payload.decision, 'PROMOTE');
  assert.equal(payload.testN, 50);
  assert.equal(payload.testMeanR, 0.25);
  assert.equal(payload.parentTestMeanR, 0.15);
  assert.deepEqual(payload.experimentNotes, ['note 1']);
});

test('IllegalTransitionError is thrown for SHADOW → CANARY (skip) but NOT for SHADOW → PROMOTED (operator override)', () => {
  const bus = new ResearchEventBus();
  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null, bus);
  strategies.ensureSeeds();
  const seed = strategies.latest('STRUCT-LIQ-η')!;
  champions.appoint(seed);
  const candidate = strategies.registerMutation(seed.id, seed.version, { minimumRewardRisk: 1.75 }, 'v2', { kind: 'manual', note: '' });
  champions.stageChallenger(candidate);

  // SHADOW → CANARY throws (skip not allowed)
  assert.throws(() => champions.transition('STRUCT-LIQ-η', candidate.version, 'CANARY'), /Illegal challenger transition: SHADOW → CANARY/);
  // SHADOW → PROMOTED is allowed (operator override)
  champions.transition('STRUCT-LIQ-η', candidate.version, 'PROMOTED', 'operator override');
  assert.equal(champions.champion('STRUCT-LIQ-η')?.version, candidate.version);
});
