export type SmcLifecycleDirection = 'LONG' | 'SHORT';

export type SmcLifecyclePhase =
  | 'ENTRY'
  | 'TP1_PARTIAL'
  | 'BREAKEVEN'
  | 'TRAILING'
  | 'CLOSED';

export interface SmcTradeLifecycleConfig {
  tp1Fraction: number;
  breakevenBufferR: number;
  trailingStartR: number;
  trailingDistanceR: number;
}

export const DEFAULT_SMC_TRADE_LIFECYCLE_CONFIG: SmcTradeLifecycleConfig = {
  tp1Fraction: 0.5,
  breakevenBufferR: 0,
  trailingStartR: 1,
  trailingDistanceR: 0.5,
};

export interface SmcTradeLifecycle {
  setupId: string;
  symbol: string;
  direction: SmcLifecycleDirection;
  initialQty: number;
  remainingQty: number;
  entryPrice: number;
  initialRisk: number;
  tp1: number;
  tp2: number;
  stopPrice: number;
  phase: SmcLifecyclePhase;
  highestPrice: number;
  lowestPrice: number;
  tp1Executed: boolean;
  breakevenActivated: boolean;
  trailingActivated: boolean;
  config: SmcTradeLifecycleConfig;
  closedReason?: 'TP2' | 'STOP' | 'EXTERNAL_CLOSE' | 'MANUAL_CLOSE';
}

export interface SmcLifecycleMarketState {
  markPrice: number;
  positionQty: number;
}

export type SmcLifecycleAction =
  | {
      type: 'PARTIAL_CLOSE';
      fraction: number;
      reason: 'TP1';
    }
  | {
      type: 'MOVE_STOP';
      stopPrice: number;
      reason: 'BREAKEVEN' | 'TRAILING';
    }
  | {
      type: 'CLOSE_REMAINING';
      reason: 'TP2';
    };

export interface SmcLifecycleTransition {
  state: SmcTradeLifecycle;
  actions: SmcLifecycleAction[];
}

export function createSmcTradeLifecycle(params: {
  setupId: string;
  symbol: string;
  direction: SmcLifecycleDirection;
  initialQty: number;
  entryPrice: number;
  initialRisk: number;
  tp1: number;
  tp2: number;
  stopPrice: number;
  config?: Partial<SmcTradeLifecycleConfig>;
}): SmcTradeLifecycle {
  if (!(params.initialQty > 0)) throw new Error('initialQty must be positive');
  if (!(params.initialRisk > 0)) throw new Error('initialRisk must be positive');
  if (!(params.entryPrice > 0 && params.tp1 > 0 && params.tp2 > 0 && params.stopPrice > 0)) {
    throw new Error('lifecycle prices must be positive');
  }

  const config = { ...DEFAULT_SMC_TRADE_LIFECYCLE_CONFIG, ...(params.config ?? {}) };
  if (!(config.tp1Fraction > 0 && config.tp1Fraction < 1)) {
    throw new Error('tp1Fraction must be within (0, 1)');
  }
  if (config.breakevenBufferR < 0 || config.trailingStartR < 0 || config.trailingDistanceR <= 0) {
    throw new Error('invalid lifecycle thresholds');
  }

  const correctGeometry =
    params.direction === 'LONG'
      ? params.stopPrice < params.entryPrice && params.entryPrice < params.tp1 && params.tp1 <= params.tp2
      : params.stopPrice > params.entryPrice && params.entryPrice > params.tp1 && params.tp1 >= params.tp2;
  if (!correctGeometry) throw new Error('lifecycle price geometry is invalid');

  return {
    setupId: params.setupId,
    symbol: params.symbol.toUpperCase(),
    direction: params.direction,
    initialQty: params.initialQty,
    remainingQty: params.initialQty,
    entryPrice: params.entryPrice,
    initialRisk: params.initialRisk,
    tp1: params.tp1,
    tp2: params.tp2,
    stopPrice: params.stopPrice,
    phase: 'ENTRY',
    highestPrice: params.entryPrice,
    lowestPrice: params.entryPrice,
    tp1Executed: false,
    breakevenActivated: false,
    trailingActivated: false,
    config,
  };
}

