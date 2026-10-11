import type { Signal, Side } from '../types.js';
import type { LiquidityPool, LiquiditySweep, MarketState, PriceZone, ZoneRecord } from '../market/types.js';

const LTF_BAR_MS = 15 * 60_000;

export interface StructureLiquidityOptions {
  maxSweepAgeCandles: number;
  minBreakDistanceAtr: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  minimumRewardRisk: number;
}

export const DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS: StructureLiquidityOptions = {
  maxSweepAgeCandles: 6,
  minBreakDistanceAtr: 0.10,
  stopBufferAtr: 0.15,
  minStopAtr: 0.50,
  maxStopAtr: 4.00,
  minimumRewardRisk: 1.50,
};

/**
 * The env-tunable subset of the setup options laid over the defaults.
 *
 * Only the sweep age window and the reward-risk floor are exposed as knobs
 * (they are the parameters the firing rate is most sensitive to); every other
 * threshold keeps its default so tuning cannot silently change stop sizing or
 * break quality.
 */
export function tunedStructureLiquidityOptions(
  overrides: Partial<Pick<StructureLiquidityOptions, 'maxSweepAgeCandles' | 'minimumRewardRisk'>>,
): StructureLiquidityOptions {
  return { ...DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS, ...overrides };
}

const isLong = (side: Side): boolean => side === 'LONG';

function expectedSweep(side: Side): LiquiditySweep['direction'] {
  return isLong(side) ? 'SELL_SIDE' : 'BUY_SIDE';
}

function isTargetPool(side: Side, pool: LiquidityPool, entry: number): boolean {
  const highSide = pool.type === 'EQUAL_HIGH'
    || pool.type === 'SWING_HIGH'
    || pool.type === 'RANGE_HIGH';
  const lowSide = pool.type === 'EQUAL_LOW'
    || pool.type === 'SWING_LOW'
    || pool.type === 'RANGE_LOW';

  return isLong(side) ? highSide && pool.price > entry : lowSide && pool.price < entry;
}

function targetPools(state: MarketState, side: Side, entry: number, breakTime: number): LiquidityPool[] {
  return [...state.liquidity.ltf.pools, ...state.liquidity.htf.pools]
    .filter((pool) => pool.sourceTimes.length > 0)
    .filter((pool) => Math.max(...pool.sourceTimes) < breakTime)
    // Pools the sweep ledger already consumed are spent liquidity, not a magnet:
    // price took them once, expecting the same rest to be taken twice is a
    // different trade. The ledger marks pools via `taken`/`sweptAt`; pools built
    // without ledger annotations (and RANGE_ pools, which the ledger skips)
    // stay eligible, so legacy-shaped states behave exactly as before.
    .filter((pool) => pool.taken !== true)
    .filter((pool) => isTargetPool(side, pool, entry))
    .sort((a, b) => (Math.abs(a.price - entry) - Math.abs(b.price - entry)) || (b.strength - a.strength));
}

/**
 * Identity of a sweep event across the two windows: candle, direction, level and
 * pool type. Deliberately excludes pool source times — two pools resting at the
 * same level swept by the same candle are the same liquidity event for trigger
 * purposes, whatever swings formed them.
 */
function sweepIdentity(sweep: LiquiditySweep): string {
  return `${sweep.time}|${sweep.direction}|${sweep.level}|${sweep.poolType}`;
}

/**
 * Trigger sweep candidates: the persistent ledger history unioned with the
 * legacy 12-bar window.
 *
 * The ledger (`LiquidityState.sweepHistory`) records every sweep over the full
 * analysed window, including sweeps of pools that aged out of the per-snapshot
 * pool list — the legacy window cannot see those. Unioning keeps the legacy
 * window as a safety net for the rare pool the ledger's active budget evicted
 * before it was swept, so the candidate set is never smaller than before.
 *
 * Determinism: history events come first, and the latest-sweep selection below
 * uses a stable sort — on an exact tie (same candle, direction and level) the
 * ledger event wins because it carries pool-source causality (`poolSourceTimes`)
 * and a stable identity (`id`). Exact duplicates collapse onto the history event.
 */
function eligibleSweeps(state: MarketState): LiquiditySweep[] {
  const ltf = state.liquidity.ltf;
  const history = ltf.sweepHistory ?? [];
  const legacy = ltf.recentSweeps ?? ltf.latestSweeps ?? [];

  if (history.length === 0) return legacy;
  if (legacy.length === 0) return history;

  const seen = new Set(history.map(sweepIdentity));
  return [...history, ...legacy.filter((sweep) => !seen.has(sweepIdentity(sweep)))];
}

