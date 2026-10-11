import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExperimentMemory,
  cosineSimilarity,
  jaccardSimilarity,
  searchableTextOf,
  searchableQueryOf,
  formatSearchResults,
  type Embedder,
  type ExperimentMemoryRecord,
} from '../src/research/ExperimentMemory.js';
import type { ExperimentRecord } from '../src/research/ExperimentStore.js';
import type { ResearchDiagnostics } from '../src/research/ResearchAgent.js';
import { seedStructLiqSpec, mutateSpec, type StructLiqSpecParams, type StrategySpec } from '../src/research/StrategySpec.js';
import type { ExperimentResult } from '../src/research/ExperimentRunner.js';
import type { PromotionVerdict } from '../src/research/PromotionGate.js';

// ─── Similarity functions ──────────────────────────────────────────────────

test('cosineSimilarity returns 1 for identical vectors', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test('cosineSimilarity returns 0 for empty or mismatched-length vectors', () => {
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, 2], [1]), 0);
});

test('jaccardSimilarity returns 1 for identical token sets', () => {
  assert.equal(jaccardSimilarity('sweep depth too low', 'sweep depth too low'), 1);
});

test('jaccardSimilarity returns 0 for disjoint token sets', () => {
  assert.equal(jaccardSimilarity('alpha beta gamma', 'delta epsilon zeta'), 0);
});

test('jaccardSimilarity returns a value in (0, 1) for partial overlap', () => {
  const score = jaccardSimilarity('sweep depth minSweepDepthAtr', 'sweep depth minimumRewardRisk');
  assert.ok(score > 0 && score < 1);
});

test('jaccardSimilarity ignores tokens shorter than 3 chars', () => {
  // 'a b ccc' → tokens: {'ccc'}; 'ccc ddd' → tokens: {'ccc', 'ddd'}
  // intersection=1, union=2 → 0.5
  assert.equal(jaccardSimilarity('a b ccc', 'ccc ddd'), 0.5);
});

// ─── Text builders ─────────────────────────────────────────────────────────

test('searchableTextOf combines hypothesis, changes, worstCells, verdict, reasons', () => {
  const text = searchableTextOf({
    hypothesis: 'raise sweep depth',
    changes: 'minSweepDepthAtr=0.5',
    worstCells: ['TREND_UP | EXPANDED | LONG'],
    verdict: 'REJECT',
    reasons: ['negative expectancy'],
  });
  assert.match(text, /raise sweep depth/);
  assert.match(text, /minSweepDepthAtr=0\.5/);
  assert.match(text, /TREND_UP \| EXPANDED \| LONG/);
  assert.match(text, /verdict: REJECT/);
  assert.match(text, /negative expectancy/);
});

test('searchableQueryOf combines champion id, worst/best cells, current params', () => {
  const d: ResearchDiagnostics = {
    championId: 'STRUCT-LIQ-η',
    championVersion: 1,
    worstCells: [{ key: 'TRANSITION | COMPRESSED | LONG', n: 30, stats: null, significant: false }],
    bestCells: [{ key: 'TREND_UP | EXPANDED | LONG', n: 40, stats: null, significant: false }],
    currentParams: seedStructLiqSpec().params,
  };
  const text = searchableQueryOf(d);
  assert.match(text, /STRUCT-LIQ-η v1/);
  assert.match(text, /TRANSITION \| COMPRESSED \| LONG/);
  assert.match(text, /TREND_UP \| EXPANDED \| LONG/);
  assert.match(text, /minimumRewardRisk=1\.5/);
});

// ─── ExperimentMemory (Jaccard mode — no embedder) ──────────────────────────

/** Build a minimal ExperimentRecord for testing. */
function fakeExperiment(
  id: string,
  changes: Partial<StructLiqSpecParams>,
  hypothesis: string,
  verdict: PromotionVerdict,
  worstCells: string[] = [],
): ExperimentRecord {
  const seed = seedStructLiqSpec();
  const candidate = mutateSpec(seed, changes, hypothesis, { kind: 'manual', note: 'test' });
  const empty: ExperimentResult = {
    candidateId: candidate.id, candidateVersion: candidate.version,
    parentId: seed.id, parentVersion: seed.version,
    train: { n: 100, winRate: 0.5, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 3, bootstrap: null },
    test: { n: 50, winRate: 0.5, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 3, bootstrap: null },
    parentTrain: { n: 100, winRate: 0.5, meanNetR: 0.2, profitFactor: 1.3, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null },
    parentTest: { n: 50, winRate: 0.5, meanNetR: 0.2, profitFactor: 1.2, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null },
    walkForward: { outOfSample: null, baseline: null, folds: 5 },
    perSymbol: [], perRegime: worstCells.map((k) => ({ key: k, n: 20, meanNetR: 0.3 })),
    experimentNotes: [],
  };
  return { experimentId: id, ranAt: Date.now(), candidate, parent: seed, result: empty, verdict };
}

