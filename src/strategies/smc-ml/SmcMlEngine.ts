import type { Candle } from '../../types.js';
import {
  BayesianLogisticCalibration,
  CausalBayesianCalibration,
  atrSeries,
  changeStdAt,
  clampProbability,
  touchProbability,
  twoProportionZ,
} from './math.js';
import {
  DEFAULT_SMC_CONFIG,
  type FairValueGap,
  type LiquidityPool,
  type OrderBlock,
  type SMCConfig,
  type SMCFrame,
  type SMCFrameAnalysis,
  type SwingPoint,
  type StructureBreak,
  type EdgeTestSummary,
} from './types.js';

interface RawBreak {
  direction: 1 | -1;
  type: 'BOS' | 'CHOCH';
  index: number;
  time: number;
  level: number;
  breakClose: number;
  protectedSwing: number;
  protectedSwingIndex: number;
  riskUnit: number;
  p0: number | null;
  sweptLiquidityFirst: boolean;
  leftFvg: boolean;
  upperAtPrint: number | null;
  lowerAtPrint: number | null;
}

interface Tracker {
  hi: number | null;
  hiIndex: number;
  hiOpen: boolean;
  lo: number | null;
  loIndex: number;
  loOpen: boolean;
  prevHi: number | null;
  prevHiIndex: number;
  prevLo: number | null;
  prevLoIndex: number;
  legLo: number | null;
  legLoIndex: number;
  legHi: number | null;
  legHiIndex: number;
  trend: 0 | 1 | -1;
}

const FRAME_ORDER: SMCFrame[] = ['5m', '15m', '1h', '4h', '1d'];

function pivotHigh(candles: Candle[], index: number, length: number): boolean {
  const p = candles[index]?.high;
  if (p === undefined || index < length || index + length >= candles.length) return false;
  for (let k = 1; k <= length; k++) {
    if (p <= candles[index - k].high || p <= candles[index + k].high) return false;
  }
  return true;
}

function pivotLow(candles: Candle[], index: number, length: number): boolean {
  const p = candles[index]?.low;
  if (p === undefined || index < length || index + length >= candles.length) return false;
  for (let k = 1; k <= length; k++) {
    if (p >= candles[index - k].low || p >= candles[index + k].low) return false;
  }
  return true;
}

function latestFvgIndex(
  fvgs: FairValueGap[],
  direction: 1 | -1,
  fromIndex: number,
  untilIndex: number,
): number | null {
  let latest: number | null = null;
  for (const fvg of fvgs) {
    if (fvg.direction !== direction || fvg.index < fromIndex || fvg.index > untilIndex) continue;
    if (latest === null || fvg.index > latest) latest = fvg.index;
  }
  return latest;
}

function detectFvgs(candles: Candle[], atr: (number | null)[], minAtr: number): FairValueGap[] {
  const out: FairValueGap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const a = atr[i];
    if (a === null || a <= 0) continue;
    const bullGap = candles[i].low > candles[i - 2].high &&
      candles[i - 1].close > candles[i - 2].high &&
      candles[i].low - candles[i - 2].high >= minAtr * a;
    const bearGap = candles[i].high < candles[i - 2].low &&
      candles[i - 1].close < candles[i - 2].low &&
      candles[i - 2].low - candles[i].high >= minAtr * a;

    if (bullGap) out.push({
      direction: 1,
      top: candles[i].low,
      bottom: candles[i - 2].high,
      index: i,
    });
    if (bearGap) out.push({
      direction: -1,
      top: candles[i - 2].low,
      bottom: candles[i].high,
      index: i,
    });
  }
  return out;
}

function cleanEqualPair(
  candles: Candle[],
  side: 1 | -1,
  level: number,
  fromIndex: number,
  tolerance: number,
): boolean {
  for (let i = fromIndex + 1; i < candles.length; i++) {
    if (side === 1 && candles[i].high > level + tolerance) return false;
    if (side === -1 && candles[i].low < level - tolerance) return false;
  }
  return true;
}

