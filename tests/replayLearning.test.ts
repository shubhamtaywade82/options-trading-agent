import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { BaseAgent, type MarketContext } from '../src/agents/BaseAgent.js';
import type { Signal, Candle } from '../src/types.js';
import { ReplayService } from '../src/backtesting/ReplayService.js';
import { FIFTEEN_MINUTES_MS } from '../src/backtesting/types.js';

const FIFTEEN_MIN = FIFTEEN_MINUTES_MS;

/** Deterministic V-shape: a long decline, then a strong rise — the same shape the replay tests use. */
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
      reason: 'one-shot learning test entry',
      ts: last.openTime,
    })];
  }
}

/**
 * Re-enters a long whenever the symbol is flat and the regime is TREND_UP,
 * always at the same raw confidence — the learning loop must be the only thing
 * that moves the recorded decision confidence.
 */
class TrendFollowingLongAgent extends BaseAgent {
  readonly id = 'MOMENTUM-γ' as const;
  readonly strategy = 'test_trend_repeat_long';

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const state = ctx.marketState?.['BTCUSDT'];
    if (!state || state.regime.regime !== 'TREND_UP') return [];
    if (ctx.positions?.some((p) => p.symbol === 'BTCUSDT')) return [];
    const closed = ctx.candles['BTCUSDT'] ?? [];
    if (closed.length < 60) return [];
    const last = closed[closed.length - 1];
    return [this.signal({
      symbol: 'BTCUSDT',
      type: 'OPEN_LONG',
      confidence: 0.6,
      entry: last.close,
      stopLoss: last.close - 3,
      takeProfit: last.close + 6,
      reason: 'repeat learning test entry',
      ts: last.openTime,
    })];
  }
}

const repeatAgents = () => [new TrendFollowingLongAgent({} as BinanceService)];
const confidencesOf = (result: Awaited<ReturnType<ReplayService['run']>>) =>
  result.decisions.filter((d) => d.strategy === 'MOMENTUM-γ' && d.status === 'EXECUTED').map((d) => d.confidence);

test('replay learning: closed trades grade into the per-agent ledger stats', async () => {
  const data = { BTCUSDT: { '15m': vShapeCandles(200, 150) } };
  const result = await new ReplayService({ agents: [new OneShotLongAgent({} as BinanceService)], config: { warmupBars: 50 } }).run(data);

  assert.ok(result.metrics.totalTrades >= 1, 'expected at least one closed trade');
  const stats = result.agentStats['FUNDING-ARB-α'];
  assert.ok(stats, 'the trading agent must appear in the learning stats');
  assert.equal(stats.trades, result.trades.filter((t) => t.strategy === 'FUNDING-ARB-α').length);
  assert.ok(stats.wins === 0 || stats.wins === stats.trades, 'wins must match the graded outcomes');
  assert.ok(Number.isFinite(stats.totalR));
});

test('replay learning: winning history amplifies later signal confidence', async () => {
  const data = { BTCUSDT: { '15m': vShapeCandles(520, 310) } };
  const result = await new ReplayService({ agents: repeatAgents(), config: { warmupBars: 60 } }).run(data);

  const stats = result.agentStats['MOMENTUM-γ'];
  assert.ok(stats, 'the repeat agent must appear in the learning stats');
  assert.ok(stats.trades >= 3, `expected at least 3 graded round trips, got ${stats.trades}`);

  const confidences = confidencesOf(result);
  assert.ok(confidences.length >= 3, `expected at least 3 executed decisions, got ${confidences.length}`);
  assert.ok(confidences[0] <= 0.6 + 1e-9, 'the cold ledger must leave the first decision at raw confidence');

  const max = Math.max(...confidences);
  assert.ok(max > 0.61, `proven wins must raise later confidences above the raw 0.6, max was ${max}`);
  assert.ok(max <= Math.min(1, 0.6 * 1.2) + 1e-9, 'the adjustment must respect the 1.2x cap');
});

test('replay learning: learning off keeps raw confidence and skips the ledger', async () => {
  const data = { BTCUSDT: { '15m': vShapeCandles(520, 310) } };
  const result = await new ReplayService({ agents: repeatAgents(), config: { warmupBars: 60, learning: false } }).run(data);

  const confidences = confidencesOf(result);
  assert.ok(confidences.length >= 1, 'expected executed decisions');
  assert.ok(confidences.every((c) => Math.abs(c - 0.6) < 1e-9), `learning off must leave confidence raw, saw ${[...new Set(confidences)].join(',')}`);
  assert.deepEqual(result.agentStats, {});
});
