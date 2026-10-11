import type { Position } from '../types.js';

export interface UnprotectedPosition {
  symbol: string;
  side: Position['side'];
  owner: Position['strategy'];
  notionalUsdt: number;
  equityPct: number;
}

/** A venue stop is "absent" when empty, zero or unparseable: none of those protect the position. */
const hasStop = (p: Position): boolean => {
  const stop = Number(p.serverSl);
  return p.serverSl !== '' && Number.isFinite(stop) && stop > 0;
};

/**
 * Positions with no protective stop whose notional is at least `minEquityPct` of equity. A mandatory stop is the
 * one risk control a strategy cannot enforce on a position it does not own (manual trades, adopted externals), so
 * the operator must be told instead.
 */
export function findUnprotected(positions: readonly Position[], equity: number, minEquityPct: number): UnprotectedPosition[] {
  if (!(equity > 0)) return [];
  return positions
    .filter((p) => !hasStop(p))
    .map((p) => {
      const notionalUsdt = Math.abs(p.qty * p.mark);
      return { symbol: p.symbol, side: p.side, owner: p.strategy, notionalUsdt, equityPct: (notionalUsdt / equity) * 100 };
    })
    .filter((p) => p.equityPct >= minEquityPct)
    .sort((a, b) => b.equityPct - a.equityPct);
}
