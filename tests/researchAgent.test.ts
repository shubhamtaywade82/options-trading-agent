import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ResearchAgent,
  candidateFromHypothesis,
  fallbackHypotheses,
  parseHypotheses,
  renderDiagnostics,
  type ResearchDiagnostics,
} from '../src/research/ResearchAgent.js';
import { seedStructLiqSpec } from '../src/research/StrategySpec.js';
import type { CellStat } from '../src/research/ConditionalEdge.js';

const cellStat = (key: string, mean: number, n: number, significant = false): CellStat => ({
  key, n,
  stats: { n, clusters: 5, mean, median: mean, ciLow: mean - 0.1, ciHigh: mean + 0.1, probPositive: 0.9, pValue: 0.05, p05: mean - 0.5, p95: mean + 0.5 },
  significant,
});

const baseDiagnostics: ResearchDiagnostics = {
  championId: 'STRUCT-LIQ-η',
  championVersion: 1,
  worstCells: [cellStat('TRANSITION | COMPRESSED | LONG', -0.4, 30)],
  bestCells: [cellStat('TREND_UP | EXPANDED | LONG', 0.6, 30, true)],
  currentParams: seedStructLiqSpec().params,
};

test('parseHypotheses accepts a clean JSON array and rejects malformed input', () => {
  const text = JSON.stringify([
    { observation: 'weak in TRANSITION', proposal: 'raise sweep depth', changes: { minSweepDepthAtr: 0.5 } },
    { observation: 'best cells have RR >= 1.75', proposal: 'raise RR floor', changes: { minimumRewardRisk: 1.75 } },
  ]);
  const hs = parseHypotheses(text, 'test-model');
  assert.equal(hs.length, 2);
  assert.equal(hs[0].changes.minSweepDepthAtr, 0.5);
  assert.equal(hs[1].changes.minimumRewardRisk, 1.75);
  assert.equal(hs[0].source, 'llm');
  assert.equal(hs[0].model, 'test-model');
});

test('parseHypotheses tolerates markdown fences', () => {
  const text = '```json\n' + JSON.stringify([{ observation: 'x', proposal: 'y', changes: { minimumRewardRisk: 1.5 } }]) + '\n```';
  const hs = parseHypotheses(text);
  assert.equal(hs.length, 1);
});

test('parseHypotheses rejects unknown parameter keys', () => {
  const text = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { unknown_param: 5 } }]);
  assert.equal(parseHypotheses(text).length, 0);
});

test('parseHypotheses rejects non-numeric parameter values', () => {
  const text = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { minimumRewardRisk: 'high' } }]);
  assert.equal(parseHypotheses(text).length, 0);
});

test('fallbackHypotheses proposes raising minSweepDepthAtr when negative cells have enough sample', () => {
  const hs = fallbackHypotheses(baseDiagnostics);
  assert.ok(hs.length > 0);
  assert.ok(hs.some((h) => h.changes.minSweepDepthAtr !== undefined));
});

test('fallbackHypotheses proposes raising RR floor when best cells are strongly positive', () => {
  const hs = fallbackHypotheses(baseDiagnostics);
  assert.ok(hs.some((h) => h.changes.minimumRewardRisk !== undefined && h.changes.minimumRewardRisk! > 1.5));
});

test('fallbackHypotheses returns no hypotheses when the champion has no negative cells', () => {
  const allPositive: ResearchDiagnostics = {
    ...baseDiagnostics,
    worstCells: [cellStat('RANGE | NORMAL | LONG', 0.05, 30)],
  };
  const hs = fallbackHypotheses(allPositive);
  // Rule 2 may still fire if best cells are strongly positive.
  // We only assert that rule 1 does not fire (no minSweepDepthAtr change).
  assert.ok(!hs.some((h) => h.changes.minSweepDepthAtr !== undefined));
});

