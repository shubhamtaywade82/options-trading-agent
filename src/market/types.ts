import type { Candle } from '../types.js';
import type { DerivativesSnapshot, NativeTimeframe } from './MarketDataTypes.js';

export type Timeframe = '15m' | '1h' | '4h';
export type MarketRegime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'HIGH_VOL' | 'LOW_VOL' | 'TRANSITION';
export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type VolatilityRegime = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TimeframeState {
  timeframe: Timeframe;
  candleCount: number;
  lastClose: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  emaSlopePct: number | null;
  adx14: number | null;
  atr14: number | null;
  atrPercentile: number | null;
  rsi14: number | null;
  vwap: number | null;
  bollingerMiddle: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
  /** Volume of the latest candle vs the previous 20 (z-score); null when history is too short or flat. */
  volumeZ?: number | null;
}

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

/**
 * Invalidation region attached to a structure break: the span between the broken
 * level and the protected swing. A close beyond the protected swing invalidates
 * the structure thesis that produced the break.
 */
export interface ProtectionZone {
  low: number;
  high: number;
  /** The structure level whose break created this zone. */
  originLevel: number;
  /** The protected swing price; a close beyond it invalidates the break. */
  protectedLevel: number;
  tested: boolean;
  testedAt: number | null;
  violated: boolean;
  violatedAt: number | null;
  violatedIndex: number | null;
}

export interface StructureBreak {
  type: 'BOS' | 'CHOCH';
  direction: 'BULLISH' | 'BEARISH';
  level: number;
  index: number;
  time: number;
  distanceAtr: number;
  /** Protected swing price as of the break candle (bullish: last swing low, bearish: last swing high). */
  protectedLevel?: number;
  /** Invalidation zone between the broken level and the protected swing, with post-break tracking. */
  protectionZone?: ProtectionZone | null;
}

export interface StructureState {
  timeframe: Timeframe;
  trend: TrendDirection;
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  lastBreak: StructureBreak | null;
  protectedHigh: SwingPoint | null;
  protectedLow: SwingPoint | null;
  /**
   * Full causal BOS/CHOCH event history over the analysed window (oldest first,
   * capped). Core fields are append-stable: appending candles never rewrites a
   * past event. `protectionZone` lifecycle flags only ever accumulate.
   */
  breaks?: StructureBreak[];
}

export interface LiquidityPool {
  type: 'EQUAL_HIGH' | 'EQUAL_LOW' | 'SWING_HIGH' | 'SWING_LOW' | 'RANGE_HIGH' | 'RANGE_LOW';
  price: number;
  tolerance: number;
  strength: number;
  timeframe: Timeframe;
  sourceTimes: number[];
  /** True once the replayed sweep ledger saw this exact pool swept. */
  taken?: boolean;
  /** openTime of the candle that swept the pool, when known. */
  sweptAt?: number | null;
}

export interface LiquiditySweep {
  poolType: LiquidityPool['type'];
  direction: 'BUY_SIDE' | 'SELL_SIDE';
  level: number;
  sweepPrice: number;
  close: number;
  index: number;
  time: number;
  confirmed: boolean;
  /** Stable identity `time|direction|level|poolType` — present on sweep-history events. */
  id?: string;
  /** sourceTimes of the swept pool at sweep time — every entry predates the sweep candle. */
  poolSourceTimes?: number[];
}

export interface LiquidityState {
  timeframe: Timeframe;
  pools: LiquidityPool[];
  /** Sweeps confirmed on the latest closed candle. */
  latestSweeps: LiquiditySweep[];
  /** Recent confirmed sweeps, ordered chronologically, for sequence-based strategies. */
  recentSweeps: LiquiditySweep[];
  /**
   * Persistent sweep history replayed causally over the analysed window: pools
   * form when their swings confirm, persist until swept, and every sweep is an
   * immutable event (never rewritten when candles are appended).
   */
  sweepHistory?: LiquiditySweep[];
}

export interface PriceZone {
  type: 'SUPPLY' | 'DEMAND';
  timeframe: Timeframe;
  high: number;
  low: number;
  originTime: number;
  causedBreak: 'BOS' | 'CHOCH' | null;
  displacementAtr: number;
  touches: number;
  fresh: boolean;
  strength: number;
}

