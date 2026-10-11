import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLedger } from '../src/learning/AgentLedger.js';
import { confidenceMultiplier } from '../src/learning/ConfidenceAdjuster.js';
import { TradeOutcomeRecorder } from '../src/learning/TradeOutcomeRecorder.js';

function makeLedger(): { ledger: AgentLedger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const ledger = new AgentLedger(join(dir, 'ledger.json'));
  return { ledger, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('AgentLedger: cold start returns null for win-rate and avgR', () => {
  const { ledger, cleanup } = makeLedger();
  assert.equal(ledger.winRate('MOMENTUM-γ' as any), null);
  assert.equal(ledger.avgR('MOMENTUM-γ' as any), null);
  cleanup();
});

test('AgentLedger: win-rate and avgR populate after 3+ trades', () => {
  const { ledger, cleanup } = makeLedger();
  ledger.record('MOMENTUM-γ' as any, true, 2.0);
  ledger.record('MOMENTUM-γ' as any, true, 1.5);
  ledger.record('MOMENTUM-γ' as any, false, -1.0);
  const wr = ledger.winRate('MOMENTUM-γ' as any);
  const avgR = ledger.avgR('MOMENTUM-γ' as any);
  assert.ok(wr !== null && wr >= 0 && wr <= 1, `win-rate should be in [0,1], got ${wr}`);
  assert.ok(avgR !== null, `avgR should be non-null after 3 trades`);
  // 2 wins at +2R and +1.5R, 1 loss at -1R — net expectancy should be positive
  assert.ok(avgR > 0, `avgR should be positive with 2 winning trades, got ${avgR}`);
  cleanup();
});

test('AgentLedger: persists across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'ledger.json');
  const a = new AgentLedger(path);
  a.record('FUNDING-ARB-β' as any, true, 1.5);
  a.record('FUNDING-ARB-β' as any, true, 2.0);
  a.record('FUNDING-ARB-β' as any, false, -0.5);
  const b = new AgentLedger(path);
  assert.ok(b.winRate('FUNDING-ARB-β' as any) !== null, 'should reload from disk');
  rmSync(dir, { recursive: true });
});

test('ConfidenceAdjuster: cold start is 1.0', () => {
  const { ledger, cleanup } = makeLedger();
  assert.equal(confidenceMultiplier('MOMENTUM-γ' as any, ledger), 1.0);
  cleanup();
});

test('ConfidenceAdjuster: proven agent gets multiplier > 1.0', () => {
  const { ledger, cleanup } = makeLedger();
  for (let i = 0; i < 10; i++) ledger.record('MOMENTUM-γ' as any, true, 2.5);
  const mult = confidenceMultiplier('MOMENTUM-γ' as any, ledger);
  assert.ok(mult > 1.0, `expected mult > 1.0, got ${mult}`);
  assert.ok(mult <= 1.2, `multiplier must not exceed 1.2, got ${mult}`);
  cleanup();
});

test('ConfidenceAdjuster: consistently losing agent gets multiplier < 1.0', () => {
  const { ledger, cleanup } = makeLedger();
  for (let i = 0; i < 10; i++) ledger.record('MOMENTUM-γ' as any, false, -1.5);
  const mult = confidenceMultiplier('MOMENTUM-γ' as any, ledger);
  assert.ok(mult < 1.0, `expected mult < 1.0, got ${mult}`);
  assert.ok(mult >= 0.6, `multiplier must not go below 0.6, got ${mult}`);
  cleanup();
});

test('TradeOutcomeRecorder: grades a new exit and skips seen ones', () => {
  const { ledger, cleanup } = makeLedger();
  const recorder = new TradeOutcomeRecorder(ledger);
  const trade = {
    symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ' as any, side: 'LONG' as any,
    entry: 40000, exit: 42000, qty: 0.1, pnl: 200, reason: 'SL' as any,
    closedAt: 1_000_000, initialRisk: 500,
  };
  const first = recorder.process([trade]);
  assert.equal(first.length, 1);
  assert.equal(first[0].rMultiple, 4); // (42000-40000)/500 = 4R

  const second = recorder.process([trade]);
  assert.equal(second.length, 0, 'should not reprocess seen trade');
  cleanup();
});

test('TradeOutcomeRecorder: updates ledger so multiplier adapts after grading', () => {
  const { ledger, cleanup } = makeLedger();
  const recorder = new TradeOutcomeRecorder(ledger);
  const base = { symbol: 'ETHUSDT', strategy: 'CROWDING-ι' as any, side: 'SHORT' as any, entry: 2000, initialRisk: 50 };
  for (let i = 0; i < 3; i++) {
    recorder.process([{ ...base, exit: 1900, qty: 1, pnl: 100, reason: 'TP' as any, closedAt: i + 1 }]);
  }
  const mult = confidenceMultiplier('CROWDING-ι' as any, ledger);
  assert.ok(mult > 1.0, `ledger should push multiplier above 1 after 3 wins, got ${mult}`);
  cleanup();
});


test('TradeOutcomeRecorder: processed trade remains deduplicated after recorder restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-restart-'));
  const path = join(dir, 'ledger.json');
  const trade = {
    symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ' as any, side: 'LONG' as any,
    entry: 40000, exit: 39500, qty: 0.1, pnl: -50, reason: 'STOP LOSS' as any,
    closedAt: 2_000_000, initialRisk: 500,
  };
  const first = new TradeOutcomeRecorder(new AgentLedger(path));
  assert.equal(first.process([trade]).length, 1);
  const restarted = new TradeOutcomeRecorder(new AgentLedger(path));
  assert.equal(restarted.process([trade]).length, 0);
  rmSync(dir, { recursive: true });
});

