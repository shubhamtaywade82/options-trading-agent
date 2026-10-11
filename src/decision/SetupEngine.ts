import type { MarketState, LiquidityPool, LiquiditySweep, PriceZone, StructureBreak, StructureState, TrendDirection, ZoneRecord } from '../market/types.js';
import type { SetupMap, SetupScenario, SetupDirection, SetupKind, SetupState } from './SetupTypes.js';
import { expectedMove } from './SetupTiming.js';

type ScenarioState = SetupScenario['state'] | 'INVALIDATED';

export type * from './SetupTypes.js';
export { formatDuration } from './SetupTiming.js';

const MAX_SWEEP_AGE_MS = 6 * 15 * 60_000;
const STOP_BUFFER_ATR = 0.15;
const MAX_STOP_ATR = 4;
const MIN_STOP_ATR = 0.5;

export interface SetupEngineOptions {
  /** Gross reward:risk a scenario must offer to exist at all; the quality gate then judges it after costs. */
  minRewardRisk: number;
}
/** Same 1.5R floor as STRUCT-LIQ and CROWDING-ι. The old hard-coded 1.25 let a 0.8-ATR target through as "RR 1.57". */
export const DEFAULT_SETUP_OPTIONS: SetupEngineOptions = { minRewardRisk: 1.5 };
/** TP2 must sit at least this far beyond TP1: equal-high clusters otherwise print a TP2 a few ticks past TP1, which is the same target twice. */
const MIN_TP2_GAP_ATR = 0.5;

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function locationOf(state: MarketState): SetupMap['location'] {
  if (state.pricing.premium) return 'PREMIUM';
  if (state.pricing.discount) return 'DISCOUNT';
  return 'EQUILIBRIUM';
}

function trendOf(state: MarketState): TrendDirection {
  if (state.regime.trendDirection !== 'NEUTRAL') return state.regime.trendDirection;
  return state.htfStructure.trend !== 'NEUTRAL' ? state.htfStructure.trend : state.ltfStructure.trend;
}

function isDirectionalLiquidity(pool: LiquidityPool, direction: SetupDirection): boolean {
  const highSide = pool.type === 'EQUAL_HIGH' || pool.type === 'SWING_HIGH' || pool.type === 'RANGE_HIGH';
  const lowSide = pool.type === 'EQUAL_LOW' || pool.type === 'SWING_LOW' || pool.type === 'RANGE_LOW';
  return direction === 'LONG' ? highSide : lowSide;
}

function directionalPool(state: MarketState, direction: SetupDirection, entry: number): LiquidityPool | null {
  const pools = [...state.liquidity.ltf.pools, ...state.liquidity.htf.pools]
    .filter((pool) => isDirectionalLiquidity(pool, direction))
    .filter((pool) => direction === 'LONG' ? pool.price > entry : pool.price < entry)
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  return pools[0] ?? null;
}

function secondDirectionalPool(state: MarketState, direction: SetupDirection, after: number, minGap = 0): LiquidityPool | null {
  const pools = [...state.liquidity.ltf.pools, ...state.liquidity.htf.pools]
    .filter((pool) => isDirectionalLiquidity(pool, direction))
    .filter((pool) => direction === 'LONG' ? pool.price > after : pool.price < after)
    // "At least minGap beyond": inclusive, with a hair of slack so a gap that is exactly N ATR in decimal survives float noise
    .filter((pool) => Math.abs(pool.price - after) >= minGap * (1 - 1e-9))
    .sort((a, b) => Math.abs(a.price - after) - Math.abs(b.price - after));
  return pools[0] ?? null;
}

function nearestZoneRecord(state: MarketState, direction: SetupDirection, mark: number): ZoneRecord | null {
  const type: PriceZone['type'] = direction === 'LONG' ? 'DEMAND' : 'SUPPLY';
  const zones = (state.zoneLedger ?? [])
    .filter((zone) => zone.type === type && zone.state !== 'EXPIRED' && zone.state !== 'INVALIDATED')
    .filter((zone) => direction === 'LONG' ? zone.low <= mark : zone.high >= mark)
    .sort((a, b) => Math.abs(mark - (a.low + a.high) / 2) - Math.abs(mark - (b.low + b.high) / 2));
  return zones[0] ?? null;
}

/** Causal break history when available, else the single latest-candle break. */
function breakEvents(structure: StructureState): StructureBreak[] {
  if (structure.breaks && structure.breaks.length > 0) return structure.breaks;
  return structure.lastBreak ? [structure.lastBreak] : [];
}