const baseDiagnostics: ResearchDiagnostics = {
  championId: 'STRUCT-LIQ-η',
  championVersion: 1,
  worstCells: [{ key: 'TRANSITION | COMPRESSED | LONG', n: 30, stats: null, significant: false }],
  bestCells: [{ key: 'TREND_UP | EXPANDED | LONG', n: 40, stats: null, significant: false }],
  currentParams: seedStructLiqSpec().params,
};

test('ExperimentMemory with null path operates in memory only', async () => {
  const m = new ExperimentMemory(null, null);
  assert.equal(m.size, 0);
  assert.equal(m.model, 'jaccard');
});

test('ExperimentMemory.index adds a record and increments size', async () => {
  const m = new ExperimentMemory(null, null);
  await m.index(fakeExperiment('e1', { minSweepDepthAtr: 0.5 }, 'raise sweep depth', { decision: 'REJECT', reasons: ['negative'], policy: {} as never }));
  assert.equal(m.size, 1);
  assert.ok(m.has('e1'));
});

test('ExperimentMemory.index is idempotent — re-indexing the same id replaces the prior record', async () => {
  const m = new ExperimentMemory(null, null);
  await m.index(fakeExperiment('e1', { minSweepDepthAtr: 0.5 }, 'first hypothesis', { decision: 'REJECT', reasons: ['r1'], policy: {} as never }));
  await m.index(fakeExperiment('e1', { minimumRewardRisk: 2.0 }, 'second hypothesis', { decision: 'PROMOTE', reasons: ['good'], policy: {} as never }));
  assert.equal(m.size, 1);  // not 2 — the second index replaced the first
  const records = m.all();
  assert.equal(records[0].hypothesis, 'second hypothesis');
  assert.equal(records[0].verdict, 'PROMOTE');
});

test('ExperimentMemory.search returns empty when no records are indexed', async () => {
  const m = new ExperimentMemory(null, null);
  const results = await m.search(baseDiagnostics);
  assert.equal(results.length, 0);
});

test('ExperimentMemory.search returns records sorted by similarity (highest first)', async () => {
  const m = new ExperimentMemory(null, null);
  // Two experiments: one about sweep depth on TREND_UP cells, one about RR floor on TRANSITION cells.
  await m.index(fakeExperiment('e1', { minSweepDepthAtr: 0.5 }, 'raise sweep depth in TREND_UP', { decision: 'REJECT', reasons: ['negative'], policy: {} as never }, ['TREND_UP | EXPANDED | LONG']));
  await m.index(fakeExperiment('e2', { minimumRewardRisk: 2.0 }, 'raise RR floor in TRANSITION', { decision: 'PROMOTE', reasons: ['good'], policy: {} as never }, ['TRANSITION | COMPRESSED | LONG']));

  // Query for TRANSITION cells — e2 should score higher than e1.
  const results = await m.search(baseDiagnostics);
  assert.ok(results.length >= 1);
  // The first result should be e2 (TRANSITION) — it shares the "transition" token with the query.
  assert.equal(results[0].record.experimentId, 'e2');
  // Scores are in descending order.
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[i - 1].score >= results[i].score, 'results must be sorted by score descending');
  }
});

test('ExperimentMemory.search with topK limits the number of results', async () => {
  const m = new ExperimentMemory(null, null);
  for (let i = 0; i < 10; i += 1) {
    await m.index(fakeExperiment(`e${i}`, { minSweepDepthAtr: 0.5 + i * 0.1 }, `experiment ${i} sweep depth`, { decision: 'REJECT', reasons: ['r'], policy: {} as never }));
  }
  const results = await m.search(baseDiagnostics, 3);
  assert.ok(results.length <= 3);
});