function buildLiquidityPools(
  candles: Candle[],
  swings: SwingPoint[],
  internalLength: number,
  toleranceAtr: number,
  atr: number | null,
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  const tol = (atr ?? 0) * toleranceAtr;

  for (const swing of swings) {
    const taken = swing.type === 'HIGH'
      ? candles.slice(swing.index + 1).some((c) => c.high > swing.price)
      : candles.slice(swing.index + 1).some((c) => c.low < swing.price);

    pools.push({
      direction: swing.type === 'HIGH' ? 1 : -1,
      price: swing.price,
      kind: 'SWING',
      firstIndex: swing.index,
      taken,
    });
  }

  const internalHighs: SwingPoint[] = [];
  const internalLows: SwingPoint[] = [];
  for (let i = internalLength; i < candles.length - internalLength; i++) {
    if (pivotHigh(candles, i, internalLength)) {
      internalHighs.push({ index: i, time: candles[i].openTime, price: candles[i].high, type: 'HIGH' });
    }
    if (pivotLow(candles, i, internalLength)) {
      internalLows.push({ index: i, time: candles[i].openTime, price: candles[i].low, type: 'LOW' });
    }
  }

  const addEqual = (points: SwingPoint[], side: 1 | -1) => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (tol <= 0 || Math.abs(a.price - b.price) > tol) continue;
      const level = side === 1 ? Math.max(a.price, b.price) : Math.min(a.price, b.price);
      const clean = cleanEqualPair(candles, side, level, b.index, tol);
      if (!clean) continue;
      pools.push({
        direction: side,
        price: level,
        kind: 'EQUAL',
        firstIndex: a.index,
        secondIndex: b.index,
        taken: false,
      });
    }
  };

  addEqual(internalHighs, 1);
  addEqual(internalLows, -1);
  return pools;
}

function nearestPools(
  pools: LiquidityPool[],
  price: number,
): { upper: LiquidityPool | null; lower: LiquidityPool | null } {
  const live = pools.filter((p) => !p.taken);
  const uppers = live.filter((p) => p.direction === 1 && p.price > price);
  const lowers = live.filter((p) => p.direction === -1 && p.price < price);
  const upper = uppers.sort((a, b) => a.price - b.price)[0] ?? null;
  const lower = lowers.sort((a, b) => b.price - a.price)[0] ?? null;
  return { upper, lower };
}

function liveLiquidityOdds(
  upper: LiquidityPool | null,
  lower: LiquidityPool | null,
  price: number,
  calibration: Pick<BayesianLogisticCalibration, 'predict'>,
): { upper: number | null; lower: number | null; formulaUpper: number | null; formulaLower: number | null } {
  if (!upper || !lower || upper.price <= price || lower.price >= price) {
    return { upper: null, lower: null, formulaUpper: null, formulaLower: null };
  }

  const du = upper.price - price;
  const dl = price - lower.price;
  const nearerUpper = du <= dl;
  const nearerFormula = clampProbability((nearerUpper ? dl : du) / (du + dl));
  const model = calibration.predict(nearerFormula) ?? nearerFormula;
  return {
    upper: nearerUpper ? model : 1 - model,
    lower: nearerUpper ? 1 - model : model,
    formulaUpper: nearerUpper ? nearerFormula : 1 - nearerFormula,
    formulaLower: nearerUpper ? 1 - nearerFormula : nearerFormula,
  };
}

function rangePosition(price: number, hi: number | null, lo: number | null): number | null {
  if (hi === null || lo === null || hi <= lo) return null;
  return (price - lo) / (hi - lo);
}

function resolveRetest(
  candles: Candle[],
  b: RawBreak,
  window: number,
): { outcome: boolean | null; entryClose: number | null; resolvedIndex: number | null } {
  for (let i = b.index + 1; i < Math.min(candles.length, b.index + window + 1); i++) {
    const c = candles[i];
    const touch = b.direction === 1 ? c.low <= b.level : c.high >= b.level;
    if (!touch) continue;
    const reclaim = b.direction === 1 ? c.close > b.level : c.close < b.level;
    return { outcome: true, entryClose: reclaim ? c.close : null, resolvedIndex: i };
  }
  if (b.index + window < candles.length) {
    return { outcome: false, entryClose: null, resolvedIndex: b.index + window };
  }
  return { outcome: null, entryClose: null, resolvedIndex: null };
}

function resolveFollowThrough(candles: Candle[], b: RawBreak, window: number): boolean | null {
  for (let i = b.index + 1; i < Math.min(candles.length, b.index + window + 1); i++) {
    const c = candles[i];
    const fail = b.direction === 1 ? c.close < b.protectedSwing : c.close > b.protectedSwing;
    const win = b.direction === 1
      ? c.close >= b.breakClose + b.riskUnit
      : c.close <= b.breakClose - b.riskUnit;
    if (fail || win) return win && !fail;
  }
  return null;
}