export function advanceSmcTradeLifecycle(
  lifecycle: SmcTradeLifecycle,
  market: SmcLifecycleMarketState,
): SmcLifecycleTransition {
  if (lifecycle.phase === 'CLOSED') return { state: lifecycle, actions: [] };

  if (!(market.markPrice > 0) || market.positionQty < 0) {
    throw new Error('invalid lifecycle market state');
  }

  if (market.positionQty === 0) {
    return {
      state: { ...lifecycle, phase: 'CLOSED', remainingQty: 0, closedReason: 'EXTERNAL_CLOSE' },
      actions: [],
    };
  }

  const next: SmcTradeLifecycle = {
    ...lifecycle,
    remainingQty: market.positionQty,
    highestPrice: Math.max(lifecycle.highestPrice, market.markPrice),
    lowestPrice: Math.min(lifecycle.lowestPrice, market.markPrice),
  };

  const tp2Reached =
    lifecycle.direction === 'LONG'
      ? market.markPrice >= lifecycle.tp2
      : market.markPrice <= lifecycle.tp2;

  if (tp2Reached) {
    return {
      state: { ...next, phase: 'CLOSED', remainingQty: 0, closedReason: 'TP2' },
      actions: [{ type: 'CLOSE_REMAINING', reason: 'TP2' }],
    };
  }

  const tp1Reached =
    lifecycle.direction === 'LONG'
      ? market.markPrice >= lifecycle.tp1
      : market.markPrice <= lifecycle.tp1;

  if (!lifecycle.tp1Executed && tp1Reached) {
    return {
      state: {
        ...next,
        phase: 'TP1_PARTIAL',
        tp1Executed: true,
        remainingQty: market.positionQty * (1 - lifecycle.config.tp1Fraction),
      },
      actions: [
        {
          type: 'PARTIAL_CLOSE',
          fraction: lifecycle.config.tp1Fraction,
          reason: 'TP1',
        },
      ],
    };
  }

  const config = lifecycle.config;
  if (lifecycle.phase === 'TP1_PARTIAL' && !lifecycle.breakevenActivated) {
    const be =
      lifecycle.direction === 'LONG'
        ? lifecycle.entryPrice + config.breakevenBufferR * lifecycle.initialRisk
        : lifecycle.entryPrice - config.breakevenBufferR * lifecycle.initialRisk;

    const improvesProtection =
      lifecycle.direction === 'LONG' ? be > lifecycle.stopPrice : be < lifecycle.stopPrice;

    if (improvesProtection) {
      return {
        state: { ...next, phase: 'BREAKEVEN', stopPrice: be, breakevenActivated: true },
        actions: [{ type: 'MOVE_STOP', stopPrice: be, reason: 'BREAKEVEN' }],
      };
    }

    return {
      state: { ...next, phase: 'BREAKEVEN', breakevenActivated: true },
      actions: [],
    };
  }

  if (lifecycle.tp1Executed) {
    const excursionR =
      lifecycle.direction === 'LONG'
        ? (next.highestPrice - lifecycle.entryPrice) / lifecycle.initialRisk
        : (lifecycle.entryPrice - next.lowestPrice) / lifecycle.initialRisk;

    if (excursionR >= config.trailingStartR) {
      const candidate =
        lifecycle.direction === 'LONG'
          ? next.highestPrice - config.trailingDistanceR * lifecycle.initialRisk
          : next.lowestPrice + config.trailingDistanceR * lifecycle.initialRisk;

      const improvesProtection =
        lifecycle.direction === 'LONG'
          ? candidate > next.stopPrice
          : candidate < next.stopPrice;

      if (improvesProtection) {
        return {
          state: { ...next, phase: 'TRAILING', stopPrice: candidate, trailingActivated: true },
          actions: [{ type: 'MOVE_STOP', stopPrice: candidate, reason: 'TRAILING' }],
        };
      }
    }
  }

  return { state: next, actions: [] };
}
