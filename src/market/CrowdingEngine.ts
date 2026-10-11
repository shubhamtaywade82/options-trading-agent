import type { DerivativesSnapshot } from './MarketDataTypes.js';
import type { CrowdingSnapshot } from './types.js';

function deriveExtreme(
  globalLs: number | null,
  topTraderLs: number | null,
  fundingRate: number,
  takerRatio: number | null,
): CrowdingSnapshot['positioningExtreme'] {
  // Long crowding: top traders significantly skewed long, or global + positive funding
  const takerBuyHeavy = takerRatio !== null && takerRatio > 1.4;
  const takerSellHeavy = takerRatio !== null && takerRatio < 0.7;
  if ((topTraderLs !== null && topTraderLs >= 1.7) || (globalLs !== null && globalLs >= 1.5 && fundingRate > 0.0001) || takerBuyHeavy) {
    return 'LONG_CROWDED';
  }
  // Short crowding: top traders heavily short, or global + negative funding
  if ((topTraderLs !== null && topTraderLs <= 0.6) || (globalLs !== null && globalLs <= 0.7 && fundingRate < -0.0001) || takerSellHeavy) {
    return 'SHORT_CROWDED';
  }
  return 'BALANCED';
}

/** Computes participant crowding and positioning asymmetry from derivatives data. */
export function calculateCrowding(
  derivatives: DerivativesSnapshot | null,
  fundingRate: number
): CrowdingSnapshot {
  if (!derivatives) {
    return {
      fundingPercentile: null,
      topTraderVsGlobalBias: null,
      positioningExtreme: 'BALANCED',
      takerAggressionRatio: null,
      openInterestExpansion: false,
    };
  }

  const globalLs = derivatives.globalLongShortRatio;
  const topTraderLs = derivatives.topTraderPositionLongShortRatio ?? derivatives.topTraderAccountLongShortRatio;
  const topTraderVsGlobalBias =
    topTraderLs !== null && globalLs !== null && globalLs > 0
      ? topTraderLs / globalLs
      : null;

  // Approximate funding percentile from rate magnitude (0.01% baseline = 50th percentile)
  const fundingPercentile = Math.max(0, Math.min(100, 50 + (fundingRate / 0.0005) * 50));
  const oiChange = derivatives.openInterestChangePct ?? 0;
  const openInterestExpansion = oiChange > 1.5;

  return {
    fundingPercentile,
    topTraderVsGlobalBias,
    positioningExtreme: deriveExtreme(globalLs, topTraderLs, fundingRate, derivatives.takerBuySellRatio),
    takerAggressionRatio: derivatives.takerBuySellRatio,
    openInterestExpansion,
  };
}
