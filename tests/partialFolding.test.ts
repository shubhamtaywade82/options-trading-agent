import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLedger } from '../src/learning/AgentLedger.js';
import { TradeOutcomeRecorder } from '../src/learning/TradeOutcomeRecorder.js';
import { foldPartials, wholePosition } from '../src/position/foldPartials.js';
import { PerformanceEngine } from '../src/risk/performanceEngine.js';
import type { TradeRecord } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 1, 12);
const trade = (over: Partial<TradeRecord>): TradeRecord => ({
  symbol: 'BTCUSDT', strategy: 'STRUCTURE-TREND-η', side: 'LONG', entry: 100, exit: 105, qty: 1, pnl: 5, reason: 'TAKE PROFIT',
  closedAt: NOW, initialRisk: 5, decisionId: 'd1', ...over,
});
// 35% at +1R, 30% at +2R, the 35% runner stopped at breakeven + costs
const partial1 = trade({ qty: 0.35, exit: 105, pnl: 1.75, reason: 'PARTIAL TP', partial: true, closedAt: NOW - 3_000 });
const partial2 = trade({ qty: 0.3, exit: 110, pnl: 3, reason: 'PARTIAL TP', partial: true, closedAt: NOW - 2_000 });
const final = trade({ qty: 0.35, exit: 100.1, pnl: 0.035, reason: 'STOP LOSS', closedAt: NOW - 1_000 });

test('should merge partial legs into the final close: total quantity and PnL, quantity-weighted exit', () => {
  const whole = wholePosition(final, [partial1, partial2, final]);
  assert.equal(whole.qty, 1);
  assert.ok(Math.abs(whole.pnl - 4.785) < 1e-9);
  assert.ok(Math.abs(whole.exit - 104.785) < 1e-9); // R = (104.785 - 100) / 5 = 0.957
});

test('should leave a trade without partials untouched and not mix in partials of another position', () => {
  const other = trade({ decisionId: 'd2', partial: true, reason: 'PARTIAL TP', pnl: 99, qty: 1, closedAt: NOW - 2_500 });
  assert.equal(wholePosition(final, [other, final]), final);
});

test('should not absorb partials that belong to an earlier position that already closed', () => {
  const oldPartial = trade({ decisionId: undefined, partial: true, reason: 'PARTIAL TP', pnl: 10, qty: 1, closedAt: NOW - 50_000 });
  const oldFinal = trade({ decisionId: undefined, closedAt: NOW - 40_000 });
  const newFinal = trade({ decisionId: undefined, qty: 1, pnl: 2, closedAt: NOW - 1_000 });
  assert.equal(wholePosition(newFinal, [oldPartial, oldFinal, newFinal]).pnl, 2);
});

test('should fold the journal to one record per finished position and keep partials of a still-open position', () => {
  const openPartial = trade({ decisionId: 'd9', partial: true, reason: 'PARTIAL TP', pnl: 1, qty: 0.1, closedAt: NOW });
  const folded = foldPartials([partial1, partial2, final, openPartial]);
  assert.equal(folded.length, 2);
  assert.deepEqual(folded.map((t) => t.reason), ['STOP LOSS', 'PARTIAL TP']);
});

test('should grade a partially exited position once, with the blended R, not once per leg', () => {
  const ledger = new AgentLedger(null);
  const graded = new TradeOutcomeRecorder(ledger).process([partial1, partial2, final]);
  assert.equal(graded.length, 1);
  assert.equal(graded[0]!.rMultiple, 0.96); // 4.785 / (5 * 1)
  const stats = ledger.get('STRUCTURE-TREND-η');
  assert.equal(stats.trades, 1);
  assert.equal(stats.wins, 1);
});

test('should grade the whole position even when the partials were seen in an earlier pass', () => {
  const ledger = new AgentLedger(null);
  const recorder = new TradeOutcomeRecorder(ledger);
  assert.deepEqual(recorder.process([partial1, partial2]), []);
  const graded = recorder.process([partial1, partial2, final]);
  assert.equal(graded.length, 1);
  assert.equal(graded[0]!.rMultiple, 0.96);
});

test('should count a partial win followed by a small stopped-out remainder as one winning trade for streaks', () => {
  const lossRemainder = trade({ qty: 0.35, exit: 99.9, pnl: -0.035, reason: 'STOP LOSS', closedAt: NOW - 1_000 });
  const engine = new PerformanceEngine(1_000, () => NOW);
  engine.hydrate([partial1, partial2, lossRemainder]);
  const snap = engine.snapshot(1_000);
  assert.equal(snap.lossStreak, 0); // position PnL +4.715: not a loss
  assert.equal(snap.winStreak, 1);
  assert.ok(Math.abs(snap.realizedToday - 4.715) < 1e-9); // realized PnL still sums every leg
});

test('should keep realized PnL by day exact: a partial yesterday and a stop today are not shifted across days', () => {
  const yesterday = trade({ partial: true, reason: 'PARTIAL TP', pnl: 10, qty: 0.5, closedAt: NOW - 86_400_000 });
  const todayLoss = trade({ qty: 0.5, pnl: -4, reason: 'STOP LOSS', closedAt: NOW - 1_000 });
  const engine = new PerformanceEngine(1_000, () => NOW);
  engine.hydrate([yesterday, todayLoss]);
  assert.equal(engine.snapshot(1_000).realizedToday, -4);
});
