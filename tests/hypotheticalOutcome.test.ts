import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionRecord } from '../src/decision/DecisionJournal.js';
import { asHypotheticalExecuted, dedupeProposals, simulateBracket } from '../src/learning/HypotheticalOutcome.js';
import { calibrateRrFloors } from '../src/risk/rrProfile.js';
import type { Candle } from '../src/types.js';

const M = 5 * 60_000;
const bar = (i: number, high: number, low: number, close = (high + low) / 2): Candle => ({ openTime: i * M, open: close, high, low, close, volume: 1 });
const base = { side: 'LONG' as const, entry: 100, stopLoss: 99, takeProfit: 102, from: 0, maxHoldMs: 24 * 3_600_000 };

test('target reached first is a win of the planned RR', () => {
  const r = simulateBracket(base, [bar(0, 100.5, 99.8), bar(1, 102.2, 100.4)]);
  assert.equal(r.outcome, 'TP');
  assert.equal(r.grossR, 2);
  assert.equal(r.exitTime, M);
});

test('stop reached first is exactly -1R', () => {
  const r = simulateBracket(base, [bar(0, 100.2, 98.9)]);
  assert.equal(r.outcome, 'SL');
  assert.equal(r.grossR, -1);
});

test('stop and target inside one candle resolve against us', () => {
  assert.equal(simulateBracket(base, [bar(0, 102.5, 98.5)]).outcome, 'SL');
});

test('shorts mirror longs', () => {
  const short = { side: 'SHORT' as const, entry: 100, stopLoss: 101, takeProfit: 98, from: 0, maxHoldMs: 1e9 };
  assert.equal(simulateBracket(short, [bar(0, 100.4, 97.9)]).outcome, 'TP');
  assert.equal(simulateBracket(short, [bar(0, 101.1, 99.9)]).outcome, 'SL');
});

test('no resolution within the hold window closes at the last close in R, with excursions', () => {
  const r = simulateBracket({ ...base, maxHoldMs: 2 * M }, [bar(0, 100.6, 99.7, 100.2), bar(1, 100.9, 100.1, 100.5), bar(2, 100.8, 100.2, 100.4), bar(10, 105, 90)]);
  assert.equal(r.outcome, 'TIMEOUT');
  assert.ok(Math.abs(r.grossR! - 0.4) < 1e-9);
  assert.ok(r.mfeR! >= 0.9 && r.maeR! <= -0.3 + 1e-9);
});

test('candles before the decision are ignored; nothing after it is NO_DATA; wrong-side brackets are invalid', () => {
  assert.equal(simulateBracket({ ...base, from: 5 * M }, [bar(0, 110, 90)]).outcome, 'NO_DATA');
  assert.equal(simulateBracket({ ...base, stopLoss: 101 }, [bar(0, 103, 99)]).outcome, 'NO_DATA');
  assert.equal(simulateBracket({ ...base, stopLoss: 100 }, [bar(0, 103, 99)]).outcome, 'NO_DATA');
});

const rec = (id: number, minutes: number, symbol = 'SOLUSDT'): DecisionRecord => ({
  decisionId: String(id), timestamp: minutes * 60_000, symbol, strategy: 'CROWDING-ι', signalType: 'OPEN_SHORT', side: 'SHORT', signalId: String(id),
  confidence: 0.8, marketStateTime: null, marketStateVersion: null, evidence: { breakdown: null, score: 0, factors: [] }, entry: 100, stopLoss: 101, takeProfit: 98,
  notionalUsdt: 0, riskDecision: { approved: false, size: 0, leverage: 0, reason: 'x' }, status: 'RISK_REJECTED', rejectionReason: 'x',
});

test('a chain of re-proposals is one idea; a new chain after a quiet hour is another', () => {
  const kept = dedupeProposals([rec(1, 0), rec(2, 15), rec(3, 30), rec(4, 85), rec(5, 200), rec(6, 10, 'BTCUSDT')]);
  // chain 1→2→3→4 never pauses for more than an hour, so only its first record survives
  assert.deepEqual(kept.map((r) => r.decisionId), ['1', '6', '5']);
  assert.equal(kept.length, 3);
});

test('hypothetical records feed the existing calibrator, which charges the costs', () => {
  const records = Array.from({ length: 40 }, (_, i) => asHypotheticalExecuted({ ...rec(i, i * 100), takeProfit: 97 }, { outcome: i % 4 === 0 ? 'SL' : 'TP', grossR: i % 4 === 0 ? -1 : 3, mfeR: 3, maeR: -0.2, exitTime: 1 })!);
  const { verdicts } = calibrateRrFloors(records, { feeRate: 0.0004, slippageRate: 0.0002, minSamples: 30 });
  assert.equal(verdicts[0].status, 'CALIBRATED');
  assert.equal(asHypotheticalExecuted(rec(1, 0), { outcome: 'NO_DATA', grossR: null, mfeR: null, maeR: null, exitTime: null }), null);
});
