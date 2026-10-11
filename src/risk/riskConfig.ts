import { config } from '../config.js';

export type CircuitState = 'NORMAL' | 'CAUTION' | 'REDUCED' | 'HALTED' | 'EMERGENCY';

export interface RiskLimits {
  maxRiskPerTradePercent: number;
  maxLeverage: number;
  minLeverage: number;
  maxDailyLossPercent: number;
  maxDrawdownPercent: number;
  maxLossStreak: number;
  maxConcurrentPositions: number;
  maxSymbolExposurePercent: number;
  maxPortfolioGrossExposurePercent: number;
  maxCorrelatedExposurePercent: number;
  maxNotionalPerTrade: number;
  minRiskRewardRatio: number;
  feeRateTaker: number;
  slippageBufferRate: number;
  /** Cap on the summed loss-at-stop of all open positions plus the new trade, as a % of equity; unset disables the check. */
  maxPortfolioRiskPercent?: number;
}

// No per-trade notional env exists; the exposure and leverage caps are what bound a position
const UNCAPPED_NOTIONAL = 1e9;

const CAUTION_FRACTION = 0.5;
const REDUCED_FRACTION = 0.75;

type RiskConfig = typeof config.risk;

/** Builds the limits envelope from the env-driven `config.risk`. */
export function riskLimitsFromConfig(risk: RiskConfig = config.risk, portfolioRiskPct: number | undefined = config.portfolioRiskPct): RiskLimits {
  return {
    maxRiskPerTradePercent: risk.riskPerTradePct,
    maxLeverage: risk.maxLeverage,
    minLeverage: risk.minLeverage,
    maxDailyLossPercent: risk.maxDailyLossPct,
    maxDrawdownPercent: risk.maxDrawdownPct,
    maxLossStreak: risk.maxLossStreak,
    maxConcurrentPositions: risk.maxConcurrentPositions,
    maxSymbolExposurePercent: risk.maxSymbolExposurePct,
    maxPortfolioGrossExposurePercent: risk.maxExposurePct,
    maxCorrelatedExposurePercent: risk.maxCorrelatedExposurePct,
    maxNotionalPerTrade: UNCAPPED_NOTIONAL,
    minRiskRewardRatio: risk.minRr,
    feeRateTaker: risk.takerFeeRate,
    slippageBufferRate: risk.slippageBufferRate,
    ...(portfolioRiskPct === undefined ? {} : { maxPortfolioRiskPercent: portfolioRiskPct }),
  };
}

function stateForRatio(ratio: number): CircuitState {
  if (ratio >= 1) return 'HALTED';
  if (ratio >= REDUCED_FRACTION) return 'REDUCED';
  if (ratio >= CAUTION_FRACTION) return 'CAUTION';
  return 'NORMAL';
}

const SEVERITY: readonly CircuitState[] = ['NORMAL', 'CAUTION', 'REDUCED', 'HALTED', 'EMERGENCY'];

/** Worst circuit state implied by daily loss, drawdown and loss streak against the limits. */
export function deriveCircuitState(
  dailyLossPct: number, drawdownPct: number, lossStreak: number, limits: RiskLimits,
): CircuitState {
  if (drawdownPct >= limits.maxDrawdownPercent) return 'EMERGENCY';
  const byDailyLoss = stateForRatio(dailyLossPct / limits.maxDailyLossPercent);
  const byStreak = stateForRatio(lossStreak / limits.maxLossStreak);
  return SEVERITY[Math.max(SEVERITY.indexOf(byDailyLoss), SEVERITY.indexOf(byStreak))];
}

/** Fraction of the normal per-trade risk budget allowed in this state. */
export function circuitRiskMultiplier(state: CircuitState): number {
  switch (state) {
    case 'NORMAL': return 1;
    case 'CAUTION': return 0.75;
    case 'REDUCED': return 0.5;
    case 'HALTED':
    case 'EMERGENCY': return 0;
  }
}

/** Correlation bucket for exposure caps: majors stand alone, everything else is one alt cluster. */
export function clusterOf(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (upper.startsWith('BTC')) return 'BTC';
  if (upper.startsWith('ETH')) return 'ETH';
  if (upper.startsWith('SOL')) return 'SOL';
  if (upper.startsWith('XRP')) return 'XRP';
  return 'ALT';
}