function resolveLiquidity(
  candles: Candle[],
  b: RawBreak,
  window: number,
): { outcome: 0 | 1 | null; nearerUpper: boolean; resolvedIndex: number | null } {
  if (b.upperAtPrint === null || b.lowerAtPrint === null) {
    return { outcome: null, nearerUpper: true, resolvedIndex: null };
  }
  const du = b.upperAtPrint - b.breakClose;
  const dl = b.breakClose - b.lowerAtPrint;
  if (du <= 0 || dl <= 0) return { outcome: null, nearerUpper: true, resolvedIndex: null };
  const nearerUpper = du <= dl;

  for (let i = b.index + 1; i < Math.min(candles.length, b.index + window + 1); i++) {
    const hu = candles[i].high > b.upperAtPrint;
    const hl = candles[i].low < b.lowerAtPrint;
    if (hu || hl) {
      if (hu === hl) return { outcome: null, nearerUpper, resolvedIndex: i };
      return { outcome: hu === nearerUpper ? 1 : 0, nearerUpper, resolvedIndex: i };
    }
  }
  return { outcome: null, nearerUpper, resolvedIndex: null };
}

function orderBlockForBreak(
  candles: Candle[],
  b: StructureBreak,
  maxHeightAtr: number,
  atr: number | null,
): OrderBlock | null {
  const from = Math.max(0, b.protectedSwingIndex - 3);
  for (let i = b.protectedSwingIndex; i >= from; i--) {
    const c = candles[i];
    const opposite = b.direction === 1 ? c.close < c.open : c.close > c.open;
    if (!opposite) continue;
    if (atr === null || c.high - c.low <= maxHeightAtr * atr) {
      return {
        direction: b.direction,
        top: c.high,
        bottom: c.low,
        index: i,
      };
    }
  }
  return null;
}

function edgeSummary(breaks: StructureBreak[]): EdgeTestSummary {
  const groups = [
    ['BOS', 'CHOCH', (b: StructureBreak) => b.type === 'BOS'],
    ['FVG', 'no FVG', (b: StructureBreak) => b.leftFvg],
    ['sweep', 'no sweep', (b: StructureBreak) => b.sweptLiquidityFirst],
  ] as const;

  const splits = groups.map(([a, b, predicate]) => {
    const groupA = breaks.filter((x) => x.followThroughOutcome !== null && predicate(x));
    const groupB = breaks.filter((x) => x.followThroughOutcome !== null && !predicate(x));
    const hitA = groupA.filter((x) => x.followThroughOutcome).length;
    const hitB = groupB.filter((x) => x.followThroughOutcome).length;
    return {
      groupA: a,
      groupB: b,
      nA: groupA.length,
      hitA,
      nB: groupB.length,
      hitB,
      z: twoProportionZ(groupA.length, hitA, groupB.length, hitB),
    };
  });

  const resolved = breaks.filter((b) => b.followThroughOutcome !== null);
  return {
    totalResolved: resolved.length,
    overallRate: resolved.length
      ? resolved.filter((b) => b.followThroughOutcome).length / resolved.length
      : null,
    splits,
  };
}

