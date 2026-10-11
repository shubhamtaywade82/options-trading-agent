import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { BaseAgent, type MarketContext } from '../src/agents/BaseAgent.js';
import type { Signal, Candle, AgentId } from '../src/types.js';
import { MarketDataFeed } from '../src/backtesting/MarketDataFeed.js';
import { ExecutionSimulator, liquidationPrice } from '../src/backtesting/ExecutionSimulator.js';
import { PortfolioSimulator } from '../src/backtesting/PortfolioSimulator.js';
import { ReplayService, defaultReplayAgents } from '../src/backtesting/ReplayService.js';
import { FIFTEEN_MINUTES_MS } from '../src/backtesting/types.js';
import type { SimTrade } from '../src/backtesting/types.js';

const FIFTEEN_MIN = FIFTEEN_MINUTES_MS;
const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);

/** Deterministic V-shape: a long decline, then a strong rise — the EMA50 cross the momentum agent hunts for. */
function vShapeCandles(count: number, turnAt: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = i < turnAt ? -0.35 : 0.6;
    const wobble = Math.sin(i / 3) * 0.15;
    const open = price;
    const close = price + drift + wobble;
    candles.push({
      openTime: i * FIFTEEN_MIN,
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
      volume: 100,
    });
    price = close;
  }
  return candles;
}

/** Fires exactly one long at the first opportunity after a minimum history. */
class OneShotLongAgent extends BaseAgent {
  readonly id = 'FUNDING-ARB-α' as const;
  readonly strategy = 'test_one_shot_long';
  private fired = false;

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    if (this.fired) return [];
    const closed = ctx.candles['BTCUSDT'] ?? [];
    if (closed.length < 60) return [];
    this.fired = true;
    const last = closed[closed.length - 1];
    return [this.signal({
      symbol: 'BTCUSDT',
      type: 'OPEN_LONG',
      confidence: 0.8,
      entry: last.close,
      stopLoss: last.close - 3,
      takeProfit: last.close + 6,
      reason: 'one-shot test entry',
      ts: last.openTime,
    })];
  }
}

test('feed: only candles fully closed by the step time are visible (no lookahead)', () => {
  const candles = vShapeCandles(10, 5);
  const feed = new MarketDataFeed({ BTCUSDT: { '15m': candles } });
  assert.equal(feed.stepCount, 10);
  // Step 3 closes candle #3 (openTime 3*15m): candles 0..3 are closed, 4+ are not
  const visible = feed.closedCandles('BTCUSDT', '15m', feed.stepTime(3));
  assert.equal(visible.length, 4);
  assert.equal(visible[3].openTime, 3 * FIFTEEN_MIN);
  // The next open after step 3 is candle #4's open — the fill anchor
  const nextOpen = feed.nextOpen(3);
  if (nextOpen === undefined) throw new Error('expected a next candle open');
  near(nextOpen, candles[4]!.open);
});

test('feed: higher timeframes only expose bars closed by the step', () => {
  const base = vShapeCandles(20, 10);
  const hour = Array.from({ length: 5 }, (_, i) => ({
    openTime: i * 60 * 60_000,
    open: 100, high: 101, low: 99, close: 100, volume: 1,
  }));
  const feed = new MarketDataFeed({ BTCUSDT: { '15m': base, '1h': hour } });
  // At 15m step 0 (close 15m), no full hourly bar has closed yet
  assert.equal(feed.closedCandles('BTCUSDT', '1h', feed.stepTime(0)).length, 0);
  // At step 4 (close 60m), exactly one hourly bar is closed
  assert.equal(feed.closedCandles('BTCUSDT', '1h', feed.stepTime(4)).length, 1);
});

test('simulator: entries pay friction and exits receive it', () => {
  const costs = { takerFeeBps: 4, spreadBps: 2, slippageBps: 3 };
  const sim = new ExecutionSimulator(costs);
  const friction = (2 / 2 + 3) / 10_000; // half-spread + slippage
  const long = sim.entry('LONG', 100, 2);
  near(long.price, 100 * (1 + friction));
  near(long.fee, 100 * (1 + friction) * 2 * 0.0004);
  const short = sim.entry('SHORT', 100, 2);
  near(short.price, 100 * (1 - friction));
});

test('simulator: a bar touching both stop and target resolves as a stop (conservative)', () => {
  const sim = new ExecutionSimulator({ takerFeeBps: 4, spreadBps: 2, slippageBps: 3 });
  const bar: Candle = { openTime: 0, open: 100, high: 110, low: 94, close: 100, volume: 1 };
  const exit = sim.evaluateExit({ side: 'LONG', entry: 100, stopLoss: 96, takeProfit: 108, leverage: 5 }, bar);
  assert.equal(exit?.reason, 'STOP LOSS');
  near(exit!.price, 96);
  // Mirrored for shorts
  const shortExit = sim.evaluateExit({ side: 'SHORT', entry: 100, stopLoss: 104, takeProfit: 92, leverage: 5 }, bar);
  assert.equal(shortExit?.reason, 'STOP LOSS');
  near(shortExit!.price, 104);
});

