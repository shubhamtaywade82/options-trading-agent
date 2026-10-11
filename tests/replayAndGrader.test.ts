import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplayEngine } from '../src/backtesting/ReplayEngine.js';
import { gradeTrade } from '../src/learning/TradeGrader.js';
import type { Candle } from '../src/types.js';
import type { TradeIntent } from '../src/decision/SignalFusion.js';

const BAR_MS = 15 * 60_000;

function makeCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    // 50 flat bars, then climb from 100 to 120, then dip
    const close = i < 50 ? 100 : i < 70 ? 100 + (i - 50) : 120 - (i - 70);
    return {
      openTime: i * BAR_MS,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    };
  });
}

test('ReplayEngine simulates trades, enforces SL/TP and calculates backtest metrics', () => {
  const candles = makeCandles(90);
  const replay = new ReplayEngine(10_000);

  let entered = false;
  const result = replay.run(candles, (closed) => {
    if (!entered && closed.length >= 52) {
      entered = true;
      return { side: 'LONG', stopLoss: 98, takeProfit: 105, notional: 1_000 };
    }
    return null;
  });

  assert.ok(result.totalTrades >= 1);
  assert.equal(result.winningTrades, 1);
  assert.ok(result.netPnl > 0);
  assert.ok(result.profitFactor > 0);
  assert.equal(result.trades[0].exitReason, 'TAKE_PROFIT');
});

test('TradeGrader awards high marks to winning setups with strong evidence scores', () => {
  const intent: TradeIntent = {
    symbol: 'BTCUSDT',
    side: 'LONG',
    sourceAgent: 'STRUCTURE-TREND-η',
    evidenceScore: 85,
    entry: 100,
    stopLoss: 98,
    takeProfit: 106,
    reasons: ['HTF trend discount'],
  };

  const grade = gradeTrade({
    intent,
    entryPrice: 100,
    exitPrice: 105, // +2.5R gain
    pnl: 50,
    exitReason: 'TAKE PROFIT',
  });

  assert.equal(grade.grade, 'A+');
  assert.equal(grade.expectancyEdge, 2.5);
  assert.match(grade.commentary, /achieved 2\.5R \(WIN\)/);
});

test('TradeGrader marks slipped stop trades down', () => {
  const intent: TradeIntent = {
    symbol: 'BTCUSDT',
    side: 'LONG',
    sourceAgent: 'MOMENTUM-γ',
    evidenceScore: 60,
    entry: 100,
    stopLoss: 98,
    takeProfit: 106,
    reasons: ['Momentum'],
  };

  const grade = gradeTrade({
    intent,
    entryPrice: 100,
    exitPrice: 96, // -2R loss due to slip
    pnl: -40,
    exitReason: 'STOP LOSS',
  });

  assert.equal(grade.grade, 'F');
  assert.equal(grade.expectancyEdge, -2);
});
