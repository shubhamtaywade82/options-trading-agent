import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal } from '../types.js';
import type { BinanceService } from '../binance/client.js';
import { config } from '../config.js';
import {
  buildStructureLiquiditySignal,
  DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS,
  type StructureLiquidityOptions,
} from '../decision/StructureLiquidityStrategy.js';
import type { MarketState } from '../market/types.js';

/**
 * Fleet wrapper around the deterministic STRUCT-LIQ setup.
 *
 * The strategy is analysis-only; this agent only adapts it to the fleet
 * contract: evaluate every configured symbol's MarketState once per closed
 * 15m candle (deduped by `generatedAt`) and forward the signal, if any, as-is.
 * The signal's id (`struct-liq-<symbol>-<breakTime>`) is deterministic per
 * setup, so the orchestrator's cooldown keys and the decision journal see a
 * stable identity across paper, live and replay.
 *
 * The setup thresholds are injectable so the composition roots (orchestrator,
 * replay fleet, parameter sweeps) can tune the setup without touching the
 * strategy itself; an absent options object is exactly the default behaviour.
 */
export class StructureLiquidityAgent extends BaseAgent {
  readonly id = 'STRUCT-LIQ-η' as const;
  readonly strategy = 'smc_structure_liquidity';
  private readonly options: StructureLiquidityOptions;
  private lastHandledTime = new Map<string, number>();

  constructor(binance: BinanceService, options: StructureLiquidityOptions = DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS) {
    super(binance);
    this.options = options;
  }

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    if (!ctx.marketState) return [];

    const signals: Signal[] = [];
    for (const symbol of config.symbols) {
      const state = ctx.marketState[symbol];
      if (!state) continue;
      if (this.lastHandledTime.get(symbol) === state.generatedAt) continue;

      const signal = buildStructureLiquiditySignal(state, this.options);
      if (signal) {
        this.lastHandledTime.set(symbol, state.generatedAt);
        signals.push(signal);
      }
    }
    return signals;
  }
}
