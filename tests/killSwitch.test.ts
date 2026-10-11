import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { RiskAgent } from '../src/agents/RiskAgent.js';
import { config } from '../src/config.js';
import { KillSwitch } from '../src/ops/killSwitch.js';
import { RiskOps, toggleKillSwitch } from '../src/runtime/opsHooks.js';
import type { Candle, Signal } from '../src/types.js';

// Pinned so the approvals below do not depend on a local .env
Object.assign(config.risk, { minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2 });

const tempFile = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'kill-switch-')), 'kill-switch.json');

test('should start not halted when the file is missing', () => {
  const ks = new KillSwitch(tempFile());
  assert.equal(ks.isHalted(), false);
  assert.deepEqual(ks.state(), { halted: false, reason: '', at: 0 });
});

test('should persist a toggle across instances with the reason and time', () => {
  const file = tempFile();
  const first = new KillSwitch(file, () => 1_234);
  assert.deepEqual(first.toggle('manual'), { halted: true, reason: 'manual', at: 1_234 });

  const second = new KillSwitch(file);
  assert.equal(second.isHalted(), true);
  assert.deepEqual(second.state(), { halted: true, reason: 'manual', at: 1_234 });
});

test('should toggle back off and persist that too', () => {
  const file = tempFile();
  const ks = new KillSwitch(file, () => 5);
  ks.toggle('manual');
  assert.deepEqual(ks.toggle('manual'), { halted: false, reason: 'manual', at: 5 });
  assert.equal(new KillSwitch(file).isHalted(), false);
});

test('should write the state atomically as JSON with no leftover temp file', () => {
  const file = tempFile();
  new KillSwitch(file, () => 9).toggle('manual');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { halted: true, reason: 'manual', at: 9 });
  assert.throws(() => readFileSync(`${file}.tmp`), { code: 'ENOENT' });
});

for (const [name, content] of [['garbage', '{not json'], ['wrong shape', '{"halted":"yes"}'], ['null', 'null'], ['empty', '']] as const) {
  test(`should treat a corrupt file (${name}) as not halted`, () => {
    const file = tempFile();
    writeFileSync(file, content);
    assert.equal(new KillSwitch(file).isHalted(), false);
  });
}

test('should stay halted in memory and report the error when the state cannot be saved', () => {
  const blocker = tempFile();
  writeFileSync(blocker, 'a file where a directory is needed');
  const ks = new KillSwitch(path.join(blocker, 'kill-switch.json'));
  ks.toggle('manual');
  assert.equal(ks.isHalted(), true);
  assert.ok(ks.lastError, 'a lost halt must be visible to the operator');
});

const flatCandles = (): Candle[] =>
  Array.from({ length: 30 }, (_, i) => ({ openTime: i, open: 100, high: 100.75, low: 99.25, close: 100, volume: 1 }));
const ctx = (): MarketContext => ({ candles: { BTCUSDT: flatCandles() }, funding: {}, marks: {}, spot: {}, equity: 100_000 });
const signal = (over: Partial<Signal> = {}): Signal =>
  ({ id: 's', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.75, entry: 100, stopLoss: 96, takeProfit: 110, reason: '', ts: 0, ...over });
const OPEN_TYPES = ['OPEN_LONG', 'OPEN_SHORT', 'OPEN_HEDGE'] as const;
const hedgeFields: Partial<Signal> = { agent: 'FUNDING-ARB-α', entry: undefined, stopLoss: undefined, notionalUsdt: 5_000 };
const openSignal = (type: (typeof OPEN_TYPES)[number]): Signal => signal(type === 'OPEN_HEDGE' ? { type, ...hedgeFields } : { type, stopLoss: type === 'OPEN_SHORT' ? 104 : 96 });
const halted = (): KillSwitch => {
  const ks = new KillSwitch(tempFile());
  ks.toggle('manual');
  return ks;
};

for (const riskEngine of ['off', 'on'] as const) {
  for (const type of OPEN_TYPES) {
    test(`should refuse ${type} while halted with RISK_ENGINE=${riskEngine}`, () => {
      const decision = new RiskAgent({} as BinanceService, { riskEngine, killSwitch: halted() }).gate(openSignal(type), ctx());
      assert.equal(decision.approved, false);
      assert.equal(decision.reason, 'kill-switch: manual');
    });
  }
}

test('should approve again once the kill-switch is toggled off', () => {
  const ks = halted();
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'off', killSwitch: ks });
  assert.equal(agent.gate(openSignal('OPEN_LONG'), ctx()).approved, false);
  ks.toggle('manual');
  assert.equal(agent.gate(openSignal('OPEN_LONG'), ctx()).approved, true);
});

test('should name the kill-switch even when the drawdown breaker would also refuse', () => {
  const decision = new RiskAgent({} as BinanceService, { killSwitch: halted() }).gate(openSignal('OPEN_LONG'), { ...ctx(), equity: 0 });
  assert.equal(decision.reason, 'kill-switch: manual');
});

test('should leave non-entry signals exactly as they are while halted', () => {
  const close = signal({ type: 'CLOSE' });
  const plain = new RiskAgent({} as BinanceService, { riskEngine: 'off' }).gate(close, ctx());
  const withSwitch = new RiskAgent({} as BinanceService, { riskEngine: 'off', killSwitch: halted() }).gate(close, ctx());
  assert.deepEqual(withSwitch, plain);
  assert.ok(!withSwitch.reason.startsWith('kill-switch'));
});

test('should show KILL-SWITCH as the fleet note while halted, taking precedence over the circuit', () => {
  const ks = new KillSwitch(tempFile());
  const ops = new RiskOps(() => {}, { isEnabled: false, killSwitch: ks });
  assert.equal(ops.note, undefined);
  ks.toggle('manual');
  assert.equal(ops.note, 'KILL-SWITCH');
  ks.toggle('manual');
  assert.equal(ops.note, undefined);
});

test('should toggle, log a warning and hand the new state to the hooks', () => {
  const ks = new KillSwitch(tempFile(), () => 77);
  const warnings: string[] = [];
  const states: unknown[] = [];
  const hooks = { onKillSwitch: (state: unknown) => states.push(state) };

  toggleKillSwitch(ks, hooks, (message) => warnings.push(message));
  toggleKillSwitch(ks, hooks, (message) => warnings.push(message));

  assert.deepEqual(warnings.map((w) => w.slice(0, w.indexOf(':'))), ['KILL-SWITCH ON', 'KILL-SWITCH OFF']);
  assert.deepEqual(states, [{ halted: true, reason: 'manual', at: 77 }, { halted: false, reason: 'manual', at: 77 }]);
});

test('should warn that the halt was not saved when the disk write fails', () => {
  const blocker = tempFile();
  writeFileSync(blocker, 'x');
  const warnings: string[] = [];
  toggleKillSwitch(new KillSwitch(path.join(blocker, 'k.json')), { onKillSwitch: () => {} }, (m) => warnings.push(m));
  assert.match(warnings[0], /KILL-SWITCH ON.*not saved/);
});
