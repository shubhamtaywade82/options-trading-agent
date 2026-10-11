/**
 * Microstructure execution engine for perpetual futures.
 * Implements non-linear tiered maintenance margins, intra-bar liquidation checks,
 * and periodic funding settlement carrying costs.
 */

export interface PositionState {
  symbol: string;
  quantity: number;
  entryPrice: number;
  marginAllocated: number;
  leverage: number;
}

export interface MarginTier {
  tierLevel?: number;
  notionalCap: number;
  maxLeverage: number;
  mmr: number;
  mmd: number;
}

export interface BarSnapshot {
  timestamp: Date | number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LiquidationResult {
  liquidated: boolean;
  liquidationPrice: number;
}

export const DEFAULT_PERP_MARGIN_TIERS: MarginTier[] = [
  { tierLevel: 1, notionalCap: 50_000, maxLeverage: 50, mmr: 0.01, mmd: 0 },
  { tierLevel: 2, notionalCap: 250_000, maxLeverage: 20, mmr: 0.025, mmd: 750 },
  { tierLevel: 3, notionalCap: 1_000_000, maxLeverage: 10, mmr: 0.05, mmd: 7_000 },
  { tierLevel: 4, notionalCap: Infinity, maxLeverage: 5, mmr: 0.1, mmd: 57_000 },
];

export interface LiquidationParams {
  entryPrice: number;
  leverage: number;
  mmr: number;
  isLong: boolean;
  extraMargin?: number;
  quantity?: number;
}

export class PerpetualExecutionEngine {
  constructor(private readonly takerFeeRate = 0.0005) {}

  public getFeeRate(): number {
    return this.takerFeeRate;
  }

  public calculateMaintenanceMargin(
    notional: number,
    tiers: MarginTier[] = DEFAULT_PERP_MARGIN_TIERS,
  ): { mmRequirement: number; activeTier: MarginTier } {
    const tier = tiers.find((t) => notional <= t.notionalCap) ?? tiers[tiers.length - 1];
    const mmRequirement = notional * tier.mmr - tier.mmd;
    return { mmRequirement: Math.max(0, mmRequirement), activeTier: tier };
  }

  public calculateLiquidationPrice(params: LiquidationParams): number {
    const { entryPrice, leverage, mmr, isLong, extraMargin = 0, quantity = 1 } = params;
    const absQty = Math.max(1e-8, Math.abs(quantity));
    const marginAdj = extraMargin / absQty;
    if (isLong) {
      return entryPrice * (1 - 1 / leverage + mmr) - marginAdj;
    }
    return entryPrice * (1 + 1 / leverage - mmr) + marginAdj;
  }

  public checkLiquidation(
    pos: PositionState,
    bar: BarSnapshot,
    tier: MarginTier,
    extraMargin = 0,
  ): LiquidationResult {
    const isLong = pos.quantity > 0;
    const liqPrice = this.calculateLiquidationPrice({
      entryPrice: pos.entryPrice,
      leverage: pos.leverage,
      mmr: tier.mmr,
      isLong,
      extraMargin,
      quantity: pos.quantity,
    });

    // Intra-bar wick breach triggers immediate liquidation
    const liquidated = isLong ? bar.low <= liqPrice : bar.high >= liqPrice;
    return { liquidated, liquidationPrice: liqPrice };
  }

  public applyFundingSettlement(
    pos: PositionState,
    markPrice: number,
    fundingRate: number,
  ): number {
    const notional = Math.abs(pos.quantity) * markPrice;
    const cashFlowDirection = pos.quantity > 0 ? -1 : 1;
    return notional * fundingRate * cashFlowDirection;
  }
}
