import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Signal, Position, LogEntry } from '../types.js';
import type { BinanceService } from '../binance/client.js';
import type { VenueState } from '../binance/remoteBroker.js';
import type { PerformanceSnapshot } from '../risk/performanceEngine.js';
import type { CircuitState } from '../risk/riskConfig.js';
import type { MarketState } from '../market/types.js';
import type { MarketDataSnapshot } from '../market/MarketDataTypes.js';
import type { SafetyVerdict } from '../market/MarketSafety.js';

export interface MarketContext {
  candles: Record<string, any[]>;
  funding: Record<string, number>;
  marks: Record<string, number>;
  spot: Record<string, number>;
  equity: number;
  positions?: Position[];
  marketState?: Record<string, MarketState>;
  marketDataV2?: Record<string, MarketDataSnapshot>;
  /** Per-symbol market-safety verdict for the cycle; absent (replay) means the gate does not apply. */
  safety?: Record<string, SafetyVerdict>;
  performance?: { circuit: CircuitState; snapshot: PerformanceSnapshot };
}

export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export const startsCooldown = (level: LogEntry['level'], venueState?: VenueState): boolean =>
  level === 'success' || (level === 'warn' && (venueState === undefined || venueState === 'connected'));

export abstract class BaseAgent extends EventEmitter {
  abstract readonly id: string;
  readonly cooldownMs: number = DEFAULT_COOLDOWN_MS;
  abstract readonly strategy: string;
  status: 'RUNNING' | 'PAUSED' | 'WATCHING' = 'RUNNING';

  constructor(protected binance: BinanceService) {
    super();
  }

  async run(ctx: MarketContext): Promise<Signal[]> {
    if (this.status !== 'RUNNING') return [];
    return this.analyze(ctx);
  }

  protected abstract analyze(ctx: MarketContext): Promise<Signal[]>;

  protected signal(partial: Omit<Signal, 'id' | 'agent' | 'ts'> & { id?: string; ts?: number }): Signal {
    const ts = partial.ts ?? Date.now();
    const id =
      partial.id ??
      createHash('sha256')
        .update(`${partial.symbol}:${this.strategy}:${partial.type}:${ts}`)
        .digest('hex')
        .slice(0, 12);
    return {
      ...partial,
      id,
      agent: this.id as any,
      ts,
    };
  }
}
