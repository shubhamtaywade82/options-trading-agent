import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionRecord } from '../src/decision/DecisionJournal.js';
import { bootstrapMean, holm, mulberry32, utcDay } from '../src/research/Bootstrap.js';
import { conditionalMatrix, keyOf, observationsOf, walkForward, type Observation } from '../src/research/ConditionalEdge.js';
import { netROf } from '../src/risk/rrProfile.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const NO_COSTS = { feeRate: 0, slippageRate: 0 };

const decision = (i: number, rMultiple: number, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decisionId: String(i), timestamp: T0 + i * 3_600_000, symbol: 'ETHUSDT', strategy: 'MOMENTUM-γ', signalType: 'OPEN_LONG', side: 'LONG',
  signalId: String(i), confidence: 0.7, marketStateTime: null, marketStateVersion: null, evidence: { breakdown: null, score: 0, factors: [] },
  entry: 100, stopLoss: 99, takeProfit: 102, notionalUsdt: 1, riskDecision: { approved: true, size: 1, leverage: 1, reason: '' },
  status: 'EXECUTED', rejectionReason: null,
  outcome: { closedAt: T0 + i * 3_600_000 + 1_800_000, exit: 100, qty: 1, pnl: 0, rMultiple, reason: rMultiple > 0 ? 'TAKE PROFIT' : 'STOP LOSS' },
  ...over,
});

/** Daily observations for one key with a given true mean and noise (deterministic). */
function daily(key: string, days: number, mean: number, seed: number, perDay = 2, from = T0): Observation[] {
  const r = mulberry32(seed);
  const out: Observation[] = [];
  for (let d = 0; d < days; d += 1) {
    for (let k = 0; k < perDay; k += 1) {
      const t = from + d * DAY + k * 3_600_000;
      out.push({ t, closedAt: t + 3_600_000, key, netR: mean + (r() - 0.5) * 2 });
    }
  }
  return out;
}

test('netROf charges round-trip costs in R and skips records without a clean outcome', () => {
  // 1% stop, 4 + 2 bps per leg -> 12 bps round trip = 0.12R
  assert.ok(Math.abs(netROf(decision(1, 2), { feeRate: 0.0004, slippageRate: 0.0002 })! - 1.88) < 1e-12);
  assert.equal(netROf(decision(1, 2, { status: 'RISK_REJECTED' }), NO_COSTS), undefined);
  assert.equal(netROf(decision(1, 2, { stopLoss: 100 }), NO_COSTS), undefined);
  assert.equal(netROf(decision(1, Number.NaN), NO_COSTS), undefined);
});

test('keyOf groups records without market context under UNKNOWN', () => {
  assert.equal(keyOf(decision(1, 1), ['strategy', 'regime', 'phase']), 'MOMENTUM-γ | UNKNOWN | UNKNOWN');
  const withCtx = decision(1, 1, { context: { regime: 'TREND_UP', volatilityPhase: 'COMPRESSED', atrPercentile: 10, adx14: 30 } });
  assert.equal(keyOf(withCtx, ['strategy', 'regime', 'phase', 'side']), 'MOMENTUM-γ | TREND_UP | COMPRESSED | LONG');
});

test('bootstrap is reproducible from its seed and brackets the sample mean', () => {
  const samples = daily('x', 40, 0.3, 3).map((o) => ({ value: o.netR, cluster: utcDay(o.t) }));
  const a = bootstrapMean(samples, { seed: 9, iterations: 2000 })!;
  const b = bootstrapMean(samples, { seed: 9, iterations: 2000 })!;
  assert.deepEqual(a, b);
  assert.equal(a.clusters, 40);
  assert.ok(a.ciLow < a.mean && a.mean < a.ciHigh);
  assert.ok(a.ciLow > 0, `a +0.3R mean over 80 trades should have a positive lower bound, got ${a.ciLow}`);
  assert.ok(a.probPositive > 0.95);
});

test('bootstrap rejects empty or non-finite input', () => {
  assert.equal(bootstrapMean([]), null);
  assert.equal(bootstrapMean([{ value: Number.NaN, cluster: 'a' }]), null);
  assert.throws(() => bootstrapMean([{ value: 1, cluster: 'a' }], { confidence: 1 }));
});

