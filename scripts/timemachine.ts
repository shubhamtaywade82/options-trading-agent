/**
 * Time Machine: offline historical replay of the live strategy on real option premiums, with a block bootstrap
 * and Monte Carlo paths over the replayed days. Research only. It imports no order code and never touches the
 * live risk gate.
 *
 *   # 1. Build a dataset (read-only Dhan calls: intraday spot bars + /charts/rollingoption)
 *   npm run timemachine -- fetch --underlying NIFTY --from 2026-04-01 --to 2026-09-30 --lot-size 75
 *        [--expiry-flag WEEK] [--expiry-code 1] [--offsets 10] [--tick-size 0.05] [--spacing-ms 400]
 *        [--timeout-ms 30000] [--out data/research/NIFTY-2026-04-01-2026-09-30.json] [--dump-raw]
 *
 *   # 2. Replay it with the current config (no credentials, no network)
 *   npm run timemachine -- run --data data/research/NIFTY-2026-04-01-2026-09-30.json
 *        [--config config.paper.yml] [--seed 19] [--iterations 10000] [--horizon 20] [--split 0.6]
 *        [--half-spread-pct 1] [--stop-slippage-pct 1] [--drawdown-alarm 30000] [--json] [--trades trades.csv]
 *
 *   # 3. Replay several indices as one account (shared daily limit, per-side and open-position caps)
 *   npm run timemachine -- portfolio --data A.json,B.json,C.json [--config config.paper.yml] [--per-side 1]
 *
 * Split a fetch at every lot-size change: one dataset carries one lot size per range.
 */
import 'dotenv/config';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configFingerprint, loadConfig, KNOWN_UNDERLYINGS, type AgentConfig } from '../src/config.js';
import type { Candle, OptionType } from '../src/domain/types.js';
import { buildSessions, parseDataset, parseRollingOptionResponse, pivotByStrike, type ResearchDataset, type RollingBar } from '../src/research/dataset.js';
import { simulatePortfolio, type PortfolioTrade } from '../src/research/portfolio.js';
import { defaultCostModel, replayConfigFrom, replayDataset, type CostModel } from '../src/research/replay.js';
import { summarize } from '../src/research/stats.js';
import { DEFAULT_TIME_MACHINE_OPTIONS, formatReport, runTimeMachine } from '../src/research/timeMachine.js';
import { shiftDateKey } from '../src/time/ist.js';

/** Dhan's intraday chart window is 90 days and the rolling-option one 180; 30-day windows stay well inside both. */
const WINDOW_DAYS = 30;
/**
 * Every replay is another test on the same days; the best of k variants is optimistic by about a factor of k.
 * This log keeps k countable per dataset.
 */
