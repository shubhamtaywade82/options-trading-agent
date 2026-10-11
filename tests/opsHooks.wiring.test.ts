import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { NotificationEngine } from '../src/ops/alerts.js';
import { createOps, type OpsDeps, type OpsHooks } from '../src/ops/hooks.js';
import { KillSwitch } from '../src/ops/killSwitch.js';
import { announceStartup, buildOps, nextDigestAt, scheduleDailyDigest } from '../src/runtime/opsHooks.js';
import type { RiskDecision, Signal, TradeRecord } from '../src/types.js';

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const signal: Signal = { id: 'sig1', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.8, entry: 100, stopLoss: 98, takeProfit: 106, reason: 'ema cross', ts: T0 };
const approved: RiskDecision = { approved: true, positionSizeUsdt: 5_000, leverage: 8, marginType: 'ISOLATED', liqBufferAtr: 3, reason: 'ok' };
const filled = { ts: T0, agent: 'EXECUTOR-ε' as const, msg: 'FILLED', level: 'success' as const };
const trade: TradeRecord = { symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 98, qty: 1, pnl: -2, reason: 'STOP LOSS', closedAt: T0 + MINUTE_MS, initialRisk: 2 };
const flat = { positions: [], marks: {} };
const venue = { name: 'paper_exchange' as const, accountId: 'a', state: 'down' as const, lastError: 'x', lastSyncAt: 0 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fireAll(ops: OpsHooks): void {
  ops.onSignal(signal);
  ops.onGate(signal, approved);
  ops.onGate(signal, { ...approved, approved: false, reason: 'no' });
  ops.onRefusal(signal, 'no');
  ops.onVeto(signal, 'no');
  ops.onOrder(signal, approved, filled, flat);
  ops.onExit([trade]);
  ops.onVenueState(venue, 'connected');
  ops.onCircuit('NORMAL', 'HALTED', { dailyLossPercent: 1, drawdownPercent: 1, lossStreak: 1 } as never);
  ops.onLoopCrash(new Error('boom'));
  ops.onKillSwitch({ halted: true, reason: 'manual', at: T0 });
  ops.digest({ trades: [trade], initialEquity: 100_000 });
}

const boom = (): never => { throw new Error('ops backend exploded'); };
const working: OpsDeps = {
  isAudit: true, isAlerts: true, now: () => T0,
  store: { append: () => {} },
  engine: new NotificationEngine(undefined, { now: () => T0 }),
  send: async () => true,
};

const BROKEN: Array<[string, Partial<OpsDeps>]> = [
  ['event store', { store: { append: boom } }],
  ['alert engine', { engine: { submit: boom } }],
  ['sender that throws', { send: boom }],
  ['sender that rejects', { send: () => Promise.reject(new Error('telegram down')) }],
];

for (const [name, broken] of BROKEN) {
  test(`should never let a failing ${name} reach the loop`, async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      fireAll(createOps({ ...working, ...broken }));
      await flush();
    } finally {
      process.off('unhandledRejection', record);
    }
    assert.deepEqual(unhandled, []);
  });
}

test('should still write the audit line when only the sender fails', () => {
  const lines: unknown[] = [];
  fireAll(createOps({ ...working, store: { append: (input) => { lines.push(input); } }, send: boom }));
  assert.ok(lines.length >= 10);
});

test('should touch nothing when both flags are off', async () => {
  const touched: string[] = [];
  const spy = (name: string) => () => { touched.push(name); throw new Error(name); };
  const ops = createOps({ isAudit: false, isAlerts: false, store: { append: spy('store') }, engine: { submit: spy('engine') }, send: spy('send') });
  fireAll(ops);
  await flush();
  assert.deepEqual(touched, []);
});

test('should only write audit lines when alerts are off and only alert when audit is off', async () => {
  const audits: unknown[] = [];
  const sends: unknown[] = [];
  const base = { ...working, store: { append: (input: unknown) => { audits.push(input); } }, send: async () => { sends.push(1); return true; } };
  fireAll(createOps({ ...base, isAlerts: false }));
  assert.ok(audits.length > 0 && sends.length === 0);
  audits.length = 0;
  fireAll(createOps({ ...base, isAudit: false }));
  await flush();
  assert.ok(audits.length === 0 && sends.length > 0);
});

function tempConfig(over: Partial<{ audit: boolean; alerts: boolean }> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-wiring-'));
  return { audit: false, alerts: false, eventsPath: path.join(dir, 'events.jsonl'), notificationsPath: path.join(dir, 'notifications.json'), ...over };
}

