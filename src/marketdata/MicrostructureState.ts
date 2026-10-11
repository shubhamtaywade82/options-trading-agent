import type { MinuteRecord } from './MinuteAggregator.js';

/**
 * Turns recorded 1-minute flow/derivatives records into a categorical microstructure state: who is opening or closing
 * positions (price x open interest), who is aggressing (taker delta), and whether forced flow is unusual (liquidations).
 *
 * Every z-score is measured against the same symbol's own trailing baseline of rolling-window changes, so one threshold
 * means the same thing on BTC and on XRP. The deadbands are descriptive (|z| below them is "no clear move"), not fitted
 * edges: whether any of these labels predicts anything is an event-study question (see EventStudy.ts), not an assumption.
 *
 * Deliberately not provided: an "EXHAUSTION" label. There is no definition of it that is not itself a trading hypothesis.
 */

export type PriceOiRegime = 'LONG_BUILD' | 'SHORT_BUILD' | 'SHORT_COVER' | 'LONG_LIQUIDATION' | 'NEUTRAL';
export type FlowRegime = 'BUY_DOMINANT' | 'SELL_DOMINANT' | 'BUY_ABSORBED' | 'SELL_ABSORBED' | 'NEUTRAL';

export interface MicrostructureOptions {
  /** Minutes the state describes (the most recent window). */
  windowMinutes: number;
  /** Minutes of history before the window used to scale the z-scores. */
  baselineMinutes: number;
  /** |z| a price or OI change must reach to count as a move. */
  moveZ: number;
  /** |z| the taker delta must reach to count as one-sided aggression. */
  flowZ: number;
}

export const DEFAULT_MICROSTRUCTURE_OPTIONS: MicrostructureOptions = { windowMinutes: 15, baselineMinutes: 240, moveZ: 0.5, flowZ: 1 };

export interface MicrostructureState {
  t: number;
  symbol: string;
  windowMinutes: number;
  priceChangeBps: number;
  priceZ: number;
  oiChangePct: number;
  oiZ: number;
  /** (aggressive buy quote - aggressive sell quote) / total, in [-1, 1]. */
  takerDelta: number;
  takerDeltaZ: number;
  liqLongNotional: number;
  liqShortNotional: number;
  /** z of total liquidation notional vs baseline windows; null when the baseline had no liquidations to scale against. */
  liquidationZ: number | null;
  bookImbalance: number | null;
  spreadBps: number | null;
  priceOiRegime: PriceOiRegime;
  flowRegime: FlowRegime;
}

export type MicrostructureResult =
  | { status: 'OK'; state: MicrostructureState }
  | { status: 'INSUFFICIENT_DATA'; reason: string };

const MINUTE = 60_000;

interface WindowFeatures { priceBps: number; oiPct: number; delta: number; liqLong: number; liqShort: number }

function features(w: readonly MinuteRecord[]): WindowFeatures | null {
  const a = w[0];
  const b = w[w.length - 1];
  if (!a.mark || !b.mark || !a.openInterest || !b.openInterest) return null;
  let buy = 0;
  let sell = 0;
  let liqLong = 0;
  let liqShort = 0;
  for (const r of w) {
    buy += r.buyQuote;
    sell += r.sellQuote;
    const px = r.mark ?? 0;
    liqLong += r.liqLongQty * px;
    liqShort += r.liqShortQty * px;
  }
  return {
    priceBps: ((b.mark - a.mark) / a.mark) * 10_000,
    oiPct: ((b.openInterest - a.openInterest) / a.openInterest) * 100,
    delta: buy + sell > 0 ? (buy - sell) / (buy + sell) : 0,
    liqLong, liqShort,
  };
}

