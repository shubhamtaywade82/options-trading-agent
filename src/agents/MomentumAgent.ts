import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, Candle } from '../types.js';
import { ema, atr, rsi } from '../binance/indicators.js';
import { config } from '../config.js';

// The EMA seeds on its first value, so a longer history would shift the crossover points
const MOMENTUM_WINDOW = 60;

export class MomentumAgent extends BaseAgent {
  readonly id = 'MOMENTUM-γ' as const;
  readonly strategy = 'atr_volatility_momentum';
  private lastHandledOpenTime = new Map<string, number>();

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const symbol of config.symbols) {
      if ((ctx.positions ?? []).some((p) => p.symbol === symbol)) continue;
      const signal = this.evaluateSymbol(symbol, ctx);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  private evaluateSymbol(symbol: string, ctx: MarketContext): Signal | null {
    const raw = ctx.candles[symbol] ?? [];
    const closed = raw.slice(0, -1);
    const lastClosed = closed.at(-1);
    if (!lastClosed || this.lastHandledOpenTime.get(symbol) === lastClosed.openTime) return null;

    const candles = closed.slice(-MOMENTUM_WINDOW);
    if (candles.length < MOMENTUM_WINDOW) return null;

    const closes = candles.map((c: Candle) => c.close);
    const ema50 = ema(closes, 50);
    const price = lastClosed.close;
    const atr14 = atr(candles, 14);
    const currentRsi = rsi(closes, 14).at(-1) ?? 50;

    const prevPrice = closes[closes.length - 2];
    const prevEma = ema50[ema50.length - 2];
    const crossed = prevPrice <= prevEma && price > ema50[ema50.length - 1];

    this.lastHandledOpenTime.set(symbol, lastClosed.openTime);
    if (!crossed || atr14 <= 0 || currentRsi >= 75) return null;

    return this.signal({
      symbol,
      type: 'OPEN_LONG',
      confidence: currentRsi > 50 ? 0.75 : 0.65,
      entry: price,
      stopLoss: price - atr14 * 2.5,
      takeProfit: price + atr14 * 5,
      reason: `EMA50 cross + ATR (${atr14.toFixed(2)}) RSI=${currentRsi.toFixed(0)}`,
      ts: lastClosed.openTime,
    });
  }
}