export type ZoneLifecycleState =
  | 'FRESH'
  | 'TESTED'
  | 'MITIGATED'
  | 'INVALIDATED'
  | 'EXPIRED';

/**
 * A cause zone tracked through its lifecycle. Transitions are monotonic and
 * append-stable: FRESH -> TESTED (first retest) -> MITIGATED (close past the
 * midpoint after entering), with INVALIDATED (close through the far boundary)
 * and EXPIRED (untouched past the age budget) as terminal states.
 */
export interface ZoneRecord extends PriceZone {
  state: ZoneLifecycleState;
  /** openTime of the candle that first retested the zone. */
  testedAt: number | null;
  /** openTime of the first candle that closed past the zone midpoint. */
  mitigatedAt: number | null;
  /** openTime of the candle whose close pierced the far boundary. */
  invalidatedAt: number | null;
  invalidatedIndex: number | null;
  /** openTime of the candle on which the untouched zone aged out. */
  expiredAt: number | null;
  /** Candle index of the originating break. */
  breakIndex: number;
  /** openTime of the originating break candle; unique per timeframe. */
  breakTime: number;
  /** Bars elapsed between the break and the end of the analysed window. */
  ageBars: number;
}

export interface RangePricing {
  high: number;
  low: number;
  equilibrium: number;
  positionPct: number;
  premium: boolean;
  discount: boolean;
}

export interface MeanReversionState {
  mean: number | null;
  vwap: number | null;
  zscore: number | null;
  rsi14: number | null;
  bollingerMiddle: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
  deviationPct: number | null;
}

export interface RegimeSnapshot {
  regime: MarketRegime;
  trendDirection: TrendDirection;
  trendStrength: number;
  volatility: VolatilityRegime;
  volatilityPercentile: number | null;
  adx14: number | null;
  emaSlopePct: number | null;
  /**
   * Set by the scored regime tracker only. `regime` is then the HELD label (hysteresis + dwell), `rawRegime` what the
   * indicators say right now, `pendingRegime` the challenger waiting out its dwell time.
   */
  rawRegime?: MarketRegime;
  pendingRegime?: MarketRegime | null;
  /** Closed 15m bars the held regime has lasted. */
  barsInRegime?: number;
  /** 0..1: for a trend, its score; otherwise how far from trending the market is (1 - strongest trend score). */
  confidence?: number;
  /** Signed trend score in -1..1 (positive = up). */
  trendScore?: number;
}

export interface MarketState {
  version: 1;
  symbol: string;
  generatedAt: number;
  mark: number;
  fundingRate: number;

  regime: RegimeSnapshot;
  timeframes: Record<Timeframe, TimeframeState>;

  htfStructure: StructureState;
  ltfStructure: StructureState;

  liquidity: {
    htf: LiquidityState;
    ltf: LiquidityState;
  };

  zones: PriceZone[];
  /**
   * Cause zones from every break event in the window, tracked through their
   * lifecycle (FRESH/TESTED/MITIGATED/INVALIDATED/EXPIRED). Keyed per record by
   * `timeframe|breakTime`. Supersedes nothing — `zones` keeps its legacy shape.
   */
  zoneLedger?: ZoneRecord[];
  pricing: RangePricing;
  meanReversion: MeanReversionState;
  derivatives?: DerivativesSnapshot | null;
  crowding?: CrowdingSnapshot | null;
}

export interface CrowdingSnapshot {
  fundingPercentile: number | null;
  topTraderVsGlobalBias: number | null;
  positioningExtreme: 'LONG_CROWDED' | 'SHORT_CROWDED' | 'BALANCED';
  takerAggressionRatio: number | null;
  openInterestExpansion: boolean;
}

export interface MarketStateInput {
  symbol: string;
  candles: Candle[];
  candlesByTimeframe?: Partial<Record<NativeTimeframe, Candle[]>>;
  mark: number;
  fundingRate: number;
  derivatives?: DerivativesSnapshot | null;
}