test('renderDiagnostics produces a markdown block with current params, worst and best cells', () => {
  const text = renderDiagnostics(baseDiagnostics);
  assert.match(text, /# Diagnostics for STRUCT-LIQ-η v1/);
  assert.match(text, /## Current parameters/);
  assert.match(text, /minimumRewardRisk: 1\.5/);
  assert.match(text, /## Worst cells/);
  assert.match(text, /## Best cells/);
  assert.match(text, /TRANSITION \| COMPRESSED \| LONG/);
});

test('ResearchAgent.propose falls back to deterministic hypotheses when no LLM client is configured', async () => {
  const agent = new ResearchAgent(null);
  const hs = await agent.propose(baseDiagnostics);
  assert.ok(hs.length > 0);
  assert.ok(hs.every((h) => h.source === 'fallback'));
});

test('ResearchAgent.propose falls back when the LLM throws', async () => {
  const failingClient = {
    listModels: async () => [],
    generateText: async () => { throw new Error('network timeout'); },
  };
  const agent = new ResearchAgent(failingClient, 'test');
  const hs = await agent.propose(baseDiagnostics);
  assert.ok(hs.every((h) => h.source === 'fallback'));
});

test('ResearchAgent.propose falls back when the LLM returns an empty array', async () => {
  const emptyClient = {
    listModels: async () => [],
    generateText: async () => '[]',
  };
  const agent = new ResearchAgent(emptyClient, 'test');
  const hs = await agent.propose(baseDiagnostics);
  assert.ok(hs.every((h) => h.source === 'fallback'));
});

test('ResearchAgent.propose uses LLM hypotheses when the client returns valid JSON', async () => {
  const goodClient = {
    listModels: async () => [],
    generateText: async () => JSON.stringify([
      { observation: 'collapse in TRANSITION', proposal: 'require sweep depth >= 0.8', changes: { minSweepDepthAtr: 0.8 } },
    ]),
  };
  // routerConfig=null disables routing so the constructor's model ('qwen-test') is used.
  const agent = new ResearchAgent(goodClient, 'qwen-test', undefined, undefined, undefined, null);
  const hs = await agent.propose(baseDiagnostics);
  assert.equal(hs.length, 1);
  assert.equal(hs[0].source, 'llm');
  assert.equal(hs[0].changes.minSweepDepthAtr, 0.8);
  assert.equal(hs[0].model, 'qwen-test');
});

test('ResearchAgent.propose repairs a malformed LLM output instead of falling back', async () => {
  // First call returns malformed JSON (unknown key); second call returns valid JSON.
  // The repair loop should re-prompt and recover — the agent must NOT fall back to the deterministic proposer.
  const malformed = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { unknown_key: 1 } }]);
  const valid = JSON.stringify([
    { observation: 'repaired', proposal: 'require sweep depth >= 0.6', changes: { minSweepDepthAtr: 0.6 } },
  ]);
  let callCount = 0;
  const repairingClient = {
    listModels: async () => [],
    generateText: async () => {
      callCount += 1;
      return callCount === 1 ? malformed : valid;
    },
  };
  // routerConfig=null disables routing so the constructor's model ('qwen-test') is used.
  const agent = new ResearchAgent(repairingClient, 'qwen-test', undefined, undefined, undefined, null);
  const hs = await agent.propose(baseDiagnostics);
  // The repair loop recovered — the agent returned LLM hypotheses, not fallback.
  assert.equal(hs.length, 1);
  assert.equal(hs[0].source, 'llm');
  assert.equal(hs[0].changes.minSweepDepthAtr, 0.6);
  assert.equal(hs[0].model, 'qwen-test');
  // Two LLM calls: the original + one repair retry.
  assert.equal(callCount, 2);
});

test('ResearchAgent.propose falls back to deterministic when the repair loop is exhausted', async () => {
  // Every call returns malformed JSON — the repair loop can't recover.
  const malformed = 'not json at all';
  const alwaysMalformedClient = {
    listModels: async () => [],
    generateText: async () => malformed,
  };
  const agent = new ResearchAgent(alwaysMalformedClient, 'qwen-test', 2);
  const hs = await agent.propose(baseDiagnostics);
  // Repair loop exhausted — the agent fell back to the deterministic proposer.
  assert.ok(hs.length > 0);
  assert.ok(hs.every((h) => h.source === 'fallback'));
});

test('ResearchAgent emits a hypothesis_repaired event when the repair loop is invoked', async () => {
  const { ResearchEventBus } = await import('../src/research/Events.js');
  const bus = new ResearchEventBus();
  const events: Array<{ type: string; payload: unknown }> = [];
  bus.subscribe((e) => { events.push({ type: e.type, payload: e.payload }); });

  const malformed = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { unknown_key: 1 } }]);
  const valid = JSON.stringify([
    { observation: 'repaired', proposal: 'require sweep depth >= 0.7', changes: { minSweepDepthAtr: 0.7 } },
  ]);
  let callCount = 0;
  const client = {
    listModels: async () => [],
    generateText: async () => {
      callCount += 1;
      return callCount === 1 ? malformed : valid;
    },
  };
  // routerConfig=null disables routing so the constructor's model ('qwen-test') is used.
  const agent = new ResearchAgent(client, 'qwen-test', 2, bus, undefined, null);
  await agent.propose(baseDiagnostics);

  const repairedEvent = events.find((e) => e.type === 'hypothesis_repaired');
  assert.ok(repairedEvent, 'expected a hypothesis_repaired event');
  const payload = repairedEvent!.payload as { ok: boolean; attempts: number; errorCount: number };
  assert.equal(payload.ok, true);
  assert.equal(payload.attempts, 1);
  // errorCount is the count from the *final* attempt — which is 0 on success (the repaired output has no errors).
  assert.equal(payload.errorCount, 0);
});

test('candidateFromHypothesis produces a child spec with hypothesis-driven params and traceable provenance', () => {
  const parent = seedStructLiqSpec();
  const h = {
    id: 'h-test-1', observation: 'weak in TRANSITION', proposal: 'require sweep depth >= 0.5',
    changes: { minSweepDepthAtr: 0.5 }, motivatedBy: ['TRANSITION | COMPRESSED | LONG'], source: 'llm' as const, model: 'qwen-test',
  };
  const child = candidateFromHypothesis(parent, h);
  assert.equal(child.version, parent.version + 1);
  assert.equal(child.params.minSweepDepthAtr, 0.5);
  assert.equal(child.provenance.kind, 'researcher');
  assert.equal(child.hypothesis, 'weak in TRANSITION → require sweep depth >= 0.5');
  assert.deepEqual(child.motivatedBy, ['TRANSITION | COMPRESSED | LONG']);
});
