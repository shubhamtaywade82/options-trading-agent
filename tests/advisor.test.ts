import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { OllamaTradeAdvisor, type AdvisorChatClient, type EntrySnapshot } from '../src/llm/advisor.js';

const SNAPSHOT: EntrySnapshot = {
  underlying: 'NIFTY',
  direction: 'BULLISH',
  optionSymbol: 'NIFTY 22450 CE',
  strike: 22_450,
  expiry: '2026-10-15',
  daysToExpiry: 3,
  minuteOfDayIst: 600,
  spot: 22_460,
  entryReference: 101,
  stopLossPrice: 70.7,
  targetPrice: 162.1,
  spreadPct: 0.9,
  openInterest: 500_000,
  lots: 1,
  riskInr: 2_000,
  signalReasons: ['ORB high broken'],
};

interface Captured {
  request: Record<string, unknown> | undefined;
}

/** Mirrors the SDK contract: chatWithSchema resolves only with a value that satisfies the schema. */
function fakeClient(behaviour: () => Promise<unknown>, captured: Captured): AdvisorChatClient {
  return {
    chatWithSchema: async (request: Record<string, unknown>, schema: { parse: (value: unknown) => unknown }) => {
      captured.request = request;
      return schema.parse(await behaviour());
    },
  } as unknown as AdvisorChatClient;
}

describe('OllamaTradeAdvisor', () => {
  it('passes an explicit ENTER through with its source marked as the LLM', async () => {
    const captured: Captured = { request: undefined };
    const advisor = new OllamaTradeAdvisor(
      fakeClient(async () => ({ decision: 'ENTER', confidence: 0.7, reason: 'clean breakout' }), captured),
      'qwen3:8b',
      8_000,
    );
    const verdict = await advisor.review(SNAPSHOT);
    assert.deepEqual(verdict, { decision: 'ENTER', confidence: 0.7, reason: 'clean breakout', source: 'llm' });
    assert.equal(captured.request?.['model'], 'qwen3:8b');
    assert.equal(captured.request?.['timeoutMs'], 8_000);
    assert.deepEqual(captured.request?.['options'], { temperature: 0 });
  });

  it('fails closed to SKIP when the endpoint errors, times out, or is unreachable', async () => {
    const captured: Captured = { request: undefined };
    const advisor = new OllamaTradeAdvisor(
      fakeClient(async () => {
        throw new Error('connect ECONNREFUSED');
      }, captured),
      'qwen3:8b',
      8_000,
    );
    const verdict = await advisor.review(SNAPSHOT);
    assert.equal(verdict.decision, 'SKIP');
    assert.equal(verdict.source, 'fail_closed');
    assert.match(verdict.reason, /ECONNREFUSED/);
  });

  it('fails closed to SKIP when the reply does not match the schema', async () => {
    const captured: Captured = { request: undefined };
    const advisor = new OllamaTradeAdvisor(
      fakeClient(async () => ({ decision: 'MAYBE', confidence: 2, reason: '' }), captured),
      'qwen3:8b',
      8_000,
    );
    const verdict = await advisor.review(SNAPSHOT);
    assert.equal(verdict.decision, 'SKIP');
    assert.equal(verdict.source, 'fail_closed');
  });

  it('treats an explicit SKIP from the model as a veto', async () => {
    const captured: Captured = { request: undefined };
    const advisor = new OllamaTradeAdvisor(
      fakeClient(async () => ({ decision: 'SKIP', confidence: 0.9, reason: 'spot stretched' }), captured),
      'qwen3:8b',
      8_000,
    );
    assert.equal((await advisor.review(SNAPSHOT)).decision, 'SKIP');
  });
});
