/**
 * Deep state inspect for crowding and structure conditions.
 * Run: npx tsx scripts/inspect-state.ts
 */
import 'dotenv/config';
import { BinanceService } from '../src/binance/client.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import { config } from '../src/config.js';

const binance = new BinanceService();
const builder = new MarketStateBuilder();

async function main() {
  await binance.initVenue();
  const market = await binance.getMarketOverview(config.symbols);

  const states = builder.buildAll(config.symbols.map((symbol) => ({
    symbol,
    candles: market.candles[symbol] ?? [],
    candlesByTimeframe: market.marketDataV2?.[symbol]?.candles,
    derivatives: market.marketDataV2?.[symbol]?.derivatives,
    mark: market.marks[symbol] ?? 0,
    fundingRate: market.funding[symbol] ?? 0,
  })));

  for (const [sym, state] of Object.entries(states)) {
    console.log(`\n=== ${sym} ===`);
    console.log(`HTF structure trend: ${state.htfStructure.trend}`);
    console.log(`HTF lastBreak:`, state.htfStructure.lastBreak);
    console.log(`LTF lastBreak:`, state.ltfStructure.lastBreak);
    console.log(`Pricing: premium=${state.pricing.premium} discount=${state.pricing.discount} positionPct=${state.pricing.positionPct.toFixed(1)}%`);
    console.log(`Crowding:`, state.crowding);
    console.log(`LTF sweeps (last 3):`, state.liquidity.ltf.latestSweeps.slice(-3));
    console.log(`MeanReversion: zscore=${state.meanReversion.zscore?.toFixed(2)} rsi=${state.meanReversion.rsi14?.toFixed(0)}`);
    console.log(`Funding: ${market.funding[sym]?.toFixed(6)}`);
  }
}

main().catch(console.error);
