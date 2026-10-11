import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DecisionRecord } from '../src/decision/DecisionJournal.js';
import { loadDecisionFiles } from '../src/decision/loadDecisionFiles.js';
import { edgeVsCoinFlip } from '../src/learning/EdgeTest.js';

const trade = (id: number, reason: string, rr = 2, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decisionId: String(id), timestamp: id, symbol: 'ETHUSDT', strategy: 'MOMENTUM-γ', signalType: 'OPEN_LONG', side: 'LONG', signalId: String(id),
  confidence: 0.7, marketStateTime: null, marketStateVersion: null, evidence: { breakdown: null, score: 0, factors: [] },
  entry: 100, stopLoss: 99, takeProfit: 100 + rr, notionalUsdt: 1, riskDecision: { approved: true, size: 1, leverage: 1, reason: '' },
  status: 'EXECUTED', rejectionReason: null,
  outcome: { closedAt: id, exit: 100, qty: 1, pnl: 0, rMultiple: reason === 'TAKE PROFIT' ? rr : -1, reason }, ...over,
});
const many = (count: number, wins: number, rr = 2): DecisionRecord[] =>
  Array.from({ length: count }, (_, i) => trade(i, i < wins ? 'TAKE PROFIT' : 'STOP LOSS', rr));

test('a 2R hit rate of one in three is exactly what a coin flip gives', () => {
  const t = edgeVsCoinFlip(many(150, 50));
  assert.equal(t.n, 150);
  assert.ok(Math.abs(t.expectedWins - 50) < 1e-9);
  assert.ok(Math.abs(t.z!) < 1e-9);
  assert.ok(Math.abs(t.pBetter! - 0.5) < 1e-3);
});

test('a hit rate far above the coin-flip expectation is flagged as unlikely to be luck', () => {
  const t = edgeVsCoinFlip(many(150, 75));
  assert.ok(t.z! > 4);
  assert.ok(t.pBetter! < 0.001);
});

test('a hit rate below chance has a high p and a negative z', () => {
  const t = edgeVsCoinFlip(many(150, 25));
  assert.ok(t.z! < -3);
  assert.ok(t.pBetter! > 0.99);
});

test('the expectation follows each trade\'s own RR', () => {
  const t = edgeVsCoinFlip([trade(1, 'STOP LOSS', 4), trade(2, 'STOP LOSS', 1)]);
  assert.ok(Math.abs(t.expectedWins - (0.2 + 0.5)) < 1e-9);
});

test('rejected, open, trailed/manual and degenerate trades are not counted', () => {
  const t = edgeVsCoinFlip([
    trade(1, 'TAKE PROFIT'), trade(2, 'CLOSE'), trade(3, 'STOP LOSS', 2, { status: 'RISK_REJECTED' }),
    trade(4, 'STOP LOSS', 2, { outcome: undefined }), trade(5, 'STOP LOSS', 2, { stopLoss: 100 }),
  ]);
  assert.equal(t.n, 1);
  assert.equal(t.wins, 1);
});

test('no qualifying trades yields no test statistic', () => {
  const t = edgeVsCoinFlip([]);
  assert.deepEqual([t.n, t.z, t.pBetter], [0, null, null]);
});

