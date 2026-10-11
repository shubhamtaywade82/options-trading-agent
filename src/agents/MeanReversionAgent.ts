import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal } from '../types.js';
import { config } from '../config.js';
import type { MarketState } from '../market/types.js';

export class MeanReversionAgent extends BaseAgent {
  readonly id = 'MEAN-REVERT-θ' as const;
  readonly strategy = 'bollinger_zscore_mean_reversion';
  private lastHandledTime = new Map<string, number>();

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    if (!ctx.marketState) return [];
    const signals: Signal[] = [];
    for (const symbol of config.symbols) {
      const state = ctx.marketState[symbol];
      if (!state) continue;
      const signal = this.evaluateSymbol(symbol, state);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  private evaluateSymbol(symbol: string, state: MarketState): Signal | null {
    if (this.lastHandledTime.get(symbol) === state.generatedAt) return null;

    const mr = state.meanReversion;
    const atr = state.timeframes['15m'].atr14 ?? 0;
    if (mr.zscore === null || atr <= 0) return null;

    if (mr.zscore <= -2.0 && (mr.rsi14 ?? 50) <= 35) {
      return this.buildLong(symbol, state, atr);
    }
    if (mr.zscore >= 2.0 && (mr.rsi14 ?? 50) >= 65) {
      return this.buildShort(symbol, state, atr);
    }
    return null;
  }

  private buildLong(symbol: string, state: MarketState, atr: number): Signal | null {
    const entry = state.mark;
    const target = state.meanReversion.vwap ?? state.meanReversion.mean ?? (entry + 2 * atr);
    const stopLoss = entry - 1.5 * atr;
    if (target <= entry) return null;

    this.lastHandledTime.set(symbol, state.generatedAt);
    return this.signal({
      symbol,
      type: 'OPEN_LONG',
      confidence: 0.75,
      entry,
      stopLoss,
      takeProfit: target,
      reason: `Range Z-score ${state.meanReversion.zscore?.toFixed(2)} ≤ -2.0, target VWAP`,
      ts: state.generatedAt,
    });
  }

  private buildShort(symbol: string, state: MarketState, atr: number): Signal | null {
    const entry = state.mark;
    const target = state.meanReversion.vwap ?? state.meanReversion.mean ?? (entry - 2 * atr);
    const stopLoss = entry + 1.5 * atr;
    if (target >= entry) return null;

    this.lastHandledTime.set(symbol, state.generatedAt);
    return this.signal({
      symbol,
      type: 'OPEN_SHORT',
      confidence: 0.75,
      entry,
      stopLoss,
      takeProfit: target,
      reason: `Range Z-score ${state.meanReversion.zscore?.toFixed(2)} ≥ 2.0, target VWAP`,
      ts: state.generatedAt,
    });
  }
}
