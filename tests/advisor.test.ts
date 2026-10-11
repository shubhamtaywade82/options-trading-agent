import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { OllamaAdvisor, parseVerdict, type AdvisorClient } from '../src/ollama/advisor.js';
import { config } from '../src/config.js';

test('should return VETO with the model reason', () => {
  assert.deepEqual(parseVerdict('{"verdict":"VETO","reason":"extended entry"}'), { verdict: 'VETO', reason: 'extended entry' });
});

test('should proceed on an explicit PROCEED', () => {
  assert.equal(parseVerdict('{"verdict":"PROCEED","reason":"clean"}').verdict, 'PROCEED');
});

test('should VETO when the reply is not JSON or has an unknown verdict (fail-closed, issue #6)', () => {
  assert.equal(parseVerdict('sure, go ahead').verdict, 'VETO');
  assert.ok(parseVerdict('sure, go ahead').reason.startsWith('advisor'));
  assert.equal(parseVerdict('{"verdict":"MAYBE"}').verdict, 'VETO');
});

const snapshot = { symbol: 'BTCUSDT', side: 'LONG' as const, regime: 'HIGH' as const, distanceFromLineAtr: 1, rsi: 55, fundingRate: 0.0001, entry: 100, stopLoss: 95, takeProfit: 112 };

test('should flag an unknown verdict as a fail-closed VETO (issue #6)', () => {
  const result = parseVerdict('{"verdict":"MAYBE"}');
  assert.equal(result.verdict, 'VETO');
  assert.match(result.reason, /^advisor sent an unknown verdict/);
});

test('should re-ping an offline advisor after the interval and then use the model', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  let online = false;
  const client: AdvisorClient = {
    listModels: async () => { if (!online) throw new Error('down'); return {}; },
    generateText: async () => '{"verdict":"VETO","reason":"extended"}',
  };
  const advisor = new OllamaAdvisor(client);
  await new Promise((resolve) => setImmediate(resolve)); // constructor ping settles offline
  assert.equal((await advisor.veto(snapshot)).reason, 'advisor offline');
  online = true;
  mock.timers.setTime(61_000);
  assert.equal((await advisor.veto(snapshot)).verdict, 'VETO');
  mock.timers.reset();
});

test('should failover to second client if first client generate throws', async () => {
  let firstCalled = false;
  let secondCalled = false;
  const failingClient: AdvisorClient = {
    listModels: async () => ({}),
    generateText: async () => { firstCalled = true; throw new Error('429 rate limited'); },
  };
  const workingClient: AdvisorClient = {
    listModels: async () => ({}),
    generateText: async () => { secondCalled = true; return '{"verdict":"PROCEED","reason":"all good"}'; },
  };

  // Instantiate advisor and inject mock clients into pool
  const advisor = new OllamaAdvisor(failingClient);
  await new Promise((resolve) => setImmediate(resolve));
  (advisor as any).clients = [failingClient, workingClient];
  const verdict = await advisor.veto(snapshot);

  assert.equal(firstCalled, true);
  assert.equal(secondCalled, true);
  assert.equal(verdict.verdict, 'PROCEED');
  assert.equal(verdict.reason, 'all good');
});


// ---- tolerant parsing, JSON mode per host, generateJson ----

const withHost = async (host: string, run: () => Promise<void>): Promise<void> => {
  const previous = config.ollama.host;
  Object.assign(config.ollama, { host });
  try { await run(); } finally { Object.assign(config.ollama, { host: previous }); }
};
const onlineClient = (reply: string, seen: Array<Parameters<AdvisorClient['generateText']>[0]> = []): AdvisorClient => ({
  listModels: async () => ({}),
  generateText: async (request) => { seen.push(request); return reply; },
});
const ready = () => new Promise((resolve) => setImmediate(resolve));

test('should accept a verdict wrapped in a code fence or prose, but still fail closed on prose without JSON', () => {
  assert.deepEqual(parseVerdict('```json\n{"verdict":"VETO","reason":"extended"}\n```'), { verdict: 'VETO', reason: 'extended' });
  assert.equal(parseVerdict('Here you go: {"verdict":"PROCEED","reason":"ok"} done').verdict, 'PROCEED');
  assert.equal(parseVerdict('I would proceed').verdict, 'VETO');
});

test('should request JSON mode from a local host only', async () => {
  for (const [host, expectFormat] of [['http://127.0.0.1:11434', true], ['http://localhost:11434', true], ['https://ollama.com', false], ['http://gpu-box.example.net:11434', false]] as const) {
    await withHost(host, async () => {
      const seen: Array<Parameters<AdvisorClient['generateText']>[0]> = [];
      const advisor = new OllamaAdvisor(onlineClient('{"verdict":"PROCEED","reason":"ok"}', seen));
      await ready();
      await advisor.veto(snapshot);
      assert.equal(seen[0]?.format, expectFormat ? 'json' : undefined, host);
      assert.ok(seen[0] && !('stream' in seen[0]), 'the SDK text helper owns streaming');
    });
  }
});

test('should return parsed JSON from generateJson even when the model fences it, and null when it is not JSON', async () => {
  const fenced = new OllamaAdvisor(onlineClient('```json\n{"a":1}\n```'));
  await ready();
  assert.deepEqual(await fenced.generateJson<{ a: number }>('p'), { a: 1 });
  const chatty = new OllamaAdvisor(onlineClient('no json here'));
  await ready();
  assert.equal(await chatty.generateJson('p'), null);
});

test('should PROCEED with the error reason when the SDK rejects the request, never throw into the loop', async () => {
  const client: AdvisorClient = { listModels: async () => ({}), generateText: async () => { throw new Error('Structured output ("format") requests are not supported'); } };
  const advisor = new OllamaAdvisor(client);
  await ready();
  const verdict = await advisor.veto(snapshot);
  assert.equal(verdict.verdict, 'PROCEED');
  assert.match(verdict.reason, /^advisor error: /);
});

test('should round-robin across clients so one rate-limited key is not hammered', async () => {
  const calls: string[] = [];
  const named = (name: string): AdvisorClient => ({ listModels: async () => ({}), generateText: async () => { calls.push(name); return 'a sentence'; } });
  const advisor = new OllamaAdvisor(named('k1'));
  await ready();
  (advisor as unknown as { clients: AdvisorClient[] }).clients = [named('k1'), named('k2')];
  await advisor.ask('q');
  await advisor.ask('q');
  assert.deepEqual(calls, ['k1', 'k2']);
});