test('journal files pool, and a repeated decision id keeps the latest record', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decisions-'));
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.jsonl');
  writeFileSync(a, [trade(1, 'STOP LOSS'), trade(2, 'TAKE PROFIT')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(b, [trade(2, 'STOP LOSS'), trade(3, 'TAKE PROFIT')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const pooled = loadDecisionFiles(`${a}, ${b}`);
  assert.deepEqual(pooled.map((r) => r.decisionId), ['1', '2', '3']);
  assert.equal(pooled[1].outcome?.reason, 'STOP LOSS');
  assert.deepEqual(loadDecisionFiles(path.join(dir, 'missing.jsonl')), []);
});

// --- capacity refusal context -------------------------------------------------------------------
import { capacityContext } from '../src/learning/RefusalContext.js';

const refused = (id: number, at: number, symbol: string, reason: string, strategy = 'MEAN-REVERT-θ'): DecisionRecord =>
  ({ ...trade(id, 'STOP LOSS'), timestamp: at, symbol, strategy: strategy as never, status: 'RISK_REJECTED', rejectionReason: reason, outcome: undefined });
const held = (id: number, openAt: number, closeAt: number, symbol = 'ETHUSDT'): DecisionRecord =>
  ({ ...trade(id, 'STOP LOSS'), timestamp: openAt, symbol, outcome: { closedAt: closeAt, exit: 99, qty: 1, pnl: -1, rMultiple: -1, reason: 'STOP LOSS' } });

test('capacity refusals are split by whether the same symbol was already held, and by the limit named', () => {
  const rows = capacityContext([
    held(1, 100, 200),
    refused(2, 150, 'ETHUSDT', 'risk-engine: portfolio_limits: symbol 185.8% (max 80%); gross 260.4% (max 80%); cluster ETH 185.8% (max 80%)'),
    refused(3, 250, 'ETHUSDT', 'risk-engine: portfolio_limits: gross 99% (max 80%)'),
    refused(4, 150, 'SOLUSDT', 'max gross exposure reached (78834 / 78612)'),
    refused(5, 160, 'ETHUSDT', 'liq buffer 1.1x ATR < 1.2x'),
  ]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.refused, 3);
  assert.equal(r.whileSymbolHeld, 1); // only the first: ETH held 100-200; the 250 refusal came after close; SOL was never held
  assert.deepEqual([r.limits.symbol, r.limits.gross, r.limits.cluster, r.limits.legacy_gross], [1, 2, 1, 1]);
});

test('a position still open at the end of the journal counts as held', () => {
  const rows = capacityContext([{ ...held(1, 100, 0), outcome: undefined }, refused(2, 500, 'ETHUSDT', 'risk-engine: portfolio_limits: gross 99% (max 80%)')]);
  assert.equal(rows[0].whileSymbolHeld, 1);
});

// --- stop width vs exposure cap ---------------------------------------------------------------
import { minStopPctToFitCap, stopFeasibility } from '../src/learning/RefusalContext.js';

test('with 1% risk, an 80% cap and 0.12% round-trip costs a stop must be at least ~1.13% wide', () => {
  const min = minStopPctToFitCap({ riskPerTradePct: 1, maxSymbolExposurePct: 80, legRate: 0.0006 });
  assert.ok(Math.abs(min - (1.25 - 0.12)) < 1e-9);
  // and that is exactly where notional/equity = risk / (stop + cost) hits the cap
  assert.ok(Math.abs(1 / (min + 0.12) - 0.8) < 1e-9);
});

test('a looser cap or a smaller risk budget lowers the stop width that can trade', () => {
  assert.ok(minStopPctToFitCap({ riskPerTradePct: 0.5, maxSymbolExposurePct: 80, legRate: 0.0006 }) < 0.6);
  assert.ok(minStopPctToFitCap({ riskPerTradePct: 1, maxSymbolExposurePct: 200, legRate: 0.0006 }) < 0.4);
});

const stoppy = (id: number, strategy: string, stopPct: number, status: DecisionRecord['status']): DecisionRecord =>
  ({ ...trade(id, 'STOP LOSS'), strategy: strategy as never, entry: 100, stopLoss: 100 - stopPct, status });

test('stop feasibility shows which strategies can ever fit the cap and whether anything infeasible traded', () => {
  const rows = stopFeasibility([
    stoppy(1, 'MEAN-REVERT-θ', 0.3, 'RISK_REJECTED'), stoppy(2, 'MEAN-REVERT-θ', 0.5, 'RISK_REJECTED'), stoppy(3, 'MEAN-REVERT-θ', 0.8, 'RISK_REJECTED'),
    stoppy(4, 'MOMENTUM-γ', 1.5, 'EXECUTED'), stoppy(5, 'MOMENTUM-γ', 2.0, 'RISK_REJECTED'), stoppy(6, 'MOMENTUM-γ', 0.4, 'RISK_REJECTED'),
  ], 1.13);
  const mr = rows.find((r) => r.strategy === 'MEAN-REVERT-θ')!;
  assert.deepEqual([mr.proposals, mr.feasible, mr.executedOfFeasible, mr.executedOfInfeasible], [3, 0, 0, 0]);
  const mo = rows.find((r) => r.strategy === 'MOMENTUM-γ')!;
  assert.deepEqual([mo.proposals, mo.feasible, mo.executedOfFeasible, mo.executedOfInfeasible], [3, 2, 1, 0]);
  assert.ok(mr.median < 1.13 && mo.p90 >= 1.13);
});

test('hypothetical (price-path replay) outcomes count like real target/stop exits', () => {
  const hypo = (id: number, tp: boolean): DecisionRecord => trade(id, tp ? 'HYPOTHETICAL TP' : 'HYPOTHETICAL SL');
  const t = edgeVsCoinFlip([hypo(1, true), hypo(2, false), hypo(3, false), trade(4, 'HYPOTHETICAL TIMEOUT')]);
  assert.equal(t.n, 3);
  assert.equal(t.wins, 1);
});
