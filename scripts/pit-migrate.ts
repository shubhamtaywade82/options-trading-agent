/**
 * Runs idempotent DDL migrations for the PIT (Point-in-Time) universe tables
 * against the supervisor PostgreSQL instance.
 */

import pg from 'pg';
import { DDL_UNIVERSE_SCHEMA } from '../src/backtesting/UniverseResolver.js';

const PG_URL = process.env.PIT_DATABASE_URL ?? 'postgres://supervisor:supervisor@localhost:5434/supervisor';

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: PG_URL, max: 1 });

  try {
    console.log('[pit-migrate] Connecting to', PG_URL.replace(/:\/\/[^@]+@/, '://***@'));
    await pool.query(DDL_UNIVERSE_SCHEMA, []);
    console.log('[pit-migrate] ✓ Schema applied (idempotent). Tables ready:');
    console.log('  - perp_contract_lifecycle');
    console.log('  - perp_funding_history');
    console.log('  - perp_market_bars');
    console.log('  - perp_margin_tiers');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[pit-migrate] FATAL:', err.message);
  process.exit(1);
});
