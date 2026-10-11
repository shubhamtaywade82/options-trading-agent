import type { MinuteRecord } from './MinuteAggregator.js';

const MINUTE = 60_000;

/**
 * Drops the first and last minute of every unbroken run of minutes. A recording session starts and ends mid-minute, and a
 * reconnect gap leaves partial minutes on both sides; none of them is a full observation.
 */
export function cleanRecords(records: readonly MinuteRecord[]): MinuteRecord[] {
  const out: MinuteRecord[] = [];
  let run: MinuteRecord[] = [];
  const flush = (): void => { if (run.length > 2) out.push(...run.slice(1, -1)); run = []; };
  for (const r of records) {
    if (run.length > 0 && r.t - run[run.length - 1].t !== MINUTE) flush();
    run.push(r);
  }
  flush();
  return out;
}

/** A feature reads a window of consecutive minutes. Positive must mean "the hypothesis predicts price UP". */
export interface Hypothesis {
  id: string;
  name: string;
  /** Window length in minutes (the feature is computed from the window ending at the event minute). */
  windowMinutes: number;
  feature: (window: readonly MinuteRecord[]) => number | null;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const notional = (qty: number, r: MinuteRecord): number => qty * (r.mark ?? 0);

/**
 * Pre-registered hypotheses, fixed BEFORE any recorded data was examined. Changing them after looking invalidates the test:
 * add a new id instead. Each is two-sided: a significantly negative result means the opposite holds, which is a new finding
 * that needs its own confirmation on later data.
 */
export const HYPOTHESES: readonly Hypothesis[] = [
  {
    id: 'H1', name: 'liquidation flush reverses (buy after long liquidations, sell after short liquidations)', windowMinutes: 5,
    feature: (w) => {
      const longs = sum(w.map((r) => notional(r.liqLongQty, r)));
      const shorts = sum(w.map((r) => notional(r.liqShortQty, r)));
      return longs + shorts > 0 ? longs - shorts : null; // net long liquidation -> forced selling -> predicts a bounce
    },
  },
  {
    id: 'H2', name: 'aggressor flow continues (price follows net aggressive buying/selling)', windowMinutes: 5,
    feature: (w) => {
      const buy = sum(w.map((r) => r.buyQuote));
      const sell = sum(w.map((r) => r.sellQuote));
      return buy + sell > 0 ? (buy - sell) / (buy + sell) : null;
    },
  },
  {
    id: 'H4', name: 'book imbalance predicts direction (bid-heavy up, ask-heavy down)', windowMinutes: 5,
    feature: (w) => {
      const vals = w.map((r) => r.bookImbalance).filter((v): v is number => v !== null);
      return vals.length === w.length ? sum(vals) / vals.length : null;
    },
  },
];

export const HORIZONS_MINUTES = [5, 15, 30, 60] as const;

export interface StudyRow {
  hypothesis: string;
  horizon: number;
  /** Events in the TEST period, non-overlapping within the horizon. */
  n: number;
  /** Mean return in the predicted direction, bps. */
  meanSignedBps: number;
  /** Mean minus what a random entry with the same long/short mix earns from drift alone. */
  excessBps: number;
  t: number | null;
  hitRate: number | null;
  /** meanSignedBps minus round-trip costs. */
  netBps: number;
  /** Per-event signed returns, bps (so callers can pool symbols). */
  returns: number[];
  /** Drift the excess subtracts: per-symbol mean drift times the sum of event signs (kept so symbols can be pooled exactly). */
  driftTerm: number;
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * Event study for one symbol. The trigger threshold is the 95th percentile of the feature's magnitude over the FIRST half of
 * the recording; events are then counted only in the SECOND half, so the threshold never sees the data it is tested on.
 * Events within one horizon of the previous event are skipped so observations do not overlap.
 */
export function eventStudy(records: readonly MinuteRecord[], h: Hypothesis, costBps: number, horizons: readonly number[] = HORIZONS_MINUTES): StudyRow[] {
  const clean = cleanRecords(records);
  if (clean.length < h.windowMinutes * 4) return [];
  const byT = new Map(clean.map((r) => [r.t, r]));
  const splitAt = clean[0].t + (clean[clean.length - 1].t - clean[0].t) / 2;

  const values: { i: number; v: number }[] = [];
  for (let i = h.windowMinutes - 1; i < clean.length; i += 1) {
    const w = clean.slice(i - h.windowMinutes + 1, i + 1);
    if (w[w.length - 1].t - w[0].t !== (h.windowMinutes - 1) * MINUTE) continue; // window spans a gap
    const v = h.feature(w);
    if (v !== null && Number.isFinite(v)) values.push({ i, v });
  }
  const train = values.filter((x) => clean[x.i].t < splitAt).map((x) => Math.abs(x.v)).filter((v) => v > 0).sort((a, b) => a - b);
  if (train.length < 20) return [];
  const threshold = quantile(train, 0.95);
  const test = values.filter((x) => clean[x.i].t >= splitAt);

  return horizons.map((horizon) => {
    const fwd = (i: number): number | null => {
      const a = clean[i].mark;
      const b = byT.get(clean[i].t + horizon * MINUTE)?.mark;
      return a && b ? ((b - a) / a) * 10_000 : null;
    };
    const drifts: number[] = [];
    for (const x of test) { const r = fwd(x.i); if (r !== null) drifts.push(r); }
    const drift = drifts.length > 0 ? sum(drifts) / drifts.length : 0;

    const returns: number[] = [];
    let signSum = 0;
    let blockedUntil = -Infinity;
    for (const x of test) {
      if (Math.abs(x.v) < threshold || clean[x.i].t < blockedUntil) continue;
      const r = fwd(x.i);
      if (r === null) continue;
      const sign = x.v > 0 ? 1 : -1;
      returns.push(sign * r);
      signSum += sign;
      blockedUntil = clean[x.i].t + horizon * MINUTE;
    }
    const n = returns.length;
    const mean = n > 0 ? sum(returns) / n : 0;
    const excess = n > 0 ? mean - drift * (signSum / n) : 0;
    const sd = n > 1 ? Math.sqrt(sum(returns.map((r) => (r - mean) ** 2)) / (n - 1)) : 0;
    return {
      hypothesis: h.id, horizon, n, meanSignedBps: mean, excessBps: excess,
      t: n > 1 && sd > 0 ? excess / (sd / Math.sqrt(n)) : null,
      hitRate: n > 0 ? returns.filter((r) => r > 0).length / n : null,
      netBps: mean - costBps, returns, driftTerm: drift * signSum,
    };
  });
}

/** Two-sided normal p-value for a t statistic (n is large enough here that the normal approximation is the honest simple choice). */
export function twoSidedP(t: number): number {
  const z = Math.abs(t);
  const erf = (x: number): number => {
    const k = 1 / (1 + 0.3275911 * x);
    return 1 - (((((1.061405429 * k - 1.453152027) * k) + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-x * x);
  };
  return 1 - erf(z / Math.SQRT2);
}

/** Pools per-symbol rows of the same hypothesis and horizon. Symbols move together, so the pooled n overstates independence: read per-symbol rows first. */
export function poolRows(rows: readonly StudyRow[], costBps: number): StudyRow | null {
  if (rows.length === 0) return null;
  const returns = rows.flatMap((r) => r.returns);
  const n = returns.length;
  if (n === 0) return null;
  const mean = sum(returns) / n;
  const excess = mean - sum(rows.map((r) => r.driftTerm)) / n;
  const sd = n > 1 ? Math.sqrt(sum(returns.map((r) => (r - mean) ** 2)) / (n - 1)) : 0;
  return {
    hypothesis: rows[0].hypothesis, horizon: rows[0].horizon, n, meanSignedBps: mean, excessBps: excess,
    t: n > 1 && sd > 0 ? excess / (sd / Math.sqrt(n)) : null,
    hitRate: returns.filter((r) => r > 0).length / n, netBps: mean - costBps, returns, driftTerm: sum(rows.map((r) => r.driftTerm)),
  };
}
