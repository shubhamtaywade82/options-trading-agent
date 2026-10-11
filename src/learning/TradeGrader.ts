import type { TradeIntent } from '../decision/SignalFusion.js';

export interface TradeReviewInput {
  intent: TradeIntent;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  exitReason: string;
}

export interface TradeGrade {
  score: number; // 0 - 100
  grade: 'A+' | 'A' | 'B' | 'C' | 'F';
  expectancyEdge: number;
  commentary: string;
}

/** Evaluates trade execution fidelity and setup quality against realized outcome. */
export function gradeTrade(review: TradeReviewInput): TradeGrade {
  const { intent, entryPrice, exitPrice, pnl } = review;
  const plannedRisk = Math.abs(intent.entry - intent.stopLoss);
  const realizedPerUnit = intent.side === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
  const rMultiple = plannedRisk > 0 ? Number((realizedPerUnit / plannedRisk).toFixed(2)) : 0;

  // Evidence alignment: high evidence setups receive top marks
  let score = intent.evidenceScore;
  if (rMultiple >= 2.0) score = Math.min(100, score + 15);
  else if (rMultiple < -1.1) score = Math.max(0, score - 20);

  let grade: TradeGrade['grade'] = 'C';
  if (score >= 90) grade = 'A+';
  else if (score >= 80) grade = 'A';
  else if (score >= 70) grade = 'B';
  else if (score < 55) grade = 'F';

  return {
    score,
    grade,
    expectancyEdge: rMultiple,
    commentary: `${intent.sourceAgent} ${intent.side} on ${intent.symbol} achieved ${rMultiple}R (${pnl >= 0 ? 'WIN' : 'LOSS'})`,
  };
}
