/**
 * Seeds perp_funding_history by paginating Binance's /fapi/v1/fundingRate endpoint
 * for all ACTIVE symbols in the universe.
 *
 * Run after pit-seed-universe.ts.
 * Usage: npx tsx scripts/pit-seed-funding.ts [--symbols BTCUSDT,ETHUSDT]
 */

import pg from 'pg';
import { type IDatabaseClient } from '../src/backtesting/UniverseResolver.js';

const PG_URL = process.env.PIT_DATABASE_URL ?? 'postgres://supervisor:supervisor@localhost:5434/supervisor';
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1/fundingRate';
const PAGE_LIMIT = 1000;
const DELAY_MS = 300; // rate-limit courtesy delay

interface FundingRecord {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

async function fetchPage(symbol: string, endTime?: number): Promise<FundingRecord[]> {
  const params = new URLSearchParams({ symbol, limit: String(PAGE_LIMIT) });
  if (endTime) params.set('endTime', String(endTime));
  const resp = await fetch(`${BINANCE_FAPI}?${params}`);
  if (!resp.ok) throw new Error(`Binance fundingRate HTTP ${resp.status} for ${symbol}`);
  return resp.json() as Promise<FundingRecord[]>;
}

async function insertBatch(db: IDatabaseClient, records: FundingRecord[]): Promise<void> {
  if (records.length === 0) return;
  const values = records.map((r, i) => {
    const b = i * 4;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
  }).join(', ');

  const params = records.flatMap((r) => [
    new Date(r.fundingTime),
    r.symbol,
    parseFloat(r.fundingRate),
    parseFloat(r.markPrice),
  ]);

  await db.query(
    `INSERT INTO perp_funding_history (funding_time, symbol, funding_rate, mark_price)
     VALUES ${values}
     ON CONFLICT DO NOTHING`,
    params,
  );
}

async function seedSymbol(db: IDatabaseClient, symbol: string): Promise<number> {
  let totalInserted = 0;
  let endTime: number | undefined;

  for (;;) {
    const batch = await fetchPage(symbol, endTime);
    if (batch.length === 0) break;
    await insertBatch(db, batch);
    totalInserted += batch.length;
    if (batch.length < PAGE_LIMIT) break;
    endTime = batch[0].fundingTime - 1; // paginate backwards
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  return totalInserted;
}

async function resolveSymbols(db: IDatabaseClient, argv: string[]): Promise<string[]> {
  const flagIdx = argv.indexOf('--symbols');
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    return argv[flagIdx + 1].split(',');
  }
  const { rows } = await db.query<{ symbol: string }>(
    `SELECT symbol FROM perp_contract_lifecycle WHERE status = 'ACTIVE' ORDER BY symbol`,
    [],
  );
  return rows.map((r) => r.symbol);
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: PG_URL });

  try {
    const symbols = await resolveSymbols(pool, process.argv);
    console.log(`[pit-seed-funding] Seeding funding rates for ${symbols.length} symbols…`);

    for (const sym of symbols) {
      try {
        const count = await seedSymbol(pool, sym);
        console.log(`  ${sym}: ${count} records`);
      } catch (err) {
        console.warn(`  ${sym}: SKIP — ${(err as Error).message}`);
      }
    }

    console.log('[pit-seed-funding] ✓ Done');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[pit-seed-funding] FATAL:', err.message);
  process.exit(1);
});