function latestEligibleSweep(
  state: MarketState,
  side: Side,
  breakTime: number,
  options: StructureLiquidityOptions,
): LiquiditySweep | null {
  const sweeps = eligibleSweeps(state);
  const maxAge = options.maxSweepAgeCandles * LTF_BAR_MS;

  return [...sweeps]
    .filter((sweep) => sweep.confirmed && sweep.direction === expectedSweep(side))
    .filter((sweep) => sweep.time <= breakTime && breakTime - sweep.time <= maxAge)
    .sort((a, b) => (b.time - a.time) || (b.index - a.index))[0] ?? null;
}

function preferredZone(state: MarketState, side: Side, breakTime: number): PriceZone | null {
  const type: PriceZone['type'] = isLong(side) ? 'DEMAND' : 'SUPPLY';

  return [...state.zones]
    .filter((zone) => zone.type === type)
    .filter((zone) => zone.timeframe === '15m' || zone.timeframe === '1h')
    .filter((zone) => zone.originTime < breakTime)
    .filter((zone) => zone.fresh)
    .sort((a, b) => b.originTime - a.originTime)[0] ?? null;
}

/**
 * The zone the stop leans on, with its provenance.
 *
 * `ledger` anchors come from the zone ledger and carry the lifecycle state the
 * anchor was chosen in; `legacy` anchors come from the per-snapshot zone list
 * and carry no lifecycle information.
 */
interface StopAnchor {
  zone: PriceZone;
  source: 'ledger' | 'legacy';
  lifecycle: ZoneRecord['state'] | null;
}

/**
 * Stop anchor from the zone ledger lifecycle.
 *
 * Only zones that are alive per the ledger qualify: FRESH (untouched) or TESTED
 * (retested once and held). MITIGATED zones are half-consumed, INVALIDATED and
 * EXPIRED zones are dead — the ledger knows, the legacy snapshot cannot. A zone
 * must also have formed strictly before the confirming break (`breakTime <
 * breakTime`), so the anchor is causal.
 *
 * Ordering, deterministic: a TESTED zone (already absorbed one retest) beats an
 * unverified FRESH one; within a tier the zone nearest the entry anchors the
 * tightest defensible stop; the freshest origin breaks exact ties.
 */
function ledgerStopAnchor(
  state: MarketState,
  side: Side,
  entry: number,
  breakTime: number,
): StopAnchor | null {
  const type: PriceZone['type'] = isLong(side) ? 'DEMAND' : 'SUPPLY';

  const candidates = (state.zoneLedger ?? [])
    .filter((zone) => zone.type === type)
    .filter((zone) => zone.timeframe === '15m' || zone.timeframe === '1h')
    .filter((zone) => zone.breakTime < breakTime)
    .filter((zone) => zone.state === 'FRESH' || zone.state === 'TESTED')
    .sort((a, b) => {
      const testedRank = (a.state === 'TESTED' ? 1 : 0) - (b.state === 'TESTED' ? 1 : 0);
      if (testedRank !== 0) return -testedRank;
      const distance = Math.abs((a.high + a.low) / 2 - entry) - Math.abs((b.high + b.low) / 2 - entry);
      if (distance !== 0) return distance;
      return b.originTime - a.originTime;
    });

  if (candidates.length === 0) return null;

  const zone = candidates[0];
  return { zone, source: 'ledger', lifecycle: zone.state };
}

/**
 * Stop anchor: the zone ledger when the state carries one, else the legacy
 * per-snapshot zone list.
 *
 * When `zoneLedger` is present it is authoritative — an empty or all-dead
 * ledger means no live zone to lean on, and the stop falls back to the sweep
 * price alone rather than reaching for a legacy zone the ledger already knows
 * is spent. Only states built without a ledger (older snapshots, fixtures)
 * use the legacy path, which behaves exactly as before.
 */
function stopAnchor(state: MarketState, side: Side, entry: number, breakTime: number): StopAnchor | null {
  if (state.zoneLedger !== undefined) return ledgerStopAnchor(state, side, entry, breakTime);

  const zone = preferredZone(state, side, breakTime);
  return zone ? { zone, source: 'legacy', lifecycle: null } : null;
}

function stopAndRisk(
  state: MarketState,
  side: Side,
  entry: number,
  sweep: LiquiditySweep,
  anchor: StopAnchor | null,
  options: StructureLiquidityOptions,
): { stop: number; riskAtr: number } | null {
  const atr14 = state.timeframes['15m'].atr14;
  if (!atr14 || !(atr14 > 0)) return null;

  const buffer = atr14 * options.stopBufferAtr;
  const rawStop = isLong(side)
    ? Math.min(sweep.sweepPrice, anchor?.zone.low ?? Number.POSITIVE_INFINITY) - buffer
    : Math.max(sweep.sweepPrice, anchor?.zone.high ?? Number.NEGATIVE_INFINITY) + buffer;

  const riskDistance = Math.abs(entry - rawStop);
  if (!(riskDistance > 0)) return null;

  const riskAtr = riskDistance / atr14;
  if (riskAtr < options.minStopAtr || riskAtr > options.maxStopAtr) return null;

  return { stop: rawStop, riskAtr };
}

