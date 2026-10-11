import type { Pool } from 'pg';

/**
 * The single trading authority for a client id. PostgreSQL is the only authority, because the order
 * path already depends on it: an order is only sent after its intent is written under this lease. A Redis
 * lock could be granted twice across a failover, so it is not used for this.
 */
export interface LeaseStore {
  /** Returns the new epoch when the lease was free, expired and past `marginMs`. Undefined otherwise. */
  acquire(clientId: string, runId: string, ttlMs: number, marginMs: number): Promise<number | undefined>;
  /** Extends the lease only while `runId` at `epoch` holds it and it has not expired. */
  renew(clientId: string, runId: string, epoch: number, ttlMs: number): Promise<boolean>;
  /** Ends the lease now. The margin still applies to the next acquisition, so in-flight orders can finish. */
  release(clientId: string, runId: string, epoch: number): Promise<void>;
}

/** Thrown by a fenced write when this process no longer holds the lease at the epoch it wrote under. */
export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

/** Every statement reads the database clock, so no process's local clock decides who holds the lease. */
export class PostgresLeaseStore implements LeaseStore {
  constructor(private readonly pool: Pool) {}

  async acquire(clientId: string, runId: string, ttlMs: number, marginMs: number): Promise<number | undefined> {
    const result = await this.pool.query<{ epoch: string }>(
      `INSERT INTO leases (client_id, holder_run, epoch, expires_at)
       VALUES ($1, $2, 1, now() + make_interval(secs => $3::double precision))
       ON CONFLICT (client_id) DO UPDATE
         SET holder_run = EXCLUDED.holder_run,
             epoch = leases.epoch + 1,
             expires_at = EXCLUDED.expires_at
         WHERE leases.expires_at <= now() - make_interval(secs => $4::double precision)
       RETURNING epoch::text AS epoch`,
      [clientId, runId, ttlMs / 1000, marginMs / 1000],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : Number(row.epoch);
  }

  async renew(clientId: string, runId: string, epoch: number, ttlMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE leases SET expires_at = now() + make_interval(secs => $4::double precision)
       WHERE client_id = $1 AND holder_run = $2 AND epoch = $3 AND expires_at > now()`,
      [clientId, runId, epoch, ttlMs / 1000],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async release(clientId: string, runId: string, epoch: number): Promise<void> {
    await this.pool.query(
      'UPDATE leases SET expires_at = now() WHERE client_id = $1 AND holder_run = $2 AND epoch = $3 AND expires_at > now()',
      [clientId, runId, epoch],
    );
  }
}

/** The same contract for tests and paper runs. Time is injected, so expiry and margin are exact. */
export class MemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, { runId: string; epoch: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(clientId: string, runId: string, ttlMs: number, marginMs: number): Promise<number | undefined> {
    const current = this.leases.get(clientId);
    if (current !== undefined && current.expiresAt > this.now() - marginMs) {
      return undefined;
    }
    const epoch = (current?.epoch ?? 0) + 1;
    this.leases.set(clientId, { runId, epoch, expiresAt: this.now() + ttlMs });
    return epoch;
  }

  async renew(clientId: string, runId: string, epoch: number, ttlMs: number): Promise<boolean> {
    const current = this.leases.get(clientId);
    if (current === undefined || current.runId !== runId || current.epoch !== epoch || current.expiresAt <= this.now()) {
      return false;
    }
    current.expiresAt = this.now() + ttlMs;
    return true;
  }

  async release(clientId: string, runId: string, epoch: number): Promise<void> {
    const current = this.leases.get(clientId);
    if (current !== undefined && current.runId === runId && current.epoch === epoch) {
      current.expiresAt = this.now();
    }
  }
}

export interface LeaseOptions {
  readonly clientId: string;
  readonly runId: string;
  readonly ttlMs: number;
  /** How long after expiry a new holder must wait. Covers an order that was in flight when the old lease ended. */
  readonly marginMs: number;
  /** Must be monotonic when used in production (performance.now). Only elapsed time is compared. */
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export type LeaseLostListener = (reason: string) => void;

/**
 * Holds the lease for one run. It renews every ttl/3. It stops holding once the last successful renewal
 * is a full ttl old, measured from when the renewal was sent. That bound is conservative, because the
 * database cannot have extended the lease past the time the renewal was sent plus the ttl.
 */
export class Lease {
  private epochValue: number | undefined;
  private renewing: Promise<void> | undefined;
  private lastRenewedSentAt = Number.NEGATIVE_INFINITY;
  private timer: unknown;
  private readonly lostListeners: LeaseLostListener[] = [];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly store: LeaseStore,
    private readonly options: LeaseOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  /** Takes the lease if it is free and past the margin. Returns false when another run holds it. */
  async acquire(): Promise<boolean> {
    const sentAt = this.now();
    const epoch = await this.store.acquire(this.options.clientId, this.options.runId, this.options.ttlMs, this.options.marginMs);
    if (epoch === undefined) {
      return false;
    }
    this.epochValue = epoch;
    this.lastRenewedSentAt = sentAt;
    this.timer = this.setTimer(() => void this.renewTick(), Math.max(1, Math.floor(this.options.ttlMs / 3)));
    return true;
  }

  /** The epoch to write under, or undefined when this run does not hold the lease. */
  epoch(): number | undefined {
    return this.holds() ? this.epochValue : undefined;
  }

  /** True only while a renewal inside the last ttl succeeded. Checked before every order. */
  holds(): boolean {
    return this.epochValue !== undefined && this.now() - this.lastRenewedSentAt < this.options.ttlMs;
  }

  onLost(listener: LeaseLostListener): void {
    this.lostListeners.push(listener);
  }

  async release(): Promise<void> {
    this.stopTimer();
    const epoch = this.epochValue;
    if (epoch === undefined) {
      return;
    }
    this.epochValue = undefined;
    await this.store.release(this.options.clientId, this.options.runId, epoch);
  }

  /** Exposed for tests. The timer calls this on every interval. Overlapping ticks share one renewal. */
  renewTick(): Promise<void> {
    this.renewing ??= this.renewOnce().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renewOnce(): Promise<void> {
    const epoch = this.epochValue;
    if (epoch === undefined) {
      return;
    }
    const sentAt = this.now();
    try {
      const renewed = await this.store.renew(this.options.clientId, this.options.runId, epoch, this.options.ttlMs);
      if (renewed) {
        this.lastRenewedSentAt = sentAt;
        return;
      }
      this.lose('the lease is held by another run, or it expired');
    } catch (error) {
      // A transient failure is retried on the next tick. Only silence for a full ttl loses the lease.
      if (this.now() - this.lastRenewedSentAt >= this.options.ttlMs) {
        this.lose(`the lease could not be renewed within ${this.options.ttlMs} ms: ${(error as Error).message}`);
      }
    }
  }

  private lose(reason: string): void {
    if (this.epochValue === undefined) {
      return;
    }
    this.epochValue = undefined;
    this.stopTimer();
    for (const listener of this.lostListeners) {
      listener(reason);
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
