import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EquityHwmStore } from '../src/risk/equityHwm.js';
import { resetRiskBaseline } from '../src/risk/hwmReset.js';
import { PerformanceEngine } from '../src/risk/performanceEngine.js';
import { RiskOps } from '../src/runtime/opsHooks.js';
import { riskLimitsFromConfig } from '../src/risk/riskConfig.js';
import type { TradeRecord } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 5, 9);
const dir = () => mkdtempSync(path.join(tmpdir(), 'hwm-reset-'));
const trade = (pnl: number, closedAt: number): TradeRecord =>
  ({ symbol: 'SOLUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 100, qty: 1, pnl, reason: 'CLOSE', closedAt });
const seeded = (file: string, peaks: object = { paper: 1300 }, extra: object = {}) =>
  writeFileSync(file, JSON.stringify({ version: 1, peaks, updatedAt: 1, ...extra }));

// ---- store ----

test('should clear the peak and stamp the reset time, per mode, and survive a reload', () => {
  const file = path.join(dir(), 'hwm.json');
  seeded(file, { paper: 1300, live: 5000 });
  const store = new EquityHwmStore(file, () => NOW);
  assert.deepEqual(store.resetDrawdown('paper'), { previousPeak: 1300, previousResetAt: 0, resetAt: NOW });
  const reloaded = new EquityHwmStore(file, () => NOW + 1);
  assert.deepEqual([reloaded.peak('paper'), reloaded.resetAt('paper'), reloaded.peak('live'), reloaded.resetAt('live')], [0, NOW, 5000, 0]);
});

test('should read files written before resets existed, and reject a malformed resets field', () => {
  const old = path.join(dir(), 'old.json');
  seeded(old);
  assert.equal(new EquityHwmStore(old).peak('paper'), 1300);
  const bad = path.join(dir(), 'bad.json');
  seeded(bad, { paper: 1300 }, { resets: { paper: 'yesterday' } });
  assert.equal(new EquityHwmStore(bad).peak('paper'), 0); // corrupt -> starts empty rather than trusting it
});

test('should keep a reset when the peak is observed again afterwards', () => {
  const file = path.join(dir(), 'hwm.json');
  seeded(file);
  const store = new EquityHwmStore(file, () => NOW);
  store.resetDrawdown('paper');
  assert.equal(store.observe('paper', 900), 900);
  assert.equal(new EquityHwmStore(file).resetAt('paper'), NOW);
});

// ---- performance engine epoch ----

test('should ignore realized peaks before the reset: the equity held at the reset becomes the first peak', () => {
  const engine = new PerformanceEngine(1_000, () => NOW);
  const journal = [trade(200, 10), trade(-150, 20)]; // 1000 -> 1200 -> 1050
  engine.hydrate(journal);
  assert.ok(Math.abs(engine.snapshot(1_050).drawdownPercent - 12.5) < 1e-9);
  engine.setDrawdownEpoch(30);
  assert.equal(engine.snapshot(1_050).drawdownPercent, 0);
});

test('should count trades after the reset towards the new peak', () => {
  const engine = new PerformanceEngine(1_000, () => NOW);
  engine.hydrate([trade(200, 10), trade(-150, 20), trade(100, 40), trade(-60, 50)]); // 1050 at reset, then 1150, 1090
  engine.setDrawdownEpoch(30);
  assert.ok(Math.abs(engine.snapshot(1_090).drawdownPercent - (60 / 1150) * 100) < 1e-9);
});

test('should keep today-only limits independent of the reset, and an epoch of 0 should change nothing', () => {
  const engine = new PerformanceEngine(1_000, () => NOW);
  engine.hydrate([trade(200, 10), trade(-150, NOW - 1_000)]);
  const before = engine.snapshot(1_050);
  engine.setDrawdownEpoch(NOW - 500);
  const after = engine.snapshot(1_050);
  assert.deepEqual([after.dailyLossPercent, after.lossStreak], [before.dailyLossPercent, before.lossStreak]);
  engine.setDrawdownEpoch(0);
  assert.deepEqual(engine.snapshot(1_050), before);
});

// ---- the circuit breaker end to end ----

test('should leave EMERGENCY once the baseline is reset, which resetting only the stored peak would not', () => {
  const limits = { ...riskLimitsFromConfig(), maxDrawdownPercent: 10 };
  const journal = [trade(300, 10), trade(-250, 20)]; // peak 1300, now 1050: 19% below the journal peak
  const account = { equity: 1_050, marginUsed: 0, initialEquity: 1_000 };
  const peaks = { stored: 1_300, resetAt: 0 };
  const hwm = {
    peak: () => peaks.stored, observe: (equity: number) => (peaks.stored = Math.max(peaks.stored, equity)),
    reset: () => { peaks.stored = 0; }, resetAt: () => peaks.resetAt,
  };
  const ops = new RiskOps(() => undefined, { isEnabled: true, limits, hwm });
  assert.equal(ops.build(journal, account)?.circuit, 'EMERGENCY');
  peaks.stored = 0; // only the stored peak cleared: the journal still shows the 19% drawdown
  assert.equal(new RiskOps(() => undefined, { isEnabled: true, limits, hwm }).build(journal, account)?.circuit, 'EMERGENCY');
  peaks.resetAt = 30; // the baseline reset
  assert.equal(new RiskOps(() => undefined, { isEnabled: true, limits, hwm }).build(journal, account)?.circuit, 'NORMAL');
});

// ---- CLI core ----

test('should write nothing on a dry run', () => {
  const folder = dir();
  const file = path.join(folder, 'hwm.json');
  seeded(file);
  const before = readFileSync(file, 'utf8');
  const report = resetRiskBaseline({ filePath: file, mode: 'paper', confirm: false, allowLive: false, now: () => NOW });
  assert.equal(report.status, 'DRY_RUN');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(folder), ['hwm.json']);
});

test('should back up, reset and say what it cleared when confirmed', () => {
  const folder = dir();
  const file = path.join(folder, 'hwm.json');
  seeded(file);
  const before = readFileSync(file, 'utf8');
  const report = resetRiskBaseline({ filePath: file, mode: 'paper', confirm: true, allowLive: false, now: () => NOW });
  assert.equal(report.status, 'RESET');
  assert.equal(report.previousPeak, 1300);
  assert.ok(report.backupPath && readFileSync(report.backupPath, 'utf8') === before);
  assert.equal(new EquityHwmStore(file).peak('paper'), 0);
  assert.match(report.lines.join('\n'), /stored peak 1300\.00 cleared/);
});

test('should refuse a live reset without --allow-live, even with --confirm, and leave the file alone', () => {
  const file = path.join(dir(), 'hwm.json');
  seeded(file, { live: 9000 });
  const report = resetRiskBaseline({ filePath: file, mode: 'live', confirm: true, allowLive: false, now: () => NOW });
  assert.equal(report.status, 'REFUSED');
  assert.equal(new EquityHwmStore(file).peak('live'), 9000);
  assert.equal(resetRiskBaseline({ filePath: file, mode: 'live', confirm: true, allowLive: true, now: () => NOW }).status, 'RESET');
});

test('should cope with a missing file: nothing to back up, a reset stamp still written', () => {
  const file = path.join(dir(), 'missing.json');
  const report = resetRiskBaseline({ filePath: file, mode: 'paper', confirm: true, allowLive: false, now: () => NOW });
  assert.equal(report.status, 'RESET');
  assert.equal(report.backupPath, undefined);
  assert.ok(existsSync(file));
  assert.equal(new EquityHwmStore(file).resetAt('paper'), NOW);
});
