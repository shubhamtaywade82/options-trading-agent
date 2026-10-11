# Persistence

This describes the persistence layer as implemented. Where a guarantee does not yet hold, it says so under **Open items**.

## Stores and roles

| Store | Role | Authority |
|---|---|---|
| PostgreSQL 16 (`DATABASE_URL`) | System of record: `trade_events` ledger, `runs`, `leases`, `schema_migrations` | Yes. Owns the trading lease and fences every live write. |
| JSONL journal (`events-YYYY-MM-DD.jsonl`, IST day) | Write-ahead log on local disk; restore source when the ledger is unavailable | Local durability. Source for backfill. |
| Redis 7 (`REDIS_URL`) | Account-wide rate gate and contract cache | No. Losing Redis slows the agent or costs a re-fetch. It never decides a trade. |
| In-process memory | Fallback for paper runs and unit tests | No. |

PostgreSQL is the only trading authority. A Redis lock can be granted twice across a failover, so it is not used for that decision.

## Keys and identity

- Every run has a UUID `run_id`, created at session start.
- Every event carries `run` (UUID), `seq` (monotonic within the run), `mode`, and `client`.
- Ledger `source_key` is `runId:seq` for events from this build, and `legacy:<day>:<line>` for older journal lines. The column is `UNIQUE`, so re-inserting is idempotent.
- Redis keys are namespaced `dhan-agent:<clientId>:cache:` and `dhan-agent:<clientId>:rl:`. Two client ids never share keys.

## Schema (migrations)

Migrations are in `src/persistence/migrations.ts`, applied in order, each in its own transaction, under advisory lock `727001`.

- `001_ledger`: `trade_events` (`id bigserial`, `source_key` unique, `run_id`, `seq`, `trading_day`, `ts`, `event_type`, `underlying`, `correlation_id`, `record jsonb`).
- `002_lease_and_tags`: `leases (client_id PK, holder_run, epoch, expires_at)`, and the mode/client tags used by restore.
- `003_append_only_and_run_safety`: a trigger on `trade_events` raises on `UPDATE`, `DELETE`, and `TRUNCATE`. `runs` gains `unconfirmed_at_end` and `acknowledged`.

The migrator refuses to run when an applied migration's checksum (sha256) has changed, or when the database holds a version this build does not know.

## Trading lease and fencing

- `PostgresLeaseStore` runs every statement on the database clock. A new holder can take the lease only after `expires_at` plus `ORDER_TIMEOUT_MS`, so an order in flight from the old holder can finish.
- `epoch` increments on every acquisition. A renewal succeeds only for the same `(run, epoch)` while unexpired.
- `Lease` renews every `ttl/3` on its own single-connection pool. It counts a renewal as successful only when the request was sent less than `ttl` ago, measured on a monotonic clock. `holds()` is false once that window passes.
- A live `PostgresLedger` writes in a transaction that takes `SELECT ... FOR SHARE` on the lease row for its `(run, epoch)`. A takeover cannot commit mid-write. A fenced-out writer gets `LeaseLostError` and its rows are not written.
- The trading gate refuses **entries** when the lease is not held. Exits are not gated by the lease (see Failure semantics).

## Journal (JSONL)

- One file per IST trading day. Lines are written with `fdatasync` for durable events.
- A failed partial write is truncated back to the last complete line.
- A torn final line from a crash is either completed (if it parses) or moved to a quarantine file. `repairTornTail` runs before every backfill.
- The journal is append-only. Backfill never rewrites it.

## Write path and the entry gate

`EventLog.durable(event)`:
1. Appends and `fdatasync`s the journal line.
2. Awaits the ledger insert.
3. If the ledger insert fails, enqueues the event in the outbox (bounded at 10 000, batched at 500, exponential backoff) and rejects.

`EventLog.unconfirmedEvents()` counts outbox items. While it is non-zero, entries are refused.

Before a live entry:
1. Persist `entry_submitted` durably, under a 2 s deadline (`INTENT_DEADLINE_MS`). Failure means `INTENT_NOT_DURABLE`, and no order is sent.
2. Recheck the gate. A failure records `entry_rejected` with `ABORTED_AFTER_INTENT`.
3. Dispatch the order. There is no `await` between the gate recheck and the broker call.

## Failure semantics

| Failure | Entries | Exits |
|---|---|---|
| PostgreSQL unreachable at start | Refuse to start (`persistence startup failed`) | n/a |
| Ledger insert failing at runtime | Refused while events are unconfirmed | Proceed; `exit_submitted` is recorded as `audit_gap` if its intent write failed |
| Lease not held | Refused | Proceed |
| Redis unreachable | Rate gate and cache fall back or miss; no trading effect | Same |
| Unconfirmed events at shutdown | Recorded on `runs.unconfirmed_at_end`; the next live start refuses until acknowledged | n/a |

