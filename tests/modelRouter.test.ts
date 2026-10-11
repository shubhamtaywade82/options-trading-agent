import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  scoreComplexity,
  ModelRouter,
  FixedModelRouter,
  DEFAULT_MODEL_ROUTER_CONFIG,
  DEFAULT_ESCALATION_THRESHOLD,
  type ModelRouterConfig,
} from '../src/research/ModelRouter.js';
import type { ResearchDiagnostics } from '../src/research/ResearchAgent.js';
import { seedStructLiqSpec } from '../src/research/StrategySpec.js';
import type { CellStat } from '../src/research/ConditionalEdge.js';
import type { ExperimentResult } from '../src/research/ExperimentRunner.js';

const cellStat = (key: string, mean: number, n: number): CellStat => ({
  key, n,
  stats: { n, clusters: 5, mean, median: mean, ciLow: mean - 0.1, ciHigh: mean + 0.1, probPositive: 0.9, pValue: 0.05, p05: mean - 0.5, p95: mean + 0.5 },
  significant: false,
});

const seedParams = seedStructLiqSpec().params;

const emptyResult: ExperimentResult = {
  candidateId: 'X', candidateVersion: 2,
  parentId: 'X', parentVersion: 1,
  train: { n: 100, winRate: 0.5, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 3, bootstrap: null },
  test: { n: 50, winRate: 0.5, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 3, bootstrap: null },
  parentTrain: { n: 100, winRate: 0.5, meanNetR: 0.2, profitFactor: 1.3, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null },
  parentTest: { n: 50, winRate: 0.5, meanNetR: 0.2, profitFactor: 1.2, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null },
  walkForward: { outOfSample: null, baseline: null, folds: 5 },
  perSymbol: [], perRegime: [], experimentNotes: [],
};

const coldStart: ResearchDiagnostics = {
  championId: 'STRUCT-LIQ-η', championVersion: 1,
  worstCells: [cellStat('TREND_UP | EXPANDED | LONG', -0.2, 30)],
  bestCells: [cellStat('TREND_UP | EXPANDED | LONG', 0.4, 30)],
  currentParams: seedParams,
};

// ─── scoreComplexity ───────────────────────────────────────────────────────

test('scoreComplexity returns 0..1 with reasons array and a recommendation', () => {
  const s = scoreComplexity(coldStart);
  assert.ok(s.score >= 0 && s.score <= 1);
  assert.ok(Array.isArray(s.reasons));
  assert.ok(s.recommendation === 'local' || s.recommendation === 'escalate');
});

test('scoreComplexity scores a cold-start (seed champion, no prior experiment) as low complexity', () => {
  const s = scoreComplexity(coldStart);
  assert.ok(s.score < DEFAULT_ESCALATION_THRESHOLD, `cold start should be < ${DEFAULT_ESCALATION_THRESHOLD}; got ${s.score}`);
  assert.equal(s.recommendation, 'local');
  assert.ok(s.reasons.some((r) => /cold start/.test(r)));
});

test('scoreComplexity scores many worst cells (>= 5) higher', () => {
  const d: ResearchDiagnostics = {
    ...coldStart,
    worstCells: Array.from({ length: 6 }, (_, i) => cellStat(`cell-${i}`, -0.2, 30)),
  };
  const s = scoreComplexity(d);
  assert.ok(s.reasons.some((r) => /6 worst cells/.test(r)));
});

test('scoreComplexity scores prior experiment existence higher', () => {
  const d: ResearchDiagnostics = {
    ...coldStart,
    lastExperiment: emptyResult,
  };
  const s = scoreComplexity(d);
  assert.ok(s.reasons.some((r) => /prior experiment/.test(r)));
});

test('scoreComplexity scores thin-sample last experiment higher', () => {
  const d: ResearchDiagnostics = {
    ...coldStart,
    lastExperiment: { ...emptyResult, test: { ...emptyResult.test, n: 15 } },
  };
  const s = scoreComplexity(d);
  assert.ok(s.reasons.some((r) => /thin sample/.test(r)));
});

test('scoreComplexity scores thin worst cells (n < 30, >= 2) higher', () => {
  const d: ResearchDiagnostics = {
    ...coldStart,
    worstCells: [cellStat('a', -0.2, 15), cellStat('b', -0.1, 20), cellStat('c', -0.3, 25)],
  };
  const s = scoreComplexity(d);
  assert.ok(s.reasons.some((r) => /worst cells with n < 30/.test(r)));
});