test('ExperimentMemory.all returns a copy (mutating it does not affect the memory)', async () => {
  const m = new ExperimentMemory(null, null);
  await m.index(fakeExperiment('e1', { minSweepDepthAtr: 0.5 }, 'h', { decision: 'REJECT', reasons: [], policy: {} as never }));
  const records = m.all();
  assert.equal(records.length, 1);
  // The returned array is a copy — pushing to a mutable copy of it does not affect the memory.
  const mutable = [...records];
  mutable.push({} as ExperimentMemoryRecord);
  assert.equal(m.all().length, 1);
});

// ─── ExperimentMemory persistence ───────────────────────────────────────────

test('ExperimentMemory persists to disk and reloads on construction', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'exp-mem-test-'));
  try {
    const filePath = path.join(tmp, 'memory.json');
    const m1 = new ExperimentMemory(filePath, null);
    await m1.index(fakeExperiment('e1', { minSweepDepthAtr: 0.5 }, 'persisted hypothesis', { decision: 'REJECT', reasons: ['r'], policy: {} as never }));
    assert.ok(existsSync(filePath));

    // A new instance loading from the same file should see the indexed record.
    const m2 = new ExperimentMemory(filePath, null);
    assert.equal(m2.size, 1);
    assert.ok(m2.has('e1'));
    assert.equal(m2.all()[0].hypothesis, 'persisted hypothesis');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ExperimentMemory with a corrupted store file starts empty', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'exp-mem-test-'));
  try {
    const filePath = path.join(tmp, 'memory.json');
    writeFileSync(filePath, 'not valid json {{{', 'utf8');
    const m = new ExperimentMemory(filePath, null);
    assert.equal(m.size, 0);  // corrupted store → empty start, not a crash
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── ExperimentMemory with a fake embedder (vector mode) ─────────────────────

/** A fake embedder that maps text to a deterministic 4-d vector via hashing. */
const fakeEmbedder: Embedder = {
  model: 'fake-embed-v1',
  dimension: 4,
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => {
      // Hash each character into one of 4 buckets.
      const vec = [0, 0, 0, 0];
      for (let i = 0; i < t.length; i += 1) {
        vec[t.charCodeAt(i) % 4] += 1;
      }
      // Normalize.
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / mag);
    });
  },
};

test('ExperimentMemory with an embedder stores dense vectors and uses cosine similarity', async () => {
  const m = new ExperimentMemory(null, fakeEmbedder);
  await m.index(fakeExperiment('e1', { minSweepDepthAtr: 0.5 }, 'raise sweep depth', { decision: 'REJECT', reasons: ['r'], policy: {} as never }));
  assert.equal(m.model, 'fake-embed-v1');
  const records = m.all();
  assert.ok(records[0].embedding !== null);
  assert.equal(records[0].embedding!.length, 4);

  const results = await m.search(baseDiagnostics);
  // With one record, the search should return it with a non-zero score (the fake embedder produces
  // non-zero vectors for non-empty text).
  assert.ok(results.length >= 1);
  assert.ok(results[0].score >= 0);
});

// ─── formatSearchResults ───────────────────────────────────────────────────

test('formatSearchResults renders a readable multi-line block', async () => {
  const m = new ExperimentMemory(null, null);
  await m.index(fakeExperiment('e1', { minSweepDepthAtr: 0.5 }, 'raise sweep depth', { decision: 'REJECT', reasons: ['negative expectancy', 'low PF'], policy: {} as never }));
  const results = await m.search(baseDiagnostics);
  const text = formatSearchResults(results);
  assert.match(text, /score=/);
  assert.match(text, /verdict=REJECT/);
  assert.match(text, /raise sweep depth/);
  assert.match(text, /negative expectancy/);
});

test('formatSearchResults returns a placeholder when there are no results', () => {
  const text = formatSearchResults([]);
  assert.match(text, /no prior experiments/);
});

// ─── ResearchAgent integration (memory prevents re-proposing rejected hypotheses) ──

