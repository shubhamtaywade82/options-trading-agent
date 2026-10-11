import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PerformanceEngine } from '../src/risk/performanceEngine.js';
import type { TradeRecord } from '../src/types.js';

const HOUR = 3_600_000;
const YESTERDAY = Date.UTC(2026, 8, 20);
const TODAY = YESTERDAY + 24 * HOUR;
const INITIAL_EQUITY = 10_000;

const trade = (pnl: number, closedAt: number): TradeRecord => ({
  symbol: 'SOLUSDT', strategy: 'ADAPTIVE-ST-ζ', side: 'LONG', entry: 100, exit: 100, qty: 1, pnl, reason: 'CLOSE', closedAt,
});

function engineAt(now: number, trades: TradeRecord[] = []): PerformanceEngine {
  const engine = new PerformanceEngine(INITIAL_EQUITY, () => now);
  engine.hydrate(trades);
  return engine;
}

// yesterday: +200, -50 (realized +150); today: +100, -30, -20
const journal = (): TradeRecord[] => [
  trade(200, YESTERDAY + HOUR), trade(-50, YESTERDAY + 2 * HOUR),
  trade(100, TODAY + HOUR), trade(-30, TODAY + 2 * HOUR), trade(-20, TODAY + 3 * HOUR),
];

test('should report a flat snapshot for an empty journal', () => {
  const snap = engineAt(TODAY + 4 * HOUR).snapshot(INITIAL_EQUITY);
  assert.deepEqual(snap, {
    dailyLossPercent: 0, drawdownPercent: 0, lossStreak: 0, winStreak: 0, realizedToday: 0, profitFactor: 0, expectancy: 0,
  });
});

test('should count today only for realized PnL and measure the loss against start-of-day equity', () => {
  const snap = engineAt(TODAY + 4 * HOUR, journal()).snapshot(10_200);
  assert.equal(snap.realizedToday, 50);
  assert.equal(snap.dailyLossPercent, 0);

  const losing = engineAt(TODAY + 4 * HOUR, [trade(150, YESTERDAY), trade(-101.5, TODAY + HOUR), trade(-50, TODAY + 2 * HOUR)]);
  const losingSnap = losing.snapshot(10_000);
  assert.equal(losingSnap.realizedToday, -151.5);
  // start-of-day equity = 10_000 + 150 (yesterday's realized), not the initial equity
  assert.ok(Math.abs(losingSnap.dailyLossPercent - (151.5 / 10_150) * 100) < 1e-9);
});

test('should never report a negative daily loss', () => {
  const snap = engineAt(TODAY + HOUR, [trade(500, TODAY)]).snapshot(10_500);
  assert.equal(snap.dailyLossPercent, 0);
  assert.equal(snap.realizedToday, 500);
});

test('should report a full daily loss when start-of-day equity is gone', () => {
  const wipedOut = engineAt(TODAY + HOUR, [trade(-INITIAL_EQUITY, YESTERDAY), trade(-5, TODAY)]);
  assert.equal(wipedOut.snapshot(0).dailyLossPercent, 100);
});

test('should count the loss streak from the newest trade of today and reset on a win', () => {
  assert.equal(engineAt(TODAY + 4 * HOUR, journal()).snapshot(10_000).lossStreak, 2);
  const withWin = [...journal(), trade(10, TODAY + 4 * HOUR)];
  assert.equal(engineAt(TODAY + 5 * HOUR, withWin).snapshot(10_000).lossStreak, 0);
});

test('should not carry yesterday losses into today', () => {
  const yesterdayLosses = [trade(-10, YESTERDAY + HOUR), trade(-10, YESTERDAY + 2 * HOUR), trade(-10, YESTERDAY + 3 * HOUR)];
  assert.equal(engineAt(YESTERDAY + 4 * HOUR, yesterdayLosses).snapshot(10_000).lossStreak, 3);
  assert.equal(engineAt(TODAY + HOUR, yesterdayLosses).snapshot(10_000).lossStreak, 0);
});

test('should reset the streak at UTC rollover using the injected clock', () => {
  let now = TODAY - HOUR;
  const engine = new PerformanceEngine(INITIAL_EQUITY, () => now);
  engine.hydrate([trade(-10, TODAY - 3 * HOUR), trade(-10, TODAY - 2 * HOUR)]);
  assert.equal(engine.snapshot(10_000).lossStreak, 2);
  assert.ok(engine.snapshot(10_000).dailyLossPercent > 0);
  now = TODAY;
  assert.equal(engine.snapshot(10_000).lossStreak, 0);
  assert.equal(engine.snapshot(10_000).dailyLossPercent, 0);
  assert.equal(engine.snapshot(10_000).realizedToday, 0);
});