function targetAndRewardRisk(
  state: MarketState,
  side: Side,
  entry: number,
  riskDistance: number,
  breakTime: number,
  minimumRewardRisk: number,
): { target: LiquidityPool; rewardRisk: number } | null {
  if (!(riskDistance > 0)) return null;

  for (const pool of targetPools(state, side, entry, breakTime)) {
    const rewardDistance = Math.abs(pool.price - entry);
    const rewardRisk = rewardDistance / riskDistance;
    if (rewardRisk >= minimumRewardRisk) return { target: pool, rewardRisk };
  }

  return null;
}

/**
 * Deterministic SMC-style trend setup:
 * HTF directional regime -> LTF liquidity sweep -> LTF BOS/CHOCH confirmation -> opposing liquidity target.
 *
 * Ledger-connected since the structure/liquidity hardening batch:
 * - the trigger sweep is drawn from the persistent `sweepHistory` (causally
 *   replayed over the whole window) unioned with the legacy 12-bar window, so
 *   sweeps of pools that aged out of the snapshot pool list still qualify;
 * - the take-profit target never selects a pool the sweep ledger already
 *   consumed (`taken`), it walks outward to the nearest untaken liquidity;
 * - the stop anchors on a zone that is alive per the zone ledger — FRESH or
 *   TESTED, formed before the break; a ledger that says every zone is dead
 *   (MITIGATED/INVALIDATED/EXPIRED) leaves the stop on the sweep price alone.
 *
 * All three connections are behavioral changes: some setups that were missed
 * now fire, some that targeted spent liquidity now aim further out or stand
 * down, and stops no longer lean on zones the ledger has retired. States built
 * without ledger annotations fall back to the legacy behavior.
 *
 * Analysis-only: no venue, risk gate, or executor calls.
 */
export function buildStructureLiquiditySignal(
  state: MarketState,
  options: StructureLiquidityOptions = DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS,
): Signal | null {
  if (!Number.isFinite(state.mark) || state.mark <= 0) return null;

  const { regime, htfStructure, ltfStructure } = state;
  const trendSide =
    regime.regime === 'TREND_UP' && regime.trendDirection === 'BULLISH' && htfStructure.trend === 'BULLISH'
      ? 'LONG'
      : regime.regime === 'TREND_DOWN' && regime.trendDirection === 'BEARISH' && htfStructure.trend === 'BEARISH'
        ? 'SHORT'
        : null;

  if (!trendSide) return null;

  const breakEvent = ltfStructure.lastBreak;
  if (!breakEvent) return null;

  const breakMatches =
    (trendSide === 'LONG' && breakEvent.direction === 'BULLISH')
    || (trendSide === 'SHORT' && breakEvent.direction === 'BEARISH');
  if (!breakMatches || breakEvent.distanceAtr < options.minBreakDistanceAtr) return null;

  const sweep = latestEligibleSweep(state, trendSide, breakEvent.time, options);
  if (!sweep) return null;

  const anchor = stopAnchor(state, trendSide, state.mark, breakEvent.time);
  const stopRisk = stopAndRisk(
    state,
    trendSide,
    state.mark,
    sweep,
    anchor,
    options,
  );
  if (!stopRisk) return null;

  const { stop, riskAtr } = stopRisk;
  const riskDistance = Math.abs(state.mark - stop);
  const target = targetAndRewardRisk(
    state,
    trendSide,
    state.mark,
    riskDistance,
    breakEvent.time,
    options.minimumRewardRisk,
  );
  if (!target) return null;

  const long = trendSide === 'LONG';
  const id = `struct-liq-${state.symbol}-${breakEvent.time}`;
  const location = long ? state.pricing.discount : state.pricing.premium;
  const confidence = Math.min(0.95, 0.70 + (sweep.time === breakEvent.time ? 0.05 : 0) + (location ? 0.05 : 0));
  const anchorNote = anchor?.source === 'ledger' ? `; ${anchor.lifecycle} zone anchor` : '';

  return {
    id,
    ts: state.generatedAt,
    agent: 'STRUCT-LIQ-η',
    symbol: state.symbol,
    type: long ? 'OPEN_LONG' : 'OPEN_SHORT',
    confidence,
    entry: state.mark,
    stopLoss: stop,
    takeProfit: target.target.price,
    reason:
      `HTF ${trendSide} regime + LTF ${breakEvent.type}; ${sweep.direction} sweep at ${sweep.level.toFixed(4)}; ` +
      `target liquidity ${target.target.price.toFixed(4)}; RR ${target.rewardRisk.toFixed(2)}; stop ${riskAtr.toFixed(2)} ATR${anchorNote}`,
  };
}
