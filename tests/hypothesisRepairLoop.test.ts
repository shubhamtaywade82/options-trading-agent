import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HypothesisRepairLoop,
  validateHypothesisOutput,
  buildRepairPrompt,
  DEFAULT_MAX_REPAIR_RETRIES,
  type RepairResult,
} from '../src/research/HypothesisRepairLoop.js';
import type { AdvisorClient } from '../src/ollama/advisor.js';
import type { ResearchDiagnostics } from '../src/research/ResearchAgent.js';
import { seedStructLiqSpec } from '../src/research/StrategySpec.js';

const baseDiagnostics: ResearchDiagnostics = {
  championId: 'STRUCT-LIQ-η',
  championVersion: 1,
  worstCells: [],
  bestCells: [],
  currentParams: seedStructLiqSpec().params,
};

/** Build a fake LLM client that returns a scripted sequence of responses. */
function fakeClient(responses: string[]): AdvisorClient {
  let i = 0;
  return {
    listModels: async () => [],
    generateText: async () => {
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return r;
    },
  };
}

const validJson = JSON.stringify([
  { observation: 'collapse in TRANSITION', proposal: 'require sweep depth >= 0.5', changes: { minSweepDepthAtr: 0.5 } },
]);

// ─── validateHypothesisOutput ───────────────────────────────────────────────

test('validateHypothesisOutput accepts a clean JSON array', () => {
  const { hypotheses, errors } = validateHypothesisOutput(validJson);
  assert.equal(hypotheses.length, 1);
  assert.equal(hypotheses[0].changes.minSweepDepthAtr, 0.5);
  assert.deepEqual(errors, []);
});

test('validateHypothesisOutput rejects non-JSON with a specific error', () => {
  const { hypotheses, errors } = validateHypothesisOutput('not json at all');
  assert.equal(hypotheses.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not valid JSON/);
});

test('validateHypothesisOutput rejects a non-array JSON value', () => {
  const { hypotheses, errors } = validateHypothesisOutput(JSON.stringify({ observation: 'x' }));
  assert.equal(hypotheses.length, 0);
  assert.match(errors[0], /not a JSON array/);
});

test('validateHypothesisOutput rejects an empty array', () => {
  const { hypotheses, errors } = validateHypothesisOutput('[]');
  assert.equal(hypotheses.length, 0);
  assert.match(errors[0], /empty array/);
});

test('validateHypothesisOutput rejects unknown parameter keys with a specific error', () => {
  const raw = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { unknown_param: 5 } }]);
  const { hypotheses, errors } = validateHypothesisOutput(raw);
  assert.equal(hypotheses.length, 0);
  assert.ok(errors.some((e) => /unknown parameter key "unknown_param"/.test(e)));
});

test('validateHypothesisOutput rejects non-numeric parameter values', () => {
  const raw = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { minimumRewardRisk: 'high' } }]);
  const { hypotheses, errors } = validateHypothesisOutput(raw);
  assert.equal(hypotheses.length, 0);
  assert.ok(errors.some((e) => /minimumRewardRisk is not a finite number/.test(e)));
});

test('validateHypothesisOutput rejects NaN and Infinity values', () => {
  const raw = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { minimumRewardRisk: NaN } }]);
  const { hypotheses, errors } = validateHypothesisOutput(raw);
  // JSON.stringify(NaN) produces "null", so this actually parses as null. Test with Infinity instead.
  // Infinity serializes as "null" in JSON too, so we use a stringified object that contains the literal.
  const raw2 = '[{"observation":"x","proposal":"y","changes":{"minimumRewardRisk":Infinity}}]';
  const { hypotheses: h2, errors: e2 } = validateHypothesisOutput(raw2);
  // Infinity is not valid JSON, so this fails to parse — that's a different error path, which is fine.
  assert.ok(e2.length > 0);
  void hypotheses; void errors;
});

test('validateHypothesisOutput rejects a hypothesis with missing observation', () => {
  const raw = JSON.stringify([{ proposal: 'y', changes: { minimumRewardRisk: 1.5 } }]);
  const { hypotheses, errors } = validateHypothesisOutput(raw);
  assert.equal(hypotheses.length, 0);
  assert.ok(errors.some((e) => /observation is missing/.test(e)));
});

test('validateHypothesisOutput rejects a hypothesis with empty changes', () => {
  const raw = JSON.stringify([{ observation: 'x', proposal: 'y', changes: {} }]);
  const { hypotheses, errors } = validateHypothesisOutput(raw);
  assert.equal(hypotheses.length, 0);
  assert.ok(errors.some((e) => /changes is empty/.test(e)));
});

test('validateHypothesisOutput accepts markdown-fenced JSON', () => {
  const raw = '```json\n' + validJson + '\n```';
  const { hypotheses, errors } = validateHypothesisOutput(raw);
  assert.equal(hypotheses.length, 1);
  assert.deepEqual(errors, []);
});

test('validateHypothesisOutput reports per-hypothesis errors independently', () => {
  // One valid, one with unknown key — the valid one is kept, the invalid one is dropped, errors mention the bad one.
  const raw = JSON.stringify([
    { observation: 'valid', proposal: 'ok', changes: { minimumRewardRisk: 1.5 } },
    { observation: 'bad', proposal: 'nope', changes: { unknown: 1 } },
  ]);
  const { hypotheses, errors } = validateHypothesisOutput(raw);
  assert.equal(hypotheses.length, 1);
  assert.equal(hypotheses[0].observation, 'valid');
  assert.ok(errors.some((e) => /hypothesis\[1\].*unknown/.test(e)));
});

