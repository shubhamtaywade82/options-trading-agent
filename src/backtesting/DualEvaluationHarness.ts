/**
 * Dual-Universe Evaluation Harness for autonomous trading agents.
 * Evaluates candidate strategies across parallel Naive and Point-in-Time simulations,
 * computing degradation metrics to prevent reward-hacking on survivorship and unmodeled carry.
 */
import type { UniverseResolver } from './UniverseResolver.js';
import type { PerpetualExecutionEngine } from './PerpetualExecutionEngine.js';

export interface StrategyHypothesis {
  id: string;
  expression: string;
  targetUniverse: string[];
  parameters: Record<string, unknown>;
}

export interface BacktestSummary {
  sharpeRatio: number;
  maxDrawdown: number;
  totalReturn: number;
  tradeCount: number;
  liquidationsCount: number;
  totalFundingPaidUsd: number;
}

export interface DualEvaluationResult {
  hypothesisId: string;
  naiveSummary: BacktestSummary;
  pitSummary: BacktestSummary;
  degradationDelta: number;
  penalizedScore: number;
  isViable: boolean;
  critiquePayload: string;
}

export interface SimulationFlags {
  enforcePITUniverse: boolean;
  settleFundingRates: boolean;
  enableTieredMargin: boolean;
}

export interface SimulationRunner {
  run(
    strategy: StrategyHypothesis,
    startTime: Date,
    endTime: Date,
    flags: SimulationFlags,
  ): Promise<BacktestSummary>;
}

export class DualEvaluationHarness {
  constructor(
    private readonly universeResolver: UniverseResolver,
    private readonly executionEngine: PerpetualExecutionEngine,
    private readonly runner?: SimulationRunner,
  ) {}

  public async evaluateHypothesis(
    strategy: StrategyHypothesis,
    startTime: Date,
    endTime: Date,
  ): Promise<DualEvaluationResult> {
    const naiveSummary = await this.runSimulation(strategy, startTime, endTime, {
      enforcePITUniverse: false,
      settleFundingRates: false,
      enableTieredMargin: false,
    });

    const pitSummary = await this.runSimulation(strategy, startTime, endTime, {
      enforcePITUniverse: true,
      settleFundingRates: true,
      enableTieredMargin: true,
    });

    const degradationDelta = Number((naiveSummary.sharpeRatio - pitSummary.sharpeRatio).toFixed(2));
    const penalizedScore = this.calculatePenalizedScore(pitSummary.sharpeRatio, degradationDelta);
    const isViable = pitSummary.sharpeRatio >= 1.2 && degradationDelta <= 0.6;
    const critiquePayload = this.generateCritique(strategy, naiveSummary, pitSummary, degradationDelta);

    return {
      hypothesisId: strategy.id,
      naiveSummary,
      pitSummary,
      degradationDelta,
      penalizedScore,
      isViable,
      critiquePayload,
    };
  }

  public calculatePenalizedScore(
    pitSharpe: number,
    degradationDelta: number,
    lambda = 2.0,
    epsilon = 0.6,
  ): number {
    const penalty = Math.max(0, degradationDelta - epsilon);
    return Number((pitSharpe - lambda * penalty).toFixed(2));
  }

  private generateCritique(
    strategy: StrategyHypothesis,
    naive: BacktestSummary,
    pit: BacktestSummary,
    delta: number,
  ): string {
    const status = delta > 0.6
      ? 'REJECTED: Hypothesis exhibits severe reliance on surviving-token selection or unmodeled funding carry. Refine alpha formula to include carrying-cost penalties.'
      : 'ACCEPTED: Hypothesis maintains structural integrity under realistic point-in-time evaluation.';

    return [
      'EVALUATION SYSTEM POST-MORTEM:',
      `- Strategy Expression: ${strategy.expression}`,
      `- Naive Sharpe: ${naive.sharpeRatio.toFixed(2)} | PIT Sharpe: ${pit.sharpeRatio.toFixed(2)}`,
      `- Performance Degradation (Delta): ${delta.toFixed(2)}`,
      `- Liquidations Observed: ${pit.liquidationsCount}`,
      `- Cumulative Funding Cost Drag: $${pit.totalFundingPaidUsd.toFixed(2)}`,
      '',
      'CRITIQUE:',
      status,
    ].join('\n');
  }

  private async runSimulation(
    strategy: StrategyHypothesis,
    start: Date,
    end: Date,
    flags: SimulationFlags,
  ): Promise<BacktestSummary> {
    if (this.runner) {
      return this.runner.run(strategy, start, end, flags);
    }

    // Default simulation baseline when no custom runner is injected
    return {
      sharpeRatio: flags.enforcePITUniverse ? 0.82 : 2.15,
      maxDrawdown: flags.enforcePITUniverse ? -0.24 : -0.09,
      totalReturn: flags.enforcePITUniverse ? 0.28 : 1.15,
      tradeCount: 380,
      liquidationsCount: flags.enableTieredMargin ? 4 : 0,
      totalFundingPaidUsd: flags.settleFundingRates ? 12450.0 : 0.0,
    };
  }
}
