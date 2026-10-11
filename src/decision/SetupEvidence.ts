import type { MarketState, StructureBreak } from '../market/types.js';
import type { SetupScenario } from './SetupTypes.js';

export type EntryLocation = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';

/** Band around 50% of the dealing range treated as equilibrium for the *planned entry*. */
const EQUILIBRIUM_BAND_PCT = 5;

/** Where the planned entry sits in the dealing range, as distinct from where price is now. */
export function locationAtEntry(state: MarketState, scenario: Pick<SetupScenario, 'entryLow' | 'entryHigh'>): { location: EntryLocation; pct: number } | null {
  const { high, low } = state.pricing;
  if (!(high > low)) return null;
  const mid = (scenario.entryLow + scenario.entryHigh) / 2;
  const pct = Math.max(0, Math.min(100, ((mid - low) / (high - low)) * 100));
  const location = pct > 50 + EQUILIBRIUM_BAND_PCT ? 'PREMIUM' : pct < 50 - EQUILIBRIUM_BAND_PCT ? 'DISCOUNT' : 'EQUILIBRIUM';
  return { location, pct };
}

export interface SweepEvidence {
  sweepLevel: number;
  sweepExtreme: number;
  reclaimClose: number;
  /** How far past the level the sweep pushed, in 15m ATR. */
  depthAtr: number;
  /** Largest confirming structure-break distance after the sweep, in ATR (0 when none). */
  displacementAtr: number;
  /** Volume z of the latest 15m bar (the sweep bar itself is not retained in MarketState). */
  volumeZLatest: number | null;
  structureShift: 'BOS' | 'CHOCH' | null;
  reclaimed: boolean;
}

/** Evidence for a LIQUIDITY_SWEEP scenario, taken from the same state the scenario was derived from. */
export function sweepEvidence(state: MarketState, scenario: SetupScenario, atr: number): SweepEvidence | null {
  if (scenario.kind !== 'LIQUIDITY_SWEEP' || !(atr > 0)) return null;
  const wantedSweep = scenario.direction === 'LONG' ? 'SELL_SIDE' : 'BUY_SIDE';
  const source = state.liquidity.ltf.sweepHistory ?? state.liquidity.ltf.recentSweeps;
  const sweep = source.find((s) => s.time === scenario.sourceTime && s.direction === wantedSweep);
  if (!sweep) return null;
  const wanted = scenario.direction === 'LONG' ? 'BULLISH' : 'BEARISH';
  const breaks: StructureBreak[] = (state.ltfStructure.breaks?.length ? state.ltfStructure.breaks : state.ltfStructure.lastBreak ? [state.ltfStructure.lastBreak] : [])
    .filter((b) => b.time >= sweep.time && b.direction === wanted);
  const best = breaks.sort((a, b) => b.distanceAtr - a.distanceAtr)[0];
  return {
    sweepLevel: sweep.level,
    sweepExtreme: sweep.sweepPrice,
    reclaimClose: sweep.close,
    depthAtr: Math.abs(sweep.level - sweep.sweepPrice) / atr,
    displacementAtr: best?.distanceAtr ?? 0,
    volumeZLatest: state.timeframes['15m'].volumeZ ?? null,
    structureShift: best?.type ?? null,
    reclaimed: scenario.direction === 'LONG' ? sweep.close > sweep.level : sweep.close < sweep.level,
  };
}
