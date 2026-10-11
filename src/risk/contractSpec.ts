import type { SymbolRules } from '../binance/symbolRules.js';
import type { RiskLimits } from './riskConfig.js';

export interface ContractSpec {
  symbol: string;
  lotSize: number;
  minQuantity: number;
  maxQuantity: number;
  minNotional: number;
  tickSize: number;
  maxLeverage: number;
}

// Exchange rules carry no upper quantity bound here; position caps come from notional and exposure limits
export const DEFAULT_MAX_QUANTITY = 1e9;

/** Adapts Binance symbol rules into the sizer's contract spec; leverage is capped by our own limit. */
export function contractSpecFor(symbol: string, rules: SymbolRules, limits: RiskLimits): ContractSpec {
  return {
    symbol,
    lotSize: rules.stepSize,
    minQuantity: rules.minQty,
    maxQuantity: DEFAULT_MAX_QUANTITY,
    minNotional: rules.minNotional,
    tickSize: rules.tickSize,
    maxLeverage: limits.maxLeverage,
  };
}