function confirmingBreakAfter(structure: StructureState, since: number, direction: SetupDirection): boolean {
  const wanted: TrendDirection = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
  return breakEvents(structure).some((b) => b.time >= since && b.direction === wanted);
}

function opposingBreakAfter(structure: StructureState, since: number, direction: SetupDirection): boolean {
  const opposing: TrendDirection = direction === 'LONG' ? 'BEARISH' : 'BULLISH';
  return breakEvents(structure).some((b) => b.time >= since && b.direction === opposing);
}

function stopForZone(
  direction: SetupDirection,
  zone: PriceZone,
  atrValue: number,
): number {
  return direction === 'LONG'
    ? zone.low - atrValue * STOP_BUFFER_ATR
    : zone.high + atrValue * STOP_BUFFER_ATR;
}

function riskReward(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  return risk > 0 ? Math.abs(target - entry) / risk : 0;
}

function flowHypothesis(
  state: MarketState,
  direction: SetupDirection,
  trigger: SetupKind,
): string {
  const crowd = state.crowding?.positioningExtreme;
  const oi = state.crowding?.openInterestExpansion;
  const ratio = state.crowding?.takerAggressionRatio;
  if (trigger === 'LIQUIDITY_SWEEP') {
    return direction === 'LONG'
      ? 'sell-side sweep; absorption/reversal hypothesis'
      : 'buy-side sweep; distribution/reversal hypothesis';
  }
  if (oi && finite(ratio)) {
    if (direction === 'LONG' && ratio > 1.1) return 'initiative buy-flow hypothesis with OI expansion';
    if (direction === 'SHORT' && ratio < 0.9) return 'initiative sell-flow hypothesis with OI expansion';
  }
  if (crowd === 'SHORT_CROWDED' && direction === 'LONG') return 'short-crowding; squeeze/continuation hypothesis';
  if (crowd === 'LONG_CROWDED' && direction === 'SHORT') return 'long-crowding; liquidation/continuation hypothesis';
  return 'trend continuation hypothesis; flow not independently confirmed';
}

function stateForBreakout(state: MarketState, pool: LiquidityPool, direction: SetupDirection): ScenarioState {
  if (!pool.taken || pool.sweptAt === null || pool.sweptAt === undefined) return 'FORMING';
  if (confirmingBreakAfter(state.ltfStructure, pool.sweptAt, direction)) return 'TRIGGERED';
  if (opposingBreakAfter(state.ltfStructure, pool.sweptAt, direction)) return 'INVALIDATED';
  return 'ARMED';
}

function stateForZone(state: MarketState, zone: ZoneRecord, direction: SetupDirection): ScenarioState {
  if (zone.state === 'FRESH') return 'FORMING';
  const since = zone.testedAt ?? zone.breakTime;
  if (confirmingBreakAfter(state.ltfStructure, since, direction)) return 'TRIGGERED';
  if (opposingBreakAfter(state.ltfStructure, since, direction)) return 'INVALIDATED';
  return 'ARMED';
}

function stateForSweep(state: MarketState, sweep: LiquiditySweep, direction: SetupDirection): ScenarioState {
  const brokeExtreme = direction === 'LONG' ? state.mark < sweep.sweepPrice : state.mark > sweep.sweepPrice;
  if (brokeExtreme) return 'INVALIDATED';
  const reclaimed = direction === 'LONG' ? state.mark > sweep.level : state.mark < sweep.level;
  if (!reclaimed) return 'FORMING';
  if (confirmingBreakAfter(state.ltfStructure, sweep.time, direction)) return 'TRIGGERED';
  if (opposingBreakAfter(state.ltfStructure, sweep.time, direction)) return 'INVALIDATED';
  return 'ARMED';
}

/** Collects ids of setups whose thesis is structurally dead, so a soft drop (RR dip) is distinguishable from a hard one. */
type DeadIds = string[];

