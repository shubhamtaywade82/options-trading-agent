import test from 'node:test';
import { analyzeSmcFrame } from '../src/strategies/smc-ml/SmcMlEngine.js';
import assert from 'node:assert/strict';
import { BayesianLogisticCalibration, CausalBayesianCalibration, clampProbability, touchProbability, twoProportionZ } from '../src/strategies/smc-ml/math.js';
import { buildSmcConfluence } from '../src/strategies/smc-ml/SmcConfluence.js';
import { buildExecutionCandidates } from '../src/strategies/smc-ml/SmcMlRuntime.js';
import type { SMCFrameAnalysis } from '../src/strategies/smc-ml/types.js';

function frame(
  tf: SMCFrameAnalysis['timeframe'],
  trend: 'LONG' | 'SHORT',
): SMCFrameAnalysis {
  return {
    timeframe: tf,
    candleCount: 200,
    lastClosedTime: Date.now(),
    lastPrice: 100,
    atr14: 1,
    volatilityStd: 1,
    trend,
    dealingRangeHigh: 110,
    dealingRangeLow: 90,
    rangePositionPct: trend === 'LONG' ? 25 : 75,
    swings: [],
    breaks: [],
    latestBreak: null,
    orderBlocks: [],
    fairValueGaps: [],
    liquidityPools: [],
    nearestUpperLiquidity: null,
    nearestLowerLiquidity: null,
    liveLiquidityOdds: { upper: null, lower: null, formulaUpper: null, formulaLower: null },
    retestCalibration: { samples: 0, hitRate: null, brierModel: null, brierFormula: null, brierBase: null },
    liquidityCalibration: { samples: 0, hitRate: null, brierModel: null, brierFormula: null, brierBase: null },
    edgeTest: { totalResolved: 0, overallRate: null, splits: [] },
  };
}

test('reflection touch probability stays bounded and increases with window', () => {
  const p10 = touchProbability(1, 1, 10)!;
  const p100 = touchProbability(1, 1, 100)!;
  assert.equal(clampProbability(p10), p10);
  assert.equal(clampProbability(p100), p100);
  assert.ok(p100 > p10);
});

test('two proportion z detects a large difference', () => {
  const z = twoProportionZ(100, 90, 100, 50)!;
  assert.ok(Math.abs(z) > 5);
});

test('MTF confluence becomes long when major frames agree', () => {
  const frames = {
    '5m': frame('5m', 'LONG'),
    '15m': frame('15m', 'LONG'),
    '1h': frame('1h', 'LONG'),
    '4h': frame('4h', 'LONG'),
  };
  const c = buildSmcConfluence(frames, 100, { minimumScore: 0.35 });
  assert.equal(c.direction, 'LONG');
  assert.ok(c.agreement === 1);
  assert.equal(c.noTradeReasons.length, 0);
});

test('MTF confluence remains unresolved when frames conflict', () => {
  const frames = {
    '5m': frame('5m', 'LONG'),
    '15m': frame('15m', 'LONG'),
    '1h': frame('1h', 'SHORT'),
    '4h': frame('4h', 'SHORT'),
  };
  const c = buildSmcConfluence(frames, 100, { minimumScore: 0.35 });
  assert.ok(c.direction === 'LONG' || c.direction === 'SHORT' || c.direction === 'NEUTRAL');
  assert.ok(c.agreement < 1);
});

import { validateDecision } from '../src/strategies/smc-ml/SmcExecutionAdvisor.js';
import type { SMCAnalysis, SMCDecisionContext } from '../src/strategies/smc-ml/types.js';

function decisionContext(
  portfolioState: SMCDecisionContext['portfolioState'] = 'NO_POSITION',
  noTradeReasons: string[] = [],
): SMCDecisionContext {
  const candidate = {
    direction: 'LONG' as const,
    entrySource: 'MARKET' as const,
    entryPrice: 100,
    protectedSwing: 98,
    atr14: 1,
    stopLoss: 97,
    tp1: 103,
    tp2: 106,
    riskPerUnit: 3,
    riskAtr: 3,
    sourceBreak: {
      type: 'BOS' as const,
      timeframe: '1h' as const,
      level: 99,
      time: 1,
      retestProbability: 0.6,
    },
  };

  const analysis: SMCAnalysis = {
    symbol: 'BTCUSDT',
    generatedAt: 2,
    price: 100,
    timeframes: {},
    confluence: {
      direction: 'LONG',
      score: 0.8,
      frameScores: [],
      agreement: 1,
      reasons: ['1h: BOS bullish'],
      noTradeReasons,
    },
    candidates: [candidate],
  };

  return {
    analysis,
    portfolioState,
    positionQty: portfolioState === 'NO_POSITION' ? 0 : 1,
    currentEntry: portfolioState === 'NO_POSITION' ? undefined : 100,
    currentMark: 100,
  };
}

