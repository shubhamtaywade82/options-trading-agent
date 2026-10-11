import type { DerivativesSnapshot } from './MarketDataTypes.js';

export type FlowQuadrant = 'FRESH_LONGS' | 'SHORT_COVERING' | 'FRESH_SHORTS' | 'LONG_LIQUIDATION' | 'UNCLEAR' | 'UNKNOWN';

export interface FlowContext {
  asOf: number;
  samples: number;
  /** Span actually covered by the baseline sample, ms; 0 when there is no usable baseline. */
  windowMs: number;
  oiDeltaPct: number | null;
  priceDeltaPct: number | null;
  takerRatio: number | null;
  /** z-score of the latest taker buy/sell ratio against this symbol's recent samples. */
  takerZ: number | null;
  fundingDelta: number | null;
  quadrant: FlowQuadrant;
}

export interface FlowThresholds {
  /** |OI change| below this over the window is noise. */
  minOiMovePct: number;
  /** |price change| below this over the window is noise. */
  minPriceMovePct: number;
  windowMs: number;
  /** Baseline must be at least this fraction of the window old, else the delta is not comparable. */
  minWindowFraction: number;
  minZSamples: number;
  maxAgeMs: number;
}

/** Starting points, not calibrated truths: the setup outcome ledger records the quadrant so they can be tuned on data. */
export const DEFAULT_FLOW_THRESHOLDS: FlowThresholds = {
  minOiMovePct: 0.25,
  minPriceMovePct: 0.15,
  windowMs: 15 * 60_000,
  minWindowFraction: 0.6,
  minZSamples: 12,
  maxAgeMs: 2 * 60 * 60_000,
};

interface Sample { at: number; price: number; oi: number | null; taker: number | null; funding: number }

const MAX_SAMPLES = 600;

const UNKNOWN = (asOf: number, samples: number): FlowContext => ({
  asOf, samples, windowMs: 0, oiDeltaPct: null, priceDeltaPct: null, takerRatio: null, takerZ: null, fundingDelta: null, quadrant: 'UNKNOWN',
});

function quadrantOf(price: number | null, oi: number | null, t: FlowThresholds): FlowQuadrant {
  if (price === null || oi === null) return 'UNKNOWN';
  if (Math.abs(price) < t.minPriceMovePct || Math.abs(oi) < t.minOiMovePct) return 'UNCLEAR';
  if (price > 0) return oi > 0 ? 'FRESH_LONGS' : 'SHORT_COVERING';
  return oi > 0 ? 'FRESH_SHORTS' : 'LONG_LIQUIDATION';
}

/**
 * Turns raw derivatives snapshots into deltas. A single snapshot ("Taker = 1.24") says little; the change
 * of OI against price and the z-score of taker aggression are what carry information. Missing inputs yield
 * null/UNKNOWN, never a guess, and stale or too-short history never produces a delta.
 */
export class FlowTracker {
  private readonly samples = new Map<string, Sample[]>();

  constructor(private readonly thresholds: FlowThresholds = DEFAULT_FLOW_THRESHOLDS) {}

  record(symbol: string, at: number, price: number, derivatives: DerivativesSnapshot | null, fundingRate: number): void {
    if (!(price > 0) || !Number.isFinite(at)) return;
    const list = this.samples.get(symbol) ?? [];
    if (list.length > 0 && at <= list[list.length - 1].at) return; // out-of-order/duplicate cycle: ignore
    list.push({ at, price, oi: derivatives?.openInterest ?? null, taker: derivatives?.takerBuySellRatio ?? null, funding: fundingRate });
    const floor = at - this.thresholds.maxAgeMs;
    while (list.length > MAX_SAMPLES || (list.length > 0 && list[0].at < floor)) list.shift();
    this.samples.set(symbol, list);
  }

  context(symbol: string, now: number): FlowContext {
    const list = this.samples.get(symbol) ?? [];
    const latest = list[list.length - 1];
    if (!latest || now - latest.at > this.thresholds.windowMs) return UNKNOWN(now, list.length);
    const t = this.thresholds;
    // Baseline: the newest sample at least minWindowFraction of the window old, closest to a full window
    const target = latest.at - t.windowMs;
    const eligible = list.filter((s) => latest.at - s.at >= t.windowMs * t.minWindowFraction && s !== latest);
    const base = eligible.sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    if (!base) return { ...UNKNOWN(now, list.length), takerRatio: latest.taker, takerZ: this.takerZ(list) };

    const oiDeltaPct = base.oi !== null && latest.oi !== null && base.oi > 0 ? ((latest.oi - base.oi) / base.oi) * 100 : null;
    const priceDeltaPct = ((latest.price - base.price) / base.price) * 100;
    return {
      asOf: latest.at, samples: list.length, windowMs: latest.at - base.at, oiDeltaPct, priceDeltaPct,
      takerRatio: latest.taker, takerZ: this.takerZ(list), fundingDelta: latest.funding - base.funding,
      quadrant: quadrantOf(priceDeltaPct, oiDeltaPct, t),
    };
  }

  private takerZ(list: readonly Sample[]): number | null {
    const values = list.map((s) => s.taker).filter((v): v is number => v !== null && Number.isFinite(v));
    if (values.length < this.thresholds.minZSamples) return null;
    const history = values.slice(0, -1);
    const mean = history.reduce((sum, v) => sum + v, 0) / history.length;
    const sd = Math.sqrt(history.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (history.length - 1));
    return sd > 0 ? (values[values.length - 1] - mean) / sd : null;
  }
}

export type FlowVerdict = 'CONFIRMS' | 'NEUTRAL' | 'CONTRADICTS' | 'UNKNOWN';

/**
 * Whether flow supports a trade. Trend-following setups need fresh positioning in their direction;
 * reversal setups (liquidity sweeps) instead only require that flow does not fight them, because a
 * sweep is itself a liquidation/short-covering event. These are hypotheses to be validated by the ledger.
 */
export function flowVerdict(flow: FlowContext, direction: 'LONG' | 'SHORT', reversal: boolean): FlowVerdict {
  const sign = direction === 'LONG' ? 1 : -1;
  const tz = flow.takerZ === null ? null : flow.takerZ * sign;
  if (flow.quadrant === 'UNKNOWN' && tz === null) return 'UNKNOWN';
  if (reversal) return tz !== null && tz <= -1.5 ? 'CONTRADICTS' : tz !== null && tz >= 0.5 ? 'CONFIRMS' : 'NEUTRAL';
  const supports: FlowQuadrant = direction === 'LONG' ? 'FRESH_LONGS' : 'FRESH_SHORTS';
  const fights: FlowQuadrant = direction === 'LONG' ? 'FRESH_SHORTS' : 'FRESH_LONGS';
  if (flow.quadrant === fights || (tz !== null && tz <= -1.5)) return 'CONTRADICTS';
  if (flow.quadrant === supports && (tz === null || tz >= 0)) return 'CONFIRMS';
  return 'NEUTRAL';
}
