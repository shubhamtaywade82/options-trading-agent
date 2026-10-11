import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { BaseAgent, type MarketContext } from '../src/agents/BaseAgent.js';
import { ExecutionSimulator } from '../src/backtesting/ExecutionSimulator.js';
import { foldSimTrades, PortfolioSimulator, type BarManager } from '../src/backtesting/PortfolioSimulator.js';
import { ReplayService } from '../src/backtesting/ReplayService.js';
import { FIFTEEN_MINUTES_MS } from '../src/backtesting/types.js';
import { DEFAULT_PM_CONFIG } from '../src/position/PositionManager.js';
import type { Candle, Signal } from '../src/types.js';

const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);

const FREE = { takerFeeBps: 0, spreadBps: 0, slippageBps: 0 };
const managerWith = (atr: number): BarManager => ({
  cfg: { ...DEFAULT_PM_CONFIG, costBufferRate: 0.001 },
  features: () => ({ atr, vol: 'MEDIUM' }),
  lot: () => ({ step: 0.001, minQty: 0.001, minNotional: 0 }),
});
// A wide ATR keeps the chandelier far below breakeven so the breakeven level itself is observable
const manager = managerWith(10);
const bar = (i: number, open: number, high: number, low: number, close: number): Candle =>
  ({ openTime: i * FIFTEEN_MINUTES_MS, open, high, low, close, volume: 1 });

function openLong(takeProfit = 130, side: 'LONG' | 'SHORT' = 'LONG', stopLoss = 95) {
  const portfolio = new PortfolioSimulator(1_000, new ExecutionSimulator(FREE));
  portfolio.open({
    symbol: 'BTCUSDT', side, qty: 1, leverage: 5, strategy: 'MOMENTUM-γ', stopLoss, takeProfit, decisionId: 'd1',
    regime: 'TREND_UP', evidenceScore: 80, fillPrice: 100, fee: 0, slippage: 0, openedAt: 0,
  });
  return portfolio;
}

test('should take TP1 at its level (not the bar high) on a long and keep the residual open with a breakeven stop', () => {
  const portfolio = openLong();
  portfolio.onBar('BTCUSDT', bar(0, 100, 106, 99.5, 105.5), manager);
  const [leg] = portfolio.getTrades();
  assert.deepEqual([leg!.reason, leg!.partial, leg!.qty, leg!.exit], ['PARTIAL TP', true, 0.35, 105]);
  const [pos] = portfolio.toPositions();
  near(pos!.qty, 0.65);
  near(Number(pos!.serverSl), 100.1);
});

test('should fill a partial at the open when the bar gaps through the level', () => {
  const portfolio = openLong();
  portfolio.onBar('BTCUSDT', bar(0, 107, 108, 106.5, 107.5), manager);
  assert.equal(portfolio.getTrades()[0]!.exit, 107);
});

test('should lift the stop to the chandelier from the extreme when it is tighter than breakeven', () => {
  const portfolio = openLong();
  portfolio.onBar('BTCUSDT', bar(0, 100, 106, 99.5, 105.5), managerWith(2)); // 106 - 2.5 * 2 = 101 > 100.1
  near(Number(portfolio.toPositions()[0]!.serverSl), 101);
});

test('should take both partials on a bar that reaches 2R and drop the fixed target', () => {
  const portfolio = openLong();
  portfolio.onBar('BTCUSDT', bar(0, 100, 111, 99.5, 110.5), manager);
  assert.deepEqual(portfolio.getTrades().map((t) => [t.reason, t.qty, t.exit]), [['PARTIAL TP', 0.35, 105], ['PARTIAL TP', 0.3, 110]]);
  assert.equal(portfolio.toPositions()[0]!.serverTp, 'trail');
});

test('should treat a bar that touches both the stop and TP1 as a stop-out with no partial (conservative)', () => {
  const portfolio = openLong();
  const exits = portfolio.onBar('BTCUSDT', bar(0, 100, 106, 94, 105), manager);
  assert.equal(exits[0]?.reason, 'STOP LOSS');
  assert.equal(portfolio.getTrades().length, 1);
  assert.equal(portfolio.getTrades()[0]!.partial, undefined);
});

test('should stop the residual on the same bar when a stop moved on that bar is below the close of the pullback', () => {
  const portfolio = openLong();
  // TP1 at the high, then the bar falls back to close below the new breakeven stop (100.1)
  const exits = portfolio.onBar('BTCUSDT', bar(0, 100, 106, 99.5, 100.05), manager);
  assert.equal(exits[0]?.reason, 'STOP LOSS');
  near(exits[0]!.price, 100.1);
  assert.deepEqual(portfolio.getTrades().map((t) => [t.reason, t.qty]), [['PARTIAL TP', 0.35], ['STOP LOSS', 0.65]]);
  assert.equal(portfolio.toPositions().length, 0);
});

test('should never let a stop moved on a bar protect the trade from that bar\'s own low', () => {
  const portfolio = openLong();
  // low 99.5 is below the future breakeven stop but happens BEFORE the favourable extreme on the path, so it must not stop the residual
  const exits = portfolio.onBar('BTCUSDT', bar(0, 100, 106, 99.5, 105.5), manager);
  assert.deepEqual(exits, []);
});

