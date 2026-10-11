import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { RiskAgent } from '../src/agents/RiskAgent.js';
import { config } from '../src/config.js';
import type { DecisionRecord } from '../src/decision/DecisionJournal.js';
import { classifyRiskRefusal } from '../src/decision/NoTrade.js';
import { approvable, DEFAULT_POLICY, evaluateConfig, evaluateEvidence, evaluateForward, isReady, liveStartBlockers, type ConfigFacts } from '../src/ops/liveReadiness.js';
import { PerformanceEngine } from '../src/risk/performanceEngine.js';
import { riskLimitsFromConfig } from '../src/risk/riskConfig.js';
import { loadApprovals, writeApprovals } from '../src/risk/strategyApprovals.js';
import type { Candle, Signal } from '../src/types.js';

const DAY = 86_400_000;
const COSTS = { feeRate: 0.0004, slippageRate: 0.0002 };
// risk 1 (entry 100, stop 99) => cost 0.12 R; `r` is the gross R the journal records
const trade = (i: number, strategy: string, r: number, dayOffset: number): DecisionRecord => ({
  decisionId: `${strategy}-${i}`, timestamp: dayOffset * DAY, symbol: 'ETHUSDT', strategy: strategy as never, signalType: 'OPEN_LONG', side: 'LONG',
  signalId: String(i), confidence: 0.7, marketStateTime: null, marketStateVersion: null, evidence: { breakdown: null, score: 0, factors: [] },
  entry: 100, stopLoss: 99, takeProfit: 102, notionalUsdt: 1, riskDecision: { approved: true, size: 1, leverage: 1, reason: '' },
  status: 'EXECUTED', rejectionReason: null,
  outcome: { closedAt: dayOffset * DAY, exit: 100, qty: 1, pnl: 0, rMultiple: r, reason: r > 0 ? 'TAKE PROFIT' : 'STOP LOSS' },
});
/** n trades over `days`, alternating gross R of `win` and -1 so the mean is controlled. */
const series = (strategy: string, n: number, days: number, win: number): DecisionRecord[] =>
  Array.from({ length: n }, (_, i) => trade(i, strategy, i % 2 === 0 ? win : -1, (i / n) * days));

test('a strategy with a genuinely positive, stable, long record passes the evidence gate', () => {
  // wins of +3R against -1R => mean gross +1R, net ~+0.88R, stable in both halves
  const [e] = evaluateEvidence(series('GOOD', 160, 200, 3), COSTS);
  assert.equal(e.pass, true, e.failures.join('; '));
  assert.ok(e.lcbNetR > 0);
});

test('a coin-flip-with-costs strategy fails on expectancy, which is what the current strategies look like', () => {
  // +2R / -1R alternating is +0.5R gross; make it the real shape: 1 win in 3 at 2R
  const rs = Array.from({ length: 180 }, (_, i) => trade(i, 'COIN', i % 3 === 0 ? 2 : -1, (i / 180) * 200));
  const [e] = evaluateEvidence(rs, COSTS);
  assert.equal(e.pass, false);
  assert.ok(e.failures.some((f) => /lower bound/.test(f)));
});

test('too few trades or too short a span fail even when the average is great', () => {
  const few = evaluateEvidence(series('FEW', 40, 200, 3), COSTS)[0];
  assert.ok(few.failures.some((f) => /only 40 trades/.test(f)));
  const short = evaluateEvidence(series('SHORT', 160, 30, 3), COSTS)[0];
  assert.ok(short.failures.some((f) => /spans 30 days/.test(f)));
});

test('a strategy that earned everything in one half and lost in the other fails the stability test', () => {
  const rs = [
    ...Array.from({ length: 80 }, (_, i) => trade(i, 'LUCKY', 3, (i / 80) * 100)),
    ...Array.from({ length: 80 }, (_, i) => trade(100 + i, 'LUCKY', i % 4 === 0 ? 0.3 : -1, 100 + (i / 80) * 100)),
  ];
  const [e] = evaluateEvidence(rs, COSTS);
  assert.ok(e.meanNetR > 0);
  assert.equal(e.pass, false);
  assert.ok(e.failures.some((f) => /both halves/.test(f)));
});

test('forward paper evidence needs trades, days and a positive net mean', () => {
  assert.equal(evaluateForward(series('F', 60, 40, 3), COSTS)[0].pass, true);
  assert.ok(evaluateForward(series('F', 10, 40, 3), COSTS)[0].failures.some((f) => /only 10 paper trades/.test(f)));
  assert.ok(evaluateForward(series('F', 60, 5, 3), COSTS)[0].failures.some((f) => /span 5 days/.test(f)));
  assert.ok(evaluateForward(series('F', 60, 40, 0.2), COSTS)[0].failures.some((f) => /not above 0/.test(f)));
});

test('a strategy is approvable only when evidence AND forward both pass', () => {
  const ev = evaluateEvidence([...series('A', 160, 200, 3), ...series('B', 160, 200, 3)], COSTS);
  const fw = evaluateForward([...series('A', 60, 40, 3), ...series('B', 60, 40, 0.2)], COSTS);
  assert.deepEqual(approvable(ev, fw).map((a) => a.strategy), ['A']);
  assert.deepEqual(approvable(ev, []), []);
  assert.ok(approvable(ev, fw)[0].snapshot.forwardTrades === 60);
});

const facts = (over: Partial<ConfigFacts> = {}): ConfigFacts => ({
  mode: 'paper', riskEngine: 'on', alerts: 'on', riskPerTradePct: 1, maxLeverage: 5, maxDailyLossPct: 3, maxDrawdownPct: 10,
  killSwitchHalted: false, unprotected: [], ...over,
});

