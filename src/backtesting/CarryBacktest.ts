/**
 * Delta-neutral funding carry: long spot, short the same quantity of the USDT-M perp. The short perp receives funding when
 * the rate is positive; the legs' price moves cancel except for basis (perp - spot) drift; entering and leaving costs four
 * fills. Everything here is pure: prices and funding in, a result out.
 */

export interface FundingPoint {
  /** Settlement time, ms. */
  time: number;
  /** Rate for that 8h interval, as a fraction (0.0001 = 0.01%). */
  rate: number;
}

export interface Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CarryCosts {
  spotFeeRate: number;
  perpFeeRate: number;
  /** Adverse price friction per fill (spread + slippage), fraction. */
  slippageRate: number;
}

export interface CarryParams {
  /** Enter when the trailing mean funding rate, annualised, is at least this (0.10 = 10% APR). */
  entryApr: number;
  /** Leave when it falls below this. */
  exitApr: number;
  /** Funding intervals in the trailing mean. */
  lookback: number;
  /** Perp leverage (isolated): sets margin and the liquidation distance. */
  perpLeverage: number;
  maintenanceMarginRate: number;
  costs: CarryCosts;
  /** Funding intervals a position must be held before a signal exit is allowed (liquidation is never deferred). Default 0. */
  minHoldIntervals?: number;
}

export interface CarryCycle {
  enteredAt: number;
  exitedAt: number;
  intervals: number;
  fundingPct: number;
  basisPct: number;
  costsPct: number;
  netPct: number;
  reason: 'SIGNAL' | 'LIQUIDATED' | 'END';
}

export interface CarryResult {
  cycles: CarryCycle[];
  /** Per 1 unit of notional, in % of notional. */
  fundingPct: number;
  basisPct: number;
  costsPct: number;
  netPct: number;
  /** Capital tied up per unit notional: the full spot leg plus perp margin. */
  capitalPerNotional: number;
  netOnCapitalPct: number;
  annualisedOnCapitalPct: number;
  timeInMarketPct: number;
  maxDrawdownPct: number;
  liquidations: number;
  years: number;
}

const INTERVALS_PER_YEAR = 3 * 365;

export const aprToRate = (apr: number): number => apr / INTERVALS_PER_YEAR;