test('should close the residual at the original target in TARGET mode and fold into one position', () => {
  const portfolio = openLong(108);
  portfolio.onBar('BTCUSDT', bar(0, 100, 106, 99.5, 105.5), manager);
  portfolio.onBar('BTCUSDT', bar(1, 105.5, 109, 105, 108.5), manager);
  const folded = foldSimTrades(portfolio.getTrades());
  assert.equal(folded.length, 1);
  assert.equal(folded[0]!.reason, 'TAKE PROFIT');
  near(folded[0]!.qty, 1);
  near(folded[0]!.pnl, 0.35 * 5 + 0.65 * 8);
  near(folded[0]!.exit, 100 + (0.35 * 5 + 0.65 * 8));
});

test('should reconcile equity with the folded ledger once flat, fees included', () => {
  const portfolio = new PortfolioSimulator(1_000, new ExecutionSimulator({ takerFeeBps: 4, spreadBps: 2, slippageBps: 3 }));
  const entry = new ExecutionSimulator({ takerFeeBps: 4, spreadBps: 2, slippageBps: 3 }).entry('LONG', 100, 1);
  portfolio.open({
    symbol: 'BTCUSDT', side: 'LONG', qty: 1, leverage: 5, strategy: 'MOMENTUM-γ', stopLoss: 95, takeProfit: 108, decisionId: 'd1',
    regime: 'TREND_UP', evidenceScore: 80, fillPrice: entry.price, fee: entry.fee, slippage: entry.slippage, openedAt: 0,
  });
  portfolio.onBar('BTCUSDT', bar(0, 100, 107, 99.9, 106.5), managerWith(10));
  portfolio.onBar('BTCUSDT', bar(1, 106.5, 109, 106, 108.5), managerWith(10));
  assert.equal(portfolio.toPositions().length, 0);
  const [position] = foldSimTrades(portfolio.getTrades());
  near(portfolio.equity(), 1_000 + position!.pnl - position!.fees, 1e-5); // trade fees are rounded to 6 decimals
});

test('should keep equity consistent through partials: realized plus unrealized on the remaining quantity', () => {
  const portfolio = openLong();
  portfolio.onBar('BTCUSDT', bar(0, 100, 106, 99.5, 105.5), manager);
  near(portfolio.equity(), 1_000 + 0.35 * 5 + 0.65 * 5.5);
});

test('should mirror every rule for shorts', () => {
  const portfolio = openLong(70, 'SHORT', 105);
  portfolio.onBar('BTCUSDT', bar(0, 100, 100.5, 94, 94.5), manager);
  const [leg] = portfolio.getTrades();
  assert.deepEqual([leg!.reason, leg!.qty, leg!.exit], ['PARTIAL TP', 0.35, 95]);
  near(Number(portfolio.toPositions()[0]!.serverSl), 99.9);
});

test('should behave exactly like the fixed stop/target replay without a manager', () => {
  const portfolio = openLong();
  portfolio.onBar('BTCUSDT', bar(0, 100, 131, 99.5, 130), undefined);
  assert.deepEqual(portfolio.getTrades().map((t) => [t.reason, t.qty, t.exit]), [['TAKE PROFIT', 1, 130]]);
});

test('should pass records without a positionId through the fold untouched', () => {
  const legacy = { symbol: 'X', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 1, exit: 2, qty: 1, pnl: 1, reason: 'CLOSE', closedAt: 1 } as never;
  assert.deepEqual(foldSimTrades([legacy]), [legacy]);
});

// ---- full service ----

function risingCandles(count: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = price + 0.3 + Math.sin(i / 4) * 0.1;
    out.push({ openTime: i * FIFTEEN_MINUTES_MS, open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, volume: 100 });
    price = close;
  }
  return out;
}

class OneShotLong extends BaseAgent {
  readonly id = 'FUNDING-ARB-α' as const;
  readonly strategy = 'test_one_shot_long';
  private fired = false;
  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const closed = ctx.candles['BTCUSDT'] ?? [];
    if (this.fired || closed.length < 60) return [];
    this.fired = true;
    const last = closed[closed.length - 1]!;
    return [this.signal({
      symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.8, entry: last.close, stopLoss: last.close - 3, takeProfit: last.close + 40,
      reason: 'one-shot', ts: last.openTime,
    })];
  }
}

async function run(positionManager: boolean) {
  const service = new ReplayService({
    agents: [new OneShotLong({} as BinanceService)],
    config: { warmupBars: 60, decisionsPath: null, learning: true, positionManager, riskEngine: 'off', costs: { takerFeeBps: 4, spreadBps: 2, slippageBps: 3 } },
  });
  return service.run({ BTCUSDT: { '15m': risingCandles(160) } });
}

test('service: with the manager on a steady uptrend is exited in partials that fold into one counted position', async () => {
  const on = await run(true);
  assert.ok(on.partials.length >= 1, 'expected at least TP1');
  assert.ok(on.partials.every((t) => t.partial === true && t.positionId));
  assert.equal(on.trades.length, 1);
  assert.equal(on.metrics.totalTrades, 1);
  const [position] = on.trades;
  near(position!.pnl, on.partials.reduce((sum, t) => sum + t.pnl, 0) + (position!.pnl - on.partials.reduce((sum, t) => sum + t.pnl, 0)));
  assert.ok(position!.qty > on.partials[0]!.qty);
});

test('service: with the manager off nothing is partialled and the result is the fixed stop/target replay', async () => {
  const off = await run(false);
  assert.equal(off.partials.length, 0);
  assert.equal(off.trades.length, 1);
  assert.ok(off.trades.every((t) => t.partial !== true));
});
