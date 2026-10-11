import { DhanAuth } from '@nemesis-oss/dhanhq-sdk';

/**
 * A TOTP code generated with fewer seconds left in its window can reach the broker
 * after the window has rolled over and be rejected as expired. Below this margin the
 * provider waits for the next window instead of sending a code that may already be stale.
 */
export const TOTP_MIN_VALID_SECONDS = 5;

export interface TotpProviderOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Supplies a fresh 6-digit TOTP code for each login. The secret is held only inside this
 * closure and never leaves it. Injected clock and sleep make the window logic testable.
 */
export function createTotpProvider(secret: string, options: TotpProviderOptions = {}): () => Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  return async () => {
    const remaining = DhanAuth.totpSecondsRemaining({ timestamp: now() });
    if (remaining < TOTP_MIN_VALID_SECONDS) {
      // The +1 second guarantees the wait lands inside the next window.
      await sleep((remaining + 1) * 1000);
    }
    return DhanAuth.generateTotp(secret, { timestamp: now() });
  };
}

/**
 * The SDK treats a token without a usable expiry as always due for renewal, so every API
 * call would start a fresh PIN+TOTP login, and each login can invalidate the previous token.
 * Startup therefore refuses such a token rather than running on it.
 */
export function assertUsableToken(token: { readonly expiresAt?: number } | undefined, now: number): void {
  if (token === undefined) {
    throw new Error('Dhan login returned no token');
  }
  if (token.expiresAt === undefined || !Number.isFinite(token.expiresAt)) {
    throw new Error(
      'Dhan login returned a token without an expiry; refusing to run because every request would trigger a fresh PIN+TOTP login',
    );
  }
  if (now >= token.expiresAt) {
    throw new Error(
      `Dhan login returned a token that is already expired (${new Date(token.expiresAt).toISOString()}); check the host clock`,
    );
  }
}

/** Human-readable expiry for logs. Never throws, even on a malformed timestamp. */
export function formatExpiry(expiresAt: number | undefined): string {
  return expiresAt !== undefined && Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : 'none';
}

/**
 * Runs `task` once for callers that overlap in time and shares its result. Used so that
 * several requests failing with 401 at once trigger one token renewal, not one each.
 * A failed run clears the slot, so the next caller retries.
 */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    inFlight ??= task().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