test('clustering widens the interval when same-day trades are duplicates of one another', () => {
  // 20 days, each day's outcome repeated 10 times: 200 trades but only 20 independent observations
  const r = mulberry32(5);
  const samples = Array.from({ length: 20 }, (_, d) => ({ v: (r() - 0.5) * 2, d })).flatMap(({ v, d }) =>
    Array.from({ length: 10 }, () => ({ value: v, cluster: `d${d}` })));
  const clustered = bootstrapMean(samples, { seed: 1 })!;
  const iid = bootstrapMean(samples.map((s, i) => ({ value: s.value, cluster: String(i) })), { seed: 1 })!;
  assert.ok(clustered.ciHigh - clustered.ciLow > 2.5 * (iid.ciHigh - iid.ciLow));
});

test('holm is step-down and stops at the first non-rejection', () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03], 0.05), [true, false, false]); // 0.01 <= .05/3; 0.03 > .05/2
  assert.deepEqual(holm([0.001, 0.02, 0.04], 0.05), [true, true, true]);
  assert.deepEqual(holm([], 0.05), []);
});

test('the matrix only tests cells with enough trades, and noise does not survive Holm', () => {
  const obs = [
    ...daily('EDGE', 60, 0.6, 1),
    ...Array.from({ length: 30 }, (_, k) => daily(`NOISE${k}`, 30, 0, 100 + k)).flat(),
    ...daily('THIN', 5, 2, 2),
  ];
  const m = conditionalMatrix(obs, { minN: 30, iterations: 2000 });
  assert.equal(m.tested, 31);
  const thin = m.cells.find((c) => c.key === 'THIN')!;
  assert.equal(thin.stats, null);
  assert.equal(thin.significant, false);
  assert.equal(m.cells.find((c) => c.key === 'EDGE')!.significant, true);
  assert.equal(m.cells.filter((c) => c.key.startsWith('NOISE') && c.significant).length, 0);
});

test('walk-forward selects only on the train window and pools the following test windows', () => {
  // A cell that is positive throughout, and one that is positive only during the first 60 days then turns negative
  const persistent = daily('PERSIST', 150, 0.5, 11);
  const decaying = [...daily('DECAY', 60, 0.8, 12), ...daily('DECAY', 90, -0.8, 13, 2, T0 + 60 * DAY)];
  const wf = walkForward([...persistent, ...decaying].sort((a, b) => a.t - b.t), { trainDays: 30, testDays: 15, minN: 30, iterations: 1000 });
  assert.ok(wf.folds.length >= 5);
  for (const fold of wf.folds) {
    assert.equal(fold.trainTo - fold.trainFrom, 30 * DAY);
    assert.equal(fold.testTo - fold.trainTo, 15 * DAY);
    assert.ok(fold.selected.includes('PERSIST'));
  }
  // Once the train window lies entirely in the negative regime DECAY is no longer selected
  const late = wf.folds.filter((f) => f.trainFrom >= T0 + 60 * DAY);
  assert.ok(late.length > 0);
  for (const fold of late) assert.ok(!fold.selected.includes('DECAY'));
  assert.ok(wf.outOfSample!.mean > wf.baseline!.mean);
});

test('walk-forward never trains on an outcome that closes after the train window', () => {
  const t = T0 + 29 * DAY;
  // 40 strongly positive trades decided inside the train window whose outcomes only become known in the test window
  const leaking: Observation[] = Array.from({ length: 40 }, (_, i) => ({ t: t + i * 60_000, closedAt: T0 + 31 * DAY, key: 'LEAK', netR: 2 }));
  const filler = daily('OTHER', 60, 0, 21);
  const wf = walkForward([...leaking, ...filler].sort((a, b) => a.t - b.t), { trainDays: 30, testDays: 15, minN: 30, iterations: 500 });
  assert.ok(!wf.folds[0].selected.includes('LEAK'));
});

test('walk-forward with a span shorter than one train window reports no folds', () => {
  const wf = walkForward(daily('X', 10, 1, 1), { trainDays: 30, testDays: 15 });
  assert.equal(wf.folds.length, 0);
  assert.equal(wf.outOfSample, null);
  assert.throws(() => walkForward([], { trainDays: 0, testDays: 1 }));
});

test('observationsOf keeps only clean outcomes, sorted by decision time', () => {
  const records = [decision(3, 1), decision(1, -1), decision(2, 1, { outcome: undefined }), decision(4, 1, { status: 'VETOED' })];
  const obs = observationsOf(records, ['strategy'], NO_COSTS);
  assert.deepEqual(obs.map((o) => o.netR), [-1, 1]);
  assert.ok(obs[0].t < obs[1].t);
});
