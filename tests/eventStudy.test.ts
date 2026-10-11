import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanRecords, eventStudy, HYPOTHESES, poolRows, twoSidedP } from '../src/marketdata/EventStudy.js';
import type { MinuteRecord } from '../src/marketdata/MinuteAggregator.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 1);

const rec = (i: number, over: Partial<MinuteRecord> = {}): MinuteRecord => ({
  t: T0 + i * MIN, symbol: 'BTCUSDT', trades: 100, buyQty: 1, sellQty: 1, buyQuote: 100, sellQuote: 100, liqLongQty: 0, liqShortQty: 0, liqCount: 0,
  spreadBps: 0.1, bookImbalance: 0, bookSamples: 100, mark: 100, index: 100, funding: 0.0001, openInterest: 1, takerRatio: 1, ...over,
});

// deterministic PRNG so the tests are stable
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/**
 * `n` minutes of a random-walk mark (sd ~3 bps/min). Every `every` minutes (from the second half and the first) a long-liquidation
 * burst occurs; if `bounceBps` > 0 the mark then rises by that much over the next 15 minutes (a planted H1 effect).
 */
function series(n: number, every: number, bounceBps: number, seed = 7): MinuteRecord[] {
  const r = lcg(seed);
  const out: MinuteRecord[] = [];
  let price = 100;
  const pending = new Map<number, number>(); // minute -> extra bps step
  for (let i = 0; i < n; i += 1) {
    const burst = i % every === 0 && i > 10;
    if (burst && bounceBps > 0) for (let k = 1; k <= 15; k += 1) pending.set(i + k, (pending.get(i + k) ?? 0) + bounceBps / 15);
    price *= 1 + (gauss(r) * 3 + (pending.get(i) ?? 0)) / 10_000;
    out.push(rec(i, { mark: price, liqLongQty: burst ? 50 + r() * 10 : r() < 0.02 ? 1 : 0, bookImbalance: gauss(r) * 0.2 }));
  }
  return out;
}

test('partial minutes at the edges of every unbroken run are dropped', () => {
  const records = [...Array.from({ length: 10 }, (_, i) => rec(i)), ...Array.from({ length: 8 }, (_, i) => rec(20 + i))];
  const clean = cleanRecords(records);
  assert.equal(clean.length, 8 + 6);
  assert.ok(!clean.some((r) => r.t === T0 || r.t === T0 + 9 * MIN || r.t === T0 + 20 * MIN || r.t === T0 + 27 * MIN));
  assert.deepEqual(cleanRecords([rec(0), rec(1)]), []);
});

test('a planted liquidation-reversal effect is detected out of sample with the right sign and size', () => {
  // ~two weeks of minutes with a burst about every 3 hours, so events are rare enough not to contaminate the drift baseline
  const rows = eventStudy(series(20_000, 200, 30), HYPOTHESES[0], 16);
  const h15 = rows.find((r) => r.horizon === 15)!;
  assert.ok(h15.n >= 30, `n=${h15.n}`);
  assert.ok(h15.excessBps > 22 && h15.excessBps < 38, `excess ${h15.excessBps}`);
  assert.ok(h15.t! > 4, `t ${h15.t}`);
  assert.ok(h15.hitRate! > 0.7);
  assert.ok(h15.netBps > 0); // 30 bps of effect beats 16 bps of cost
});

test('with no planted effect the same events show nothing, and costs make the net negative', () => {
  const rows = eventStudy(series(20_000, 200, 0), HYPOTHESES[0], 16);
  for (const row of rows) {
    assert.ok(Math.abs(row.t ?? 0) < 3.5, `${row.horizon}m t=${row.t}`);
    assert.ok(row.netBps < 5, `${row.horizon}m net=${row.netBps}`);
  }
});

test('the threshold comes from the first half only: a burst confined to the test half is still an event', () => {
  const a = series(4000, 10_000, 0); // essentially no bursts
  const records = a.map((r, i) => (i >= 2500 && i % 50 === 0 ? { ...r, liqLongQty: 500 } : r));
  const rows = eventStudy(records, HYPOTHESES[0], 16);
  assert.ok(rows.length > 0);
  assert.ok(rows[0].n > 5, `n=${rows[0].n}`); // big bursts exceed the (tiny) training threshold
});

test('events inside one horizon of the previous event are not double counted', () => {
  const rows = eventStudy(series(6000, 5, 0), HYPOTHESES[0], 16); // a burst every 5 minutes
  const h60 = rows.find((r) => r.horizon === 60)!;
  // test half is ~3000 minutes; at most one event per 60 minutes
  assert.ok(h60.n <= 3000 / 60 + 1, `n=${h60.n}`);
});

test('too little data yields no rows rather than a verdict', () => {
  assert.deepEqual(eventStudy(series(30, 10, 0), HYPOTHESES[0], 16), []);
  assert.deepEqual(eventStudy([], HYPOTHESES[0], 16), []);
});

test('aggressor-flow and book-imbalance features are signed so that positive predicts up', () => {
  const w = (over: Partial<MinuteRecord>) => Array.from({ length: 5 }, (_, i) => rec(i, over));
  assert.ok(HYPOTHESES[1].feature(w({ buyQuote: 300, sellQuote: 100 }))! > 0);
  assert.ok(HYPOTHESES[1].feature(w({ buyQuote: 100, sellQuote: 300 }))! < 0);
  assert.ok(HYPOTHESES[2].feature(w({ bookImbalance: 0.4 }))! > 0);
  assert.equal(HYPOTHESES[2].feature(w({ bookImbalance: null })), null);
  assert.ok(HYPOTHESES[0].feature(w({ liqLongQty: 5 }))! > 0); // forced selling -> predicts a bounce
  assert.ok(HYPOTHESES[0].feature(w({ liqShortQty: 5 }))! < 0);
  assert.equal(HYPOTHESES[0].feature(w({})), null);
});

test('pooling symbols recomputes the excess from the events and each symbol\'s own drift', () => {
  const a = eventStudy(series(20_000, 200, 30, 7), HYPOTHESES[0], 16).find((r) => r.horizon === 15)!;
  const b = eventStudy(series(20_000, 200, 30, 11), HYPOTHESES[0], 16).find((r) => r.horizon === 15)!;
  const pooled = poolRows([a, b], 16)!;
  assert.equal(pooled.n, a.n + b.n);
  assert.ok(pooled.excessBps > 22 && pooled.excessBps < 38);
  assert.ok(pooled.t! > a.t!);
  assert.equal(poolRows([], 16), null);
});

test('two-sided p-values behave: t=0 is 1, t=1.96 is ~0.05, t=3 is ~0.003', () => {
  assert.ok(Math.abs(twoSidedP(0) - 1) < 1e-6);
  assert.ok(Math.abs(twoSidedP(1.96) - 0.05) < 0.002);
  assert.ok(twoSidedP(3) < 0.004 && twoSidedP(3) > 0.002);
});