test('validator fails closed when confluence contains a no-trade reason', () => {
  const context = decisionContext('NO_POSITION', ['fewer than three analysed timeframes']);
  const result = validateDecision(
    { action: 'OPEN', side: 'LONG', entrySource: 'MARKET', reason: 'open' },
    context,
  );
  assert.equal(result.action, 'HOLD');
  assert.equal(result.side, 'NONE');
  assert.equal(result.entrySource, null);
});

test('validator accepts only an existing candidate for an otherwise admissible OPEN', () => {
  const context = decisionContext();
  const result = validateDecision(
    { action: 'OPEN', side: 'LONG', entrySource: 'MARKET', reason: 'open' },
    context,
  );
  assert.equal(result.action, 'OPEN');
  assert.equal(result.side, 'LONG');
  assert.equal(result.entrySource, 'MARKET');
});

test('validator rejects ADD when confluence is opposite to the open position', () => {
  const context = decisionContext('SHORT');
  const result = validateDecision(
    { action: 'ADD', side: 'SHORT', entrySource: 'MARKET', reason: 'add' },
    context,
  );
  assert.equal(result.action, 'HOLD');
  assert.equal(result.side, 'NONE');
  assert.equal(result.entrySource, null);
});

test('validator strips entry source from EXIT decisions', () => {
  const context = decisionContext('LONG');
  const result = validateDecision(
    { action: 'EXIT', side: 'LONG', entrySource: 'MARKET', reason: 'exit' },
    context,
  );
  assert.equal(result.action, 'EXIT');
  assert.equal(result.side, 'LONG');
  assert.equal(result.entrySource, null);
});

test('causal calibration does not use an unresolved prior outcome', () => {
  const calibration = new CausalBayesianCalibration(new BayesianLogisticCalibration());
  const firstPrediction = calibration.observe(10, 0.9, 30, 0);
  const secondPrediction = calibration.observe(20, 0.9, null, null);

  assert.ok(firstPrediction !== null);
  assert.ok(secondPrediction !== null);
  assert.ok(Math.abs(firstPrediction - 0.9) < 1e-12);
  assert.ok(Math.abs(secondPrediction - 0.9) < 1e-12);
  assert.equal(calibration.summary().samples, 0);
});

test('causal calibration includes an outcome resolved on the current signal candle', () => {
  const calibration = new CausalBayesianCalibration(new BayesianLogisticCalibration());
  calibration.observe(10, 0.9, 20, 0);
  const predictionAtResolution = calibration.observe(20, 0.9, null, null);

  assert.ok(predictionAtResolution !== null);
  assert.ok(predictionAtResolution < 0.9);
  assert.equal(calibration.summary().samples, 1);
});

function frameWithBreak(breakIndex: number): SMCFrameAnalysis {
  return {
    ...frame('1h', 'LONG'),
    candleCount: 100,
    latestBreak: {
      direction: 1,
      type: 'BOS',
      index: breakIndex,
      time: breakIndex,
      level: 99,
      breakClose: 100,
      protectedSwing: 95,
      protectedSwingIndex: breakIndex - 5,
      riskUnit: 5,
      retestFormulaProbability: 0.6,
      retestProbability: 0.6,
      retestEntryPrice: null,
      retestOutcome: null,
      followThroughOutcome: null,
      sweptLiquidityFirst: false,
      leftFvg: false,
      nearestUpperPoolAtPrint: 110,
      nearestLowerPoolAtPrint: 90,
    },
    atr14: 1,
  };
}

test('execution candidates expire after the retest window', () => {
  const stale = frameWithBreak(10);
  const candidates = buildExecutionCandidates({ '1h': stale }, 'LONG', 100, {
    retestWindow: 20,
  });
  assert.equal(candidates.length, 0);
});