Exits proceed on lease loss because an open position with no working exit is the larger risk. `submitExit` reads the broker position before it sends anything: if the position cannot be read, it sends nothing and records `EXIT_UNCONFIRMED`. It never sells more than the broker shows.

## Startup (`openSession`)

1. Migrate. Refuse on checksum mismatch or an unknown version.
2. Create the lease pool (single connection, statement timeout below the renewal interval) and the ledger pool.
3. Connect Redis (`PING`). Failure is redacted and fatal in live mode.
4. Register the run in `runs`.
5. Live only: acquire the lease. Then refuse while `runsNeedingReview` is non-empty. That covers earlier live runs for the same client that never ended, or that ended with unconfirmed events, and are not acknowledged.
6. Restore the day (below). Refusals name the exact remedy.

Any startup failure closes what was opened and throws a redacted error. No credential reaches a log line.

## Restore

`restoreFromLedger` runs `backfillDay` for today, then:
- Refuses if the day has untagged rows (`untaggedDayCount > 0`). Those predate mode and client tags, so they cannot be attributed.
- Reads `dayLines(day, {mode, clientId})`, ordered by run start, then `seq`.
- Replays through `restoreDayBook`. Operator events are replayed. Unresolved intents receive a zero-P&L close with a cooldown.

`backfillDay`:
- Parses every line. Refuses on malformed JSON, a bad timestamp, a line from another IST day, a partial `run`/`seq`, a non-UUID run id, or a gap in a run's sequence.
- Verifies afterwards that every key in the file is present in the ledger. Otherwise it throws, rather than restoring a set it cannot prove complete.

Without a `DATABASE_URL`, restore reads the journal directly through `scopeJournalLines`, which applies the same mode and client filter.

## Acknowledging a run

`npm run db:acknowledge -- --run <runId> --reason "<what you checked>"` requires a UUID and a reason of at least 10 characters. It sets `acknowledged`, closes a never-ended run with `acknowledged: <reason>`, and records the reason. Check the broker's positions and orders before acknowledging.

## Operations

- Migrate: `npm run db:migrate`. Status: `npm run db:status`.
- Local services: `docker compose up -d` (PostgreSQL 16 and Redis 7 on `127.0.0.1`; Redis runs with `appendonly yes` and `noeviction`).
- Tests: `npm test` runs every suite. The integration tests in `tests/persistence.integration.test.ts` run only when `TEST_DATABASE_URL` and `TEST_REDIS_URL` are set, and are skipped otherwise. `npm run test:integration` runs that file alone. With `CI=true` and either URL unset, the module throws instead of skipping.

## Open items

These are known gaps. Each one is a stated requirement, not a shipped guarantee.

1. **Synchronous replication.** Live mode assumes PostgreSQL `synchronous_commit = on` with a synchronous standby. Nothing checks this at startup. Until it is enforced, a failover can lose the last committed events, and restore cannot see them.
2. **TLS.** `validatePostgresUrl` checks scheme and host only. Live use should require `sslmode=verify-full` and `sslrootcert`, and Redis should use `rediss://`. Not enforced yet.
3. **Two database roles.** The migrator should be a separate role run as a separate command. The application role should hold only `SELECT` and `INSERT` on `trade_events`. Not yet split.
4. **Halt and breach latches across days.** Per-underlying halts and the operator block are restored from today's events only. A latch from a prior day is not carried forward. Operator clear is not yet refused while a halt or breach is latched.
5. **Broker kill switch journalling.** `broker_kill_engaged` and `broker_kill_failed` are not journalled yet. On start, the agent does not re-engage the kill switch when a breach is latched without a confirmed engage.
6. **Broker reconciliation.** Realised P&L is not reconciled against the broker at start. `PositionResponse.realizedProfit` and `orders.listTrades` semantics are not verified against the SDK, so this is not implemented as a hard refusal.
7. **Backfill window.** Only today's journal is backfilled. Retained days are not checked in both directions for key-set equality.
8. **Retention and recovery.** Backup, point-in-time recovery, the RPO target, a restore drill, and the journal-to-ledger rebuild procedure are operator decisions. They are not documented with numbers here. Retention for journal files and `trade_events` is not yet defined.
9. **Pre-existing halt behaviour.** A halt engages the broker kill switch immediately, even with positions open. That conflicts with the rule that exits must not be blocked. It is outside this change and is tracked separately.