test('AgentLedger: context history can differ by symbol', () => {
  const { ledger, cleanup } = makeLedger();
  for (let i = 0; i < 8; i++) ledger.record('MOMENTUM-γ' as any, true, 2, { symbol: 'BTCUSDT' });
  for (let i = 0; i < 8; i++) ledger.record('MOMENTUM-γ' as any, false, -1, { symbol: 'ETHUSDT' });
  assert.ok(ledger.tradeStats('MOMENTUM-γ' as any, 'BTCUSDT').wins === 8);
  assert.equal(ledger.tradeStats('MOMENTUM-γ' as any, 'ETHUSDT').wins, 0);
  const btcMultiplier = confidenceMultiplier('MOMENTUM-γ' as any, ledger, 'BTCUSDT');
  const ethMultiplier = confidenceMultiplier('MOMENTUM-γ' as any, ledger, 'ETHUSDT');
  assert.ok(btcMultiplier > 1, `expected BTC context multiplier > 1, got ${btcMultiplier}`);
  assert.ok(ethMultiplier < 1, `expected ETH context multiplier < 1, got ${ethMultiplier}`);
  cleanup();
});

test('AgentLedger: resolves directional and neutral forecasts from future marks', () => {
  const { ledger, cleanup } = makeLedger();
  ledger.recordPrediction({
    id: 'forecast:test:long',
    actorId: 'TECHNICAL-ANALYST',
    symbol: 'BTCUSDT',
    stance: 'LONG',
    probability: 0.7,
    mark: 100,
    thresholdPct: 0.02,
    horizonMinutes: 30,
    createdAt: 1_000_000,
  });
  ledger.recordPrediction({
    id: 'forecast:test:neutral',
    actorId: 'SKEPTIC-ANALYST',
    symbol: 'ETHUSDT',
    stance: 'NEUTRAL',
    probability: 0.65,
    mark: 100,
    thresholdPct: 0.02,
    horizonMinutes: 30,
    createdAt: 1_000_000,
  });
  const resolved = ledger.resolvePredictions({ BTCUSDT: 103, ETHUSDT: 101 }, 1_000_000 + 31 * 60_000);
  assert.equal(resolved.length, 2);
  assert.equal(resolved.find((r) => r.actorId === 'TECHNICAL-ANALYST')?.correct, true);
  assert.equal(resolved.find((r) => r.actorId === 'SKEPTIC-ANALYST')?.correct, true);
  cleanup();
});

test('AgentLedger: null path keeps the ledger in memory without touching disk', () => {
  const ledger = new AgentLedger(null);
  ledger.record('STRUCT-LIQ-η' as any, true, 2.0, { symbol: 'BTCUSDT' });
  ledger.record('STRUCT-LIQ-η' as any, true, 1.5, { symbol: 'ETHUSDT' });

  const stats = ledger.get('STRUCT-LIQ-η' as any);
  assert.equal(stats.trades, 2);
  assert.equal(stats.wins, 2);
  assert.ok(stats.totalR > 0);

  // A second in-memory ledger starts cold: one replay never trains another
  const fresh = new AgentLedger(null);
  assert.equal(fresh.get('STRUCT-LIQ-η' as any).trades, 0);
  assert.ok(!fresh.hasProcessedTrade('any-key'));
});

test('AgentLedger: in-memory mode still dedupes processed trades within the instance', () => {
  const ledger = new AgentLedger(null);
  const recorder = new TradeOutcomeRecorder(ledger);
  const trade = {
    symbol: 'BTCUSDT', strategy: 'STRUCT-LIQ-η' as any, side: 'LONG' as any,
    entry: 100, exit: 103, qty: 1, pnl: 3, reason: 'TAKE PROFIT' as any,
    closedAt: 5_000_000, initialRisk: 1.5,
  };
  assert.equal(recorder.process([trade]).length, 1);
  assert.equal(recorder.process([trade]).length, 0, 'same trade must not grade twice');
  assert.equal(ledger.get('STRUCT-LIQ-η' as any).trades, 1);
});