/** Last bar opening at or before `t` (bars sorted ascending); undefined when `t` precedes them all. */
function barAt(bars: readonly Bar[], t: number): Bar | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  let found: Bar | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].openTime <= t) { found = bars[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** One direction of the trade: a spot fill and a perp fill. */
const entryCost = (c: CarryCosts): number => (c.spotFeeRate + c.slippageRate) + (c.perpFeeRate + c.slippageRate);
/** Only the spot leg is sold when the perp has already been liquidated. */
const spotOnlyCost = (c: CarryCosts): number => c.spotFeeRate + c.slippageRate;

/** First bar in [from, to] whose high reaches the short's liquidation price. */
function liquidationBar(perp: readonly Bar[], from: number, to: number, liqPrice: number): Bar | undefined {
  return perp.find((b) => b.openTime >= from && b.openTime <= to && b.high >= liqPrice);
}

interface OpenPosition {
  at: number;
  spotPx: number;
  perpPx: number;
  /** Funding received so far, fraction of notional. */
  funding: number;
  intervals: number;
}

export function simulateCarry(funding: readonly FundingPoint[], spot: readonly Bar[], perp: readonly Bar[], p: CarryParams): CarryResult {
  const cycles: CarryCycle[] = [];
  const entryRate = aprToRate(p.entryApr);
  const exitRate = aprToRate(p.exitApr);
  const capitalPerNotional = 1 + 1 / p.perpLeverage;

  let open: OpenPosition | null = null;
  /** Realised result including entry costs already paid, fraction of notional. */
  let realised = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let inMarket = 0;
  let observed = 0;

  const priceLeg = (pos: OpenPosition, spotPx: number, perpPx: number): number =>
    (spotPx - pos.spotPx) / pos.spotPx + (pos.perpPx - perpPx) / pos.perpPx;

  const close = (at: number, spotPx: number, perpPx: number, reason: CarryCycle['reason']): void => {
    if (!open) return;
    const liquidated = reason === 'LIQUIDATED';
    // A liquidated short loses its whole margin; the spot leg is then sold at the breach
    const basis = liquidated ? (spotPx - open.spotPx) / open.spotPx - 1 / p.perpLeverage : priceLeg(open, spotPx, perpPx);
    const exitCost = liquidated ? spotOnlyCost(p.costs) : entryCost(p.costs);
    const costs = entryCost(p.costs) + exitCost;
    cycles.push({
      enteredAt: open.at, exitedAt: at, intervals: open.intervals,
      fundingPct: open.funding * 100, basisPct: basis * 100, costsPct: costs * 100,
      netPct: (open.funding + basis - costs) * 100, reason,
    });
    realised += open.funding + basis - exitCost;
    open = null;
  };

  for (let i = 0; i < funding.length; i += 1) {
    const f = funding[i];
    const s = barAt(spot, f.time);
    const q = barAt(perp, f.time);
    if (!s || !q) continue;
    observed += 1;
    let closedThisStep = false;

    if (open) {
      inMarket += 1;
      // Funding accrues on the perp notional, which drifts with price
      open.funding += f.rate * (q.open / open.perpPx);
      open.intervals += 1;
      const liqPx = open.perpPx * (1 + 1 / p.perpLeverage - p.maintenanceMarginRate);
      const breach = liquidationBar(perp, funding[i - 1]?.time ?? open.at, f.time, liqPx);
      if (breach) {
        close(breach.openTime, barAt(spot, breach.openTime)?.open ?? s.open, liqPx, 'LIQUIDATED');
        closedThisStep = true;
      }
    }

    // Decide for the NEXT interval from rates already known: no lookahead
    const window = funding.slice(Math.max(0, i - p.lookback + 1), i + 1);
    if (window.length === p.lookback) {
      const mean = window.reduce((sum, w) => sum + w.rate, 0) / window.length;
      if (!open && !closedThisStep && mean >= entryRate) {
        open = { at: f.time, spotPx: s.open, perpPx: q.open, funding: 0, intervals: 0 };
        realised -= entryCost(p.costs);
      } else if (open && mean < exitRate && open.intervals >= (p.minHoldIntervals ?? 0)) {
        close(f.time, s.open, q.open, 'SIGNAL');
      }
    }

    const live = open ? open.funding + priceLeg(open, s.open, q.open) : 0;
    const equity = realised + live;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const last = funding.length > 0 ? funding[funding.length - 1] : undefined;
  if (open && last) {
    const s = barAt(spot, last.time);
    const q = barAt(perp, last.time);
    if (s && q) close(last.time, s.open, q.open, 'END');
  }

  const sum = (pick: (c: CarryCycle) => number): number => cycles.reduce((t, c) => t + pick(c), 0);
  const years = funding.length > 1 ? (funding[funding.length - 1].time - funding[0].time) / (365 * 86_400_000) : 0;
  const netPct = sum((c) => c.netPct);
  const netOnCapitalPct = netPct / capitalPerNotional;
  return {
    cycles,
    fundingPct: sum((c) => c.fundingPct),
    basisPct: sum((c) => c.basisPct),
    costsPct: sum((c) => c.costsPct),
    netPct,
    capitalPerNotional,
    netOnCapitalPct,
    annualisedOnCapitalPct: years > 0 ? netOnCapitalPct / years : 0,
    timeInMarketPct: observed > 0 ? (inMarket / observed) * 100 : 0,
    maxDrawdownPct: maxDrawdown * 100,
    liquidations: cycles.filter((c) => c.reason === 'LIQUIDATED').length,
    years,
  };
}
