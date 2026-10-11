import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotificationEngine, type AlertEvent } from '../src/ops/alerts.js';
import type { AuditInput } from '../src/ops/eventStore.js';
import { createOps, type OpsDeps } from '../src/ops/hooks.js';
import type { SetupMap } from '../src/decision/SetupEngine.js';

const T0 = Date.UTC(2026, 8, 25, 18, 0, 0);

const setup = (state: SetupMap['state'] = 'FORMING'): SetupMap => ({
  symbol: 'BTCUSDT',
  generatedAt: T0,
  mark: 100,
  state,
  bias: 'BULLISH',
  regime: 'TREND_UP',
  volatility: 'MEDIUM',
  positionPct: 70,
  location: 'PREMIUM',
  htfTrend: 'BULLISH',
  ltfTrend: 'BULLISH',
  lastBreak: null,
  nearestUpperLiquidity: 105,
  nearestLowerLiquidity: 98,
  crowding: 'SHORT_CROWDED',
  openInterestExpansion: true,
  takerAggressionRatio: 1.2,
  scenarios: [{
    id: 'breakout-btc-long-10500',
    kind: 'BREAKOUT_RETEST',
    direction: 'LONG',
    state: state === 'TRIGGERED' ? 'TRIGGERED' : 'FORMING',
    timeframe: '15m',
    entryLow: 104.8,
    entryHigh: 105.2,
    stopLoss: 104,
    target1: 107,
    target2: 110,
    trigger: '15m close above 105 + retest hold',
    invalidation: 'acceptance back below 105',
    flowHypothesis: 'short-crowding; squeeze/continuation hypothesis',
    expectedMove: { minMinutes: 20, maxMinutes: 80, thesisExpiryMinutes: 120, distanceAtr: 2 },
    sourceTime: T0,
    rewardRisk: 2.75,
  }],
  noTradeReasons: [],
});

interface Sent { event: AlertEvent; html: string }

function harness() {
  let now = T0;
  const audits: AuditInput[] = [];
  const sent: Sent[] = [];
  const deps: OpsDeps = {
    isAudit: true,
    isAlerts: true,
    store: { append: (input) => audits.push(input) },
    engine: new NotificationEngine(undefined, { now: () => now, cooldownMs: { SETUP: 900_000 } }),
    send: async (event, html) => { sent.push({ event, html }); return true; },
    now: () => now,
  };
  return { ops: createOps(deps), audits, sent, advance: (ms: number) => { now += ms; } };
}

test('setup hook emits a rich SETUP alert and audit event', () => {
  const { ops, audits, sent } = harness();
  ops.onSetup(setup());
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].event.class, sent[0].event.severity, sent[0].event.stateTo], ['SETUP', 'WATCH', 'FORMING']);
  assert.match(sent[0].html, /DERIVATIVES FLOW CONTEXT/);
  assert.deepEqual(audits.map((a) => a.type), ['setup']);
  assert.equal(audits[0].symbol, 'BTCUSDT');
});

test('setup hook makes a triggered setup audible and suppresses identical repeats during cooldown', () => {
  const { ops, sent, advance } = harness();
  ops.onSetup(setup('TRIGGERED'));
  ops.onSetup(setup('TRIGGERED'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.severity, 'SIGNAL');
  advance(900_000);
  ops.onSetup(setup('TRIGGERED'));
  assert.equal(sent.length, 2);
});

test('setup state transition from forming to triggered emits immediately despite cooldown', () => {
  const { ops, sent } = harness();
  ops.onSetup(setup('FORMING'));
  ops.onSetup(setup('TRIGGERED'));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => s.event.stateTo), ['FORMING', 'TRIGGERED']);
});

test('empty setup map is never sent', () => {
  const { ops, sent, audits } = harness();
  ops.onSetup({ ...setup(), scenarios: [], state: 'NO_TRADE' });
  assert.equal(sent.length, 0);
  assert.equal(audits.length, 0);
});

test('becoming ENTRY_ELIGIBLE after a TRIGGERED notice is announced despite the cooldown', () => {
  const { ops, sent } = harness();
  const triggered = setup('TRIGGERED');
  ops.onSetup(triggered);
  const eligible = { ...triggered, scenarios: triggered.scenarios.map((s) => ({ ...s, quality: { verdict: 'ENTRY_ELIGIBLE' as const, effectiveRr: 2, reasons: [], checks: { structure: 'PASS', location: 'PASS', trigger: 'PASS', evidence: 'PASS', flow: 'PASS', rr: 'PASS', freshness: 'PASS' } as const } })) };
  ops.onSetup(eligible);
  assert.equal(sent.length, 2);
  ops.onSetup(eligible);
  assert.equal(sent.length, 2);
});