export function analyzeSmcFrame(
  timeframe: SMCFrame,
  inputCandles: Candle[],
  overrides: Partial<SMCConfig> = {},
): SMCFrameAnalysis {
  const cfg = { ...DEFAULT_SMC_CONFIG, ...overrides };
  const candles = [...inputCandles].sort((a, b) => a.openTime - b.openTime);
  if (candles.length === 0) {
    throw new Error(`SMC ${timeframe}: no closed candles`);
  }

  const atr = atrSeries(candles);
  const closes = candles.map((x) => x.close);
  const fvgs = detectFvgs(candles, atr, 0.3);
  const swings: SwingPoint[] = [];
  const swingHighs: SwingPoint[] = [];
  const swingLows: SwingPoint[] = [];
  const tracker: Tracker = {
    hi: null, hiIndex: -1, hiOpen: false,
    lo: null, loIndex: -1, loOpen: false,
    prevHi: null, prevHiIndex: -1, prevLo: null, prevLoIndex: -1,
    legLo: null, legLoIndex: -1, legHi: null, legHiIndex: -1,
    trend: 0,
  };
  const rawBreaks: RawBreak[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (tracker.legLo !== null && c.low < tracker.legLo) {
      tracker.legLo = c.low;
      tracker.legLoIndex = i;
    }
    if (tracker.legHi !== null && c.high > tracker.legHi) {
      tracker.legHi = c.high;
      tracker.legHiIndex = i;
    }

    if (tracker.hiOpen && tracker.hi !== null && c.close > tracker.hi) {
      const protectedSwing = tracker.legLo ?? c.low;
      const protectedIndex = tracker.legLoIndex >= 0 ? tracker.legLoIndex : i;
      const level = tracker.hi;
      const riskUnit = Math.abs(c.close - protectedSwing);
      const sd = changeStdAt(closes, i, 100);
      const fvgIdx = latestFvgIndex(fvgs, 1, protectedIndex, i);
      const referenceLow =
        tracker.loIndex >= 0 && tracker.loIndex < protectedIndex ? tracker.lo :
        tracker.prevLoIndex >= 0 && tracker.prevLoIndex < protectedIndex ? tracker.prevLo : null;
      rawBreaks.push({
        direction: 1,
        type: tracker.trend === -1 ? 'CHOCH' : 'BOS',
        index: i,
        time: c.openTime,
        level,
        breakClose: c.close,
        protectedSwing,
        protectedSwingIndex: protectedIndex,
        riskUnit,
        p0: touchProbability(Math.abs(c.close - level), sd, cfg.retestWindow),
        sweptLiquidityFirst: referenceLow !== null && protectedSwing < referenceLow,
        leftFvg: fvgIdx !== null,
        upperAtPrint: tracker.hi,
        lowerAtPrint: tracker.lo,
      });
      tracker.trend = 1;
      tracker.hiOpen = false;
    } else if (tracker.loOpen && tracker.lo !== null && c.close < tracker.lo) {
      const protectedSwing = tracker.legHi ?? c.high;
      const protectedIndex = tracker.legHiIndex >= 0 ? tracker.legHiIndex : i;
      const level = tracker.lo;
      const riskUnit = Math.abs(c.close - protectedSwing);
      const sd = changeStdAt(closes, i, 100);
      const fvgIdx = latestFvgIndex(fvgs, -1, protectedIndex, i);
      const referenceHigh =
        tracker.hiIndex >= 0 && tracker.hiIndex < protectedIndex ? tracker.hi :
        tracker.prevHiIndex >= 0 && tracker.prevHiIndex < protectedIndex ? tracker.prevHi : null;
      rawBreaks.push({
        direction: -1,
        type: tracker.trend === 1 ? 'CHOCH' : 'BOS',
        index: i,
        time: c.openTime,
        level,
        breakClose: c.close,
        protectedSwing,
        protectedSwingIndex: protectedIndex,
        riskUnit,
        p0: touchProbability(Math.abs(c.close - level), sd, cfg.retestWindow),
        sweptLiquidityFirst: referenceHigh !== null && protectedSwing > referenceHigh,
        leftFvg: fvgIdx !== null,
        upperAtPrint: tracker.hi,
        lowerAtPrint: tracker.lo,
      });
      tracker.trend = -1;
      tracker.loOpen = false;
    }

    if (i >= cfg.swingLength * 2) {
      const pivotIndex = i - cfg.swingLength;
      if (pivotHigh(candles, pivotIndex, cfg.swingLength)) {
        tracker.prevHi = tracker.hi;
        tracker.prevHiIndex = tracker.hiIndex;
        tracker.hi = candles[pivotIndex].high;
        tracker.hiIndex = pivotIndex;
        tracker.hiOpen = true;

        let minLow = Number.POSITIVE_INFINITY;
        let minIndex = i;
        for (let j = pivotIndex + 1; j <= i; j++) {
          if (candles[j].low < minLow) {
            minLow = candles[j].low;
            minIndex = j;
          }
        }
        tracker.legLo = minLow;
        tracker.legLoIndex = minIndex;

        const point: SwingPoint = {
          index: pivotIndex,
          time: candles[pivotIndex].openTime,
          price: candles[pivotIndex].high,
          type: 'HIGH',
        };
        swings.push(point);
        swingHighs.push(point);
      }

      if (pivotLow(candles, pivotIndex, cfg.swingLength)) {
        tracker.prevLo = tracker.lo;
        tracker.prevLoIndex = tracker.loIndex;
        tracker.lo = candles[pivotIndex].low;
        tracker.loIndex = pivotIndex;
        tracker.loOpen = true;

        let maxHigh = Number.NEGATIVE_INFINITY;
        let maxIndex = i;
        for (let j = pivotIndex + 1; j <= i; j++) {
          if (candles[j].high > maxHigh) {
            maxHigh = candles[j].high;
            maxIndex = j;
          }
        }
        tracker.legHi = maxHigh;
        tracker.legHiIndex = maxIndex;

        const point: SwingPoint = {
          index: pivotIndex,
          time: candles[pivotIndex].openTime,
          price: candles[pivotIndex].low,
          type: 'LOW',
        };
        swings.push(point);
        swingLows.push(point);
      }
    }
  }

  const retestCal = new CausalBayesianCalibration(new BayesianLogisticCalibration());
  const liquidityCal = new CausalBayesianCalibration(new BayesianLogisticCalibration(50, 500, true));
  const breaks: StructureBreak[] = [];

  for (const raw of rawBreaks) {
    const retest = resolveRetest(candles, raw, cfg.retestWindow);
    const retestP = retestCal.observe(
      raw.index,
      raw.p0,
      retest.resolvedIndex,
      retest.outcome === null ? null : retest.outcome ? 1 : 0,
    );

    const followThroughOutcome = resolveFollowThrough(candles, raw, cfg.followThroughWindow);
    const liquidity = resolveLiquidity(candles, raw, cfg.liquidityWindow);
    if (
      raw.upperAtPrint !== null &&
      raw.lowerAtPrint !== null &&
      raw.upperAtPrint > raw.breakClose &&
      raw.lowerAtPrint < raw.breakClose
    ) {
      const du = raw.upperAtPrint - raw.breakClose;
      const dl = raw.breakClose - raw.lowerAtPrint;
      const nearerUpper = du <= dl;
      const q0 = clampProbability((nearerUpper ? dl : du) / (du + dl));
      liquidityCal.observe(raw.index, q0, liquidity.resolvedIndex, liquidity.outcome);
    }

    breaks.push({
      ...raw,
      retestFormulaProbability: raw.p0,
      retestProbability: retestP,
      retestEntryPrice: retest.entryClose,
      retestOutcome: retest.outcome,
      followThroughOutcome,
      nearestUpperPoolAtPrint: raw.upperAtPrint,
      nearestLowerPoolAtPrint: raw.lowerAtPrint,
    });
  }

  retestCal.finalize();
  liquidityCal.finalize();

  const latest = breaks.at(-1) ?? null;
  const lastPrice = candles.at(-1)!.close;
  const hi = tracker.legHi !== null && (tracker.hi === null || tracker.legHi >= tracker.hi)
    ? tracker.legHi
    : tracker.hi;
  const lo = tracker.legLo !== null && (tracker.lo === null || tracker.legLo <= tracker.lo)
    ? tracker.legLo
    : tracker.lo;

  const pools = buildLiquidityPools(
    candles,
    [...swingHighs, ...swingLows],
    cfg.internalLength,
    0.15,
    atr.at(-1) ?? null,
  );
  const { upper, lower } = nearestPools(pools, lastPrice);
  const liquidityOdds = liveLiquidityOdds(upper, lower, lastPrice, liquidityCal);

  const orderBlocks = breaks
    .map((b) => orderBlockForBreak(candles, b, 3, atr[b.index]))
    .filter((x): x is OrderBlock => x !== null)
    .slice(-8);

  const activeFvgs = fvgs.filter((f) => {
    for (let i = f.index + 1; i < candles.length; i++) {
      if (f.direction === 1 && candles[i].low <= f.bottom) return false;
      if (f.direction === -1 && candles[i].high >= f.top) return false;
    }
    return true;
  }).slice(-8);

  return {
    timeframe,
    candleCount: candles.length,
    lastClosedTime: candles.at(-1)!.openTime,
    lastPrice,
    atr14: atr.at(-1) ?? null,
    volatilityStd: changeStdAt(closes, candles.length - 1, 100),
    trend: tracker.trend === 1 ? 'LONG' : tracker.trend === -1 ? 'SHORT' : 'NEUTRAL',
    dealingRangeHigh: hi,
    dealingRangeLow: lo,
    rangePositionPct: (() => {
      const p = rangePosition(lastPrice, hi, lo);
      return p === null ? null : p * 100;
    })(),
    swings: swings.slice(-30),
    breaks: breaks.slice(-30),
    latestBreak: latest,
    orderBlocks,
    fairValueGaps: activeFvgs,
    liquidityPools: pools.filter((p) => !p.taken).slice(-30),
    nearestUpperLiquidity: upper,
    nearestLowerLiquidity: lower,
    liveLiquidityOdds: liquidityOdds,
    retestCalibration: retestCal.summary(),
    liquidityCalibration: liquidityCal.summary(),
    edgeTest: edgeSummary(breaks),
  };
}

export function analyzeSmcMultiTimeframe(
  byTimeframe: Record<SMCFrame, Candle[]>,
  overrides: Partial<SMCConfig> = {},
): Partial<Record<SMCFrame, SMCFrameAnalysis>> {
  const result: Partial<Record<SMCFrame, SMCFrameAnalysis>> = {};
  for (const tf of FRAME_ORDER) {
    const candles = byTimeframe[tf] ?? [];
    if (candles.length >= Math.max(50, (overrides.swingLength ?? DEFAULT_SMC_CONFIG.swingLength) * 4)) {
      result[tf] = analyzeSmcFrame(tf, candles, overrides);
    }
  }
  return result;
}
