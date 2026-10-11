/**
 * Diagnose why no trades are being placed.
 * Run: npx tsx scripts/diagnose-trades.ts
 */
import 'dotenv/config';
import { BinanceService } from '../src/binance/client.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import { FundingArbAgent } from '../src/agents/FundingArbAgent.js';
import { MomentumAgent } from '../src/agents/MomentumAgent.js';
import { StructureTrendAgent } from '../src/agents/StructureTrendAgent.js';
import { MeanReversionAgent } from '../src/agents/MeanReversionAgent.js';
import { CrowdingAgent } from '../src/agents/CrowdingAgent.js';
import { AdaptiveSuperTrendAgent } from '../src/agents/AdaptiveSuperTrendAgent.js';
import { RiskAgent } from '../src/agents/RiskAgent.js';
import { applyRouter } from '../src/decision/StrategyRouter.js';
import { evaluateExecutionQuality } from '../src/execution/ExecutionQuality.js';
import { config } from '../src/config.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import type { Signal } from '../src/types.js';

const binance = new BinanceService();
const builder = new MarketStateBuilder();

async function main() {
  console.log('\n=== CRYPTO TRADING AGENT — TRADE DIAGNOSTIC ===\n');
  console.log(`Mode: ${config.mode}  |  Symbols: ${config.symbols.join(', ')}`);
  console.log(`Risk engine: ${config.riskEngine}  |  Risk/trade: ${config.risk.riskPerTradePct}%  |  Max exposure: ${config.risk.maxExposurePct}%`);
  console.log(`Min liq buffer: ${config.risk.minLiqBufferAtr}x ATR  |  Max drawdown: ${config.risk.maxDrawdownPct}%\n`);

  // 1. Init venue
  console.log('--- [1] Venue init ---');
  try {
    await binance.initVenue();
    console.log('✅ Venue initialized\n');
  } catch (e) {
    console.error(`❌ Venue init FAILED: ${(e as Error).message}\n`);
    return;
  }

  // 2. Fetch market data
  console.log('--- [2] Market data fetch ---');
  const market = await binance.getMarketOverview(config.symbols);
  for (const sym of config.symbols) {
    const candles = market.candles[sym] ?? [];
    const v2 = market.marketDataV2?.[sym];
    console.log(`  ${sym}: ${candles.length} candles  |  V2 timeframes: ${v2 ? Object.keys(v2.candles ?? {}).join(',') : 'NONE'}  |  derivatives: ${v2?.derivatives ? 'YES (spread=' + v2.derivatives.spreadBps?.toFixed(1) + ' bps)' : 'NONE'}`);
  }
  console.log();

  // 3. Build market states
  console.log('--- [3] Market state (regime) ---');
  const marketState = builder.buildAll(config.symbols.map((symbol) => ({
    symbol,
    candles: market.candles[symbol] ?? [],
    candlesByTimeframe: market.marketDataV2?.[symbol]?.candles,
    derivatives: market.marketDataV2?.[symbol]?.derivatives,
    mark: market.marks[symbol] ?? 0,
    fundingRate: market.funding[symbol] ?? 0,
  })));
  for (const [sym, state] of Object.entries(marketState)) {
    const r = state.regime;
    console.log(`  ${sym}: regime=${r.regime}  adx=${r.adx14?.toFixed(1) ?? 'n/a'}  trend=${r.trendDirection}  vol%=${r.volatilityPercentile?.toFixed(0) ?? 'n/a'}  htfTrend=${state.htfStructure.trend}`);
    console.log(`         discount=${state.pricing.discount}  premium=${state.pricing.premium}  zscore=${state.meanReversion.zscore?.toFixed(2) ?? 'n/a'}  rsi=${state.meanReversion.rsi14?.toFixed(0) ?? 'n/a'}`);
  }
  console.log();

  // 4. Run all agents
  console.log('--- [4] Agent signals ---');
  const [positions, account] = await Promise.all([binance.getPositions(), binance.getAccount()]);
  const ctx: MarketContext = { ...market, spot: {}, equity: account.equity, positions, marketState, performance: undefined };

  const agents = [
    new FundingArbAgent(binance),
    new MomentumAgent(binance),
    new AdaptiveSuperTrendAgent(binance),
    new StructureTrendAgent(binance),
    new MeanReversionAgent(binance),
    new CrowdingAgent(binance),
  ];
  const allSignals: Signal[] = [];
  for (const agent of agents) {
    const signals = await agent.run(ctx);
    if (signals.length === 0) {
      console.log(`  ${agent.id}: 0 signals`);
    } else {
      for (const s of signals) {
        console.log(`  ✅ ${agent.id}: SIGNAL ${s.symbol} ${s.type} conf=${(s.confidence * 100).toFixed(0)}%  reason=${s.reason}`);
        allSignals.push(s);
      }
    }
  }
  console.log();

  if (allSignals.length === 0) {
    console.log('⛔ NO signals from any agent. No trades will be placed. See regime + conditions above.\n');
    return;
  }

  // 5. Strategy Router
  console.log('--- [5] Strategy Router ---');
  const { passed, vetoed } = applyRouter(allSignals, marketState);
  for (const v of vetoed) console.log(`  🚫 ROUTED OUT: ${v.agent} ${v.symbol} in regime ${v.regime}`);
  for (const s of passed) console.log(`  ✅ PASSED: ${s.agent} ${s.symbol}`);
  console.log();

  if (passed.length === 0) {
    console.log('⛔ ALL signals routed out by StrategyRouter. Regime mismatch is the main blocker.\n');
    return;
  }

  // 6. RiskAgent gate
  console.log('--- [6] RiskAgent gate ---');
  const risk = new RiskAgent(binance);
  for (const signal of passed) {
    const decision = risk.gate(signal, ctx);
    if (!decision.approved) {
      console.log(`  🚫 RISK REJECTED: ${signal.agent} ${signal.symbol} — ${decision.reason}`);
    } else {
      console.log(`  ✅ RISK APPROVED: ${signal.agent} ${signal.symbol} — ${decision.reason}`);
      // 7. EQ gate
      const derivatives = ctx.marketDataV2?.[signal.symbol]?.derivatives ?? null;
      const eq = evaluateExecutionQuality(
        { symbol: signal.symbol, side: signal.type.includes('SHORT') ? 'SHORT' : 'LONG', sourceAgent: signal.agent, evidenceScore: Math.round(signal.confidence * 100), entry: signal.entry ?? 0, stopLoss: signal.stopLoss ?? 0, takeProfit: signal.takeProfit ?? 0, reasons: [signal.reason] },
        derivatives,
        decision.positionSizeUsdt,
      );
      if (!eq.approved) {
        console.log(`    🚫 EQ BLOCKED: ${signal.symbol} — ${eq.reason}`);
      } else {
        console.log(`    ✅ EQ OK: ${signal.symbol} — ${eq.reason}`);
        console.log(`    🎯 WOULD EXECUTE: ${signal.agent} ${signal.symbol} ${signal.type} @ ${signal.entry} SL=${signal.stopLoss} TP=${signal.takeProfit}`);
      }
    }
  }
  console.log();
}

main().catch(console.error);
