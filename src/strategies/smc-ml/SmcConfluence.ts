import {
  type FrameConfluence,
  type SMCConfluence,
  type SMCFrame,
  type SMCFrameAnalysis,
  type SMCDirection,
} from './types.js';

export interface ConfluenceConfig {
  weights: Partial<Record<SMCFrame, number>>;
  minimumScore: number;
}

const DEFAULT_WEIGHTS: Record<SMCFrame, number> = {
  '5m': 0.15,
  '15m': 0.25,
  '1h': 0.30,
  '4h': 0.30,
  '1d': 0.35,
};

function directionFromScore(score: number, threshold: number): SMCDirection {
  if (score >= threshold) return 'LONG';
  if (score <= -threshold) return 'SHORT';
  return 'NEUTRAL';
}

function latestBreakBias(frame: SMCFrameAnalysis): number {
  const b = frame.latestBreak;
  if (!b) return 0;
  const age = frame.candleCount - b.index - 1;
  const decay = age <= 3 ? 1 : age <= 10 ? 0.75 : age <= 25 ? 0.45 : 0.2;
  return b.direction * decay;
}

function zoneBias(frame: SMCFrameAnalysis, price: number): number {
  let score = 0;
  for (const z of frame.orderBlocks.slice(-4)) {
    if (price >= z.bottom && price <= z.top) {
      score += z.direction * 0.8;
      continue;
    }
    const distance = Math.min(Math.abs(price - z.bottom), Math.abs(price - z.top));
    const atr = frame.atr14 ?? 0;
    if (atr > 0 && distance <= atr) score += z.direction * 0.25;
  }
  for (const fvg of frame.fairValueGaps.slice(-4)) {
    if (price >= fvg.bottom && price <= fvg.top) score += fvg.direction * 0.35;
  }
  return Math.max(-1, Math.min(1, score));
}

function liquidityBias(frame: SMCFrameAnalysis): number {
  const upper = frame.liveLiquidityOdds.upper;
  const lower = frame.liveLiquidityOdds.lower;
  if (upper === null || lower === null) return 0;
  return Math.max(-1, Math.min(1, upper - lower));
}

function rangeBias(frame: SMCFrameAnalysis): number {
  const pct = frame.rangePositionPct;
  if (pct === null) return 0;
  if (pct <= 30) return 0.45;
  if (pct <= 40) return 0.15;
  if (pct >= 70) return -0.45;
  if (pct >= 60) return -0.15;
  return 0;
}

export function scoreFrame(
  timeframe: SMCFrame,
  frame: SMCFrameAnalysis,
  price: number,
): FrameConfluence {
  const trendScore = frame.trend === 'LONG' ? 1 : frame.trend === 'SHORT' ? -1 : 0;
  const breakScore = latestBreakBias(frame);
  const rangeScore = rangeBias(frame);
  const zoneScore = zoneBias(frame, price);
  const liquidityScore = liquidityBias(frame);

  const score =
    trendScore * 0.35 +
    breakScore * 0.30 +
    rangeScore * 0.10 +
    zoneScore * 0.15 +
    liquidityScore * 0.10;

  const reasons: string[] = [];
  if (trendScore) reasons.push(frame.trend + ' swing structure');
  if (frame.latestBreak) reasons.push(
    frame.latestBreak.type + ' ' + (frame.latestBreak.direction === 1 ? 'bullish' : 'bearish'),
  );
  if (frame.rangePositionPct !== null) reasons.push('range ' + frame.rangePositionPct.toFixed(0) + '%');
  if (zoneScore > 0.2) reasons.push('bullish OB/FVG support');
  if (zoneScore < -0.2) reasons.push('bearish OB/FVG resistance');
  if (liquidityScore > 0.2) reasons.push('upper liquidity currently more likely');
  if (liquidityScore < -0.2) reasons.push('lower liquidity currently more likely');

  return {
    timeframe,
    direction: directionFromScore(score, 0.15),
    score,
    trendScore,
    breakScore,
    rangeScore,
    zoneScore,
    liquidityScore,
    reasons,
  };
}

export function buildSmcConfluence(
  frames: Partial<Record<SMCFrame, SMCFrameAnalysis>>,
  price: number,
  config: Partial<ConfluenceConfig> = {},
): SMCConfluence {
  const weights = { ...DEFAULT_WEIGHTS, ...(config.weights ?? {}) };
  const minimumScore = config.minimumScore ?? 0.35;

  const scores = (Object.keys(frames) as SMCFrame[])
    .filter((tf): tf is SMCFrame => frames[tf] !== undefined)
    .map((tf) => scoreFrame(tf, frames[tf]!, price));

  let totalWeight = 0;
  let weightedScore = 0;
  for (const s of scores) {
    const w = weights[s.timeframe] ?? 0;
    weightedScore += s.score * w;
    totalWeight += w;
  }

  const score = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const direction = directionFromScore(score, minimumScore);

  const agreement =
    scores.length === 0
      ? 0
      : scores.filter((s) => direction !== 'NEUTRAL' && s.direction === direction).length / scores.length;

  const reasons = scores
    .filter((s) => s.direction === direction)
    .flatMap((s) => s.reasons.map((r) => s.timeframe + ': ' + r))
    .slice(0, 10);

  const noTradeReasons: string[] = [];
  if (scores.length < 3) noTradeReasons.push('fewer than three analysed timeframes');
  if (direction === 'NEUTRAL') noTradeReasons.push('timeframe confluence is directionally unresolved');
  if (Math.abs(score) < minimumScore) {
    noTradeReasons.push('confluence score ' + score.toFixed(2) + ' is below ' + minimumScore.toFixed(2));
  }
  if (agreement < 0.5) {
    noTradeReasons.push('timeframe agreement ' + (agreement * 100).toFixed(0) + '% is too low');
  }

  return { direction, score, frameScores: scores, agreement, reasons, noTradeReasons };
}
