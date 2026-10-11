import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotificationEngine, type AlertEvent } from '../src/ops/alerts.js';
import type { AuditInput } from '../src/ops/eventStore.js';
import { createOps, type OpsDeps, type OpsHooks } from '../src/ops/hooks.js';
import { sendAlert } from '../src/ops/telegram.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { summarizePerformance } from '../src/binance/performance.js';
import { digestCard } from '../src/ops/cards.js';
import type { RiskDecision, Signal, TradeRecord } from '../src/types.js';

setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 });

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
const DAY_MS = 86_400_000;

interface Sent { event: AlertEvent; html: string }

function harness(over: Partial<OpsDeps> = {}) {
  let now = T0;
  const audits: AuditInput[] = [];
  const sent: Sent[] = [];
  const deps: OpsDeps = {
    isAudit: true, isAlerts: true,
    store: { append: (input) => { audits.push(input); } },
    engine: new NotificationEngine(undefined, { now: () => now }),
    send: async (event, html) => { sent.push({ event, html }); return true; },
    now: () => now,
    ...over,
  };
  const ops: OpsHooks = createOps(deps);
  return { ops, audits, sent, advance: (ms: number) => { now += ms; } };
}

const signal = (over: Partial<Signal> = {}): Signal =>
  ({ id: 'sig1', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.8, entry: 100, stopLoss: 98, takeProfit: 106, reason: 'ema cross', ts: T0, ...over });
const approved: RiskDecision = { approved: true, positionSizeUsdt: 5_000, leverage: 8, marginType: 'ISOLATED', liqBufferAtr: 3, reason: 'size=$5000 lev=8x' };
const refused = (reason: string): RiskDecision => ({ ...approved, approved: false, positionSizeUsdt: 0, reason });
const filled = { ts: T0, agent: 'EXECUTOR-ε' as const, msg: 'FILLED BUY BTCUSDT qty=50.000 orderId=1', level: 'success' as const };
const trade = (over: Partial<TradeRecord> = {}): TradeRecord =>
  ({ symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 98, qty: 1, pnl: -2, reason: 'STOP LOSS', closedAt: T0 + 60_000, initialRisk: 2, ...over });
