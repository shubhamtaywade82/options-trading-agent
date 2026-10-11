import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotificationEngine, type AlertEvent } from '../src/ops/alerts.js';
import type { AuditInput } from '../src/ops/eventStore.js';
import { createOps } from '../src/ops/hooks.js';
import { findUnprotected } from '../src/risk/unprotected.js';
import type { Position } from '../src/types.js';

const pos = (over: Partial<Position> = {}): Position => ({
  id: 'p', symbol: 'ETHUSDT', side: 'LONG', strategy: 'EXECUTOR-ε', entry: 2743, qty: 121, mark: 2743, upnl: 0, upnlPct: 0, leverage: 3,
  marginType: 'ISOLATED', liqDistancePct: null, serverSl: '', serverTp: '', ...over,
});

test('a large position with no stop is reported with its size as a share of equity', () => {
  const [p] = findUnprotected([pos()], 100_000, 25);
  assert.equal(p.symbol, 'ETHUSDT');
  assert.ok(Math.abs(p.notionalUsdt - 121 * 2743) < 1e-6);
  assert.ok(p.equityPct > 330 && p.equityPct < 335);
  assert.equal(p.owner, 'EXECUTOR-ε');
});

test('a real stop protects; empty, zero and garbage stops do not', () => {
  assert.equal(findUnprotected([pos({ serverSl: '2600.5' })], 100_000, 25).length, 0);
  for (const bad of ['', '0', '0.0', 'abc', 'NaN']) assert.equal(findUnprotected([pos({ serverSl: bad })], 100_000, 25).length, 1, `serverSl=${bad}`);
});

test('small positions and a non-positive equity stay quiet; results are largest first', () => {
  assert.equal(findUnprotected([pos({ qty: 1, mark: 100 })], 100_000, 25).length, 0);
  assert.equal(findUnprotected([pos()], 0, 25).length, 0);
  const rows = findUnprotected([pos({ symbol: 'SOLUSDT', qty: 300, mark: 120 }), pos()], 100_000, 25);
  assert.deepEqual(rows.map((r) => r.symbol), ['ETHUSDT', 'SOLUSDT']);
});

const T0 = Date.UTC(2026, 8, 30);
function harness() {
  let now = T0;
  const audits: AuditInput[] = [];
  const sent: { event: AlertEvent; html: string }[] = [];
  const ops = createOps({
    isAudit: true, isAlerts: true, store: { append: (i) => { audits.push(i); } },
    engine: new NotificationEngine(undefined, { now: () => now }),
    send: async (event, html) => { sent.push({ event, html }); return true; }, now: () => now,
  });
  return { ops, sent, audits, advance: (ms: number) => { now += ms; } };
}
const exposed = (qty = 121) => findUnprotected([pos({ qty })], 100_000, 25);

test('an unprotected position raises one CRITICAL alert, not one per loop', () => {
  const { ops, sent, audits } = harness();
  ops.onUnprotected(exposed(), 100_000);
  ops.onUnprotected(exposed(122), 100_000); // same symbol/side, size drifted
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.severity, 'CRITICAL');
  assert.equal(sent[0].event.class, 'SYSTEM');
  assert.match(sent[0].html, /POSITION WITHOUT A STOP/);
  assert.match(sent[0].html, /ETHUSDT LONG/);
  assert.deepEqual(audits.map((a) => a.type), ['unprotected']);
});

test('it reminds after six hours, and announces again when the set of positions changes', () => {
  const { ops, sent, advance } = harness();
  ops.onUnprotected(exposed(), 100_000);
  advance(5 * 3_600_000);
  ops.onUnprotected(exposed(), 100_000);
  assert.equal(sent.length, 1);
  advance(2 * 3_600_000);
  ops.onUnprotected(exposed(), 100_000);
  assert.equal(sent.length, 2);
  ops.onUnprotected(findUnprotected([pos(), pos({ symbol: 'BTCUSDT', qty: 3.8, mark: 85_000 })], 100_000, 25), 100_000);
  assert.equal(sent.length, 3);
});

test('once the exposure is gone a new one is announced immediately', () => {
  const { ops, sent } = harness();
  ops.onUnprotected(exposed(), 100_000);
  ops.onUnprotected([], 100_000);
  ops.onUnprotected(exposed(), 100_000);
  assert.equal(sent.length, 2);
});
