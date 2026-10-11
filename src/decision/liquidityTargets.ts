import type { LiquidityPool, MarketState } from '../market/types.js';

const HIGH_SIDE: ReadonlySet<LiquidityPool['type']> = new Set(['EQUAL_HIGH', 'SWING_HIGH', 'RANGE_HIGH']);
const LOW_SIDE: ReadonlySet<LiquidityPool['type']> = new Set(['EQUAL_LOW', 'SWING_LOW', 'RANGE_LOW']);

export interface PoolTarget {
  pool: LiquidityPool;
  rewardRisk: number;
}

/**
 * The nearest untaken liquidity pool in the direction of profit that pays at least `minimumRewardRisk` times the
 * stop distance, walking outward past pools that are too close to be worth the risk. Pools the sweep ledger already
 * consumed (`taken`) are spent liquidity, not a magnet. Null when no pool qualifies: the caller should not trade.
 */
export function nearestPoolWithRewardRisk(
  state: MarketState,
  side: 'LONG' | 'SHORT',
  entry: number,
  riskDistance: number,
  minimumRewardRisk: number,
): PoolTarget | null {
  if (!(riskDistance > 0) || !Number.isFinite(entry)) return null;
  const wanted = side === 'LONG' ? HIGH_SIDE : LOW_SIDE;
  const pools = [...state.liquidity.ltf.pools, ...state.liquidity.htf.pools]
    .filter((pool) => wanted.has(pool.type) && pool.taken !== true && Number.isFinite(pool.price))
    .filter((pool) => (side === 'LONG' ? pool.price > entry : pool.price < entry))
    .sort((a, b) => (Math.abs(a.price - entry) - Math.abs(b.price - entry)) || (b.strength - a.strength));
  for (const pool of pools) {
    const rewardRisk = Math.abs(pool.price - entry) / riskDistance;
    if (rewardRisk >= minimumRewardRisk) return { pool, rewardRisk };
  }
  return null;
}