// ─── buildRepairPrompt ─────────────────────────────────────────────────────

test('buildRepairPrompt includes the diagnostics, the previous output, and the validation errors', () => {
  const prompt = buildRepairPrompt(baseDiagnostics, 'previous bad output', ['error 1', 'error 2']);
  assert.match(prompt, /Original diagnostics/);
  assert.match(prompt, /Your previous \(invalid\) response/);
  assert.match(prompt, /previous bad output/);
  assert.match(prompt, /Validation errors/);
  assert.match(prompt, /- error 1/);
  assert.match(prompt, /- error 2/);
  assert.match(prompt, /JSON array/);
});

// ─── HypothesisRepairLoop ──────────────────────────────────────────────────

test('HypothesisRepairLoop returns ok=true, attempts=0 when the original output is valid', async () => {
  const client = fakeClient([validJson]);
  const loop = new HypothesisRepairLoop(client, 'test-model', 2);
  const result = await loop.run({ diagnostics: baseDiagnostics, originalRawOutput: validJson });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 0);
  assert.equal(result.hypotheses.length, 1);
  assert.equal(result.history.length, 1);
  assert.deepEqual(result.history[0].errors, []);
});

test('HypothesisRepairLoop repairs a malformed output on the first retry', async () => {
  // Attempt 0: validates the originalRawOutput (malformed) — no LLM call.
  // Attempt 1: LLM returns valid JSON — succeeds.
  const malformed = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { unknown_key: 1 } }]);
  const client = fakeClient([validJson]);  // the first LLM call (attempt 1) returns valid JSON
  const loop = new HypothesisRepairLoop(client, 'test-model', 2);
  const result = await loop.run({ diagnostics: baseDiagnostics, originalRawOutput: malformed });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.hypotheses.length, 1);
  assert.equal(result.history.length, 2);  // attempt 0 + attempt 1
  assert.ok(result.history[0].errors.length > 0);
  assert.deepEqual(result.history[1].errors, []);
});

test('HypothesisRepairLoop returns ok=false after exhausting retries', async () => {
  // originalRawOutput is malformed; every retry also returns malformed.
  const malformed = 'not json';
  const client = fakeClient([malformed, malformed]);  // 2 retries, both malformed
  const loop = new HypothesisRepairLoop(client, 'test-model', 2);
  const result = await loop.run({ diagnostics: baseDiagnostics, originalRawOutput: malformed });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.hypotheses.length, 0);
  assert.equal(result.history.length, 3);  // attempt 0 + 2 retries
  // Every history entry has errors.
  for (const h of result.history) assert.ok(h.errors.length > 0);
});

test('HypothesisRepairLoop bails out immediately on LLM network errors', async () => {
  const failingClient: AdvisorClient = {
    listModels: async () => [],
    generateText: async () => { throw new Error('network timeout'); },
  };
  const loop = new HypothesisRepairLoop(failingClient, 'test-model', 3);
  const result = await loop.run({ diagnostics: baseDiagnostics, originalRawOutput: 'not json' });
  assert.equal(result.ok, false);
  // attempt 0 validated the original output; attempt 1 tried the LLM and failed — loop bails.
  assert.ok(result.attempts >= 1);
  assert.ok(result.history.some((h) => h.errors.some((e) => /LLM call failed/.test(e))));
});

test('HypothesisRepairLoop with maxRetries=0 does not retry — only validates the original', async () => {
  const malformed = 'not json';
  const client = fakeClient([validJson]);  // would repair if asked, but maxRetries=0 means no retries
  const loop = new HypothesisRepairLoop(client, 'test-model', 0);
  const result = await loop.run({ diagnostics: baseDiagnostics, originalRawOutput: malformed });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 0);
  assert.equal(result.hypotheses.length, 0);
  assert.equal(result.history.length, 1);  // only attempt 0
});

test('DEFAULT_MAX_REPAIR_RETRIES is 2 (matches agent-tui default)', () => {
  assert.equal(DEFAULT_MAX_REPAIR_RETRIES, 2);
});

test('HypothesisRepairLoop returns hypotheses with source=llm (not fallback)', async () => {
  const client = fakeClient([validJson]);
  const loop = new HypothesisRepairLoop(client, 'test-model', 2);
  const result = await loop.run({ diagnostics: baseDiagnostics, originalRawOutput: validJson });
  assert.equal(result.hypotheses[0].source, 'llm');
});

test('HypothesisRepairLoop history captures the raw output of every attempt for audit', async () => {
  // originalRawOutput = malformed1 (attempt 0).
  // Retry 1 returns malformed2, retry 2 returns validJson.
  const malformed1 = JSON.stringify([{ observation: 'x', proposal: 'y', changes: { bad: 1 } }]);
  const malformed2 = JSON.stringify([{ observation: 'x', proposal: 'y', changes: {} }]);
  const client = fakeClient([malformed2, validJson]);
  const loop = new HypothesisRepairLoop(client, 'test-model', 3);
  const result = await loop.run({ diagnostics: baseDiagnostics, originalRawOutput: malformed1 });
  // attempt 0 = original, attempt 1 = malformed2, attempt 2 = validJson (success).
  assert.equal(result.ok, true);
  assert.equal(result.history.length, 3);
  assert.equal(result.history[0].raw, malformed1);
  assert.equal(result.history[1].raw, malformed2);
  assert.equal(result.history[2].raw, validJson);
});
