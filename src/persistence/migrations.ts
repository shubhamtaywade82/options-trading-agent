import type { Migration } from './postgres.js';

/**
 * Schema for the trading ledger. Migrations are append-only: an applied migration is never edited,
 * because its checksum is stored and checked on every start. Add a new version to change the schema.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: '001_ledger',
    sql: `
      CREATE TABLE runs (
        run_id uuid PRIMARY KEY,
        instance_id text NOT NULL,
        mode text NOT NULL CHECK (mode IN ('paper', 'live')),
        client_id text NOT NULL,
        config_fingerprint text NOT NULL,
        started_at timestamptz NOT NULL,
        ended_at timestamptz,
        ended_reason text
      );

      -- Append-only. Each row is the exact JSONL record, so restore replays it through the same code path as the file.
      -- source_key is 'run:seq' for events written by this build, and 'legacy:<day>:<line>' for lines written before run ids existed.
      CREATE TABLE trade_events (
        id bigserial PRIMARY KEY,
        source_key text NOT NULL UNIQUE,
        run_id uuid REFERENCES runs (run_id),
        seq integer,
        trading_day date NOT NULL,
        ts timestamptz NOT NULL,
        event_type text NOT NULL,
        underlying text,
        correlation_id text,
        record jsonb NOT NULL,
        CHECK ((run_id IS NULL) = (seq IS NULL))
      );

      CREATE INDEX trade_events_day_order_idx ON trade_events (trading_day, ts, seq, id);
      CREATE INDEX trade_events_correlation_idx ON trade_events (correlation_id) WHERE correlation_id IS NOT NULL;

      CREATE VIEW v_closed_trades AS
        SELECT
          trading_day,
          underlying,
          record->>'positionId' AS position_id,
          record->>'contract' AS contract,
          (record->>'quantity')::integer AS quantity,
          (record->>'entryPrice')::numeric AS entry_price,
          (record->>'exitPrice')::numeric AS exit_price,
          (record->>'pnlInr')::numeric AS pnl_inr,
          record->>'reason' AS exit_reason,
          ts AS closed_at
        FROM trade_events
        WHERE event_type = 'trade_closed';
    `,
  },
  {
    version: '002_lease_and_tags',
    sql: `
      -- The single trading authority per client id. Holder and epoch change together on every acquisition, so a
      -- stale holder can be recognised by its old epoch. Acquisition and renewal use the database clock.
      CREATE TABLE leases (
        client_id text PRIMARY KEY,
        holder_run uuid NOT NULL,
        epoch bigint NOT NULL,
        expires_at timestamptz NOT NULL
      );

      -- Restore filters each day by the mode and client that wrote it, so paper and live never share state.
      CREATE INDEX trade_events_tags_idx ON trade_events (trading_day, (record->>'client'), (record->>'mode'));
    `,
  },
  {
    version: '003_append_only_and_run_safety',
    sql: `
      -- Rows are written once. Correction happens by a new event, never by editing history. This holds for every
      -- role, including the owner, because the trigger runs for all of them. Retention is a partition drop, done by a migration.
      CREATE FUNCTION trade_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'trade_events is append-only; rows cannot be changed, removed or truncated';
      END
      $$;

      CREATE TRIGGER trade_events_immutable
        BEFORE UPDATE OR DELETE ON trade_events
        FOR EACH ROW EXECUTE FUNCTION trade_events_append_only();

      CREATE TRIGGER trade_events_no_truncate
        BEFORE TRUNCATE ON trade_events
        FOR EACH STATEMENT EXECUTE FUNCTION trade_events_append_only();

      -- A run that ended with events still unconfirmed, or that never ended, must be reviewed before a live run starts.
      ALTER TABLE runs ADD COLUMN unconfirmed_at_end integer NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN acknowledged boolean NOT NULL DEFAULT false;
    `,
  },
];