const RUN_LOG = 'data/research/runs.jsonl';
const MAX_ATTEMPTS = 3;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function dateArgument(name: string): string {
  const value = required(name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be YYYY-MM-DD, got "${value}"`);
  }
  return value;
}

function numberArgument(name: string, fallback: number, check: (value: number) => boolean): number {
  const text = argument(name);
  if (text === undefined) {
    return fallback;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || !check(value)) {
    throw new Error(`${name} is out of range: "${text}"`);
  }
  return value;
}

function windows(fromDate: string, toDate: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let from = fromDate;
  while (from <= toDate) {
    const end = shiftDateKey(from, WINDOW_DAYS - 1);
    const to = end < toDate ? end : toDate;
    // Windows overlap by one day so an exclusive toDate never drops a session; bars are de-duplicated by time.
    out.push({ from, to: to === toDate ? to : shiftDateKey(to, 1) });
    from = shiftDateKey(to, 1);
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${label}: attempt ${attempt}/${MAX_ATTEMPTS} failed: ${message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1_000 * 2 ** attempt);
      }
    }
  }
  throw new Error(`${label}: gave up after ${MAX_ATTEMPTS} attempts (${lastError instanceof Error ? lastError.message : String(lastError)})`);
}

async function fetchDataset(): Promise<void> {
  const underlying = required('--underlying').toUpperCase();
  const optionSegment = KNOWN_UNDERLYINGS[underlying];
  if (optionSegment === undefined) {
    throw new Error(`unknown underlying ${underlying}; known: ${Object.keys(KNOWN_UNDERLYINGS).join(', ')}`);
  }
  const fromDate = dateArgument('--from');
  const toDate = dateArgument('--to');
  if (fromDate > toDate) {
    throw new Error('--from must not be after --to');
  }
  const lotSize = numberArgument('--lot-size', Number.NaN, (value) => Number.isInteger(value) && value > 0);
  if (Number.isNaN(lotSize)) {
    throw new Error('--lot-size is required: lot sizes change, so the one in force over the range must be given');
  }
  const tickSize = numberArgument('--tick-size', 0.05, (value) => value > 0);
  const barMinutes = numberArgument('--interval', 5, (value) => [1, 5, 15, 25, 60].includes(value));
  const offsets = numberArgument('--offsets', 10, (value) => Number.isInteger(value) && value >= 0 && value <= 10);
  const expiryCode = numberArgument('--expiry-code', 1, (value) => Number.isInteger(value) && value >= 1 && value <= 3);
  const expiryFlag = (argument('--expiry-flag') ?? 'WEEK').toUpperCase();
  if (expiryFlag !== 'WEEK' && expiryFlag !== 'MONTH') {
    throw new Error('--expiry-flag must be WEEK or MONTH');
  }
  const spacingMs = numberArgument('--spacing-ms', 400, (value) => value >= 0);
  const timeoutMs = numberArgument('--timeout-ms', 30_000, (value) => value > 0);
  const out = argument('--out') ?? `data/research/${underlying}-${fromDate}-${toDate}.json`;

  const { createDhanClient } = await import('../src/dhan/client.js');
  const { InstrumentMaster } = await import('../src/dhan/instrumentMaster.js');
  const { DhanMarketData } = await import('../src/dhan/marketData.js');
  const { createConsoleLogger } = await import('../src/ops/logger.js');
  const { istParts } = await import('../src/time/ist.js');

  const config = loadConfig({ ...process.env, MODE: 'paper' });
  const client = await createDhanClient(config.dhan, { logger: createConsoleLogger(), timeoutMs });
  const master = new InstrumentMaster(client.instruments, () => istParts(Date.now()).date);
  const market = new DhanMarketData(client, { istShiftedTimestamps: config.feed.istShiftedTimestamps });
  const spotRef = await master.resolveSpot(underlying);

  const spot: Candle[] = [];
  const rolling: Record<OptionType, RollingBar[][]> = { CE: [], PE: [] };
  const dumped = new Set<OptionType>();
  for (const window of windows(fromDate, toDate)) {
    console.error(`${underlying} ${window.from}..${window.to}: spot bars`);
    spot.push(...(await withRetry(`spot ${window.from}`, () => market.intradayCandles(spotRef, barMinutes, window.from, window.to))));
    for (const optionType of ['CE', 'PE'] as const) {
      for (let offset = -offsets; offset <= offsets; offset += 1) {
        const strike = offset === 0 ? 'ATM' : offset > 0 ? `ATM+${offset}` : `ATM${offset}`;
        await sleep(spacingMs);
        const raw = await withRetry(`${optionType} ${strike} ${window.from}`, () =>
          client.expiredOptionsData.fetch({
            securityId: spotRef.securityId,
            exchangeSegment: optionSegment,
            instrument: 'OPTIDX',
            expiryFlag,
            expiryCode,
            strike,
            drvOptionType: optionType === 'CE' ? 'CALL' : 'PUT',
            interval: String(barMinutes),
            requiredData: ['open', 'high', 'low', 'close', 'volume', 'strike', 'iv', 'oi'],
            fromDate: window.from,
            toDate: window.to,
          }),
        );
        if (flag('--dump-raw') && !dumped.has(optionType)) {
          dumped.add(optionType);
          const rawPath = `${out}.raw-${optionType}.json`;
          await mkdir(dirname(rawPath), { recursive: true });
          await writeFile(rawPath, JSON.stringify(raw, null, 2));
          console.error(`raw ${optionType} response written to ${rawPath}`);
        }
        rolling[optionType].push(parseRollingOptionResponse(raw, optionType, config.feed.istShiftedTimestamps));
      }
    }
  }

  const calls = pivotByStrike(rolling.CE);
  const puts = pivotByStrike(rolling.PE);
  const uniqueSpot = [...new Map(spot.map((bar) => [bar.time, bar])).values()].sort((a, b) => a.time - b.time);
  const dataset: ResearchDataset = {
    version: 1,
    underlying,
    optionSegment,
    barMinutes,
    source: {
      kind: 'dhan_rollingoption',
      expiryFlag,
      expiryCode,
      offsets,
      fetchedAt: new Date().toISOString(),
      conflictingBars: calls.conflicts + puts.conflicts,
    },
    sessions: buildSessions({ spot: uniqueSpot, calls: calls.byStrike, puts: puts.byStrike, lotSize, tickSize, fromDate, toDate }),
  };
  // Round-trip through the validator so a file on disk is always one `run` accepts.
  parseDataset(JSON.parse(JSON.stringify(dataset)));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(dataset));
  console.log(`wrote ${out}: ${dataset.sessions.length} sessions, ${dataset.source.conflictingBars} conflicting bars`);
}

/** The replay never calls the broker. Placeholders satisfy config validation without real credentials. */
function offlineConfig(configPath: string | undefined): AgentConfig {
  const env: Record<string, string | undefined> = { ...process.env, MODE: 'paper' };
  env.DHAN_CLIENT_ID ??= 'offline-research';
  if (env.DHAN_ACCESS_TOKEN === undefined && env.DHAN_PIN === undefined && env.DHAN_TOTP_SECRET === undefined) {
    env.DHAN_ACCESS_TOKEN = 'offline-research';
  }
  env.DATABASE_URL ??= 'postgres://offline-research@127.0.0.1:5432/offline_research';
  return loadConfig(env, configPath);
}

function costsArgument(config: AgentConfig): CostModel {
  const fallbackCosts = defaultCostModel(config);
  return {
    halfSpreadPct: numberArgument('--half-spread-pct', fallbackCosts.halfSpreadPct, (value) => value >= 0 && value <= 20),
    stopSlippagePct: numberArgument('--stop-slippage-pct', fallbackCosts.stopSlippagePct, (value) => value >= 0 && value <= 20),
  };
}

async function runReplay(): Promise<void> {
  const dataPath = required('--data');
  const configPath = argument('--config');
  const config = offlineConfig(configPath);
  const dataset = parseDataset(JSON.parse(await readFile(dataPath, 'utf8')));
  const { replay, divergences } = replayConfigFrom(config);
  const costs = costsArgument(config);
  const report = runTimeMachine(dataset, replay, costs, divergences, {
    ...DEFAULT_TIME_MACHINE_OPTIONS,
    seed: numberArgument('--seed', DEFAULT_TIME_MACHINE_OPTIONS.seed, (value) => Number.isInteger(value) && value >= 0 && value < 2 ** 32),
    iterations: numberArgument('--iterations', DEFAULT_TIME_MACHINE_OPTIONS.iterations, (value) => Number.isInteger(value) && value >= 100 && value <= 1_000_000),
    horizonDays: numberArgument('--horizon', DEFAULT_TIME_MACHINE_OPTIONS.horizonDays, (value) => Number.isInteger(value) && value >= 1),
    splitFraction: numberArgument('--split', DEFAULT_TIME_MACHINE_OPTIONS.splitFraction, (value) => value > 0 && value < 1),
    drawdownAlarmInr: numberArgument('--drawdown-alarm', (config.capital.inr * config.capital.maxDailyLossPct) / 100, (value) => value > 0),
  });
  const tradesPath = argument('--trades');
  if (tradesPath !== undefined) {
    const header = 'date,strategy,direction,optionType,strike,entryTime,exitTime,entryPrice,exitPrice,lots,quantity,riskInr,grossPnlInr,chargesInr,netPnlInr,r,exitReason,ambiguousBar,gapThroughStop';
    const rows = report.trades.map((t) =>
      [t.date, t.strategy, t.direction, t.optionType, t.strike, new Date(t.entryTime).toISOString(), new Date(t.exitTime).toISOString(), t.entryPrice, t.exitPrice, t.lots, t.quantity, t.riskInr, t.grossPnlInr, t.chargesInr, t.netPnlInr, t.r, t.exitReason, t.ambiguousBar, t.gapThroughStop].join(','),
    );
    await writeFile(tradesPath, [header, ...rows].join('\n') + '\n');
  }
  const run = {
    ts: new Date().toISOString(),
    data: dataPath,
    config: configPath ?? null,
    configFingerprint: configFingerprint(config),
    costs,
    trades: report.overall.trades,
    meanR: report.overall.meanR,
    verdict: report.verdict,
  };
  await mkdir(dirname(RUN_LOG), { recursive: true });
  await appendFile(RUN_LOG, `${JSON.stringify(run)}\n`);
  console.log(flag('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
}

/**
 * Replays several indices under one account: each index runs with no daily limit, then the shared daily limit
 * and the per-side and open-position caps are applied across them on one timeline.
 */
async function runPortfolio(): Promise<void> {
  const dataPaths = required('--data').split(',');
  const config = offlineConfig(argument('--config'));
  const costs = costsArgument(config);
  const { replay } = replayConfigFrom(config);
  const unlimited = { ...replay, capital: { ...replay.capital, maxDailyLossPct: 100 } };
  const trades: PortfolioTrade[] = [];
  const dates = new Set<string>();
  for (const dataPath of dataPaths) {
    const dataset = parseDataset(JSON.parse(await readFile(dataPath, 'utf8')));
    const result = replayDataset(dataset, unlimited, costs);
    result.dates.forEach((date) => dates.add(date));
    trades.push(...result.trades.filter((trade) => trade.exitReason !== 'DATA_GAP').map((trade) => ({ ...trade, underlying: dataset.underlying })));
  }
  const rules = {
    dailyLossLimitInr: (config.capital.inr * config.capital.maxDailyLossPct) / 100,
    maxPositionsPerSide: numberArgument('--per-side', config.capital.maxPositionsPerSide, (value) => Number.isInteger(value) && value >= 1),
    maxOpenPositions: config.capital.maxOpenPositions,
  };
  const { taken, skipped } = simulatePortfolio(trades, rules);
  const summary = summarize([...taken].sort((a, b) => a.exitTime - b.exitTime), dates.size);
  console.log(`Portfolio: ${dataPaths.length} indices, ${dates.size} days, per side ${rules.maxPositionsPerSide}, open ${rules.maxOpenPositions}, daily limit ₹${rules.dailyLossLimitInr}`);
  console.log(`  trades ${summary.trades} of ${trades.length}; skipped ${JSON.stringify(skipped)}`);
  console.log(`  total net ₹${summary.totalNetInr.toFixed(0)}, mean net R ${summary.meanR}, win rate ${summary.winRate}, profit factor ${summary.profitFactor}, max drawdown ₹${summary.maxDrawdownInr.toFixed(0)}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'fetch') {
    await fetchDataset();
  } else if (command === 'run') {
    await runReplay();
  } else if (command === 'portfolio') {
    await runPortfolio();
  } else {
    throw new Error('usage: npm run timemachine -- fetch|run|portfolio [options] (see scripts/timemachine.ts)');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