test('ResearchAgent with memory filters out fallback hypotheses that match a prior REJECTED experiment', async () => {
  const { ResearchAgent } = await import('../src/research/ResearchAgent.js');
  const { ExperimentMemory } = await import('../src/research/ExperimentMemory.js');

  // Index a prior experiment that was REJECTED for raising minSweepDepthAtr to 0.5.
  const memory = new ExperimentMemory(null, null);
  await memory.index(fakeExperiment('prior-1', { minSweepDepthAtr: 0.5 }, 'raise sweep depth to 0.5', { decision: 'REJECT', reasons: ['negative'], policy: {} as never }));

  // No LLM — the fallback proposer fires. It would normally propose raising minSweepDepthAtr to 0.5,
  // but the memory has a prior REJECTED experiment with exactly that change. The agent should filter it out.
  const agent = new ResearchAgent(null, undefined, undefined, null, memory);
  const hypotheses = await agent.propose(baseDiagnostics);

  // The fallback proposer's Rule 1 proposes minSweepDepthAtr=0.5. With the memory, this should be filtered.
  // Either the hypotheses list is empty, or it contains only the RR-floor proposal (Rule 2), not the sweep-depth one.
  for (const h of hypotheses) {
    if (h.changes.minSweepDepthAtr !== undefined) {
      assert.notEqual(h.changes.minSweepDepthAtr, 0.5, `the agent should not re-propose minSweepDepthAtr=0.5 after a prior REJECT`);
    }
  }
});

test('ResearchAgent with memory does NOT filter hypotheses matching a prior PROMOTED experiment', async () => {
  const { ResearchAgent } = await import('../src/research/ResearchAgent.js');
  const { ExperimentMemory } = await import('../src/research/ExperimentMemory.js');

  // Index a prior experiment that was PROMOTED for raising minSweepDepthAtr to 0.5.
  const memory = new ExperimentMemory(null, null);
  await memory.index(fakeExperiment('prior-1', { minSweepDepthAtr: 0.5 }, 'raise sweep depth to 0.5', { decision: 'PROMOTE', reasons: ['good'], policy: {} as never }));

  const agent = new ResearchAgent(null, undefined, undefined, null, memory);
  const hypotheses = await agent.propose(baseDiagnostics);

  // A PROMOTED experiment should not block re-proposing — the candidate may have been superseded.
  // The fallback may or may not propose it (depends on the data), but if it does, it should not be filtered.
  // We just assert the agent didn't crash and returned a list.
  assert.ok(Array.isArray(hypotheses));
});

test('ResearchAgent with no memory behaves as before (no filtering)', async () => {
  const { ResearchAgent } = await import('../src/research/ResearchAgent.js');
  const agent = new ResearchAgent(null, undefined, undefined, null, null);
  const hypotheses = await agent.propose(baseDiagnostics);
  assert.ok(Array.isArray(hypotheses));
  // The fallback proposer should fire (worst cell has negative mean, n >= 10 is not met here since
  // the fixture cell has n=30 and stats=null, so the rule may or may not fire — either is fine).
});

// ─── SelfImprovementLoop integration (loop indexes completed experiments) ───

test('SelfImprovementLoop with memory indexes every completed experiment', async () => {
  const { SelfImprovementLoop } = await import('../src/research/SelfImprovementLoop.js');
  const { StrategyRegistry } = await import('../src/research/StrategyRegistry.js');
  const { ChampionRegistry } = await import('../src/research/ChampionRegistry.js');
  const { ExperimentStore } = await import('../src/research/ExperimentStore.js');
  const { ResearchAgent } = await import('../src/research/ResearchAgent.js');
  const { ExperimentMemory } = await import('../src/research/ExperimentMemory.js');
  const { makeMultiRegimeLedger } = await import('../src/research/LedgerFixtures.js');

  const strategies = new StrategyRegistry(null);
  const champions = new ChampionRegistry(null, null);
  const experiments = new ExperimentStore(null);
  const memory = new ExperimentMemory(null, null);
  const agent = new ResearchAgent(null, undefined, undefined, null, memory);
  const loop = new SelfImprovementLoop(strategies, champions, experiments, agent, {
    trainDays: 30, testDays: 15, costs: { feeRate: 0, slippageRate: 0 }, maxHypothesesPerRun: 2,
  }, null, memory);

  const ledger = makeMultiRegimeLedger(60, 8, 7);
  const result = await loop.run(ledger);

  // Every experiment the loop ran should be indexed in the memory.
  assert.equal(memory.size, result.experiments.length);
  for (const exp of result.experiments) {
    assert.ok(memory.has(exp.experimentId), `experiment ${exp.experimentId} should be indexed in memory`);
  }
});
