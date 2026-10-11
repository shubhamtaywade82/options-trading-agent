import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EquityHwmStore } from '../src/risk/equityHwm.js';
import { PerformanceEngine } from '../src/risk/performanceEngine.js';
import { RiskAgent } from '../src/agents/RiskAgent.js';
import type { BinanceService } from '../src/binance/client.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { config } from '../src/config.js';
import type { Candle, Signal } from '../src/types.js';

const hwmFile = () => join(mkdtempSync(join(tmpdir(), 'hwm-')), 'risk-hwm.json');

const flatCandles = (): Candle[] =>
  Array.from({ length: 30 }, (_, i) => ({ openTime: i, open: 100, high: 100.75, low: 99.25, close: 100, volume: 1 }));

const signal = (): Signal =>
  ({ id: 's', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.75, entry: 100, stopLoss: 96, takeProfit: 110, reason: '', ts: 0 });

const context = (equity: number): MarketContext =>
  ({ candles: { BTCUSDT: flatCandles() }, funding: {}, marks: {}, spot: {}, equity });

test('hwm: a fresh store reports no peak and ignores non-positive readings', () => {
  const store = new EquityHwmStore(hwmFile());
  assert.equal(store.peak('paper'), 0);
  assert.equal(store.observe('paper', -5), 0);
  assert.equal(store.observe('paper', Number.NaN), 0);
});

test('hwm: observe ratchets the peak up and returns the effective peak', () => {
  const store = new EquityHwmStore(hwmFile());
  assert.equal(store.observe('paper', 100_000), 100_000);
  assert.equal(store.observe('paper', 95_000), 100_000);
  assert.equal(store.observe('paper', 101_500), 101_500);
  assert.equal(store.peak('paper'), 101_500);
});

test('hwm: the peak survives a restart (a new store instance reading the same file)', () => {
  const file = hwmFile();
  const first = new EquityHwmStore(file);
  first.observe('paper', 100_000);
  first.observe('paper', 94_000);
  const restarted = new EquityHwmStore(file);
  assert.equal(restarted.peak('paper'), 100_000);
  assert.equal(restarted.observe('paper', 95_000), 100_000);
});

test('hwm: paper and live wallets keep independent peaks', () => {
  const store = new EquityHwmStore(hwmFile());
  store.observe('paper', 1_150);
  store.observe('live', 100_000);
  assert.equal(store.peak('paper'), 1_150);
  assert.equal(store.peak('live'), 100_000);
  // A live drawdown must not be rescued by the small paper wallet
  assert.equal(store.forMode('live').observe(95_000), 100_000);
});

test('hwm: a corrupt file degrades to an empty store instead of throwing', () => {
  const file = hwmFile();
  writeFileSync(file, '{not json', 'utf-8');
  const store = new EquityHwmStore(file);
  assert.equal(store.peak('paper'), 0);
  assert.equal(store.observe('paper', 42), 42);
});

test('hwm: reset clears only the requested mode', () => {
  const store = new EquityHwmStore(hwmFile());
  store.observe('paper', 1_150);
  store.observe('live', 100_000);
  store.forMode('live').reset();
  assert.equal(store.peak('live'), 0);
  assert.equal(store.peak('paper'), 1_150);
});

test('hwm: persisted snapshot is valid JSON with the expected shape', () => {
  const file = hwmFile();
  const store = new EquityHwmStore(file);
  store.observe('paper', 1_150);
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.peaks.paper, 1_150);
  assert.equal(typeof raw.updatedAt, 'number');
});

test('performanceEngine: seedObservedPeak restores drawdown across a restart', () => {
  // Session one: equity peaked at 1_200 unrealized, engine sees it, then the process dies
  const sessionOne = new PerformanceEngine(1_000, () => 0);
  sessionOne.onEquity(1_200);
  assert.equal(sessionOne.snapshot(1_200).drawdownPercent, 0);

  // Session two: no journal entries, but the persisted peak (1_200) is seeded
  const sessionTwo = new PerformanceEngine(1_000, () => 0);
  sessionTwo.seedObservedPeak(1_200);
  const snapshot = sessionTwo.snapshot(1_140);
  assert.ok(snapshot.drawdownPercent > 4.9 && snapshot.drawdownPercent < 5.1, `drawdown ${snapshot.drawdownPercent}`);
});

test('performanceEngine: seedObservedPeak never lowers an in-memory peak', () => {
  const engine = new PerformanceEngine(1_000, () => 0);
  engine.onEquity(1_500);
  engine.seedObservedPeak(1_200);
  assert.equal(engine.snapshot(1_400).drawdownPercent, 100 * (100 / 1_500));
});

test('riskAgent: a drawdown halt survives a restart through the persisted peak', () => {
  Object.assign(config.risk, { minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2 });
  const file = hwmFile();

  // Session one: equity peaks at 100k, falls into a >5% drawdown, the agent halts
  const store = new EquityHwmStore(file);
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'off', hwm: store.forMode('paper') });
  assert.equal(agent.gate(signal(), context(100_000)).approved, true);
  assert.equal(agent.gate(signal(), context(94_000)).approved, false);

  // Session two: a brand-new agent and store read the same file — the halt must hold
  const restartedStore = new EquityHwmStore(file);
  const restartedAgent = new RiskAgent({} as BinanceService, { riskEngine: 'off', hwm: restartedStore.forMode('paper') });
  const decision = restartedAgent.gate(signal(), context(94_500));
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /drawdown kill-switch/);

  // Recovery back at the peak re-arms entries
  assert.equal(restartedAgent.gate(signal(), context(100_000)).approved, true);
});

test('riskAgent: with the risk engine on (the default), a drawdown halt still survives a restart', () => {
  Object.assign(config.risk, { minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2 });
  const withPerformance = (equity: number): MarketContext => {
    const engine = new PerformanceEngine(100_000, () => 0);
    engine.onEquity(equity);
    return { ...context(equity), performance: { circuit: 'NORMAL', snapshot: engine.snapshot(equity) } };
  };
  const file = hwmFile();

  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'on', hwm: new EquityHwmStore(file).forMode('paper') });
  const first = agent.gate(signal(), withPerformance(100_000));
  assert.equal(first.approved, true, first.reason);
  assert.equal(agent.gate(signal(), withPerformance(94_000)).approved, false);

  const restarted = new RiskAgent({} as BinanceService, { riskEngine: 'on', hwm: new EquityHwmStore(file).forMode('paper') });
  const decision = restarted.gate(signal(), withPerformance(94_500));
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /drawdown kill-switch/);
});

test('riskAgent: without a store the legacy session-peak behaviour is unchanged', () => {
  Object.assign(config.risk, { minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2 });
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'off' });
  assert.equal(agent.gate(signal(), context(100_000)).approved, true);
  assert.equal(agent.gate(signal(), context(94_000)).approved, false);
  // A restart without persistence forgets the peak (documented legacy behaviour)
  const fresh = new RiskAgent({} as BinanceService, { riskEngine: 'off' });
  assert.equal(fresh.gate(signal(), context(94_000)).approved, true);
});
