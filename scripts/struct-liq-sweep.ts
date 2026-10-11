/**
 * STRUCT-LIQ parameter-sensitivity sweep — measures how tunable the setup's
 * firing rate actually is.
 *
 *   npx tsx scripts/struct-liq-sweep.ts [--symbols BTCUSDT,ETHUSDT] [--days 45]
 *                                        [--warmup 300]
 *                                        [--fleet 6:1.5,24:1.0,96:0.6]
 *
 * Fetches public USD-M klines (15m/1h/4h), rebuilds the MarketState history
 * with the same no-lookahead discipline the replay engine uses, then evaluates
 * the setup over a grid of `maxSweepAgeCandles` x `minimumRewardRisk` values.
 * The report separates:
 *
 *   - emissions       bars on which the setup produced a signal
 *   - distinct setups unique signal ids (symbol + confirming break) — what
 *                     cooldowns would turn into trades
 *   - new vs baseline setups this cell fires that the default thresholds
 *                     (age 6, RR 1.5) do not
 *
 * `--fleet age:rr,...` additionally runs a full replay per listed combo with
 * the tuned agent in the default fleet, showing which fires survive routing,
 * fusion, risk and execution — the raw sweep only measures the strategy gate.
 */
import { MarketDataFeed } from '../src/backtesting/MarketDataFeed.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import { ReplayService } from '../src/backtesting/ReplayService.js';
import { DEFAULT_SWEEP_GRID, marginalAxes, sweepStructureLiquidity } from '../src/backtesting/StructLiqSweep.js';
import { DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS, tunedStructureLiquidityOptions } from '../src/decision/StructureLiquidityStrategy.js';
import type { Candle } from '../src/types.js';
import type { NativeTimeframe } from '../src/market/MarketDataTypes.js';
import type { ReplayData } from '../src/backtesting/types.js';
import type { MarketState } from '../src/market/types.js';
import { CrowdingAgent } from '../src/agents/CrowdingAgent.js';
import { FundingArbAgent } from '../src/agents/FundingArbAgent.js';
import { MeanReversionAgent } from '../src/agents/MeanReversionAgent.js';
import { MomentumAgent } from '../src/agents/MomentumAgent.js';
import { StructureTrendAgent } from '../src/agents/StructureTrendAgent.js';
import { StructureLiquidityAgent } from '../src/agents/StructureLiquidityAgent.js';
import type { BinanceService } from '../src/binance/client.js';
import type { BaseAgent } from '../src/agents/BaseAgent.js';

const BASE = 'https://fapi.binance.com';
const INTERVAL_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const TIMEFRAMES: NativeTimeframe[] = ['15m', '1h', '4h'];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const symbols = arg('symbols', 'BTCUSDT,ETHUSDT').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
const days = Number(arg('days', '45'));
const warmupBars = Number(arg('warmup', '300'));
const fleetArg = arg('fleet', '');