function buildBreakout(
  state: MarketState,
  direction: SetupDirection,
  atrValue: number,
  dead: DeadIds,
  minRr: number,
): SetupScenario | null {
  const pool = directionalPool(state, direction, state.mark);
  if (!pool) return null;

  const level = pool.price;
  const next = secondDirectionalPool(state, direction, level);
  if (!next) return null;

  const id = 'breakout-' + state.symbol + '-' + direction + '-' + Math.round(level * 100);
  const scenarioState = stateForBreakout(state, pool, direction);
  if (scenarioState === 'INVALIDATED') { dead.push(id); return null; }

  const pad = atrValue * 0.20;
  const entryLow = direction === 'LONG' ? level : level - pad;
  const entryHigh = direction === 'LONG' ? level + pad : level;
  const entry = direction === 'LONG' ? entryHigh : entryLow;
  const stop = direction === 'LONG' ? level - atrValue * 0.35 : level + atrValue * 0.35;
  const target1 = next.price;
  const rr = riskReward(entry, stop, target1);
  const move = expectedMove(Math.abs(target1 - entry), atrValue, '15m', state.regime.volatility);
  if (!move || rr < minRr || Math.abs(entry - stop) / atrValue > MAX_STOP_ATR) return null;

  return {
    id,
    kind: 'BREAKOUT_RETEST',
    direction,
    state: scenarioState,
    timeframe: '15m',
    entryLow,
    entryHigh,
    stopLoss: stop,
    target1,
    target2: undefined,
    trigger: (direction === 'LONG' ? '15m close above ' : '15m close below ') + level.toFixed(4) + ' + retest hold',
    invalidation: direction === 'LONG' ? 'acceptance back below breakout level' : 'acceptance back above breakout level',
    flowHypothesis: flowHypothesis(state, direction, 'BREAKOUT_RETEST'),
    expectedMove: move,
    sourceTime: state.generatedAt,
    rewardRisk: rr,
  };
}

function buildPullback(
  state: MarketState,
  direction: SetupDirection,
  atrValue: number,
  dead: DeadIds,
  minRr: number,
): SetupScenario | null {
  const zone = nearestZoneRecord(state, direction, state.mark);
  if (!zone) return null;
  const id = 'pullback-' + state.symbol + '-' + direction + '-' + zone.breakTime;
  const scenarioState = stateForZone(state, zone, direction);
  if (scenarioState === 'INVALIDATED') { dead.push(id); return null; }

  const entry = direction === 'LONG' ? Math.min(state.mark, zone.high) : Math.max(state.mark, zone.low);
  const stop = stopForZone(direction, zone, atrValue);
  const target = directionalPool(state, direction, Math.max(entry, state.mark));
  if (!target) return null;
  const second = secondDirectionalPool(state, direction, target.price, atrValue * MIN_TP2_GAP_ATR);
  const riskAtr = Math.abs(entry - stop) / atrValue;
  const rr = riskReward(entry, stop, target.price);
  const move = expectedMove(Math.abs(target.price - entry), atrValue, '15m', state.regime.volatility);
  if (!move || riskAtr < MIN_STOP_ATR || riskAtr > MAX_STOP_ATR || rr < minRr) return null;

  return {
    id,
    kind: 'PULLBACK_RETEST',
    direction,
    state: scenarioState,
    timeframe: '15m',
    entryLow: zone.low,
    entryHigh: zone.high,
    stopLoss: stop,
    target1: target.price,
    target2: second?.price,
    trigger: direction === 'LONG'
      ? '15m rejection of demand + bullish BOS/CHOCH'
      : '15m rejection of supply + bearish BOS/CHOCH',
    invalidation: direction === 'LONG' ? '15m acceptance below demand' : '15m acceptance above supply',
    flowHypothesis: flowHypothesis(state, direction, 'PULLBACK_RETEST'),
    expectedMove: move,
    sourceTime: zone.breakTime,
    rewardRisk: rr,
  };
}

function latestSweep(state: MarketState, direction: SetupDirection): LiquiditySweep | null {
  const wanted: LiquiditySweep['direction'] = direction === 'LONG' ? 'SELL_SIDE' : 'BUY_SIDE';
  const source = state.liquidity.ltf.sweepHistory ?? state.liquidity.ltf.recentSweeps;
  return [...source]
    .filter((sweep) => sweep.confirmed && sweep.direction === wanted)
    .sort((a, b) => b.time - a.time)[0] ?? null;
}

