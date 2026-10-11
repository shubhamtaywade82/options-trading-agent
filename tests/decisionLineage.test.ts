import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { DecisionJournal, type DecisionRecord } from '../src/decision/DecisionJournal.js';
import { ExecutorAgent } from '../src/agents/ExecutorAgent.js';
import { PaperEngine } from '../src/binance/paperEngine.js';
import { AgentLedger } from '../src/learning/AgentLedger.js';
import { TradeOutcomeRecorder } from '../src/learning/TradeOutcomeRecorder.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { entryMeta, type OpenParams } from '../src/binance/remoteOrders.js';
import { closedTrade } from '../src/binance/remoteState.js';
import type { AgentId, RiskDecision, Signal } from '../src/types.js';

const journalFile = () => join(mkdtempSync(join(tmpdir(), 'decisions-')), 'decisions.jsonl');

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decisionId: 'd1',
  timestamp: 1_000,
  symbol: 'BTCUSDT',
  strategy: 'MOMENTUM-γ' as AgentId,
  signalType: 'OPEN_LONG',
  side: 'LONG',
  signalId: 'sig1',
  confidence: 0.75,
  marketStateTime: 900,
  marketStateVersion: 1,
  evidence: { breakdown: null, score: 72, factors: ['regime_aligned:+20'] },
  entry: 100,
  stopLoss: 96,
  takeProfit: 108,
  notionalUsdt: 1_000,
  riskDecision: { approved: true, size: 1_000, leverage: 5, reason: 'ok' },
  status: 'EXECUTED',
  rejectionReason: null,
  ...over,
});

test('journal: records are readable back and survive a restart', () => {
  const file = journalFile();
  const journal = new DecisionJournal(file);
  journal.record(record());
  assert.equal(journal.get('d1')?.evidence.score, 72);

  const restarted = new DecisionJournal(file);
  assert.equal(restarted.get('d1')?.status, 'EXECUTED');
  assert.equal(restarted.get('d1')?.riskDecision.size, 1_000);
  assert.equal(restarted.all().length, 1);
});

test('journal: execution and outcome attach by superseding, not by rewriting history', () => {
  const file = journalFile();
  const journal = new DecisionJournal(file);
  journal.record(record());
  journal.attachExecution('d1', { ts: 1_050, spreadBps: 2, slippageBps: 1.5, effectiveCostBps: 8.5 });
  journal.attachOutcome('d1', { closedAt: 2_000, exit: 108, qty: 10, pnl: 80, rMultiple: 2, reason: 'TAKE PROFIT' });

  const folded = new DecisionJournal(file).get('d1');
  assert.equal(folded?.execution?.slippageBps, 1.5);
  assert.equal(folded?.outcome?.rMultiple, 2);
  assert.equal(folded?.status, 'EXECUTED');
  // The file itself keeps every append: one decision line, one execution line, one outcome line
  const lines = readFileSync(file, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).outcome, undefined);
  assert.equal(JSON.parse(lines[2]).outcome.rMultiple, 2);
});

test('journal: unknown ids are ignored and completed() filters for outcomes', () => {
  const journal = new DecisionJournal(journalFile());
  journal.record(record({ decisionId: 'open' }));
  journal.record(record({ decisionId: 'closed' }));
  journal.attachOutcome('closed', { closedAt: 2_000, exit: 108, qty: 1, pnl: 8, rMultiple: 2, reason: 'TAKE PROFIT' });
  journal.attachOutcome('missing', { closedAt: 0, exit: 0, qty: 0, pnl: 0, rMultiple: 0, reason: 'CLOSE' });
  assert.equal(journal.completed().length, 1);
  assert.equal(journal.completed()[0].decisionId, 'closed');
});

test('journal: a torn final line is skipped without losing earlier records', () => {
  const file = journalFile();
  const journal = new DecisionJournal(file);
  journal.record(record({ decisionId: 'ok' }));
  appendFileSync(file, '{"decisionId":"torn","timestamp":123', 'utf-8');
  const recovered = new DecisionJournal(file);
  assert.equal(recovered.get('ok')?.decisionId, 'ok');
  assert.equal(recovered.get('torn'), undefined);
});

test('journal: an unreadable file degrades to empty instead of throwing', () => {
  const file = journalFile();
  writeFileSync(file, 'not json at all', 'utf-8');
  const journal = new DecisionJournal(file);
  assert.equal(journal.all().length, 0);
  journal.record(record());
  assert.equal(journal.get('d1')?.decisionId, 'd1');
});

test('executor: threads the decisionId into the venue order', async () => {
  setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 0 });
  const captured: Record<string, unknown>[] = [];
  const service = {
    openFuturesPosition: async (params: Record<string, unknown>) => { captured.push(params); return { orderId: 1, status: 'FILLED' }; },
    getPremiumIndex: async () => ({ markPrice: 250, fundingRate: 0 }),
  } as unknown as BinanceService;
  const executor = new ExecutorAgent(service);
  const signal: Signal = { id: 's', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.75, entry: 100, stopLoss: 95, takeProfit: 110, reason: '', ts: 0 };
  const risk: RiskDecision = { approved: true, positionSizeUsdt: 1_000, leverage: 5, marginType: 'ISOLATED', liqBufferAtr: 3, reason: '' };
  await executor.execute(signal, risk, 'dec-42');
  assert.equal(captured[0].decisionId, 'dec-42');
  // Omitting it keeps the parameter absent (legacy callers unchanged)
  await executor.execute(signal, risk);
  assert.equal('decisionId' in captured[1], false);
});

