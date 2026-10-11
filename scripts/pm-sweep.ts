/**
 * Variant sweeps on real klines (Binance public data archive, no API needed).
 *
 *   npx tsx scripts/pm-sweep.ts --symbol SOLUSDT --days 90 [--end-days-ago 90] [--study pm|regime] [--json]
 *
 * Fetches the klines once, then replays the same fleet once per variant, so the only difference between rows is the
 * variable under study:
 *   --study pm      (default) exit management: manager off vs each position-manager variant
 *   --study regime  regime model: the classic first-match classifier vs the scored regime with hysteresis (manager off)
 * Use --end-days-ago to score a window the variants were not tuned on.
 */
import { fetchArchiveKlines } from '../src/backtesting/archiveKlines.js';
import { ReplayService } from '../src/backtesting/ReplayService.js';
import type { ReplayData } from '../src/backtesting/types.js';
import { DEFAULT_PM_CONFIG, type PmConfig } from '../src/position/PositionManager.js';
import type { NativeTimeframe } from '../src/market/MarketDataTypes.js';
import { pmConfigFromEnv } from '../src/position/pmConfig.js';
import type { RegimeOptions } from '../src/market/RegimeScoring.js';

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
};
const symbol = arg('symbol', 'BTCUSDT').toUpperCase();
const days = Number(arg('days', '90'));
const endDaysAgo = Number(arg('end-days-ago', '0'));
const json = process.argv.includes('--json');
const study = arg('study', 'pm');
if (!['pm', 'regime'].includes(study)) throw new Error('--study must be pm or regime');

const base = pmConfigFromEnv();
interface Variant { name: string; pm?: Partial<PmConfig>; regime?: Partial<RegimeOptions> | null }
const pmVariants: Variant[] = [
  { name: 'off' },
  { name: 'default (35%@1R, BE+trail after TP1)', pm: {} },
  { name: 'partial only (35%@1R, original stop/target)', pm: { tp2R: Infinity, breakevenAfter: 'NEVER', trailStartR: Infinity } },
  { name: 'partial @1.5R only', pm: { tp1R: 1.5, tp2R: Infinity, breakevenAfter: 'NEVER', trailStartR: Infinity } },
  { name: 'late BE+trail (after TP2 @2R)', pm: { breakevenAfter: 'TP2', trailStartR: 2 } },
  { name: 'wide trail (4/5/6 ATR)', pm: { trailAtr: { LOW: 4, MEDIUM: 5, HIGH: 6 } } },
  { name: 'BE at TP1, trail from 2R', pm: { trailStartR: 2 } },
];

const regimeVariants: Variant[] = [
  { name: 'classic regime', regime: null },
  { name: 'scored, confirm 1 bar (hysteresis only)', regime: { confirmBars: 1 } },
  { name: 'scored, confirm 2 bars', regime: { confirmBars: 2 } },
  { name: 'scored, confirm 3 bars', regime: { confirmBars: 3 } },
  { name: 'scored, confirm 2, enter .60 / exit .45', regime: { confirmBars: 2, trendEnter: 0.6, trendExit: 0.45 } },
];
const variants = study === 'pm' ? pmVariants : regimeVariants;

const toMs = Date.now() - endDaysAgo * 86_400_000;
const fromMs = toMs - days * 86_400_000;
const data: ReplayData = { [symbol]: {} };
for (const timeframe of ['15m', '1h', '4h'] as NativeTimeframe[]) {
  const { candles } = await fetchArchiveKlines(symbol, timeframe, fromMs, toMs);
  if (candles.length === 0) throw new Error(`no ${timeframe} candles for ${symbol}`);
  data[symbol]![timeframe] = candles;
}

const rows: Array<Record<string, number | string | null>> = [];
for (const variant of variants) {
  const pm: PmConfig = { ...base, ...(variant.pm ?? {}) };
  const result = await new ReplayService({
    config: {
      decisionsPath: null, positionManager: study === 'pm' && variant.pm !== undefined, pm, regime: study === 'regime' ? variant.regime : null,
      funding: { enabled: true, intervalHours: 8, rate: 0.0001 },
    },
  }).run(data);
  const m = result.metrics;
  rows.push({
    symbol, window: endDaysAgo === 0 ? `last ${days}d` : `${days}d ending ${endDaysAgo}d ago`, variant: variant.name,
    trades: m.totalTrades, winPct: m.winRatePct, expectancyR: m.expectancyR === null ? null : Number(m.expectancyR.toFixed(3)),
    profitFactor: m.profitFactor === null ? null : Number(m.profitFactor.toFixed(2)), netPnl: Number(m.netPnl.toFixed(2)),
    maxDdPct: m.maxDrawdownPct, largestWin: Number(m.largestWinUsd.toFixed(2)),
  });
}
if (json) console.log(JSON.stringify(rows));
else {
  console.log(`\n${symbol} · ${rows[0]!.window}`);
  console.log('variant'.padEnd(48) + 'trades  win%   E[R]    PF     net PnL   maxDD%  bigWin');
  for (const r of rows) console.log(String(r.variant).padEnd(48) + String(r.trades).padEnd(8) + String(r.winPct).padEnd(7) + String(r.expectancyR).padEnd(8) + String(r.profitFactor).padEnd(7) + String(r.netPnl).padEnd(10) + String(r.maxDdPct).padEnd(8) + String(r.largestWin));
}
void DEFAULT_PM_CONFIG;