function zOf(value: number, sample: readonly number[]): number {
  const n = sample.length;
  const mean = sample.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(sample.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  return sd > 0 ? (value - mean) / sd : 0;
}

export function classifyPriceOi(priceZ: number, oiZ: number, moveZ: number): PriceOiRegime {
  if (Math.abs(priceZ) < moveZ || Math.abs(oiZ) < moveZ) return 'NEUTRAL';
  if (priceZ > 0) return oiZ > 0 ? 'LONG_BUILD' : 'SHORT_COVER';
  return oiZ > 0 ? 'SHORT_BUILD' : 'LONG_LIQUIDATION';
}

/** One-sided aggression whose price did not follow (moved the other way past the move deadband) is labelled absorbed. */
export function classifyFlow(takerDeltaZ: number, priceZ: number, flowZ: number, moveZ: number): FlowRegime {
  if (Math.abs(takerDeltaZ) < flowZ) return 'NEUTRAL';
  if (takerDeltaZ > 0) return priceZ <= -moveZ ? 'BUY_ABSORBED' : 'BUY_DOMINANT';
  return priceZ >= moveZ ? 'SELL_ABSORBED' : 'SELL_DOMINANT';
}

/**
 * State as of the last record in `records`. Requires `windowMinutes + baselineMinutes` contiguous minutes (no gaps) ending
 * at that record, with mark and open interest present at every window boundary; otherwise reports why it cannot classify.
 */
export function microstructureState(records: readonly MinuteRecord[], options: Partial<MicrostructureOptions> = {}): MicrostructureResult {
  const o = { ...DEFAULT_MICROSTRUCTURE_OPTIONS, ...options };
  if (!(o.windowMinutes >= 2 && o.baselineMinutes >= o.windowMinutes * 4)) throw new Error('need windowMinutes >= 2 and baselineMinutes >= 4 x windowMinutes');
  const need = o.windowMinutes + o.baselineMinutes;
  if (records.length < need) return { status: 'INSUFFICIENT_DATA', reason: `need ${need} minutes, have ${records.length}` };
  const span = records.slice(-need);
  for (let i = 1; i < span.length; i += 1) {
    if (span[i].symbol !== span[0].symbol) return { status: 'INSUFFICIENT_DATA', reason: 'records mix symbols' };
    if (span[i].t - span[i - 1].t !== MINUTE) return { status: 'INSUFFICIENT_DATA', reason: `gap at ${new Date(span[i].t).toISOString()}` };
  }

  const current = features(span.slice(-o.windowMinutes));
  if (!current) return { status: 'INSUFFICIENT_DATA', reason: 'mark or open interest missing at the window boundary' };
  const base: WindowFeatures[] = [];
  for (let end = o.windowMinutes; end <= o.baselineMinutes; end += 1) {
    const f = features(span.slice(end - o.windowMinutes, end));
    if (f) base.push(f);
  }
  if (base.length < o.baselineMinutes / 2) return { status: 'INSUFFICIENT_DATA', reason: `only ${base.length} usable baseline windows` };

  const priceZ = zOf(current.priceBps, base.map((f) => f.priceBps));
  const oiZ = zOf(current.oiPct, base.map((f) => f.oiPct));
  const takerDeltaZ = zOf(current.delta, base.map((f) => f.delta));
  const baseLiq = base.map((f) => f.liqLong + f.liqShort);
  const liquidationZ = baseLiq.some((x) => x > 0) ? zOf(current.liqLong + current.liqShort, baseLiq) : null;
  const window = span.slice(-o.windowMinutes);
  const books = window.map((r) => r.bookImbalance).filter((v): v is number => v !== null);
  const spreads = window.map((r) => r.spreadBps).filter((v): v is number => v !== null);
  const last = span[span.length - 1];

  return {
    status: 'OK',
    state: {
      t: last.t, symbol: last.symbol, windowMinutes: o.windowMinutes,
      priceChangeBps: current.priceBps, priceZ,
      oiChangePct: current.oiPct, oiZ,
      takerDelta: current.delta, takerDeltaZ,
      liqLongNotional: current.liqLong, liqShortNotional: current.liqShort, liquidationZ,
      bookImbalance: books.length > 0 ? books.reduce((s, x) => s + x, 0) / books.length : null,
      spreadBps: spreads.length > 0 ? spreads.reduce((s, x) => s + x, 0) / spreads.length : null,
      priceOiRegime: classifyPriceOi(priceZ, oiZ, o.moveZ),
      flowRegime: classifyFlow(takerDeltaZ, priceZ, o.flowZ, o.moveZ),
    },
  };
}