test('paper engine: the decisionId travels from fill to position to trade journal', () => {
  const engine = new PaperEngine(join(mkdtempSync(join(tmpdir(), 'paper-')), 'state.json'));
  engine.openPosition({ symbol: 'BTCUSDT', side: 'BUY', qty: 2, leverage: 5, strategy: 'MOMENTUM-γ', entryPrice: 100, stopLoss: 95, takeProfit: 130, decisionId: 'dec-7' });
  const [pos] = engine.getPositions();
  assert.equal(pos.decisionId, 'dec-7');
  engine.markAll({ BTCUSDT: 131 });
  const [trade] = engine.getTrades();
  assert.equal(trade.decisionId, 'dec-7');

  // A fill without a decisionId journals a link-free trade (legacy behaviour unchanged)
  engine.openPosition({ symbol: 'ETHUSDT', side: 'BUY', qty: 1, leverage: 5, strategy: 'MOMENTUM-γ', entryPrice: 100, stopLoss: 95, takeProfit: 130 });
  engine.markAll({ ETHUSDT: 131 });
  const [ethTrade] = engine.getTrades().filter((t) => t.symbol === 'ETHUSDT');
  assert.equal('decisionId' in ethTrade, false);
});

test('recorder: grades against the stored decision evidence instead of a neutral 50', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grade-'));
  const ledger = new AgentLedger(join(dir, 'ledger.json'));
  const journal = new DecisionJournal(join(dir, 'decisions.jsonl'));
  journal.record(record({ decisionId: 'dec-9', evidence: { breakdown: null, score: 88, factors: ['regime_aligned:+20', 'pricing_location:+20'] }, entry: 100, stopLoss: 96, takeProfit: 108 }));

  const recorder = new TradeOutcomeRecorder(ledger, journal);
  const [graded] = recorder.process([{
    symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 108, qty: 10,
    pnl: 80, reason: 'TAKE PROFIT', closedAt: 2_000, initialRisk: 4, decisionId: 'dec-9',
  }]);
  // Planned risk from the decision (100 -> 96 = 4) with a realized 8-point move is 2R
  assert.equal(graded.rMultiple, 2);
  assert.equal(graded.evidence?.score, 88);
  assert.equal(graded.evidence?.source, 'decision');
  assert.ok(graded.score >= 88, `score ${graded.score} should be anchored at the decision's evidence score`);

  // The journal now carries the outcome — the lineage is closed
  assert.equal(journal.get('dec-9')?.outcome?.rMultiple, 2);
  assert.equal(journal.get('dec-9')?.outcome?.pnl, 80);
});

test('recorder: trades without a decisionId keep the neutral fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grade-'));
  const ledger = new AgentLedger(join(dir, 'ledger.json'));
  const journal = new DecisionJournal(join(dir, 'decisions.jsonl'));
  const recorder = new TradeOutcomeRecorder(ledger, journal);
  const [graded] = recorder.process([{
    symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 90, qty: 1,
    pnl: -10, reason: 'STOP LOSS', closedAt: 2_000, initialRisk: 10,
  }]);
  assert.equal(graded.evidence, undefined);
  assert.equal(graded.rMultiple, -1);
  assert.equal(journal.all().length, 0);
});

test('remote: entryMeta and closedTrade carry the decision lineage', () => {
  const params: OpenParams = { symbol: 'BTCUSDT', side: 'BUY', qty: 1, leverage: 5, strategy: 'MOMENTUM-γ', entryPrice: 100, stopLoss: 95, takeProfit: 130, decisionId: 'dec-r1' };
  const meta = entryMeta(params, 1_000);
  assert.equal(meta.decisionId, 'dec-r1');
  assert.equal(meta.initialRisk, 5);
  const trade = closedTrade({ symbol: 'BTCUSDT', owner: 'MOMENTUM-γ', side: 'LONG', entry: 100, qty: 1, initialRisk: 5, decisionId: 'dec-r1' }, 130, 'TAKE PROFIT', 2_000);
  assert.equal(trade.decisionId, 'dec-r1');

  // Metas without a decisionId are unchanged (no phantom keys)
  const plain = entryMeta({ ...params, decisionId: undefined }, 1_000);
  assert.equal('decisionId' in plain, false);
  const plainTrade = closedTrade({ symbol: 'BTCUSDT', owner: 'MOMENTUM-γ', side: 'LONG', entry: 100, qty: 1 }, 130, 'TAKE PROFIT', 2_000);
  assert.equal('decisionId' in plainTrade, false);
});
