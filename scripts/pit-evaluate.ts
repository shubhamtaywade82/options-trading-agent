/**
 * CLI entry point for dual-universe PIT strategy evaluation.
 *
 * Usage:
 *   npx tsx scripts/pit-evaluate.ts \
 *     --strategy-id my-momentum-v1 \
 *     --expression "rsi14 < 30 AND volume_surge > 2x" \
 *     --start 2023-01-01 \
 *     --end   2024-01-01
 */

import pg from 'pg';
import { UniverseResolver } from '../src/backtesting/UniverseResolver.js';
import { PerpetualExecutionEngine } from '../src/backtesting/PerpetualExecutionEngine.js';
import { DualEvaluationHarness, type StrategyHypothesis } from '../src/backtesting/DualEvaluationHarness.js';

const PG_URL = process.env.PIT_DATABASE_URL ?? 'postgres://supervisor:supervisor@localhost:5434/supervisor';

function parseArgs(): { strategyId: string; expression: string; start: Date; end: Date } {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    if (i === -1 || !args[i + 1]) throw new Error(`Missing required arg: ${flag}`);
    return args[i + 1];
  };
  return {
    strategyId: get('--strategy-id'),
    expression: get('--expression'),
    start: new Date(get('--start')),
    end: new Date(get('--end')),
  };
}

function printResult(result: ReturnType<DualEvaluationHarness['evaluateHypothesis']> extends Promise<infer T> ? T : never): void {
  const { naiveSummary: n, pitSummary: p } = result;
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║         DUAL-UNIVERSE EVALUATION REPORT              ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Strategy ID  : ${result.hypothesisId.padEnd(36)}║`);
  console.log(`║  Viable       : ${(result.isViable ? '✓ YES' : '✗ NO').padEnd(36)}║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║              Naive Sim    PIT Sim   Delta             ║`);
  console.log(`║  Sharpe      ${n.sharpeRatio.toFixed(2).padStart(8)}   ${p.sharpeRatio.toFixed(2).padStart(7)}   Δ${result.degradationDelta.toFixed(2).padStart(5)}        ║`);
  console.log(`║  Max DD      ${(n.maxDrawdown * 100).toFixed(1).padStart(7)}%  ${(p.maxDrawdown * 100).toFixed(1).padStart(7)}%                  ║`);
  console.log(`║  Return      ${(n.totalReturn * 100).toFixed(1).padStart(7)}%  ${(p.totalReturn * 100).toFixed(1).padStart(7)}%                  ║`);
  console.log(`║  Trades      ${String(n.tradeCount).padStart(8)}   ${String(p.tradeCount).padStart(7)}                    ║`);
  console.log(`║  Liquidated  ${String(n.liquidationsCount).padStart(8)}   ${String(p.liquidationsCount).padStart(7)}                    ║`);
  console.log(`║  Funding $          —   ${('$' + p.totalFundingPaidUsd.toFixed(0)).padStart(7)}                    ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Penalized Score : ${result.penalizedScore.toFixed(2).padEnd(33)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('\n' + result.critiquePayload);
}

async function main(): Promise<void> {
  const { strategyId, expression, start, end } = parseArgs();

  const pool = new pg.Pool({ connectionString: PG_URL });

  try {
    const strategy: StrategyHypothesis = {
      id: strategyId,
      expression,
      targetUniverse: [],
      parameters: {},
    };

    const resolver = new UniverseResolver(pool);
    const engine = new PerpetualExecutionEngine();
    const harness = new DualEvaluationHarness(resolver, engine);

    console.log(`[pit-evaluate] Evaluating "${strategyId}" from ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}…`);
    const result = await harness.evaluateHypothesis(strategy, start, end);
    printResult(result);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[pit-evaluate] FATAL:', err.message);
  process.exit(1);
});
