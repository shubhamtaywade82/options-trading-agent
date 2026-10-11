import type { DerivativesSnapshot } from '../market/MarketDataTypes.js';
import type { TradeIntent } from '../decision/SignalFusion.js';

export interface ExecutionQualityVerdict {
  approved: boolean;
  spreadBps: number;
  estimatedSlippageBps: number;
  effectiveCostBps: number;
  reason: string;
}

const DEFAULT_TAKER_FEE_BPS = 5; // 0.05% typical Binance VIP0 taker fee
const MAX_ALLOWABLE_SPREAD_BPS = 12; // 12 bps maximum allowable spread
const MAX_SLIPPAGE_BPS = 15; // 15 bps maximum allowable estimated slippage

/** Estimates slippage and transaction friction before firing market orders. */
export function evaluateExecutionQuality(
  intent: TradeIntent,
  derivatives: DerivativesSnapshot | null,
  notionalUsdt: number
): ExecutionQualityVerdict {
  const spreadBps = derivatives?.spreadBps ?? 2.0;

  // Spread guard: avoid market orders during illiquid spread blowouts
  if (spreadBps > MAX_ALLOWABLE_SPREAD_BPS) {
    return {
      approved: false,
      spreadBps,
      estimatedSlippageBps: 0,
      effectiveCostBps: spreadBps + DEFAULT_TAKER_FEE_BPS,
      reason: `Spread ${spreadBps.toFixed(1)} bps exceeds maximum allowable limit (${MAX_ALLOWABLE_SPREAD_BPS} bps)`,
    };
  }

  // Book impact model: notional relative to open interest / book depth
  const bookImbalance = Math.abs(derivatives?.orderBookImbalance ?? 0);
  const sizeImpactBps = Math.min(10, (notionalUsdt / 10_000) * 1.5);
  const estimatedSlippageBps = Number((sizeImpactBps * (1 + bookImbalance)).toFixed(2));

  if (estimatedSlippageBps > MAX_SLIPPAGE_BPS) {
    return {
      approved: false,
      spreadBps,
      estimatedSlippageBps,
      effectiveCostBps: spreadBps / 2 + estimatedSlippageBps + DEFAULT_TAKER_FEE_BPS,
      reason: `Estimated slippage ${estimatedSlippageBps.toFixed(1)} bps exceeds limit (${MAX_SLIPPAGE_BPS} bps)`,
    };
  }

  const effectiveCostBps = Number((spreadBps / 2 + estimatedSlippageBps + DEFAULT_TAKER_FEE_BPS).toFixed(2));
  return {
    approved: true,
    spreadBps,
    estimatedSlippageBps,
    effectiveCostBps,
    reason: `Execution quality acceptable (friction ${effectiveCostBps.toFixed(1)} bps)`,
  };
}
