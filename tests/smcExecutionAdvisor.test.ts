import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmcExecutionAdvisor } from '../src/strategies/smc-ml/SmcExecutionAdvisor.js';
import type { SMCDecisionContext } from '../src/strategies/smc-ml/types.js';

const context = (): SMCDecisionContext => ({
  analysis: {
    symbol: 'BTCUSDT', generatedAt: 2, price: 100, timeframes: {},
    confluence: { direction: 'LONG', score: 0.8, frameScores: [], agreement: 1, reasons: ['1h: BOS bullish'], noTradeReasons: [] },
    candidates: [{
      direction: 'LONG', entrySource: 'MARKET', entryPrice: 100, protectedSwing: 98, atr14: 1, stopLoss: 97, tp1: 103, tp2: 106,
      riskPerUnit: 3, riskAtr: 3, sourceBreak: { type: 'BOS', timeframe: '1h', level: 99, time: 1, retestProbability: 0.6 },
    }],
  },
  portfolioState: 'NO_POSITION', positionQty: 0, currentMark: 100,
});

type Seen = { model: string; prompt: string; format?: 'json' };
const advisorWith = (host: string, reply: () => Promise<string>, seen: Seen[] = []) =>
  new SmcExecutionAdvisor({ host, model: 'm', client: { generateText: async (request: Seen) => { seen.push(request); return reply(); } } });

const HOLD_REASON = 'LLM unavailable or invalid; autonomous execution is fail-closed.';

test('should open on a valid decision and request JSON mode from a local host', async () => {
  const seen: Seen[] = [];
  const decision = await advisorWith('http://127.0.0.1:11434', async () => '{"action":"OPEN","side":"LONG","entrySource":"MARKET","reason":"aligned"}', seen).decide(context());
  assert.equal(decision.action, 'OPEN');
  assert.deepEqual([seen[0]?.model, seen[0]?.format], ['m', 'json']);
});

test('should leave the format out for a cloud host and still read a fenced reply', async () => {
  const seen: Seen[] = [];
  const decision = await advisorWith('https://ollama.com', async () => '```json\n{"action":"HOLD","side":"NONE","entrySource":null,"reason":"stale"}\n```', seen).decide(context());
  assert.equal(decision.action, 'HOLD');
  assert.equal(seen[0]?.format, undefined);
});

test('should fail closed to HOLD on a transport error, a timeout, and an unparseable reply', async () => {
  const never = () => new Promise<string>(() => undefined);
  const slow = new SmcExecutionAdvisor({ host: 'http://127.0.0.1:11434', model: 'm', timeoutMs: 20, client: { generateText: never } });
  const cases = [
    advisorWith('http://127.0.0.1:11434', async () => { throw new Error('boom'); }),
    slow,
    advisorWith('http://127.0.0.1:11434', async () => 'not json'),
  ];
  for (const advisor of cases) {
    const decision = await advisor.decide(context());
    assert.deepEqual([decision.action, decision.reason], ['HOLD', HOLD_REASON]);
  }
});

test('should HOLD, with the validator reason, when the model picks an entry source that is not a candidate', async () => {
  const decision = await advisorWith('http://127.0.0.1:11434', async () => '{"action":"OPEN","side":"LONG","entrySource":"NOT_A_CANDIDATE","reason":"x"}').decide(context());
  assert.equal(decision.action, 'HOLD');
});
