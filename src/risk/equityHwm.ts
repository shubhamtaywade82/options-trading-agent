import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Mode } from '../types.js';

/**
 * Mode-bound view over a persisted high-water mark. Consumers (RiskAgent,
 * RiskOps) never need to know which wallet they are reading; the orchestrator
 * binds the mode once at startup.
 */
export interface PeakEquitySource {
  /** The highest equity ever observed for this account mode. */
  peak(): number;
  /** Records an equity reading; returns the effective peak afterwards. */
  observe(equity: number): number;
  /** Clears the peak (operator maintenance); the next reading re-establishes it. */
  reset(): void;
  /** When the operator last reset the drawdown baseline (epoch ms), 0 if never. Realized peaks before it no longer count. */
  resetAt?(): number;
}

export interface EquityHwmSnapshot {
  version: 1;
  /** Peak equity per account mode: paper and live are different wallets and must not share a peak. */
  peaks: Partial<Record<Mode, number>>;
  /** Per-mode time of the last operator drawdown reset; absent in files written before resets existed. */
  resets?: Partial<Record<Mode, number>>;
  updatedAt: number;
}

const EMPTY: EquityHwmSnapshot = { version: 1, peaks: {}, updatedAt: 0 };

function isHwmSnapshot(value: unknown): value is EquityHwmSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || typeof state.updatedAt !== 'number' || state.peaks === null || typeof state.peaks !== 'object') {
    return false;
  }
  const resets = state.resets;
  if (resets !== undefined && (resets === null || typeof resets !== 'object'
    || !Object.values(resets).every((at) => typeof at === 'number' && Number.isFinite(at)))) return false;
  return Object.values(state.peaks).every((peak) => typeof peak === 'number' && Number.isFinite(peak));
}

function loadSnapshot(filePath: string): EquityHwmSnapshot {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    return isHwmSnapshot(parsed) ? parsed : EMPTY;
  } catch {
    // A missing or corrupt file means no peak is known yet; it re-establishes on the first reading
    return EMPTY;
  }
}

/**
 * The single authoritative equity high-water mark, persisted so a restart
 * cannot reset drawdown (issue: "restarting the process resets the peak, so a
 * process crash mid-drawdown silently re-arms the bot").
 *
 * Semantics:
 * - The peak only ever ratchets up while running; equity below the peak never lowers it.
 * - Writes are atomic (tmp + rename) and best-effort, like the kill-switch: a
 *   disk failure must never interrupt trading, it only risks losing the last peak.
 * - Peaks are keyed by account mode: paper equity and live equity belong to
 *   different wallets and would poison each other's drawdown if shared.
 */
export class EquityHwmStore {
  private snapshot: EquityHwmSnapshot;

  constructor(
    private readonly filePath = path.resolve('data/risk-hwm.json'),
    private readonly now: () => number = Date.now,
  ) {
    this.snapshot = loadSnapshot(this.filePath);
  }

  peak(mode: Mode): number {
    return this.snapshot.peaks[mode] ?? 0;
  }

  /** Records an equity reading and returns the effective peak; non-positive or non-finite readings are ignored. */
  observe(mode: Mode, equity: number): number {
    if (!Number.isFinite(equity) || equity <= 0) return this.peak(mode);
    if (equity > this.peak(mode)) {
      this.snapshot = {
        ...this.snapshot,
        version: 1,
        peaks: { ...this.snapshot.peaks, [mode]: equity },
        updatedAt: this.now(),
      };
      this.persist();
    }
    return this.peak(mode);
  }

  reset(mode: Mode): void {
    if (!(mode in this.snapshot.peaks)) return;
    const peaks = { ...this.snapshot.peaks };
    delete peaks[mode];
    this.snapshot = { ...this.snapshot, version: 1, peaks, updatedAt: this.now() };
    this.persist();
  }

  /** When the drawdown baseline of `mode` was last reset by the operator (epoch ms), 0 if never. */
  resetAt(mode: Mode): number {
    return this.snapshot.resets?.[mode] ?? 0;
  }

  /**
   * Operator reset of the drawdown baseline: forgets the stored peak AND stamps the reset time, so the closed-trade
   * journal's realized peak from before it stops counting too (the circuit breaker reads both). Returns what was cleared.
   * The loss-streak and daily-loss limits are untouched: they look at today's trades only.
   */
  resetDrawdown(mode: Mode): { previousPeak: number; previousResetAt: number; resetAt: number } {
    const previousPeak = this.peak(mode);
    const previousResetAt = this.resetAt(mode);
    const peaks = { ...this.snapshot.peaks };
    delete peaks[mode];
    const resetAt = this.now();
    this.snapshot = { version: 1, peaks, resets: { ...this.snapshot.resets, [mode]: resetAt }, updatedAt: resetAt };
    this.persist();
    return { previousPeak, previousResetAt, resetAt };
  }

  /** Binds this store to one account mode so consumers stay mode-agnostic. */
  forMode(mode: Mode): PeakEquitySource {
    return {
      peak: () => this.peak(mode),
      observe: (equity) => this.observe(mode, equity),
      reset: () => this.reset(mode),
      resetAt: () => this.resetAt(mode),
    };
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot, null, 2));
      renameSync(tmp, this.filePath);
    } catch {
      // Best-effort: the in-memory peak still governs this session
    }
  }
}