test('simulator: a stop gapped through at the open fills at the open, never better than the level', () => {
  const sim = new ExecutionSimulator({ takerFeeBps: 4, spreadBps: 2, slippageBps: 3 });
  const bar: Candle = { openTime: 0, open: 90, high: 99, low: 88, close: 95, volume: 1 };
  const exit = sim.evaluateExit({ side: 'LONG', entry: 100, stopLoss: 96, takeProfit: 108, leverage: 5 }, bar);
  assert.equal(exit?.reason, 'STOP LOSS');
  near(exit!.price, 90);
});

test('simulator: liquidation price matches the isolated-margin formula', () => {
  near(liquidationPrice('LONG', 100, 10)!, 90.5);
  near(liquidationPrice('SHORT', 100, 10)!, 109.5);
  assert.equal(liquidationPrice('LONG', 100, 1), null);
});

test('portfolio: an open, mark and stop-out books a trade with risk, decision and excursions', () => {
  const costs = { takerFeeBps: 4, spreadBps: 2, slippageBps: 3 };
  const portfolio = new PortfolioSimulator(1_000, new ExecutionSimulator(costs));
  const fill = new ExecutionSimulator(costs).entry('LONG', 100, 2);
  portfolio.open({
    symbol: 'BTCUSDT', side: 'LONG', qty: 2, leverage: 5, strategy: 'MOMENTUM-γ',
    stopLoss: 96, takeProfit: 108, decisionId: 'd-1', regime: 'TREND_UP', evidenceScore: 72,
    fillPrice: fill.price, fee: fill.fee, slippage: fill.slippage, openedAt: 0,
  });
  // Adverse excursion, then the stop resolves
  portfolio.onBar('BTCUSDT', { openTime: FIFTEEN_MIN, open: 100, high: 101, low: 95.5, close: 96, volume: 1 });
  const [trade] = portfolio.getTrades();
  assert.equal(trade.reason, 'STOP LOSS');
  assert.equal(trade.decisionId, 'd-1');
  assert.equal(trade.regime, 'TREND_UP');
  assert.equal(trade.evidenceScore, 72);
  assert.ok((trade.maeR ?? 0) > 0, 'adverse excursion is a positive magnitude in R');
  assert.ok(trade.fees > 0);
  // Entry fee left the wallet at open, exit fee at close
  near(portfolio.equity(), 1_000 - fill.fee + trade.pnl - (trade.fees - fill.fee));
});

test('portfolio: scale-in averages the entry and replaces levels', () => {
  const costs = { takerFeeBps: 4, spreadBps: 2, slippageBps: 3 };
  const simulator = new ExecutionSimulator(costs);
  const portfolio = new PortfolioSimulator(1_000, simulator);
  portfolio.open({
    symbol: 'BTCUSDT', side: 'LONG', qty: 1, leverage: 5, strategy: 'MOMENTUM-γ',
    stopLoss: 95, takeProfit: 110, decisionId: 'd-1', regime: 'RANGE', evidenceScore: 60,
    fillPrice: 100, fee: 0.4, slippage: 0.1, openedAt: 0,
  });
  const holder = portfolio.holderOf('BTCUSDT')!;
  portfolio.scaleIn(holder, {
    symbol: 'BTCUSDT', side: 'LONG', qty: 3, leverage: 6, strategy: 'MOMENTUM-γ',
    stopLoss: 97, takeProfit: 112, decisionId: 'd-2', regime: 'RANGE', evidenceScore: 60,
    fillPrice: 104, fee: 0.5, slippage: 0.1, openedAt: FIFTEEN_MIN,
  });
  const merged = portfolio.toPositions()[0];
  near(merged.entry, 103);
  near(merged.qty, 4);
  assert.equal(merged.serverSl, '97');
  assert.equal(merged.serverTp, '112');
});

test('portfolio: funding debits longs on positive rates and survives to the journal', () => {
  const costs = { takerFeeBps: 4, spreadBps: 2, slippageBps: 3 };
  const simulator = new ExecutionSimulator(costs);
  const portfolio = new PortfolioSimulator(1_000, simulator);
  portfolio.open({
    symbol: 'BTCUSDT', side: 'LONG', qty: 1, leverage: 5, strategy: 'MOMENTUM-γ',
    takeProfit: 120, regime: 'RANGE', evidenceScore: null, fillPrice: 100, fee: 0, slippage: 0, openedAt: 0,
  });
  const before = portfolio.equity();
  portfolio.applyFunding('BTCUSDT', 0.001, FIFTEEN_MIN);
  near(portfolio.equity(), before - 0.1); // 0.1% of 100 notional
  portfolio.onBar('BTCUSDT', { openTime: 2 * FIFTEEN_MIN, open: 100, high: 130, low: 99, close: 130, volume: 1 });
  const [trade] = portfolio.getTrades();
  near(trade.funding, -0.1);
});

