/**
 * Ledger fixtures for the research plane — deterministic synthetic SetupOutcomeRecord generators.
 *
 * Moved from tests/support/ledgerFixture.ts so both tests and the golden-task suite can share them without
 * src/ importing from tests/. The tests file re-exports these for backward compatibility.
 */

import { mulberry32 } from './Bootstrap.js';
import type { SetupOutcomeRecord, SetupOutcome } from '../learning/SetupOutcomeLedger.js';
import type { SetupScenario } from '../decision/SetupTypes.js';

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface LedgerFixtureOptions {
  /** Number of trades to generate. */
  n: number;
  /** Mean net R for the population. */
  meanR?: number;
  /** Noise amplitude (uniform). */
  noise?: number;
  /** Start time (epoch ms). */
  from?: number;
  /** Spacing between trades (ms). */
  spacing?: number;
  /** Symbol override; default 'BTCUSDT'. */
  symbol?: string;
  /** Regime override; default 'TREND_UP'. */
  regime?: string;
  /** Volatility override; default 'EXPANDED'. */
  volatility?: string;
  /** Direction override; default 'LONG'. */
  direction?: SetupScenario['direction'];
  /** RR for each trade; default 1.5. */
  rr?: number;
  /** Sweep depth ATR feature; default null. */
  sweepDepthAtr?: number | null;
  /** Override the random seed (deterministic via mulberry32). */
  seed?: number;
  /** Optional idPrefix to disambiguate setupIds across multiple fixture calls. */
  idPrefix?: string;
}

// `mulberry32` is re-exported from Bootstrap.ts (canonical location). Importing here to avoid a circular dep;
// do not re-export it from this module.

/** Build a deterministic synthetic ledger of N setup-outcome records. */
export function makeLedger(opts: LedgerFixtureOptions): SetupOutcomeRecord[] {
  const meanR = opts.meanR ?? 0.3;
  const noise = opts.noise ?? 0.4;
  const from = opts.from ?? T0;
  const spacing = opts.spacing ?? HOUR;
  const symbol = opts.symbol ?? 'BTCUSDT';
  const regime = opts.regime ?? 'TREND_UP';
  const volatility = opts.volatility ?? 'EXPANDED';
  const direction = opts.direction ?? 'LONG';
  const rr = opts.rr ?? 1.5;
  const sweepDepthAtr = opts.sweepDepthAtr ?? null;
  const rand = mulberry32(opts.seed ?? 1);
  const idPrefix = opts.idPrefix ?? 'setup';

  const out: SetupOutcomeRecord[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const createdAt = from + i * spacing;
    const netR = meanR + (rand() - 0.5) * 2 * noise;
    const outcome: SetupOutcome = netR > 0 ? 'TP1' : 'SL';
    out.push({
      setupId: `${idPrefix}-${i}-${createdAt}`,
      symbol,
      kind: 'LIQUIDITY_SWEEP',
      direction,
      createdAt,
      expiresAt: createdAt + DAY,
      entryLow: 100,
      entryHigh: 100.5,
      entry: direction === 'LONG' ? 100.5 : 100,
      stop: direction === 'LONG' ? 99 : 101.5,
      target1: direction === 'LONG' ? 102 : 97,
      rr,
      effectiveRr: rr,
      features: {
        quadrant: null,
        takerZ: null,
        oiDeltaPct: null,
        regime,
        volatility,
        htfTrend: regime === 'TREND_UP' ? 'BULLISH' : 'BEARISH',
        ltfTrend: regime === 'TREND_UP' ? 'BULLISH' : 'BEARISH',
        locationAtEntry: null,
        checks: null,
        verdictAtCreation: null,
        sweepDepthAtr,
        sweepDisplacementAtr: null,
      },
      statesReached: [{ state: 'TRIGGERED', at: createdAt }],
      eligibleSeenAt: createdAt,
      entryTouchedAt: createdAt + 60_000,
      mfeR: Math.max(0, netR),
      maeR: Math.min(0, netR),
      outcome,
      closedAt: createdAt + 2 * HOUR,
      netR,
    });
  }
  return out;
}

/**
 * Build a ledger that spans `days` of data and alternates regimes per day, so walk-forward and regime-conditional
 * tests have realistic cell distributions.
 */
export function makeMultiRegimeLedger(days: number, tradesPerDay = 8, seed = 7): SetupOutcomeRecord[] {
  const rand = mulberry32(seed);
  const regimes = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION'] as const;
  const volatilities = ['EXPANDED', 'COMPRESSED', 'NORMAL'] as const;
  const out: SetupOutcomeRecord[] = [];
  for (let d = 0; d < days; d += 1) {
    const regime = regimes[d % regimes.length];
    const volatility = volatilities[d % volatilities.length];
    const direction = regime === 'TREND_DOWN' ? 'SHORT' : 'LONG';
    const baseMean = regime === 'TREND_UP' && volatility === 'EXPANDED' ? 0.4 : -0.1;
    for (let k = 0; k < tradesPerDay; k += 1) {
      const t = T0 + d * DAY + k * (HOUR * 2);
      const netR = baseMean + (rand() - 0.5) * 0.6;
      out.push(...makeLedger({
        n: 1,
        meanR: netR,
        noise: 0,
        from: t,
        spacing: HOUR,
        regime,
        volatility,
        direction,
        sweepDepthAtr: 0.5 + rand() * 0.8,
        seed: d * 100 + k,
        idPrefix: `setup-d${d}-k${k}`,
      }));
    }
  }
  return out;
}
