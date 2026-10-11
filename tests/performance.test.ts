import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TradeRecord } from '../src/types.js';
import { correlation, simpleReturns, summarizePerformance } from '../src/binance/performance.js';

const DAY = 86_400_000;
const trade = (pnl: number, closedAt: number, overrides: Partial<TradeRecord> = {}): TradeRecord => ({
  symbol: 'BTCUSDT', strategy: 'ADAPTIVE-ST-ζ', side: 'LONG', entry: 100, exit: 100 + pnl, qty: 1, pnl, reason: 'CLOSE', closedAt, ...overrides,
});
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('should report nulls and zeros for an empty journal', () => {
  const s = summarizePerformance([], 100_000, 100_000, 0);
  assert.deepEqual({ w: s.winRate, sh: s.sharpe, v: s.var95, dd: s.maxDrawdownPct, pnl: s.totalPnl, n: s.closedTrades }, { w: null, sh: null, v: null, dd: 0, pnl: 0, n: 0 });
});

test('should compute totals, win rate, per-strategy stats and liquidations', () => {
  const trades = [trade(100, 1), trade(-50, 2, { strategy: 'MOMENTUM-γ' }), trade(-30, 3, { reason: 'LIQUIDATED' })];
  const s = summarizePerformance(trades, 100_000, 100_020, 10);
  near(s.totalPnl, 20);
  near(s.totalPnlPct, 0.02);
  near(s.winRate!, 100 / 3);
  assert.equal(s.liquidations, 1);
  assert.deepEqual(s.byStrategy['ADAPTIVE-ST-ζ'], { closed: 2, wins: 1, pnl: 70 });
  assert.deepEqual(s.byStrategy['MOMENTUM-γ'], { closed: 1, wins: 0, pnl: -50 });
});

test('should measure the largest peak-to-trough drawdown on the realized curve', () => {
  // curve: 100000, 100100, 100050, 100020 (peak 100100, trough 100020)
  const s = summarizePerformance([trade(100, 1), trade(-50, 2), trade(-30, 3)], 100_000, 100_020, 10);
  near(s.maxDrawdownPct, ((100_020 - 100_100) / 100_100) * 100);
});

test('should return sharpe only with five calendar days of data', () => {
  const day = (n: number, pnl: number) => trade(pnl, n * DAY + 1000);
  const four = summarizePerformance([day(0, 100), day(1, 50), day(2, 80), day(3, 20)], 100_000, 100_250, 3 * DAY + 5000);
  assert.equal(four.sharpe, null);
  const five = summarizePerformance([day(0, 100), day(1, 50), day(2, 80), day(3, 20), day(4, 60)], 100_000, 100_310, 4 * DAY + 5000);
  assert.ok(five.sharpe! > 0);
});

test('should return var95 only with 20 trades and floor it at zero', () => {
  const few = summarizePerformance(Array.from({ length: 19 }, (_, i) => trade(-i, i)), 100_000, 99_000, 100);
  assert.equal(few.var95, null);
  const twenty = Array.from({ length: 20 }, (_, i) => trade(i + 1, i)); // all winners
  assert.equal(summarizePerformance(twenty, 100_000, 100_210, 100).var95, 0);
  const losing = Array.from({ length: 20 }, (_, i) => trade(-(i + 1), i)); // -1 … -20
  assert.equal(summarizePerformance(losing, 100_000, 99_790, 100).var95, -19); // ascending -20,-19,…: index floor(0.05 × 20) = 1
});

test('should compute simple returns and Pearson correlation', () => {
  assert.deepEqual(simpleReturns([100, 110, 99]), [0.1, -0.1]);
  const a = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3));
  near(correlation(a, a)!, 1);
  near(correlation(a, a.map((x) => -x))!, -1);
  assert.equal(correlation(a.slice(0, 10), a.slice(0, 10)), null);
  assert.equal(correlation(new Array(40).fill(1), a), null);
});
