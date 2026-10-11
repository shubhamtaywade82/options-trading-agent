import type { Candle } from '../../types.js';

export type SMCFrame = '5m' | '15m' | '1h' | '4h' | '1d';
export type SMCDirection = 'LONG' | 'SHORT' | 'NEUTRAL';
export type SMCBreakType = 'BOS' | 'CHOCH';
export type SMCEntrySource = 'MARKET' | 'BREAK_CLOSE' | 'RETEST_LEVEL';

export interface SMCConfig {
  swingLength: number;
  internalLength: number;
  retestWindow: number;
  followThroughWindow: number;
  liquidityWindow: number;
  stopBufferAtr: number;
  maxRiskAtr: number;
  tp1R: number;
  tp2R: number;
  minConfluence: number;
}

export const DEFAULT_SMC_CONFIG: SMCConfig = {
  swingLength: 10,
  internalLength: 3,
  retestWindow: 20,
  followThroughWindow: 150,
  liquidityWindow: 1000,
  stopBufferAtr: 0.20,
  maxRiskAtr: 6,
  tp1R: 1,
  tp2R: 2,
  minConfluence: 0.65,
};

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

export interface FairValueGap {
  direction: 1 | -1;
  top: number;
  bottom: number;
  index: number;
}

export interface OrderBlock {
  direction: 1 | -1;
  top: number;
  bottom: number;
  index: number;
}

export interface LiquidityPool {
  direction: 1 | -1;
  price: number;
  kind: 'SWING' | 'EQUAL';
  firstIndex: number;
  secondIndex?: number;
  taken: boolean;
}

export interface StructureBreak {
  direction: 1 | -1;
  type: SMCBreakType;
  index: number;
  time: number;
  level: number;
  breakClose: number;
  protectedSwing: number;
  protectedSwingIndex: number;
  riskUnit: number;
  retestFormulaProbability: number | null;
  retestProbability: number | null;
  retestEntryPrice: number | null;
  retestOutcome: boolean | null;
  followThroughOutcome: boolean | null;
  sweptLiquidityFirst: boolean;
  leftFvg: boolean;
  nearestUpperPoolAtPrint: number | null;
  nearestLowerPoolAtPrint: number | null;
}

export interface CalibrationSummary {
  samples: number;
  hitRate: number | null;
  brierModel: number | null;
  brierFormula: number | null;
  brierBase: number | null;
}

export interface EdgeTestSummary {
  totalResolved: number;
  overallRate: number | null;
  splits: {
    groupA: string;
    groupB: string;
    nA: number;
    hitA: number;
    nB: number;
    hitB: number;
    z: number | null;
  }[];
}

export interface SMCFrameAnalysis {
  timeframe: SMCFrame;
  candleCount: number;
  lastClosedTime: number;
  lastPrice: number;
  atr14: number | null;
  volatilityStd: number | null;
  trend: SMCDirection;
  dealingRangeHigh: number | null;
  dealingRangeLow: number | null;
  rangePositionPct: number | null;
  swings: SwingPoint[];
  breaks: StructureBreak[];
  latestBreak: StructureBreak | null;
  orderBlocks: OrderBlock[];
  fairValueGaps: FairValueGap[];
  liquidityPools: LiquidityPool[];
  nearestUpperLiquidity: LiquidityPool | null;
  nearestLowerLiquidity: LiquidityPool | null;
  liveLiquidityOdds: { upper: number | null; lower: number | null; formulaUpper: number | null; formulaLower: number | null };
  retestCalibration: CalibrationSummary;
  liquidityCalibration: CalibrationSummary;
  edgeTest: EdgeTestSummary;
}

export interface FrameConfluence {
  timeframe: SMCFrame;
  direction: SMCDirection;
  score: number;
  trendScore: number;
  breakScore: number;
  rangeScore: number;
  zoneScore: number;
  liquidityScore: number;
  reasons: string[];
}

export interface SMCConfluence {
  direction: SMCDirection;
  score: number;
  frameScores: FrameConfluence[];
  agreement: number;
  reasons: string[];
  noTradeReasons: string[];
}

export interface ExecutionCandidate {
  direction: Exclude<SMCDirection, 'NEUTRAL'>;
  entrySource: SMCEntrySource;
  entryPrice: number;
  protectedSwing: number;
  atr14: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  riskPerUnit: number;
  riskAtr: number;
  sourceBreak: {
    type: SMCBreakType;
    timeframe: SMCFrame;
    level: number;
    time: number;
    retestProbability: number | null;
  };
}

export interface SMCAnalysis {
  symbol: string;
  generatedAt: number;
  price: number;
  timeframes: Partial<Record<SMCFrame, SMCFrameAnalysis>>;
  confluence: SMCConfluence;
  candidates: ExecutionCandidate[];
}

export type PortfolioState = 'NO_POSITION' | 'LONG' | 'SHORT';

export interface SMCTradeDecision {
  action: 'OPEN' | 'ADD' | 'EXIT' | 'HOLD';
  side: 'LONG' | 'SHORT' | 'NONE';
  entrySource: SMCEntrySource | null;
  reason: string;
}

export interface SMCDecisionContext {
  analysis: SMCAnalysis;
  portfolioState: PortfolioState;
  positionQty: number;
  currentEntry?: number;
  currentMark: number;
}
