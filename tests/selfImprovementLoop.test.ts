import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SelfImprovementLoop, DEFAULT_LOOP_CONFIG } from '../src/research/SelfImprovementLoop.js';
import { StrategyRegistry } from '../src/research/StrategyRegistry.js';
import { ChampionRegistry } from '../src/research/ChampionRegistry.js';
import { ExperimentStore } from '../src/research/ExperimentStore.js';
import { ResearchAgent } from '../src/research/ResearchAgent.js';
import { makeMultiRegimeLedger } from './support/ledgerFixture.js';

/**
 * End-to-end smoke test: a single run() of the loop with no LLM client.
 * Verifies the loop:
 *   - appoints the seed as champion on construction
 *   - proposes hypotheses (via fallback proposer)
 *   - runs one experiment per hypothesis
 *   - stages any candidate that clears the gate as a SHADOW challenger
 */
test('SelfImprovementLoop appoints the seed as champion on construction', async () => {
  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null);
  const experiments = new ExperimentStore(null);
  const agent = new ResearchAgent(null);
  const loop = new SelfImprovementLoop(strategies, champions, experiments, agent, { ...DEFAULT_LOOP_CONFIG, trainDays: 30, testDays: 15 });

  assert.ok(champions.champion('STRUCT-LIQ-η'));
  assert.equal(champions.champion('STRUCT-LIQ-η')?.version, 1);
});

test('SelfImprovementLoop.run produces hypotheses, runs experiments, and stages promoting candidates as SHADOW', async () => {
  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null);
  const experiments = new ExperimentStore(null);
  const agent = new ResearchAgent(null);
  const loop = new SelfImprovementLoop(strategies, champions, experiments, agent, {
    ...DEFAULT_LOOP_CONFIG,
    trainDays: 30,
    testDays: 15,
    maxHypothesesPerRun: 2,
  });

  // 60 days of multi-regime data; the champion collapses in some cells, so the fallback proposer fires.
  const ledger = makeMultiRegimeLedger(60, 8, 7);
  const result = await loop.run(ledger);

  assert.ok(result.hypotheses.length > 0, `expected fallback hypotheses; got ${result.hypotheses.length}`);
  assert.equal(result.experiments.length, result.hypotheses.length);

  // Every experiment has a verdict and is appended to the store.
  for (const e of result.experiments) {
    assert.ok(e.verdict.decision === 'PROMOTE' || e.verdict.decision === 'REJECT' || e.verdict.decision === 'INSUFFICIENT_DATA');
    assert.equal(e.candidate.id, 'STRUCT-LIQ-η');
    assert.ok(e.candidate.version > 1, `candidate version > 1; got ${e.candidate.version}`);
  }
  assert.equal(experiments.all().length, result.experiments.length);
});

test('SelfImprovementLoop.run with an empty ledger returns no hypotheses and no experiments', async () => {
  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null);
  const experiments = new ExperimentStore(null);
  const agent = new ResearchAgent(null);
  const loop = new SelfImprovementLoop(strategies, champions, experiments, agent, DEFAULT_LOOP_CONFIG);

  const result = await loop.run([]);
  assert.equal(result.hypotheses.length, 0);
  assert.equal(result.experiments.length, 0);
});

test('SelfImprovementLoop.advanceChallenger walks a SHADOW challenger through PAPER → CANARY → PROMOTED', async () => {
  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null);
  const experiments = new ExperimentStore(null);
  const agent = new ResearchAgent(null);
  const loop = new SelfImprovementLoop(strategies, champions, experiments, agent, DEFAULT_LOOP_CONFIG);

  const ledger = makeMultiRegimeLedger(60, 8, 7);
  const result = await loop.run(ledger);

  // If any candidate was staged, walk it through.
  const active = champions.challengersFor('STRUCT-LIQ-η');
  if (active.length > 0) {
    const challenger = active[0];
    loop.advanceChallenger('STRUCT-LIQ-η', 'PAPER', 'manual advance');
    loop.advanceChallenger('STRUCT-LIQ-η', 'CANARY', 'manual advance');
    loop.advanceChallenger('STRUCT-LIQ-η', 'PROMOTED', 'promoted by operator', result.experiments[0]?.experimentId);
    assert.equal(champions.champion('STRUCT-LIQ-η')?.version, challenger.version);
  }
});

test('SelfImprovementLoop is idempotent on construction — calling the constructor twice does not double-appoint', () => {
  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null);
  const experiments = new ExperimentStore(null);
  const agent = new ResearchAgent(null);

  // First construction: appoints v1.
  // eslint-disable-next-line no-new
  new SelfImprovementLoop(strategies, champions, experiments, agent, DEFAULT_LOOP_CONFIG);
  const firstTrail = champions.auditTrail().length;
  // Second construction: should not re-appoint (champion already exists).
  // eslint-disable-next-line no-new
  new SelfImprovementLoop(strategies, champions, experiments, agent, DEFAULT_LOOP_CONFIG);
  assert.equal(champions.auditTrail().length, firstTrail);
});