test('replay: a one-shot long fills at the next open with friction and links its decision', async () => {
  const data = { BTCUSDT: { '15m': vShapeCandles(200, 150) } };
  const result = await new ReplayService({ agents: [new OneShotLongAgent({} as BinanceService)], config: { warmupBars: 50 } }).run(data);

  assert.ok(result.metrics.totalTrades >= 1, 'expected at least one trade');
  const trade = result.trades.find((t) => t.symbol === 'BTCUSDT')!;
  assert.equal(trade.strategy, 'FUNDING-ARB-α');

  // No-lookahead: the fill price anchors to the bar AFTER the decision close, with friction
  const decision = result.decisions.find((d) => d.decisionId === trade.decisionId);
  assert.ok(decision, 'trade decision must exist in the journal');
  assert.equal(decision?.status, 'EXECUTED');
  assert.ok(decision?.execution, 'execution friction must be attached');
  assert.ok(decision?.outcome, 'outcome must be attached once closed');
  assert.equal(decision?.outcome?.rMultiple !== undefined, true);
  const fillBar = data.BTCUSDT['15m'].find((c) => c.openTime === decision!.timestamp);
  assert.ok(fillBar, 'the fill bar opens exactly at the decision close time');
  const friction = (2 / 2 + 3) / 10_000;
  near(trade.openedAt, decision!.timestamp);
  near(trade.entry, fillBar!.open * (1 + friction), 1e-4);

  // The journal saw the decision, and the equity curve covers the full run
  assert.equal(result.equityCurve.length, 200);
  assert.ok(result.metrics.byStrategy['FUNDING-ARB-α'] !== undefined);
});

test('replay: same input produces the identical result (determinism)', async () => {
  const data = { BTCUSDT: { '15m': vShapeCandles(180, 140) } };
  const agents = () => [new OneShotLongAgent({} as BinanceService)];
  const first = await new ReplayService({ agents: agents() }).run(data);
  const second = await new ReplayService({ agents: agents() }).run(data);
  assert.deepEqual(JSON.parse(JSON.stringify(first.metrics)), JSON.parse(JSON.stringify(second.metrics)));
  assert.deepEqual(first.trades.map((t) => [t.decisionId, t.entry, t.exit, t.pnl]), second.trades.map((t) => [t.decisionId, t.entry, t.exit, t.pnl]));
});

test('replay: the default fleet runs the full pipeline on trending data', { timeout: 120_000 }, async () => {
  const data = {
    BTCUSDT: { '15m': vShapeCandles(520, 310) },
  };
  const result = await new ReplayService({ config: { warmupBars: 280 } }).run(data);
  assert.equal(defaultReplayAgents().length, 6);
  assert.equal(result.equityCurve.length, 520);
  // Whatever the strategies decided, the journal must be consistent: every executed trade has a decision with an outcome
  for (const trade of result.trades as SimTrade[]) {
    const decision = result.decisions.find((d) => d.decisionId === trade.decisionId);
    assert.ok(decision, `trade ${trade.decisionId} must resolve to a decision`);
    assert.equal(decision?.outcome?.pnl, trade.pnl);
  }
  // Metrics are well-formed numbers
  assert.ok(Number.isFinite(result.metrics.finalEquity));
  assert.ok(Number.isFinite(result.metrics.maxDrawdownPct));
  assert.ok(result.metrics.period.steps > 0);
  for (const slice of Object.values(result.metrics.byStrategy)) {
    assert.ok(slice.trades >= 0);
    assert.ok(slice.winRatePct >= 0 && slice.winRatePct <= 100);
  }
});

test('replay: decisions that risk rejects are journaled with the reason', async () => {
  // A stop 0.1% from entry: far inside the ATR buffer, so the risk gate must refuse it
  class TooTightAgent extends BaseAgent {
    readonly id = 'FUNDING-ARB-α' as const;
    readonly strategy = 'test_tight_stop';
    private fired = false;
    protected async analyze(ctx: MarketContext): Promise<Signal[]> {
      if (this.fired) return [];
      const closed = ctx.candles['BTCUSDT'] ?? [];
      if (closed.length < 60) return [];
      this.fired = true;
      const last = closed[closed.length - 1];
      return [this.signal({
        symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.8, entry: last.close,
        stopLoss: last.close * 0.999, takeProfit: last.close * 1.01, reason: 'tight stop', ts: last.openTime,
      })];
    }
  }
  const result = await new ReplayService({ agents: [new TooTightAgent({} as BinanceService)], config: { warmupBars: 50 } }).run({ BTCUSDT: { '15m': vShapeCandles(120, 90) } });
  const rejected = result.decisions.filter((d) => d.status === 'RISK_REJECTED');
  assert.ok(rejected.length >= 1);
  assert.ok(rejected[0].rejectionReason !== null && rejected[0].rejectionReason.length > 0);
  assert.equal(rejected[0].evidence.score > 0, true);
  // The rejection fields ride on the same canonical record shape
  assert.equal(rejected[0].riskDecision.approved, false);
});