test('scoreComplexity clamps the score to [0, 1]', () => {
  // Build a diagnostics that maximizes every dimension — should clamp at 1.
  const d: ResearchDiagnostics = {
    ...coldStart,
    worstCells: Array.from({ length: 8 }, (_, i) => cellStat(`cell-${i}`, -0.2, 15)),
    bestCells: Array.from({ length: 6 }, (_, i) => cellStat(`best-${i}`, 0.4, 30)),
    lastExperiment: { ...emptyResult, test: { ...emptyResult.test, n: 10 } },
    // Use non-seed params so the cold-start reduction doesn't fire.
    currentParams: { ...seedParams, minSweepDepthAtr: 0.5 },
  };
  const s = scoreComplexity(d);
  assert.ok(s.score <= 1, `score should be <= 1; got ${s.score}`);
  assert.ok(s.score >= 0);
});

test('scoreComplexity is pure — same input produces same output', () => {
  const a = scoreComplexity(coldStart);
  const b = scoreComplexity(coldStart);
  assert.deepEqual(a, b);
});

// ─── ModelRouter ───────────────────────────────────────────────────────────

test('ModelRouter.decide returns the small model for low-complexity diagnostics', () => {
  const router = new ModelRouter(DEFAULT_MODEL_ROUTER_CONFIG);
  const choice = router.decide(coldStart);
  assert.equal(choice.kind, 'local');
  assert.equal(choice.model, DEFAULT_MODEL_ROUTER_CONFIG.smallModel);
});

test('ModelRouter.decide returns the large model for high-complexity diagnostics', () => {
  const router = new ModelRouter(DEFAULT_MODEL_ROUTER_CONFIG);
  const d: ResearchDiagnostics = {
    ...coldStart,
    worstCells: Array.from({ length: 8 }, (_, i) => cellStat(`cell-${i}`, -0.2, 15)),
    bestCells: Array.from({ length: 6 }, (_, i) => cellStat(`best-${i}`, 0.4, 30)),
    lastExperiment: { ...emptyResult, test: { ...emptyResult.test, n: 10 } },
    currentParams: { ...seedParams, minSweepDepthAtr: 0.5 },  // not seed → no cold-start reduction
  };
  const choice = router.decide(d);
  assert.equal(choice.kind, 'escalate');
  assert.equal(choice.model, DEFAULT_MODEL_ROUTER_CONFIG.largeModel);
});

test('ModelRouter.decide respects a custom threshold', () => {
  // A very low threshold (0.05) means even a low-but-nonzero score escalates.
  // Use 3 worst cells (gives +0.10) with seed params but no prior experiment.
  // Cold-start reduction (-0.15) → score = max(0, 0.10 - 0.15) = 0. That's still local.
  // So use non-seed params to avoid the cold-start reduction.
  const d: ResearchDiagnostics = {
    ...coldStart,
    worstCells: [cellStat('a', -0.2, 30), cellStat('b', -0.2, 30), cellStat('c', -0.2, 30)],
    currentParams: { ...seedParams, minSweepDepthAtr: 0.5 },  // not seed → no cold-start reduction
  };
  const config: ModelRouterConfig = { ...DEFAULT_MODEL_ROUTER_CONFIG, threshold: 0.05 };
  const router = new ModelRouter(config);
  const choice = router.decide(d);
  assert.equal(choice.kind, 'escalate');
});

test('ModelRouter.score returns the same ComplexityScore as scoreComplexity', () => {
  const router = new ModelRouter(DEFAULT_MODEL_ROUTER_CONFIG);
  const s = router.score(coldStart);
  assert.deepEqual(s, scoreComplexity(coldStart));
});

test('ModelRouter is deterministic — same diagnostics produce the same choice', () => {
  const router = new ModelRouter(DEFAULT_MODEL_ROUTER_CONFIG);
  const a = router.decide(coldStart);
  const b = router.decide(coldStart);
  assert.deepEqual(a, b);
});