test('should write no file, call no fetch and start no timer when the flags are off', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const cfg = tempConfig();
    const fetchCalls: string[] = [];
    const fetchImpl = (async (url: string) => { fetchCalls.push(url); return { ok: true }; }) as unknown as typeof fetch;
    let accountReads = 0;
    const ops = buildOps({ log: () => {}, seedTrades: [], config: cfg, telegram: { fetchImpl, env: { TELEGRAM_TRADING_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' } }, now: () => T0 });
    ops.start({ getTrades: () => [trade], getAccount: async () => { accountReads += 1; return { initialEquity: 1 }; } });
    fireAll(ops);
    mock.timers.tick(3 * DAY_MS);
    await flush();
    assert.equal(existsSync(cfg.eventsPath), false);
    assert.deepEqual(fetchCalls, []);
    assert.equal(accountReads, 0);
    ops.stop();
  } finally {
    mock.timers.reset();
  }
});

test('should write audit lines sharing one decisionId and log dry-run cards, without any fetch', async () => {
  const cfg = tempConfig({ audit: true, alerts: true });
  const logged: string[] = [];
  let fetches = 0;
  const fetchImpl = (async () => { fetches += 1; return { ok: true }; }) as unknown as typeof fetch;
  const ops = buildOps({ log: (line) => logged.push(line), seedTrades: [], config: cfg, telegram: { fetchImpl, env: { TELEGRAM_DRY_RUN: '1' } }, now: () => T0 });

  ops.onSignal(signal);
  ops.onGate(signal, approved);
  ops.onOrder(signal, approved, filled, flat);
  ops.onExit([trade]);
  await flush();

  const lines = readFileSync(cfg.eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; decisionId: string });
  assert.deepEqual(lines.map((l) => l.type), ['signal', 'gate', 'order', 'exit', 'journal']);
  assert.deepEqual([...new Set(lines.map((l) => l.decisionId))], ['sig1']);
  assert.equal(fetches, 0);
  assert.ok(logged.length >= 3 && logged.every((l) => l.startsWith('[telegram dry-run]') && !l.includes('\n')), logged.join('\n'));
});

test('should schedule the digest for the next 00:05 UTC', () => {
  const day = Date.UTC(2026, 8, 22);
  assert.equal(nextDigestAt(day - 1), day + 5 * MINUTE_MS);
  assert.equal(nextDigestAt(day), day + 5 * MINUTE_MS);
  assert.equal(nextDigestAt(day + 5 * MINUTE_MS), day + DAY_MS + 5 * MINUTE_MS);
  assert.equal(nextDigestAt(day + 23 * 3_600_000), day + DAY_MS + 5 * MINUTE_MS);
});

test('should send the digest at 00:05 UTC each day from the journal, and stop when cancelled', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let now = Date.UTC(2026, 8, 22, 23, 0, 0);
    const digests: unknown[] = [];
    const hooks = { digest: (input: unknown) => { digests.push(input); } };
    const source = { getTrades: () => [trade], getAccount: async () => ({ initialEquity: 100_000 }) };
    const cancel = scheduleDailyDigest(hooks, source, { now: () => now, log: () => {} });

    now = Date.UTC(2026, 8, 23, 0, 5, 0);
    mock.timers.tick(65 * MINUTE_MS);
    await flush();
    assert.deepEqual(digests, [{ trades: [trade], initialEquity: 100_000, at: Date.UTC(2026, 8, 23, 0, 5) }]);

    now += DAY_MS;
    mock.timers.tick(DAY_MS);
    await flush();
    assert.equal(digests.length, 2);
    assert.equal((digests[1] as { at: number }).at, Date.UTC(2026, 8, 24, 0, 5));

    cancel();
    mock.timers.tick(3 * DAY_MS);
    await flush();
    assert.equal(digests.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test('should skip the digest and log why when the account cannot be read', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logged: string[] = [];
    const digests: unknown[] = [];
    const source = { getTrades: () => [], getAccount: () => Promise.reject(new Error('venue down')) };
    scheduleDailyDigest({ digest: (input) => { digests.push(input); } }, source, { now: () => T0, log: (line) => logged.push(line) });
    mock.timers.tick(DAY_MS);
    await flush();
    assert.deepEqual(digests, []);
    assert.match(logged[0], /digest skipped.*venue down/i);
  } finally {
    mock.timers.reset();
  }
});

for (const [flags, expectAudit] of [[{}, false], [{ audit: true }, true]] as const) {
  test(`should ${expectAudit ? 'audit' : 'not audit'} a persisted halt announced at start when audit is ${expectAudit ? 'on' : 'off'}`, () => {
    const cfg = tempConfig(flags);
    const killSwitch = new KillSwitch(path.join(path.dirname(cfg.eventsPath), 'kill-switch.json'), () => T0);
    killSwitch.toggle('manual');
    const ops = buildOps({ log: () => {}, seedTrades: [], config: cfg, now: () => T0 });
    announceStartup({ killSwitch, hooks: ops, warn: () => {}, mode: 'paper', isEngineOn: false });
    assert.equal(existsSync(cfg.eventsPath), expectAudit);
    if (expectAudit) assert.equal((JSON.parse(readFileSync(cfg.eventsPath, 'utf-8').trim()) as { type: string }).type, 'killswitch');
  });
}