test('should ignore zero-pnl trades when counting streaks', () => {
  const trades = [trade(-5, TODAY), trade(0, TODAY + HOUR), trade(-5, TODAY + 2 * HOUR)];
  assert.equal(engineAt(TODAY + 3 * HOUR, trades).snapshot(10_000).lossStreak, 2);
});

test('should count the win streak over the whole journal, not just today', () => {
  const trades = [trade(-5, YESTERDAY), trade(10, YESTERDAY + HOUR), trade(10, TODAY - HOUR), trade(10, TODAY + HOUR)];
  assert.equal(engineAt(TODAY + 2 * HOUR, trades).snapshot(10_000).winStreak, 3);
  assert.equal(engineAt(TODAY + 2 * HOUR, [...trades, trade(-1, TODAY + HOUR + 1)]).snapshot(10_000).winStreak, 0);
});

test('should compute profit factor and expectancy over all journal trades', () => {
  const snap = engineAt(TODAY + 4 * HOUR, journal()).snapshot(10_000);
  // wins 300, losses 100, five trades with net +200
  assert.equal(snap.profitFactor, 3);
  assert.equal(snap.expectancy, 40);
});

test('should report an infinite profit factor with only wins and zero with only zeros', () => {
  assert.equal(engineAt(TODAY, [trade(10, TODAY - HOUR)]).snapshot(10_010).profitFactor, Infinity);
  assert.equal(engineAt(TODAY, [trade(0, TODAY - HOUR)]).snapshot(10_000).profitFactor, 0);
});

test('should measure drawdown from the realized equity high-water mark', () => {
  // realized equity path: 10_000 -> 10_200 -> 10_150 -> 10_250 (peak) -> 10_220 -> 10_200
  const snap = engineAt(TODAY + 4 * HOUR, journal()).snapshot(10_000);
  assert.ok(Math.abs(snap.drawdownPercent - ((10_250 - 10_000) / 10_250) * 100) < 1e-9);
});

test('should report no drawdown at or above the high-water mark', () => {
  const engine = engineAt(TODAY + 4 * HOUR, journal());
  assert.equal(engine.snapshot(10_250).drawdownPercent, 0);
  assert.equal(engine.snapshot(11_000).drawdownPercent, 0);
});

test('should raise the high-water mark from observed live equity', () => {
  const engine = engineAt(TODAY + 4 * HOUR, journal());
  engine.onEquity(10_500);
  assert.ok(Math.abs(engine.snapshot(10_000).drawdownPercent - (500 / 10_500) * 100) < 1e-9);
  engine.onEquity(10_100);
  assert.ok(Math.abs(engine.snapshot(10_000).drawdownPercent - (500 / 10_500) * 100) < 1e-9);
  engine.onEquity(Number.NaN);
  assert.ok(Math.abs(engine.snapshot(10_000).drawdownPercent - (500 / 10_500) * 100) < 1e-9);
});

test('should be idempotent when hydrated twice with the same trades', () => {
  const engine = engineAt(TODAY + 4 * HOUR, journal());
  const once = engine.snapshot(10_000);
  engine.hydrate(journal());
  engine.hydrate(journal());
  assert.deepEqual(engine.snapshot(10_000), once);
});

test('should rebuild from scratch when hydrated with a different journal', () => {
  const engine = engineAt(TODAY + 4 * HOUR, journal());
  engine.hydrate([]);
  assert.equal(engine.snapshot(10_000).expectancy, 0);
  assert.equal(engine.snapshot(10_000).lossStreak, 0);
});

test('should be deterministic regardless of journal order', () => {
  const ordered = engineAt(TODAY + 4 * HOUR, journal()).snapshot(10_000);
  const shuffled = engineAt(TODAY + 4 * HOUR, journal().reverse()).snapshot(10_000);
  assert.deepEqual(shuffled, ordered);
});

test('should not mutate the journal passed to hydrate', () => {
  const trades = journal().reverse();
  const copy = trades.map((t) => ({ ...t }));
  engineAt(TODAY + 4 * HOUR, trades);
  assert.deepEqual(trades, copy);
});
