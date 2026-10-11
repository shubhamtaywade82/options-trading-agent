import type { Side } from '../types.js';
import type { MarketState } from '../market/types.js';
import type { EvidenceBreakdown } from './types.js';

export function scoreCandidate(
  side: Side,
  state: MarketState,
  executionScore = 10,
): EvidenceBreakdown {
  const reasons: string[] = [];
  let regime = 0;
  let structure = 0;
  let liquidity = 0;
  let location = 0;
  let derivatives = 0;

  const trendAligned = (side === 'LONG' && state.regime.trendDirection === 'BULLISH')
    || (side === 'SHORT' && state.regime.trendDirection === 'BEARISH');

  if (
    (side === 'LONG' && state.regime.regime === 'TREND_UP')
    || (side === 'SHORT' && state.regime.regime === 'TREND_DOWN')
  ) {
    regime = 20;
    reasons.push('regime aligns with direction');
  } else if (state.regime.regime === 'TRANSITION') {
    regime = 5;
    reasons.push('market regime is transitional');
  } else if (state.regime.regime === 'RANGE') {
    regime = 0;
    reasons.push('range regime reduces trend conviction');
  }

  if (trendAligned) {
    regime = Math.min(20, regime + 5);
    reasons.push('HTF trend direction agrees');
  }

  if (
    (side === 'LONG' && state.ltfStructure.trend === 'BULLISH')
    || (side === 'SHORT' && state.ltfStructure.trend === 'BEARISH')
  ) {
    structure += 10;
    reasons.push('LTF structure agrees');
  }

  if (
    (side === 'LONG' && state.htfStructure.trend === 'BULLISH')
    || (side === 'SHORT' && state.htfStructure.trend === 'BEARISH')
  ) {
    structure += 10;
    reasons.push('HTF structure agrees');
  }

  const lastBreak = state.ltfStructure.lastBreak;
  if (
    lastBreak
    && (
      (side === 'LONG' && lastBreak.direction === 'BULLISH')
      || (side === 'SHORT' && lastBreak.direction === 'BEARISH')
    )
  ) {
    structure += lastBreak.type === 'CHOCH' ? 7 : 5;
    reasons.push(`LTF ${lastBreak.type} confirms direction`);
  }

  structure = Math.min(25, structure);

  const expectedSweep = side === 'LONG' ? 'SELL_SIDE' : 'BUY_SIDE';
  const sweeps = state.liquidity.ltf.recentSweeps ?? state.liquidity.ltf.latestSweeps;
  if (sweeps.some((sweep) => sweep.direction === expectedSweep && sweep.confirmed)) {
    liquidity = 20;
    reasons.push(`${expectedSweep} liquidity sweep confirmed`);
  } else if (sweeps.length > 0) {
    liquidity = 3;
    reasons.push('liquidity event exists but is directionally mismatched');
  }

  const pricing = state.pricing;
  if (side === 'LONG' ? pricing.discount : pricing.premium) {
    location = 15;
    reasons.push(side === 'LONG' ? 'price is in HTF discount' : 'price is in HTF premium');
  } else {
    location = 3;
    reasons.push('price is outside preferred HTF location');
  }

  const d = state.derivatives;
  if (d) {
    const ratio = d.globalLongShortRatio;
    if (ratio !== null) {
      const crowdedLong = ratio > 1.3;
      const crowdedShort = ratio < 0.75;
      if ((side === 'SHORT' && crowdedLong) || (side === 'LONG' && crowdedShort)) {
        derivatives += 5;
        reasons.push('positioning context supports the direction');
      } else if ((side === 'LONG' && crowdedLong) || (side === 'SHORT' && crowdedShort)) {
        derivatives += 1;
        reasons.push('positioning context is crowded in the trade direction');
      }
    }

    if (d.openInterestChangePct !== null && Math.abs(d.openInterestChangePct) >= 2) {
      derivatives += 3;
      reasons.push(`OI changed ${d.openInterestChangePct.toFixed(1)}%`);
    } else if (d.openInterestChangePct !== null) {
      derivatives += 1;
    }
  }

  const execution = Math.max(0, Math.min(10, executionScore));
  const total = Math.max(
    0,
    Math.min(100, regime + structure + liquidity + location + derivatives + execution),
  );

  return {
    regime,
    structure,
    liquidity,
    location,
    derivatives,
    execution,
    total,
    reasons,
  };
}