test('a conservative configuration is ready; each unsafe setting is called out', () => {
  assert.equal(isReady(evaluateConfig(facts())), true);
  assert.equal(isReady(evaluateConfig(facts({ riskEngine: 'off' }))), false);
  assert.equal(isReady(evaluateConfig(facts({ alerts: 'off' }))), false);
  assert.equal(isReady(evaluateConfig(facts({ maxLeverage: 20 }))), false);
  assert.equal(isReady(evaluateConfig(facts({ maxDailyLossPct: 0 }))), false); // 0 means no limit
  assert.equal(isReady(evaluateConfig(facts({ maxDrawdownPct: 40 }))), false);
  assert.equal(isReady(evaluateConfig(facts({ unprotected: [{ symbol: 'ETHUSDT', owner: 'EXECUTOR-ε' }] }))), false);
});

test('values between the pass and fail limits warn without blocking', () => {
  const checks = evaluateConfig(facts({ riskPerTradePct: 1.5, maxLeverage: 8 }));
  assert.equal(checks.find((c) => c.id === 'risk-per-trade')!.status, 'WARN');
  assert.equal(checks.find((c) => c.id === 'max-leverage')!.status, 'WARN');
  assert.equal(isReady(checks), true);
  assert.equal(evaluateConfig(facts({ killSwitchHalted: true })).find((c) => c.id === 'kill-switch')!.status, 'WARN');
});

test('live start is blocked without the risk engine or alerts; paper never is', () => {
  assert.deepEqual(liveStartBlockers({ mode: 'paper', riskEngine: 'off', alerts: 'off' }), []);
  assert.equal(liveStartBlockers({ mode: 'live', riskEngine: 'on', alerts: 'on' }).length, 0);
  assert.equal(liveStartBlockers({ mode: 'live', riskEngine: 'off', alerts: 'on' }).length, 1);
  assert.equal(liveStartBlockers({ mode: 'live', riskEngine: 'off', alerts: 'off' }).length, 2);
  assert.ok(DEFAULT_POLICY.evidence.minTrades >= 100);
});

// --- approvals file -----------------------------------------------------------------------------
test('approvals round-trip, and anything missing or malformed approves nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'approvals-'));
  const file = path.join(dir, 'a.json');
  assert.equal(loadApprovals(file).size, 0);
  const snapshot = { trades: 1, meanNetR: 1, lcbNetR: 1, firstHalfNetR: 1, secondHalfNetR: 1, forwardTrades: 1, forwardMeanNetR: 1 };
  writeApprovals(file, [{ strategy: 'GOOD', approvedAt: 1, evidence: snapshot }]);
  assert.deepEqual([...loadApprovals(file)], ['GOOD']);
  writeFileSync(file, '{not json');
  assert.equal(loadApprovals(file).size, 0);
  writeFileSync(file, JSON.stringify({ version: 2, approvals: [{ strategy: 'X' }] }));
  assert.equal(loadApprovals(file).size, 0);
  writeFileSync(file, JSON.stringify({ version: 1, approvals: [{ strategy: '' }, { nope: true }] }));
  assert.equal(loadApprovals(file).size, 0);
});

// --- the live gate in RiskAgent -----------------------------------------------------------------
const risk = {
  minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2,
  maxDailyLossPct: 3, maxLossStreak: 4, maxConcurrentPositions: 4, maxSymbolExposurePct: 80, maxCorrelatedExposurePct: 80,
  minRr: 0, takerFeeRate: 0.0004, slippageBufferRate: 0.0002,
};
Object.assign(config.risk, risk);
const limits = riskLimitsFromConfig(risk);
setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 });
const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({ openTime: i, open: 100, high: 100.25, low: 99.75, close: 100, volume: 1 }));
const perf = new PerformanceEngine(100_000, () => 0);
perf.onEquity(100_000);
const ctx = (): MarketContext => ({ candles: { BTCUSDT: candles }, funding: {}, marks: {}, spot: {}, equity: 100_000, positions: [], performance: { circuit: 'NORMAL', snapshot: perf.snapshot(100_000) } });
const sig = (agent: string, type: Signal['type'] = 'OPEN_LONG'): Signal =>
  ({ id: 's', agent: agent as never, symbol: 'BTCUSDT', type, confidence: 0.75, entry: 100, stopLoss: 98, takeProfit: 106, reason: '', ts: 0 });

test('in live mode an unapproved strategy is refused, an approved one is gated normally', () => {
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'on', limits, requireApproval: true, approvedStrategies: new Set(['MOMENTUM-γ']) });
  const refused = agent.gate(sig('CROWDING-ι'), ctx());
  assert.equal(refused.approved, false);
  assert.match(refused.reason, /not approved for live trading/);
  assert.equal(classifyRiskRefusal(refused.reason), 'NOT_APPROVED');
  assert.equal(agent.gate(sig('MOMENTUM-γ'), ctx()).approved, true);
});

test('with no approvals file live refuses every entry but never blocks a close', () => {
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'on', limits, requireApproval: true, approvedStrategies: loadApprovals('/nonexistent/approvals.json') });
  assert.equal(agent.gate(sig('MOMENTUM-γ'), ctx()).approved, false);
  assert.equal(agent.gate(sig('MOMENTUM-γ', 'CLOSE' as Signal['type']), ctx()).reason.includes('not approved'), false);
});

test('paper mode is unaffected by the approval gate', () => {
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'on', limits });
  assert.equal(agent.gate(sig('CROWDING-ι'), ctx()).approved, true);
});
