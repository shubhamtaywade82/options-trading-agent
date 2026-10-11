/**
 * Point-in-time universe resolver for perpetual futures.
 * Ensures that backtests only access instruments active at historical timestamp t,
 * eliminating survivorship bias and lookahead listing leaks.
 */

export interface ActivePerpSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  listedAt: Date;
  delistedAt: Date | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELISTED' | 'SETTLED_TO_ZERO';
}

export interface IDatabaseClient {
  query<T = unknown>(text: string, params: unknown[]): Promise<{ rows: T[] }>;
}

export const DDL_UNIVERSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS perp_contract_lifecycle (
    symbol VARCHAR(32) PRIMARY KEY,
    base_asset VARCHAR(16) NOT NULL,
    quote_asset VARCHAR(16) NOT NULL,
    listed_at TIMESTAMPTZ NOT NULL,
    delisted_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    settlement_price NUMERIC(18, 8),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_perp_lifecycle_temporal 
ON perp_contract_lifecycle (listed_at, delisted_at);

CREATE TABLE IF NOT EXISTS perp_funding_history (
    funding_time TIMESTAMPTZ NOT NULL,
    symbol VARCHAR(32) NOT NULL REFERENCES perp_contract_lifecycle(symbol),
    funding_rate NUMERIC(12, 8) NOT NULL,
    mark_price NUMERIC(18, 8) NOT NULL,
    PRIMARY KEY (funding_time, symbol)
);

CREATE INDEX IF NOT EXISTS idx_perp_funding_lookup 
ON perp_funding_history (symbol, funding_time DESC);

CREATE TABLE IF NOT EXISTS perp_market_bars (
    timestamp TIMESTAMPTZ NOT NULL,
    symbol VARCHAR(32) NOT NULL REFERENCES perp_contract_lifecycle(symbol),
    open_price NUMERIC(18, 8) NOT NULL,
    high_price NUMERIC(18, 8) NOT NULL,
    low_price NUMERIC(18, 8) NOT NULL,
    close_price NUMERIC(18, 8) NOT NULL,
    volume_base NUMERIC(28, 8) NOT NULL,
    volume_quote NUMERIC(28, 8) NOT NULL,
    open_interest NUMERIC(28, 8),
    PRIMARY KEY (timestamp, symbol)
);

CREATE TABLE IF NOT EXISTS perp_margin_tiers (
    symbol VARCHAR(32) NOT NULL REFERENCES perp_contract_lifecycle(symbol),
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to TIMESTAMPTZ,
    tier_level INT NOT NULL,
    notional_cap NUMERIC(24, 4) NOT NULL,
    max_leverage INT NOT NULL,
    maintenance_margin_rate NUMERIC(8, 6) NOT NULL,
    maintenance_margin_deduction NUMERIC(24, 4) NOT NULL,
    PRIMARY KEY (symbol, effective_from, tier_level)
);
`;

export async function initUniverseSchema(db: IDatabaseClient): Promise<void> {
  await db.query(DDL_UNIVERSE_SCHEMA, []);
}

export class UniverseResolver {
  constructor(private readonly db: IDatabaseClient) {}

  public async getAsOfUniverse(asOfDate: Date): Promise<ActivePerpSymbol[]> {
    const query = `
      SELECT 
        symbol, 
        base_asset AS "baseAsset", 
        quote_asset AS "quoteAsset", 
        listed_at AS "listedAt", 
        delisted_at AS "delistedAt", 
        status
      FROM perp_contract_lifecycle
      WHERE listed_at <= $1
        AND (delisted_at IS NULL OR delisted_at > $1)
        AND status IN ('ACTIVE', 'SUSPENDED')
      ORDER BY symbol ASC;
    `;

    const result = await this.db.query<ActivePerpSymbol>(query, [asOfDate]);
    return result.rows;
  }

  public async getIntervalUniverse(startDate: Date, endDate: Date): Promise<string[]> {
    const query = `
      SELECT symbol
      FROM perp_contract_lifecycle
      WHERE listed_at <= $2
        AND (delisted_at IS NULL OR delisted_at >= $1)
      ORDER BY symbol ASC;
    `;

    const result = await this.db.query<{ symbol: string }>(query, [startDate, endDate]);
    return result.rows.map((r) => r.symbol);
  }

  public async upsertContract(contract: ActivePerpSymbol): Promise<void> {
    const query = `
      INSERT INTO perp_contract_lifecycle (symbol, base_asset, quote_asset, listed_at, delisted_at, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (symbol) DO UPDATE SET
        delisted_at = EXCLUDED.delisted_at,
        status = EXCLUDED.status;
    `;
    await this.db.query(query, [
      contract.symbol,
      contract.baseAsset,
      contract.quoteAsset,
      contract.listedAt,
      contract.delistedAt,
      contract.status,
    ]);
  }
}
