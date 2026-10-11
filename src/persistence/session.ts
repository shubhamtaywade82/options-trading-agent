import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { configFingerprint, type AgentConfig } from '../config.js';
import type { Logger } from '../ops/logger.js';
import { MemoryCacheStore, RedisCacheStore, type CacheStore } from './cache.js';
import { Lease, PostgresLeaseStore } from './lease.js';
import { PostgresLedger } from './ledger.js';
import { MIGRATIONS } from './migrations.js';
import { createPostgresPool, migrate } from './postgres.js';
import { connectRedis } from './redis.js';
import { MemoryRateGate, RedisRateGate, type RateGate } from './rateGate.js';
import { errorMessage, secretsOf } from './redact.js';

/** Key namespace for everything this agent writes to Redis. Per client id, so two accounts never collide. */
const KEY_ROOT = 'dhan-agent';

export interface PersistenceSession {
  readonly runId: string;
  /** Present when DATABASE_URL is set. Live writes through it are fenced to the lease. */
  readonly ledger: PostgresLedger | undefined;
  readonly cache: CacheStore;
  readonly rateGate: RateGate;
  /** Present in live mode. The trading right for this client id, held in PostgreSQL. */
  readonly lease: Lease | undefined;
  /** Strings that must never appear in a log line or error message. */
  readonly secrets: readonly string[];
  /**
   * Ends the run record, releases the lease and closes connections. `unconfirmed` is how many events were not yet
   * in the journal and ledger at that moment; a non-zero count makes the next live start wait for review. Idempotent.
   */
  close(reason: string, unconfirmed?: number): Promise<void>;
}

/**
 * Opens every configured store and registers the run. Live mode also takes the trading lease and refuses
 * to start while an earlier live run for the same client never ended, because that run may still hold
 * orders or positions that this process has not seen. Any failure closes what was opened and throws a
 * redacted error, so a refused start leaves nothing connected and never prints a credential.
 */
export async function openSession(
  config: AgentConfig,
  input: { readonly logger: Logger; readonly now: () => number },
): Promise<PersistenceSession> {
  const { logger } = input;
  const { databaseUrl, redisUrl, leaseTtlMs, postgresMaxConnections } = config.persistence;
  const clientId = config.dhan.clientId;
  const live = config.mode === 'live';
  const secrets = [...(databaseUrl === undefined ? [] : secretsOf(databaseUrl)), ...(redisUrl === undefined ? [] : secretsOf(redisUrl))];
  const runId = randomUUID();
  const instance = config.persistence.instanceId ?? hostname();

  let pool: Pool | undefined;
  let leasePool: Pool | undefined;
  let redis: Redis | undefined;
  let lease: Lease | undefined;
  let ledger: PostgresLedger | undefined;
  let runRegistered = false;
  let closing: Promise<void> | undefined;

  const close = (reason: string, unconfirmed = 0): Promise<void> => {
    closing ??= (async () => {
      if (ledger !== undefined && runRegistered) {
        await ledger.endRun(runId, reason, unconfirmed).catch((error: unknown) => {
          logger.error('could not mark the run ended', { runId, error: errorMessage(error, secrets) });
        });
      }
      if (lease !== undefined) {
        await lease.release().catch((error: unknown) => {
          logger.error('could not release the trading lease', { error: errorMessage(error, secrets) });
        });
      }
      redis?.disconnect();
      for (const toClose of [leasePool, pool]) {
        await toClose?.end().catch((error: unknown) => {
          logger.warn('ledger pool did not close cleanly', { error: errorMessage(error, secrets) });
        });
      }
    })();
    return closing;
  };

  try {
    if (databaseUrl !== undefined) {
      pool = createPostgresPool({
        url: databaseUrl,
        maxConnections: postgresMaxConnections,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 10_000,
        onError: (error) => logger.error('ledger connection error', { error: errorMessage(error, secrets) }),
      });
      const report = await migrate(pool, MIGRATIONS);
      logger.info('ledger schema ready', { applied: [...report.applied], alreadyApplied: report.alreadyApplied });

      // The lease has its own single connection, with a timeout below the renewal interval. A busy event
      // outbox must never delay a renewal, and a stalled renewal must show up as a lost lease, not a hang.
      leasePool = createPostgresPool({
        url: databaseUrl,
        maxConnections: 1,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: Math.max(1_000, Math.floor(leaseTtlMs / 3)),
        onError: (error) => logger.error('lease connection error', { error: errorMessage(error, secrets) }),
      });
      // Created before the ledger, because a live ledger writes under the lease's epoch.
      lease = new Lease(new PostgresLeaseStore(leasePool), {
        clientId,
        runId,
        ttlMs: leaseTtlMs,
        // A new holder waits this long after expiry, so an order that was in flight can still finish.
        marginMs: config.ops.orderTimeoutMs,
        // Elapsed time since the last renewal is measured in this process, so it uses a monotonic clock. A wall
        // clock step backwards would otherwise keep the lease "held" after its ttl has passed.
        now: () => performance.now(),
      });
      ledger = new PostgresLedger(
        pool,
        live ? { clientId, runId, epoch: () => lease?.epoch() } : undefined,
      );
    }

    if (redisUrl !== undefined) {
      redis = await connectRedis({
        url: redisUrl,
        connectTimeoutMs: 5_000,
        commandTimeoutMs: 3_000,
        onError: (error) => logger.warn('redis connection error', { error: errorMessage(error, secrets) }),
      });
    }

    // Redis holds the account rate gate and the contract cache. Neither is a trading authority.
    const cache: CacheStore = redis === undefined ? new MemoryCacheStore(input.now) : new RedisCacheStore(redis, `${KEY_ROOT}:${clientId}:cache:`);
    const rateGate: RateGate =
      redis === undefined ? new MemoryRateGate({ now: input.now }) : new RedisRateGate(redis, { prefix: `${KEY_ROOT}:${clientId}:rl:` });

    if (ledger !== undefined) {
      await ledger.startRun({
        runId,
        instanceId: instance,
        mode: config.mode,
        clientId,
        configFingerprint: configFingerprint(config),
        startedAt: new Date(input.now()).toISOString(),
      });
      runRegistered = true;
    }

    if (live && lease !== undefined && ledger !== undefined) {
      if (!(await lease.acquire())) {
        throw new Error(
          `another run holds the trading lease for client ${clientId}. A crashed run releases it when its lease expires, plus the order timeout; start again after that`,
        );
      }
      logger.info('trading lease acquired', { clientId, runId });
      const review = await ledger.runsNeedingReview(clientId, runId);
      if (review.length > 0) {
        const list = review.map((r) => `${r.runId} (${r.instanceId}, started ${r.startedAt}, ${r.reason})`).join('; ');
        throw new Error(
          `live runs for client ${clientId} need review before this one starts: ${list}. Check their positions and orders at the broker, then run npm run db:acknowledge -- --run <runId> --reason "<what you checked>"`,
        );
      }
      lease.onLost((reason) => logger.error('trading lease lost; no orders will be sent', { reason }));
    }

    return { runId, ledger, cache, rateGate, lease, secrets, close };
  } catch (error) {
    await close('startup failed');
    throw new Error(`persistence startup failed: ${errorMessage(error, secrets)}`);
  }
}