function buildSweep(
  state: MarketState,
  direction: SetupDirection,
  atrValue: number,
  dead: DeadIds,
  minRr: number,
): SetupScenario | null {
  const sweep = latestSweep(state, direction);
  if (!sweep || state.generatedAt - sweep.time > MAX_SWEEP_AGE_MS) return null;
  const id = 'sweep-' + state.symbol + '-' + direction + '-' + sweep.time;
  const scenarioState = stateForSweep(state, sweep, direction);
  if (scenarioState === 'INVALIDATED') { dead.push(id); return null; }
  const target = directionalPool(state, direction, state.mark);
  if (!target || Math.abs(target.price - sweep.level) <= atrValue * 0.5) return null;

  const entry = sweep.level;
  const stop = direction === 'LONG'
    ? sweep.sweepPrice - atrValue * STOP_BUFFER_ATR
    : sweep.sweepPrice + atrValue * STOP_BUFFER_ATR;
  const rr = riskReward(entry, stop, target.price);
  const move = expectedMove(Math.abs(target.price - entry), atrValue, '15m', state.regime.volatility);
  const riskAtr = Math.abs(entry - stop) / atrValue;
  if (!move || riskAtr < MIN_STOP_ATR || riskAtr > MAX_STOP_ATR || rr < minRr) return null;

  return {
    id,
    kind: 'LIQUIDITY_SWEEP',
    direction,
    state: scenarioState,
    timeframe: '15m',
    entryLow: direction === 'LONG' ? entry : entry - atrValue * 0.1,
    entryHigh: direction === 'LONG' ? entry + atrValue * 0.1 : entry,
    stopLoss: stop,
    target1: target.price,
    target2: secondDirectionalPool(state, direction, target.price, atrValue * MIN_TP2_GAP_ATR)?.price,
    trigger: direction === 'LONG'
      ? 'sell-side sweep + reclaim of sweep level + bullish displacement'
      : 'buy-side sweep + reclaim of sweep level + bearish displacement',
    invalidation: direction === 'LONG' ? 'loss of swept low' : 'loss of swept high',
    flowHypothesis: flowHypothesis(state, direction, 'LIQUIDITY_SWEEP'),
    expectedMove: move,
    sourceTime: sweep.time,
    rewardRisk: rr,
  };
}

export function buildSetupMap(state: MarketState, options: SetupEngineOptions = DEFAULT_SETUP_OPTIONS): SetupMap {
  const bias = trendOf(state);
  const direction: SetupDirection | null = bias === 'BULLISH' ? 'LONG' : bias === 'BEARISH' ? 'SHORT' : null;
  const atr15 = state.timeframes['15m'].atr14 ?? 0;
  const scenarios: SetupScenario[] = [];
  const invalidatedIds: string[] = [];

  if (direction && atr15 > 0) {
    for (const builder of [buildSweep, buildPullback, buildBreakout]) {
      const setup = builder(state, direction, atr15, invalidatedIds, options.minRewardRisk);
      if (setup) scenarios.push(setup);
    }
  }

  const STATE_RANK: Record<SetupScenario['state'], number> = { TRIGGERED: 2, ARMED: 1, FORMING: 0 };
  scenarios.sort((a, b) =>
    STATE_RANK[b.state] - STATE_RANK[a.state]
    || (b.rewardRisk - a.rewardRisk)
  );
  const mapState: SetupState = scenarios.length === 0
    ? 'NO_TRADE'
    : scenarios.some((s) => s.state === 'TRIGGERED')
      ? 'TRIGGERED'
      : scenarios.some((s) => s.state === 'ARMED')
        ? 'ARMED'
        : 'FORMING';
  const noTradeReasons: string[] = [];
  if (!direction) noTradeReasons.push('directional structure is unresolved');
  if (direction && scenarios.length === 0) noTradeReasons.push('no admissible structure/liquidity setup with a valid target');
  if (state.pricing.premium && direction === 'LONG') noTradeReasons.push('long setup is in premium; require stronger confirmation');
  if (state.pricing.discount && direction === 'SHORT') noTradeReasons.push('short setup is in discount; require stronger confirmation');

  return {
    symbol: state.symbol,
    generatedAt: state.generatedAt,
    mark: state.mark,
    state: mapState,
    bias,
    regime: state.regime.regime,
    volatility: state.regime.volatility,
    positionPct: state.pricing.positionPct,
    location: locationOf(state),
    htfTrend: state.htfStructure.trend,
    ltfTrend: state.ltfStructure.trend,
    lastBreak: state.ltfStructure.lastBreak
      ? {
        type: state.ltfStructure.lastBreak.type,
        direction: state.ltfStructure.lastBreak.direction,
        level: state.ltfStructure.lastBreak.level,
        time: state.ltfStructure.lastBreak.time,
        distanceAtr: state.ltfStructure.lastBreak.distanceAtr,
      }
      : null,
    nearestUpperLiquidity: directionalPool(state, 'LONG', state.mark)?.price ?? null,
    nearestLowerLiquidity: directionalPool(state, 'SHORT', state.mark)?.price ?? null,
    crowding: state.crowding?.positioningExtreme ?? null,
    openInterestExpansion: state.crowding?.openInterestExpansion ?? null,
    takerAggressionRatio: state.crowding?.takerAggressionRatio ?? null,
    scenarios,
    invalidatedIds,
    noTradeReasons: noTradeReasons.slice(0, 3),
  };
}