test('ModelRouter with custom model names uses them in the choice', () => {
  const config: ModelRouterConfig = {
    smallModel: 'minicpm5:2b',
    largeModel: 'llama3:8b',
    threshold: DEFAULT_ESCALATION_THRESHOLD,
  };
  const router = new ModelRouter(config);
  const localChoice = router.decide(coldStart);
  assert.equal(localChoice.model, 'minicpm5:2b');
  // Build a complex diagnostics to test the large model.
  const d: ResearchDiagnostics = {
    ...coldStart,
    worstCells: Array.from({ length: 8 }, (_, i) => cellStat(`cell-${i}`, -0.2, 15)),
    bestCells: Array.from({ length: 6 }, (_, i) => cellStat(`best-${i}`, 0.4, 30)),
    lastExperiment: { ...emptyResult, test: { ...emptyResult.test, n: 10 } },
    currentParams: { ...seedParams, minSweepDepthAtr: 0.5 },
  };
  const escalateChoice = router.decide(d);
  assert.equal(escalateChoice.model, 'llama3:8b');
});

// ─── FixedModelRouter ──────────────────────────────────────────────────────

test('FixedModelRouter always returns the same model regardless of diagnostics', () => {
  const router = new FixedModelRouter('forced-model');
  const choice1 = router.decide(coldStart);
  const choice2 = router.decide({
    ...coldStart,
    worstCells: Array.from({ length: 10 }, (_, i) => cellStat(`c-${i}`, -0.5, 10)),
  });
  assert.equal(choice1.model, 'forced-model');
  assert.equal(choice2.model, 'forced-model');
  assert.equal(choice1.kind, 'local');
});

test('FixedModelRouter reports score=0 with a "routing disabled" reason', () => {
  const router = new FixedModelRouter('forced-model');
  const choice = router.decide(coldStart);
  assert.equal(choice.score.score, 0);
  assert.ok(choice.score.reasons.some((r) => /routing disabled/.test(r)));
});

// ─── ResearchAgent integration (model routing emits events) ─────────────────

test('ResearchAgent with a router emits model_routed events on every propose()', async () => {
  const { ResearchAgent } = await import('../src/research/ResearchAgent.js');
  const { ResearchEventBus } = await import('../src/research/Events.js');

  const bus = new ResearchEventBus();
  const events: Array<{ type: string; payload: unknown }> = [];
  bus.subscribe((e) => { events.push({ type: e.type, payload: e.payload }); });

  const goodClient = {
    listModels: async () => [],
    generateText: async () => JSON.stringify([
      { observation: 'collapse', proposal: 'raise sweep', changes: { minSweepDepthAtr: 0.5 } },
    ]),
  };
  // routerConfig is the default (routing enabled). The agent should emit model_routed.
  const agent = new ResearchAgent(goodClient, 'qwen-test', undefined, bus, undefined, DEFAULT_MODEL_ROUTER_CONFIG);
  await agent.propose(coldStart);

  const routedEvent = events.find((e) => e.type === 'model_routed');
  assert.ok(routedEvent, 'expected a model_routed event');
  const payload = routedEvent!.payload as { model: string; kind: string; score: number; reasons: string[] };
  // Cold-start diagnostics → low complexity → local (small model).
  assert.equal(payload.kind, 'local');
  assert.equal(payload.model, DEFAULT_MODEL_ROUTER_CONFIG.smallModel);
  assert.ok(payload.score < DEFAULT_ESCALATION_THRESHOLD);
});

test('ResearchAgent with routerConfig=null emits model_routed with the forced model and score=0', async () => {
  const { ResearchAgent } = await import('../src/research/ResearchAgent.js');
  const { ResearchEventBus } = await import('../src/research/Events.js');

  const bus = new ResearchEventBus();
  const events: Array<{ type: string; payload: unknown }> = [];
  bus.subscribe((e) => { events.push({ type: e.type, payload: e.payload }); });

  const goodClient = {
    listModels: async () => [],
    generateText: async () => JSON.stringify([
      { observation: 'collapse', proposal: 'raise sweep', changes: { minSweepDepthAtr: 0.5 } },
    ]),
  };
  const agent = new ResearchAgent(goodClient, 'forced-model', undefined, bus, undefined, null);
  await agent.propose(coldStart);

  const routedEvent = events.find((e) => e.type === 'model_routed');
  assert.ok(routedEvent, 'expected a model_routed event (even with routing disabled, the event fires with the forced model)');
  const payload = routedEvent!.payload as { model: string; kind: string; score: number; reasons: string[] };
  assert.equal(payload.model, 'forced-model');
  assert.equal(payload.score, 0);
  assert.ok(payload.reasons.some((r) => /routing disabled/.test(r)));
});
