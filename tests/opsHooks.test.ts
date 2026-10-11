import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { KillSwitch } from '../src/ops/killSwitch.js';
import { announceStartup, RiskOps } from '../src/runtime/opsHooks.js';
import { riskLimitsFromConfig } from '../src/risk/riskConfig.js';
import type { TradeRecord } from '../src/types.js';

const limits = riskLimitsFromConfig({
  minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2,
  maxDailyLossPct: 3, maxLossStreak: 4, maxConcurrentPositions: 4, maxSymbolExposurePct: 80, maxCorrelatedExposurePct: 80,
  minRr: 0, takerFeeRate: 0.0004, slippageBufferRate: 0.0002,
});

const loss = (pnl: number, closedAt = Date.now()): TradeRecord =>
  ({ symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 99, qty: 1, pnl, reason: 'STOP LOSS', closedAt });
const account = (equity = 100_000, initialEquity = 100_000) => ({ equity, initialEquity });

function opsWith(isEnabled: boolean) {
  const warnings: string[] = [];
  return { warnings, ops: new RiskOps((message) => warnings.push(message), { isEnabled, limits }) };
}

test('should build nothing and stay silent while the engine is off', () => {
  const { ops, warnings } = opsWith(false);
  assert.equal(ops.build([loss(-9_000)], account(91_000)), undefined);
  assert.equal(ops.note, undefined);
  assert.deepEqual(warnings, []);
});

test('should derive the circuit from the journal and expose it as a note', () => {
  const { ops } = opsWith(true);
  assert.equal(ops.build([], account())?.circuit, 'NORMAL');
  assert.equal(ops.note, undefined);
  assert.equal(ops.build([loss(-1_600)], account())?.circuit, 'CAUTION');
  assert.equal(ops.note, 'CAUTION');
  assert.equal(ops.build([loss(-3_100)], account())?.circuit, 'HALTED');
  assert.equal(ops.note, 'HALTED');
});

test('should log each circuit change exactly once', () => {
  const { ops, warnings } = opsWith(true);
  ops.build([], account());
  ops.build([loss(-3_100)], account());
  ops.build([loss(-3_100)], account());
  ops.build([], account());
  assert.deepEqual(warnings, ['circuit NORMAL -> HALTED', 'circuit HALTED -> NORMAL']);
});

test('should reach the same snapshot from the same journal after a restart', () => {
  const journal = [loss(-500), loss(-700)];
  const before = opsWith(true).ops.build(journal, account(98_800));
  const after = opsWith(true).ops.build(journal, account(98_800));
  assert.deepEqual(after, before);
});

test('should measure daily loss against the venue starting equity once it is known', () => {
  const { ops } = opsWith(true);
  // 2_100 is 2.1% of 100k (CAUTION) but 4.2% of a 50k account (HALTED)
  assert.equal(ops.build([loss(-2_100)], account(100_000, 100_000))?.circuit, 'CAUTION');
  assert.equal(ops.build([loss(-2_100)], account(48_000, 50_000))?.circuit, 'HALTED');
});

const LIVE_BLIND_WARNING = 'RISK_ENGINE: live mode has no trade journal — daily-loss and loss-streak limits are inactive (drawdown still applies)';

for (const [mode, isEngineOn, expected] of [
  ['live', true, [LIVE_BLIND_WARNING]], ['live', false, []], ['paper', true, []], ['paper', false, []],
] as const) {
  test(`should ${expected.length ? 'warn' : 'stay silent'} at start in ${mode} mode with the engine ${isEngineOn ? 'on' : 'off'}`, () => {
    const lines: string[] = [];
    const killSwitch = new KillSwitch(path.join(mkdtempSync(path.join(tmpdir(), 'startup-')), 'kill-switch.json'));
    announceStartup({ killSwitch, hooks: { onKillSwitch: () => {} }, warn: (line) => lines.push(line), mode, isEngineOn });
    assert.deepEqual(lines, expected);
  });
}

test('should announce a persisted halt with its reason and hand it to the ops hooks', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'startup-')), 'kill-switch.json');
  new KillSwitch(file, () => 7).toggle('manual');
  const lines: string[] = [];
  const handed: unknown[] = [];
  announceStartup({ killSwitch: new KillSwitch(file), hooks: { onKillSwitch: (state) => handed.push(state) }, warn: (line) => lines.push(line), mode: 'paper', isEngineOn: false });
  assert.deepEqual(lines, ['KILL-SWITCH ON (persisted): manual — press k to resume']);
  assert.deepEqual(handed, [{ halted: true, reason: 'manual', at: 7 }]);
});

test('should announce nothing at start when the kill-switch is not halted', () => {
  const lines: string[] = [];
  const handed: unknown[] = [];
  const killSwitch = new KillSwitch(path.join(mkdtempSync(path.join(tmpdir(), 'startup-')), 'kill-switch.json'));
  announceStartup({ killSwitch, hooks: { onKillSwitch: (state) => handed.push(state) }, warn: (line) => lines.push(line), mode: 'paper', isEngineOn: false });
  assert.deepEqual([lines, handed], [[], []]);
});