async function fetchKlines(symbol: string, interval: NativeTimeframe, fromMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = fromMs;
  for (;;) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1500`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`klines ${interval} failed: HTTP ${response.status}`);
    const raw = (await response.json()) as unknown[][];
    for (const k of raw) {
      out.push({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) });
    }
    if (raw.length < 1500) break;
    cursor = Number(raw[raw.length - 1][0]) + INTERVAL_MS[interval];
  }
  return out;
}

const fromMs = Date.now() - days * 86_400_000;
console.log(`STRUCT-LIQ parameter sweep over the last ${days} day(s)...`);
const data: ReplayData = {};
for (const symbol of symbols) {
  data[symbol] = {};
  for (const timeframe of TIMEFRAMES) {
    const candles = await fetchKlines(symbol, timeframe, fromMs);
    data[symbol][timeframe] = candles;
  }
  console.log(`  ${symbol}: ${data[symbol]['15m']!.length} x 15m candles`);
}

// Rebuild the state history exactly like the replay engine: step per 15m close,
// every timeframe truncated to candles that had fully closed by then. States are
// yielded lazily and released after the sweep consumes them, so a whole-window
// sweep runs in bounded memory.
const feed = new MarketDataFeed(data);
const builder = new MarketStateBuilder();

function* statesFor(symbolsToSweep: string[]): Generator<MarketState> {
  for (let step = warmupBars; step < feed.stepCount; step += 1) {
    const closeTime = feed.stepTime(step);
    const inputs = symbolsToSweep.map((symbol) => {
      const closed15m = feed.closedCandles(symbol, '15m', closeTime);
      const candlesByTimeframe: Partial<Record<NativeTimeframe, Candle[]>> = {};
      for (const timeframe of TIMEFRAMES) {
        const series = feed.closedCandles(symbol, timeframe, closeTime);
        if (series.length > 0) candlesByTimeframe[timeframe] = series;
      }
      return {
        symbol,
        candles: closed15m,
        candlesByTimeframe,
        mark: closed15m.length > 0 ? closed15m[closed15m.length - 1].close : 0,
        fundingRate: 0,
      };
    });
    yield* Object.values(builder.buildAll(inputs));
  }
}

const stepsPerSymbol = Math.max(0, feed.stepCount - warmupBars);
console.log(`  states evaluated: ${stepsPerSymbol * symbols.length} (${stepsPerSymbol} steps per symbol)\n`);

const grid = DEFAULT_SWEEP_GRID;
const perSymbol = new Map<string, ReturnType<typeof sweepStructureLiquidity>>();
for (const symbol of symbols) perSymbol.set(symbol, sweepStructureLiquidity(statesFor([symbol]), grid));
const total = sweepStructureLiquidity(statesFor(symbols), grid);

const defaultAge = DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.maxSweepAgeCandles;
const defaultRr = DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.minimumRewardRisk;

console.log(`Baseline (defaults: age ${defaultAge}, RR ${defaultRr}): ${total.baselineSetups} distinct setup(s)`);
for (const symbol of symbols) {
  const sweep = perSymbol.get(symbol)!;
  console.log(`  ${symbol}: ${sweep.baselineSetups} distinct setup(s)`);
}

console.log('\nFiring matrix — one row per (age, RR) cell');
console.log('  ' + ['age', 'RR', 'setups', 'emissions', 'new vs default'].map((h) => h.padEnd(10)).join(''));
for (const row of total.cells) {
  for (const cell of row) {
    const rrLabel = cell.minimumRewardRisk < 0.1 ? 'off' : cell.minimumRewardRisk.toFixed(2);
    const delta = cell.newSetups > 0 ? `+${cell.newSetups}` : cell.lostSetups > 0 ? `-${cell.lostSetups}` : '';
    console.log('  ' + [String(cell.maxSweepAgeCandles), rrLabel, String(cell.distinctSetups), String(cell.emissions), delta || '—'].map((v) => v.padEnd(10)).join(''));
  }
}

const { age: ageAxis, rewardRisk: rrAxis } = marginalAxes(total, grid);
console.log('\nMarginal: sweep age relaxed, RR at default');
for (const cell of ageAxis) {
  const delta = cell.newSetups > 0 ? ` (+${cell.newSetups} new)` : cell.lostSetups > 0 ? ` (-${cell.lostSetups})` : '';
  console.log(`  age ${String(cell.maxSweepAgeCandles).padStart(3)} -> ${cell.distinctSetups} setup(s)${delta}`);
}
console.log('\nMarginal: reward-risk floor relaxed, age at default');
for (const cell of rrAxis) {
  const delta = cell.newSetups > 0 ? ` (+${cell.newSetups} new)` : cell.lostSetups > 0 ? ` (-${cell.lostSetups})` : '';
  const label = cell.minimumRewardRisk < 0.1 ? 'gate off ' : `RR ${cell.minimumRewardRisk.toFixed(2)}`;
  console.log(`  ${label} -> ${cell.distinctSetups} setup(s)${delta}`);
}

// The most relaxed cell shows the ceiling: what every other gate still allows through.
const mostRelaxed = total.cells[total.cells.length - 1].find((c) => c.minimumRewardRisk === grid.rewardRisks[grid.rewardRisks.length - 1])!;
console.log(`\nCeiling (age ${mostRelaxed.maxSweepAgeCandles}, RR ${mostRelaxed.minimumRewardRisk}): ${mostRelaxed.distinctSetups} distinct setup(s) — the hard bound from all other gates combined`);

const combos = fleetArg
  ? fleetArg.split(',').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const [age, rr] = pair.split(':').map(Number);
    if (!(age > 0) || !(rr >= 0)) throw new Error(`--fleet entries must look like 24:1.0, got "${pair}"`);
    return { age, rr };
  })
  : [];

for (const { age, rr } of combos) {
  const binance = {} as BinanceService;
  const fleet: BaseAgent[] = [
    new FundingArbAgent(binance),
    new MomentumAgent(binance),
    new StructureTrendAgent(binance),
    new StructureLiquidityAgent(binance, tunedStructureLiquidityOptions({ maxSweepAgeCandles: age, minimumRewardRisk: rr })),
    new MeanReversionAgent(binance),
    new CrowdingAgent(binance),
  ];
  const result = await new ReplayService({ agents: fleet, config: { warmupBars }, log: () => undefined }).run(data);
  const m = result.metrics;
  const slice = m.byStrategy['STRUCT-LIQ-η'];
  const learned = result.agentStats['STRUCT-LIQ-η'];
  const learnedNote = learned ? ` | ledger: ${learned.trades} graded, ${learned.wins} win(s), ${learned.totalR >= 0 ? '+' : ''}${learned.totalR.toFixed(1)}R` : '';
  console.log(`\nFleet replay @ age ${age} / RR ${rr}: ${m.totalTrades} trade(s) total, net ${m.netPnl >= 0 ? '+' : ''}${m.netPnl.toFixed(2)} USDT (${m.netReturnPct}%)`);
  console.log(`  STRUCT-LIQ: ${slice ? `${slice.trades} trade(s), win ${slice.winRatePct}%, net ${slice.netPnl.toFixed(2)} USDT` : '0 trade(s)'}${learnedNote}`);
}

console.log(`\nGrid: ages [${grid.sweepAges.join(', ')}] x RRs [${grid.rewardRisks.join(', ')}]`);
console.log('Notes: emissions repeat the same setup on following bars; distinct setups are what cooldowns turn into trades.');
console.log('      RR 0.01 is a diagnostic "reward-risk gate off" probe, not a tradable setting.');
