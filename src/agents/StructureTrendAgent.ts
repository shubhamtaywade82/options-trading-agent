import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal } from '../types.js';
import { config } from '../config.js';
import type { MarketState } from '../market/types.js';

export class StructureTrendAgent extends BaseAgent {
  readonly id = 'STRUCTURE-TREND-η' as const;
  readonly strategy = 'smc_structure_trend';
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
    const isBull = state.htfStructure.trend === 'BULLISH';
    const isBear = state.htfStructure.trend === 'BEARISH';
    if (!isBull && !isBear) return null;

    // HTF discount for longs, premium for shorts
    if (isBull && !state.pricing.discount) return null;
    if (isBear && !state.pricing.premium) return null;

    const atr = state.timeframes['15m'].atr14 ?? state.timeframes['1h'].atr14 ?? 0;
    if (atr <= 0) return null;

    return isBull
      ? this.buildLongSignal(symbol, state, atr)
      : this.buildShortSignal(symbol, state, atr);
  }

  private buildLongSignal(symbol: string, state: MarketState, atr: number): Signal | null {
    const ltfBreak = state.ltfStructure.lastBreak;
    const ltfSweep = state.liquidity.ltf.latestSweeps.find((s) => s.direction === 'SELL_SIDE' && s.confirmed);
    if (!ltfSweep && (!ltfBreak || ltfBreak.direction !== 'BULLISH')) return null;

    const entry = state.mark;
    const stopLoss = state.ltfStructure.protectedLow?.price ?? (entry - 1.5 * atr);
    if (stopLoss >= entry) return null;

    const risk = entry - stopLoss;
    const takeProfit = Math.max(state.pricing.high, entry + 2.0 * risk);
    this.lastHandledTime.set(symbol, state.generatedAt);

    return this.signal({
      symbol,
      type: 'OPEN_LONG',
      confidence: 0.8,
      entry,
      stopLoss,
      takeProfit,
      reason: `SMC trend discount + ${ltfSweep ? 'liquidity sweep' : 'CHOCH trigger'}`,
      ts: state.generatedAt,
    });
  }

  private buildShortSignal(symbol: string, state: MarketState, atr: number): Signal | null {
    const ltfBreak = state.ltfStructure.lastBreak;
    const ltfSweep = state.liquidity.ltf.latestSweeps.find((s) => s.direction === 'BUY_SIDE' && s.confirmed);
    if (!ltfSweep && (!ltfBreak || ltfBreak.direction !== 'BEARISH')) return null;

    const entry = state.mark;
    const stopLoss = state.ltfStructure.protectedHigh?.price ?? (entry + 1.5 * atr);
    if (stopLoss <= entry) return null;

    const risk = stopLoss - entry;
    const takeProfit = Math.min(state.pricing.low, entry - 2.0 * risk);
    this.lastHandledTime.set(symbol, state.generatedAt);

    return this.signal({
      symbol,
      type: 'OPEN_SHORT',
      confidence: 0.8,
      entry,
      stopLoss,
      takeProfit,
      reason: `SMC trend premium + ${ltfSweep ? 'liquidity sweep' : 'CHOCH trigger'}`,
      ts: state.generatedAt,
    });
  }
}