test('fresh structure breaks can produce a market execution candidate', () => {
  const fresh = frameWithBreak(90);
  const candidates = buildExecutionCandidates({ '1h': fresh }, 'LONG', 100, {
    retestWindow: 20,
  });
  assert.ok(candidates.some((candidate) => candidate.entrySource === 'MARKET'));
});

import { applySmcPortfolioSafety } from '../src/strategies/smc-ml/SmcMlRuntime.js';

test('portfolio safety does not force an exit from a no-trade confluence', () => {
  const decision = applySmcPortfolioSafety('LONG', {
    direction: 'SHORT',
    score: -0.8,
    frameScores: [],
    agreement: 1,
    reasons: [],
    noTradeReasons: ['fewer than three analysed timeframes'],
  });

  assert.equal(decision, null);
});

test('portfolio safety forces an exit only for admissible opposite confluence', () => {
  const decision = applySmcPortfolioSafety('LONG', {
    direction: 'SHORT',
    score: -0.8,
    frameScores: [],
    agreement: 0.75,
    reasons: ['4h: BOS bearish'],
    noTradeReasons: [],
  });

  assert.deepEqual(decision, {
    action: 'EXIT',
    side: 'LONG',
    entrySource: null,
    reason: 'deterministic portfolio policy: MTF confluence is opposite to the open position',
  });
});

test('execution candidates reject a long stop above the entry price', () => {
  const malformed = frameWithBreak(90);
  malformed.latestBreak!.protectedSwing = 103;

  const candidates = buildExecutionCandidates({ '1h': malformed }, 'LONG', 100, {
    retestWindow: 20,
  });

  assert.equal(candidates.length, 0);
});

test('execution candidates reject a short stop below the entry price', () => {
  const malformed = frame('1h', 'SHORT');
  malformed.candleCount = 100;
  malformed.latestBreak = {
    direction: -1,
    type: 'BOS',
    index: 90,
    time: 90,
    level: 101,
    breakClose: 100,
    protectedSwing: 97,
    protectedSwingIndex: 85,
    riskUnit: 3,
    retestFormulaProbability: 0.6,
    retestProbability: 0.6,
    retestEntryPrice: null,
    retestOutcome: null,
    followThroughOutcome: null,
    sweptLiquidityFirst: false,
    leftFvg: false,
    nearestUpperPoolAtPrint: 110,
    nearestLowerPoolAtPrint: 90,
  };

  const candidates = buildExecutionCandidates({ '1h': malformed }, 'SHORT', 100, {
    retestWindow: 20,
  });

  assert.equal(candidates.length, 0);
});

import { executionPositionGuard } from '../src/strategies/smc-ml/SmcMlRuntime.js';

test('execution guard rejects an OPEN when a position appeared after analysis', () => {
  assert.equal(executionPositionGuard('OPEN', 'NO_POSITION', 'LONG'), 'REJECT');
});

test('execution guard permits an ADD only when the same side is still open', () => {
  assert.equal(executionPositionGuard('ADD', 'LONG', 'LONG'), 'PROCEED');
  assert.equal(executionPositionGuard('ADD', 'LONG', 'SHORT'), 'REJECT');
});

test('execution guard treats an already-flat EXIT as idempotent', () => {
  assert.equal(executionPositionGuard('EXIT', 'LONG', 'NO_POSITION'), 'ALREADY_FLAT');
});

test('execution guard rejects an EXIT when the position changed direction', () => {
  assert.equal(executionPositionGuard('EXIT', 'LONG', 'SHORT'), 'REJECT');
});

import { smcRunnerLockKey } from '../src/strategies/smc-ml/SmcMlRunner.js';

test('SMC runner serializes all timeframe triggers for the same symbol', () => {
  assert.equal(smcRunnerLockKey('BTCUSDT', '5m'), smcRunnerLockKey('BTCUSDT', '15m'));
  assert.notEqual(smcRunnerLockKey('BTCUSDT', '5m'), smcRunnerLockKey('ETHUSDT', '5m'));
});


test('SMC frame analysis rejects an empty candle set with a useful error', () => {
  assert.throws(
    () => analyzeSmcFrame('1h', []),
    /SMC 1h: no closed candles/,
  );
});
