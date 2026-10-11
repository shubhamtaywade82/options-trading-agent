/**
 * Seeds the perp_contract_lifecycle table with Binance USDT-M perpetual contracts.
 *
 * For delisted/settled symbols, a known-delisted stub set is hardcoded because
 * Binance does not expose historical delist dates via public API.
 *
 * Usage: npx tsx scripts/pit-seed-universe.ts
 */

import pg from 'pg';
import { UniverseResolver, initUniverseSchema } from '../src/backtesting/UniverseResolver.js';

const PG_URL = process.env.PIT_DATABASE_URL ?? 'postgres://supervisor:supervisor@localhost:5434/supervisor';
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

// Known delisted pairs — Binance does not expose these via API.
// Dates sourced from public post-mortems and community records.
const KNOWN_DELISTED: Array<{
  symbol: string; base: string; listedAt: string; delistedAt: string;
}> = [
  { symbol: 'LUNAUSDT', base: 'LUNA', listedAt: '2021-07-01', delistedAt: '2022-05-13' },
  { symbol: 'FTTUSDT',  base: 'FTT',  listedAt: '2021-09-14', delistedAt: '2022-11-10' },
  { symbol: 'SRMUSDT',  base: 'SRM',  listedAt: '2021-09-14', delistedAt: '2023-08-31' },
  { symbol: 'RAYUSDT',  base: 'RAY',  listedAt: '2021-09-15', delistedAt: '2023-09-18' },
  { symbol: 'BAKEUSDT', base: 'BAKE', listedAt: '2021-09-01', delistedAt: '2023-12-15' },
];

interface BinanceSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  onboardDate: number;
  contractType: string;
}

async function fetchBinanceSymbols(): Promise<BinanceSymbol[]> {
  const resp = await fetch(BINANCE_FAPI);
  if (!resp.ok) throw new Error(`Binance exchangeInfo HTTP ${resp.status}`);
  const data = await resp.json() as { symbols: BinanceSymbol[] };
  return data.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT');
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: PG_URL });
  const resolver = new UniverseResolver(pool);

  try {
    await initUniverseSchema(pool);

    console.log('[pit-seed-universe] Fetching Binance USDT-M perpetuals…');
    const symbols = await fetchBinanceSymbols();
    console.log(`[pit-seed-universe] Found ${symbols.length} active perpetual contracts`);

    let upserted = 0;
    for (const s of symbols) {
      await resolver.upsertContract({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        listedAt: new Date(s.onboardDate),
        delistedAt: null,
        status: s.status === 'TRADING' ? 'ACTIVE' : 'SUSPENDED',
      });
      upserted++;
    }

    console.log(`[pit-seed-universe] ✓ Upserted ${upserted} active contracts`);

    // Seed known-delisted stubs
    for (const d of KNOWN_DELISTED) {
      await resolver.upsertContract({
        symbol: d.symbol,
        baseAsset: d.base,
        quoteAsset: 'USDT',
        listedAt: new Date(d.listedAt),
        delistedAt: new Date(d.delistedAt),
        status: 'DELISTED',
      });
    }
    console.log(`[pit-seed-universe] ✓ Seeded ${KNOWN_DELISTED.length} known-delisted stubs`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[pit-seed-universe] FATAL:', err.message);
  process.exit(1);
});