const flat = { positions: [], marks: {} };
const held = (side: 'LONG' | 'SHORT') => ({ positions: [{ symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ' as const, side }] as never[], marks: {} });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const decisionIds = (audits: AuditInput[]) => new Set(audits.map((a) => a.decisionId));

test('should carry one decisionId from signal through gate, order, exit and journal', () => {
  const { ops, audits } = harness({ seedTrades: [] });
  ops.onSignal(signal());
  ops.onGate(signal(), approved);
  ops.onOrder(signal(), approved, filled, flat);
  ops.onExit([trade()]);

  assert.deepEqual(audits.map((a) => a.type), ['signal', 'gate', 'order', 'exit', 'journal']);
  assert.deepEqual([...decisionIds(audits)], ['sig1']);
  assert.ok(audits.every((a) => a.symbol === 'BTCUSDT'));
});

test('should keep audit payloads small and JSON-safe', () => {
  const { ops, audits } = harness();
  ops.onSignal(signal());
  ops.onGate(signal(), approved);
  ops.onOrder(signal(), approved, filled, flat);
  ops.onExit([trade()]);
  for (const audit of audits) {
    assert.deepEqual(JSON.parse(JSON.stringify(audit.payload)), audit.payload);
    assert.ok(Object.values(audit.payload).every((v) => v === undefined || ['number', 'string', 'boolean'].includes(typeof v)), audit.type);
  }
});

test('should raise a SIGNAL-severity SIGNAL alert when the gate accepts and a TRADE alert when it fills', () => {
  const { ops, sent } = harness();
  ops.onGate(signal(), approved);
  ops.onOrder(signal(), approved, filled, flat);

  const [accepted, fill] = sent.map((s) => s.event);
  assert.deepEqual([accepted.class, accepted.severity, accepted.stateTo], ['SIGNAL', 'SIGNAL', 'ACCEPTED']);
  assert.deepEqual([fill.class, fill.severity, fill.fingerprint], ['TRADE', 'SIGNAL', 'TRADE:sig1:fill']);
  assert.match(sent[1].html, /POSITION OPENED/);
});

test('should describe a scale-in and a flip by the position already held', () => {
  const scale = harness();
  scale.ops.onOrder(signal(), approved, filled, held('LONG'));
  assert.match(scale.sent[0].html, /SCALE-IN/);

  const flip = harness();
  flip.ops.onOrder(signal(), approved, filled, held('SHORT'));
  assert.match(flip.sent[0].html, /FLIPPED/);
});

test('should attribute the exit of a flipped position to the decision that opened it', () => {
  const { ops, audits } = harness();
  ops.onOrder(signal({ id: 'old' }), approved, filled, flat);
  ops.onOrder(signal({ id: 'new', type: 'OPEN_SHORT' }), approved, filled, held('LONG'));
  ops.onExit([trade({ reason: 'FLIP' })]);
  ops.onExit([trade({ reason: 'FLIP' }), trade({ reason: 'STOP LOSS', closedAt: T0 + 120_000 })]);

  const exits = audits.filter((a) => a.type === 'exit');
  assert.deepEqual(exits.map((a) => a.decisionId), ['old', 'new']);
});

test('should map an exit to an IMPORTANT TRADE alert with reason, PnL and R', () => {
  const { ops, sent } = harness();
  ops.onExit([trade()]);
  const { event, html } = sent[0];
  assert.deepEqual([event.class, event.severity, event.fingerprint], ['TRADE', 'IMPORTANT', `TRADE:BTCUSDT:${T0 + 60_000}:exit`]);
  assert.match(html, /STOP LOSS/);
  assert.match(html, /-2\.00 USDT/);
  assert.match(html, /-1\.00R/);
});

test('should escalate a liquidation to CRITICAL', () => {
  const { ops, sent } = harness();
  ops.onExit([trade({ reason: 'LIQUIDATED' })]);
  assert.equal(sent[0].event.severity, 'CRITICAL');
});

test('should ignore trades already in the journal at start and report each new one once', () => {
  const old = trade({ closedAt: T0 - 1_000 });
  const { ops, sent, audits } = harness({ seedTrades: [old] });
  ops.onExit([old]);
  assert.equal(sent.length, 0);
  ops.onExit([old, trade()]);
  ops.onExit([old, trade()]);
  assert.equal(sent.length, 1);
  assert.equal(audits.filter((a) => a.type === 'exit').length, 1);
});

test('should suppress alerts for past closed trades arrived after startup without seedTrades', () => {
  const historical = trade({ closedAt: T0 - 5_000 });
  const { ops, sent, audits } = harness({ seedTrades: [] });
  ops.onExit([historical]);
  assert.equal(sent.length, 0);
  assert.equal(audits.filter((a) => a.type === 'exit').length, 0);
  ops.onExit([historical, trade({ closedAt: T0 + 1_000 })]);
  assert.equal(sent.length, 1);
  assert.equal(audits.filter((a) => a.type === 'exit').length, 1);
});

test('should turn a gate refusal into a WATCH SIGNAL alert and an audit refusal', () => {
  const { ops, sent, audits } = harness();
  ops.onGate(signal(), refused('liq buffer 0.7x ATR < 2x'));
  ops.onRefusal(signal(), 'liq buffer 0.7x ATR < 2x');

  assert.deepEqual(audits.map((a) => a.type), ['gate', 'refusal']);
  assert.deepEqual([sent[0].event.class, sent[0].event.severity, sent[0].event.stateTo], ['SIGNAL', 'WATCH', 'REFUSED']);
  assert.match(sent[0].html, /liq buffer/);
});

test('should turn a veto into a WATCH SIGNAL alert', () => {
  const { ops, sent, audits } = harness();
  ops.onVeto(signal(), 'overextended');
  assert.deepEqual(audits.map((a) => a.type), ['veto']);
  assert.deepEqual([sent[0].event.severity, sent[0].event.stateTo], ['WATCH', 'VETOED']);
});

test('should count an executor refusal the same as a gate refusal', () => {
  const { ops, audits } = harness();
  ops.onOrder(signal(), approved, { ...filled, level: 'warn', msg: 'EXECUTION REFUSED: BTCUSDT is held by X' }, flat);
  assert.deepEqual(audits.map((a) => a.type), ['order', 'refusal']);
});

test('should not repeat a signal alert for the same symbol, agent and reason inside the signal cooldown', () => {
  const engine = new NotificationEngine(undefined, { now: () => T0, cooldownMs: { SIGNAL: 900_000 } });
  const { ops, sent } = harness({ engine });
  ops.onRefusal(signal({ id: 'a' }), 'liq buffer 0.7x ATR < 2x');
  ops.onRefusal(signal({ id: 'b' }), 'liq buffer 0.9x ATR < 2x');
  assert.equal(sent.length, 1);
});

test('should announce a standing risk block once, not again after the signal cooldown lapses', () => {
  let now = T0;
  const engine = new NotificationEngine(undefined, { now: () => now, cooldownMs: { SIGNAL: 900_000 } });
  const { ops, sent } = harness({ engine, now: () => now });
  ops.onRefusal(signal({ id: 'a' }), 'symbol exposure 127% > 100%');
  now += 20 * 60_000;
  ops.onRefusal(signal({ id: 'b' }), 'symbol exposure 130% > 100%');
  assert.equal(sent.length, 1);
  ops.onRefusal(signal({ id: 'c' }), 'gross exposure 196% > 150%');
  assert.equal(sent.length, 2);
  now += 4 * 60 * 60_000;
  ops.onRefusal(signal({ id: 'd' }), 'symbol exposure 131% > 100%');
  assert.equal(sent.length, 3);
});

test('should alert a signal without levels (a hedge) in the audit trail only', () => {
  const { ops, sent, audits } = harness();
  ops.onGate(signal({ type: 'OPEN_HEDGE', entry: undefined, stopLoss: undefined, takeProfit: undefined }), approved);
  assert.equal(sent.length, 0);
  assert.equal(audits.length, 1);
});

test('should map venue degraded, down and recovered to SYSTEM alerts, silent about the first healthy read', () => {
  const { ops, sent } = harness();
  const venue = (state: 'connected' | 'degraded' | 'down') => ({ name: 'paper_exchange' as const, accountId: 'a', state, lastError: 'boom', lastSyncAt: 0 });
  ops.onVenueState(venue('connected'), 'connected');
  ops.onVenueState(venue('degraded'), 'connected');
  ops.onVenueState(venue('down'), 'connected');
  ops.onVenueState(venue('connected'), 'connected');

  assert.deepEqual(sent.map((s) => [s.event.class, s.event.severity, s.event.fingerprint]), [
    ['SYSTEM', 'IMPORTANT', 'SYSTEM:venue:degraded'],
    ['SYSTEM', 'CRITICAL', 'SYSTEM:venue:down'],
    ['SYSTEM', 'IMPORTANT', 'SYSTEM:venue:recovered'],
  ]);
});

test('should dedupe a venue that flaps back to down inside the SYSTEM cooldown', () => {
  const { ops, sent, advance } = harness();
  const venue = (state: 'degraded' | 'down') => ({ name: 'paper_exchange' as const, accountId: 'a', state, lastError: null, lastSyncAt: 0 });
  ops.onVenueState(venue('down'), 'connected');
  ops.onVenueState(venue('degraded'), 'connected');
  advance(1_000);
  ops.onVenueState(venue('down'), 'connected');
  assert.deepEqual(sent.map((s) => s.event.fingerprint), ['SYSTEM:venue:down', 'SYSTEM:venue:degraded']);
});

test('should alert a websocket that drops after having been up, not one that never connected', () => {
  const { ops, sent } = harness();
  ops.onVenueState(null, 'down');
  assert.equal(sent.length, 0);
  ops.onVenueState(null, 'connected');
  ops.onVenueState(null, 'down');
  assert.deepEqual(sent.map((s) => [s.event.fingerprint, s.event.severity]), [['SYSTEM:ws:down', 'IMPORTANT']]);
});

test('should map circuit changes to SYSTEM alerts, CRITICAL from HALTED up', () => {
  const { ops, sent, audits } = harness();
  const snapshot = { dailyLossPercent: 3.1, drawdownPercent: 1, lossStreak: 2 } as never;
  ops.onCircuit('NORMAL', 'CAUTION', snapshot);
  ops.onCircuit('CAUTION', 'HALTED', snapshot);
  ops.onCircuit('HALTED', 'EMERGENCY', snapshot);
  assert.deepEqual(sent.map((s) => s.event.severity), ['IMPORTANT', 'CRITICAL', 'CRITICAL']);
  assert.deepEqual(sent.map((s) => s.event.fingerprint), ['SYSTEM:circuit:CAUTION', 'SYSTEM:circuit:HALTED', 'SYSTEM:circuit:EMERGENCY']);
  assert.equal(audits.length, 3);
});

test('should raise CRITICAL alerts for a loop crash and for kill-switch changes', () => {
  const { ops, sent, audits } = harness();
  ops.onLoopCrash(new Error('boom <script>'));
  ops.onKillSwitch({ halted: true, reason: 'manual', at: T0 });
  ops.onKillSwitch({ halted: false, reason: 'manual', at: T0 + 1 });

  assert.deepEqual(sent.map((s) => [s.event.class, s.event.severity]), [['SYSTEM', 'CRITICAL'], ['SYSTEM', 'CRITICAL'], ['SYSTEM', 'CRITICAL']]);
  assert.match(sent[0].html, /boom &lt;script&gt;/);
  assert.match(sent[1].html, /HALTED/);
  assert.match(sent[2].html, /RESUMED/);
  assert.deepEqual(audits.map((a) => a.type), ['crash', 'killswitch', 'killswitch']);
});

test('should send every TRADE alert audibly, never silent', async () => {
  const bodies: Array<{ disable_notification: boolean }> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true };
  }) as unknown as typeof fetch;
  const env = { TELEGRAM_TRADING_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' };
  const { ops } = harness({ send: (event, html) => sendAlert(event, html, { fetchImpl, env }) });

  ops.onOrder(signal(), approved, filled, flat);
  ops.onExit([trade(), trade({ reason: 'LIQUIDATED', closedAt: T0 + 5 })]);
  await flush();

  assert.equal(bodies.length, 3);
  assert.ok(bodies.every((b) => b.disable_notification === false));
});

test('should build the digest from the previous UTC day of the journal and reset refusal counts', () => {
  const dayStart = Math.floor(T0 / DAY_MS) * DAY_MS - DAY_MS;
  const before = trade({ pnl: -50, closedAt: dayStart - 1_000 });
  const day = [trade({ pnl: 120, closedAt: dayStart + 3_600_000 }), trade({ pnl: -30, symbol: 'ETHUSDT', closedAt: dayStart + 7_200_000 })];
  const { ops, sent: all, audits, advance } = harness({ seedTrades: [before, ...day] });
  ops.onRefusal(signal(), 'stop too tight');

  ops.digest({ trades: [before, ...day, trade({ closedAt: T0 })], initialEquity: 100_000 });
  advance(DAY_MS);
  ops.digest({ trades: [before, ...day], initialEquity: 100_000 });

  const sent = all.filter((s) => s.event.class === 'RESEARCH');
  const startEquity = 100_000 - 50;
  const summary = summarizePerformance(day, startEquity, startEquity + 90, T0);
  const expected = digestCard({ period: '2026-09-21 UTC', summary, trades: day, refusals: { 'stop too tight': 1 }, at: T0 });
  assert.equal(sent[0].html, expected);
  assert.match(sent[0].html, /\+90\.00 USDT/);
  assert.match(sent[0].html, /2 · win rate 50\.0%/);
  assert.match(sent[0].html, /stop too tight: 1/);
  assert.doesNotMatch(sent[1]?.html ?? '', /Refusals/);
  assert.deepEqual([sent[0].event.class, sent[0].event.severity], ['RESEARCH', 'WATCH']);
  assert.equal(audits.filter((a) => a.type === 'digest').length, 2);
});

test('should label the digest by the scheduled instant even when the clock reads a moment early', () => {
  const { ops, sent } = harness();
  const scheduled = Date.UTC(2026, 8, 23, 0, 5);
  ops.digest({ trades: [], initialEquity: 100_000, at: scheduled });
  assert.match(sent[0].html, /2026-09-22 UTC/);
});

test('should print no NaN, Infinity or undefined in a digest of an empty or all-winning day', () => {
  const dayStart = Math.floor(T0 / DAY_MS) * DAY_MS - DAY_MS;
  for (const trades of [[], [trade({ pnl: 40, closedAt: dayStart + 1 }), trade({ pnl: 10, closedAt: dayStart + 2 })]]) {
    const { ops, sent } = harness();
    ops.digest({ trades, initialEquity: 100_000 });
    assert.doesNotMatch(sent[0].html, /NaN|Infinity|undefined|null/);
    assert.match(sent[0].html, /Profit factor:<\/b> —/);
  }
});

test('should still attribute a flip exit to the old decision when the journal is read before the order is reported', () => {
  const { ops, audits } = harness();
  ops.onOrder(signal({ id: 'old' }), approved, filled, flat);
  ops.onExit([trade({ reason: 'FLIP' })]);
  ops.onOrder(signal({ id: 'new', type: 'OPEN_SHORT' }), approved, filled, held('LONG'));
  ops.onExit([trade({ reason: 'FLIP' }), trade({ reason: 'STOP LOSS', closedAt: T0 + 120_000 })]);
  assert.deepEqual(audits.filter((a) => a.type === 'exit').map((a) => a.decisionId), ['old', 'new']);
});
