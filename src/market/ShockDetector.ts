import type { Candle } from '../types.js';

export type ShockLevel = 'NORMAL' | 'SHOCK';

export interface ShockOptions {
  returnZ: number;
  volumeZ: number;
  spreadMult: number;
  recoveryBars: number;
  /** Minimum closed 1m bars before any verdict other than insufficient-data. */
  minBars?: number;
  /** Closed 1m bars used as the baseline. */
  window?: number;
  spreadSamples?: number;
}

export interface ShockReading {
  level: ShockLevel;
  retZ: number;
  volZ: number;
  spreadMult: number;
  reason: string;
}

const DEFAULT_MIN_BARS = 60;
const DEFAULT_WINDOW = 120;
const DEFAULT_SPREAD_SAMPLES = 120;
const CALM_RETURN_Z = 2;
const CALM_SPREAD_MULT = 1.5;
const MIN_SPREAD_SAMPLES = 10;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
function stdev(xs: number[], m = mean(xs)): number {
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}
function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
/** Z-score that is 0 (not NaN/Infinity) when the baseline has no variance. */
const zscore = (value: number, m: number, sd: number): number => (sd > 0 && Number.isFinite(sd) ? (value - m) / sd : 0);

interface SymbolState {
  level: ShockLevel;
  lastBar: number;
  calmBars: number;
  spreads: number[];
  last: ShockReading;
}

const INSUFFICIENT: ShockReading = { level: 'NORMAL', retZ: 0, volZ: 0, spreadMult: 1, reason: 'insufficient-data' };

/**
 * Per-symbol shock state machine over closed 1m bars. Entering needs a return outlier confirmed by volume
 * or spread; leaving needs `recoveryBars` consecutive calm bars (hysteresis). Idempotent per bar openTime, so
 * evaluating once per orchestrator cycle (8s) never double-counts a bar.
 */
export class ShockDetector {
  private readonly states = new Map<string, SymbolState>();
  private readonly options: Required<ShockOptions>;

  constructor(options: ShockOptions) {
    this.options = {
      minBars: DEFAULT_MIN_BARS, window: DEFAULT_WINDOW, spreadSamples: DEFAULT_SPREAD_SAMPLES, ...options,
    };
  }

  /** `closed1m` must contain closed bars only (oldest first); `spreadBps` is the current book spread, if known. */
  evaluate(symbol: string, closed1m: readonly Candle[], spreadBps?: number): ShockReading {
    const state = this.stateOf(symbol);
    if (spreadBps !== undefined && Number.isFinite(spreadBps) && spreadBps >= 0) this.sampleSpread(state, spreadBps);

    const bars = closed1m.slice(-(this.options.window + 1));
    const latest = bars[bars.length - 1];
    if (!latest || bars.length < this.options.minBars || bars.some((c) => !(c.close > 0))) return this.hold(state, INSUFFICIENT);
    // Same bar as last time: spread may have moved, but the bar statistics and the calm counter must not
    if (latest.openTime === state.lastBar) return this.withSpread(state, state.last);

    const reading = this.read(state, bars, latest);
    state.lastBar = latest.openTime;
    return this.transition(state, reading);
  }

  levelOf(symbol: string): ShockLevel {
    return this.states.get(symbol)?.level ?? 'NORMAL';
  }

  private stateOf(symbol: string): SymbolState {
    let state = this.states.get(symbol);
    if (!state) {
      state = { level: 'NORMAL', lastBar: -1, calmBars: 0, spreads: [], last: INSUFFICIENT };
      this.states.set(symbol, state);
    }
    return state;
  }

  private sampleSpread(state: SymbolState, spreadBps: number): void {
    state.spreads.push(spreadBps);
    if (state.spreads.length > this.options.spreadSamples) state.spreads.shift();
  }

  private spreadMultiple(state: SymbolState): number {
    const current = state.spreads[state.spreads.length - 1];
    if (current === undefined || state.spreads.length < MIN_SPREAD_SAMPLES) return 1;
    const base = median(state.spreads.slice(0, -1));
    return base > 0 ? current / base : 1;
  }

  private read(state: SymbolState, bars: readonly Candle[], latest: Candle): ShockReading {
    const baseline = bars.slice(0, -1);
    const returns = baseline.slice(1).map((c, i) => Math.log(c.close / baseline[i]!.close));
    const prevClose = baseline[baseline.length - 1]!.close;
    const latestReturn = Math.log(latest.close / prevClose);
    const retMean = mean(returns);
    const retZ = zscore(latestReturn, retMean, stdev(returns, retMean));
    const volumes = baseline.map((c) => c.volume);
    const volMean = mean(volumes);
    const volZ = zscore(latest.volume, volMean, stdev(volumes, volMean));
    const spreadMult = this.spreadMultiple(state);
    const { returnZ, volumeZ, spreadMult: spreadLimit } = this.options;
    const isShock = Math.abs(retZ) >= returnZ && (volZ >= volumeZ || spreadMult >= spreadLimit);
    return {
      level: isShock ? 'SHOCK' : 'NORMAL', retZ, volZ, spreadMult,
      reason: `retZ=${retZ.toFixed(1)} volZ=${volZ.toFixed(1)} spread×${spreadMult.toFixed(1)}`,
    };
  }

  private transition(state: SymbolState, reading: ShockReading): ShockReading {
    const isCalm = Math.abs(reading.retZ) < CALM_RETURN_Z && reading.spreadMult <= CALM_SPREAD_MULT;
    let level = state.level;
    if (reading.level === 'SHOCK') {
      level = 'SHOCK';
      state.calmBars = 0;
    } else if (state.level === 'SHOCK') {
      state.calmBars = isCalm ? state.calmBars + 1 : 0;
      if (state.calmBars >= this.options.recoveryBars) { level = 'NORMAL'; state.calmBars = 0; }
    }
    state.level = level;
    const out = { ...reading, level, reason: level === 'SHOCK' && reading.level !== 'SHOCK' ? `recovering (${state.calmBars}/${this.options.recoveryBars} calm) ${reading.reason}` : reading.reason };
    state.last = out;
    return out;
  }

  private hold(state: SymbolState, reading: ShockReading): ShockReading {
    return { ...reading, level: state.level };
  }

  private withSpread(state: SymbolState, last: ShockReading): ShockReading {
    return { ...last, level: state.level, spreadMult: this.spreadMultiple(state) };
  }
}
