import type { ShockReading } from './ShockDetector.js';

export type SafetyLevel = 'NORMAL' | 'NO_ENTRY' | 'HALT';

export interface SafetyVerdict {
  level: SafetyLevel;
  reasons: string[];
}

export interface SafetyInput {
  now: number;
  /** REST/WS mark used for the cycle; missing, non-positive or non-finite is a HALT. */
  mark: number | undefined;
  /** Epoch ms of the last websocket trade for the symbol; undefined = never seen. */
  lastTickAt: number | undefined;
  /** Epoch ms the REST mark was last refreshed. */
  markAt: number | undefined;
  /** Exchange-reported symbol status (e.g. TRADING); undefined = unknown, not a halt. */
  exchangeStatus?: string;
  /** Open time of the latest closed 15m candle; undefined skips the check (e.g. no kline data yet). */
  latestClosed15mOpen?: number;
  /** `asOf` of derivatives; only checked when the caller has market-data-v2 enabled. */
  derivativesAsOf?: number;
  shock?: ShockReading;
  tickStaleMs: number;
  markStaleMs: number;
}

const FIFTEEN_MIN_MS = 15 * 60_000;
const DERIVATIVES_STALE_MS = 5 * 60_000;
const RANK: Record<SafetyLevel, number> = { NORMAL: 0, NO_ENTRY: 1, HALT: 2 };

/**
 * Priority-0 gate for new entries. Pure: returns the worst applicable verdict plus every reason.
 * It never closes anything — a protected open position keeps its stop and its manager through a bad feed.
 */
export function assessSafety(input: SafetyInput): SafetyVerdict {
  const hits: Array<[SafetyLevel, string]> = [];
  const add = (level: SafetyLevel, reason: string): void => { hits.push([level, reason]); };

  if (!(typeof input.mark === 'number' && Number.isFinite(input.mark) && input.mark > 0)) add('HALT', 'mark price missing or invalid');
  if (input.exchangeStatus !== undefined && input.exchangeStatus !== 'TRADING') add('HALT', `exchange status ${input.exchangeStatus}`);

  const tickAge = input.lastTickAt === undefined ? Infinity : input.now - input.lastTickAt;
  const markAge = input.markAt === undefined ? Infinity : input.now - input.markAt;
  const tickStale = tickAge > input.tickStaleMs;
  if (tickStale && markAge > input.markStaleMs) add('HALT', 'no fresh tick or mark');
  else if (tickStale) add('NO_ENTRY', `websocket tick stale (${Number.isFinite(tickAge) ? `${Math.round(tickAge / 1000)}s` : 'never seen'})`);

  if (input.latestClosed15mOpen !== undefined && input.now - input.latestClosed15mOpen > 3 * FIFTEEN_MIN_MS) {
    add('NO_ENTRY', 'latest closed 15m candle is stale');
  }
  if (input.derivativesAsOf !== undefined && input.now - input.derivativesAsOf > DERIVATIVES_STALE_MS) add('NO_ENTRY', 'derivatives data stale');
  if (input.shock?.level === 'SHOCK') add('NO_ENTRY', `shock ${input.shock.reason}`);

  const level = hits.reduce<SafetyLevel>((worst, [l]) => (RANK[l] > RANK[worst] ? l : worst), 'NORMAL');
  return { level, reasons: hits.map(([, reason]) => reason) };
}
