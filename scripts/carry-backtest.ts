/**
 * Funding-carry backtest on real Binance history: long spot + short the USDT-M perp, delta-neutral.
 *
 *   npx tsx scripts/carry-backtest.ts [--symbols BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT] [--days 365] [--end-days-ago 0]
 *                                     [--leverage 2] [--lookback 3] [--min-hold 0] [--spot-fee 0.001] [--perp-fee 0.0004] [--slippage 0.0002]
 *
 * Public endpoints only (no keys): /fapi/v1/fundingRate, perp mark-price 1h klines (liquidation and funding notional
 * follow mark price), and spot 1h klines. The grid is fixed and small on purpose
 * (always-in, plus three entry/exit pairs): pick ONE rule before looking, then confirm it on --end-days-ago windows.
 * Funding received is credited on the perp notional; entering and leaving cost four fills; a perp that trades through the
 * isolated-margin liquidation price loses its margin. No borrow, no spot yield, no capital cost beyond the capital base.
 */
import { aprToRate, simulateCarry, type Bar, type CarryParams, type FundingPoint } from '../src/backtesting/CarryBacktest.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const num = (name: string, fallback: number): number => {
  const v = Number(arg(name, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a non-negative number`);
  return v;
};

const symbols = arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const days = num('days', 365);
const endDaysAgo = num('end-days-ago', 0);
const leverage = num('leverage', 2);
const lookback = Math.max(1, Math.round(num('lookback', 3)));
const minHold = Math.max(0, Math.round(num('min-hold', 0)));
const costs = { spotFeeRate: num('spot-fee', 0.001), perpFeeRate: num('perp-fee', 0.0004), slippageRate: num('slippage', 0.0002) };
const toMs = Date.now() - endDaysAgo * 86_400_000;
const fromMs = toMs - days * 86_400_000;
const HOUR = 3_600_000;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function fetchFunding(symbol: string): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  for (let cursor = fromMs; cursor < toMs;) {
    const rows = (await getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${toMs}&limit=1000`)) as { fundingTime: number; fundingRate: string }[];
    if (rows.length === 0) break;
    for (const r of rows) out.push({ time: Number(r.fundingTime), rate: Number(r.fundingRate) });
    cursor = Number(rows[rows.length - 1].fundingTime) + 1;
    if (rows.length < 1000) break;
  }
  return out;
}

async function fetchBars(base: string, path: string, symbol: string, limit: number): Promise<Bar[]> {
  const out: Bar[] = [];
  for (let cursor = fromMs; cursor < toMs;) {
    const rows = (await getJson(`${base}${path}?symbol=${symbol}&interval=1h&startTime=${cursor}&endTime=${toMs}&limit=${limit}`)) as unknown[][];
    if (rows.length === 0) break;
    for (const k of rows) out.push({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) });
    cursor = Number(rows[rows.length - 1][0]) + HOUR;
    if (rows.length < limit) break;
  }
  return out;
}

const grid: { label: string; entryApr: number; exitApr: number }[] = [
  { label: 'always in', entryApr: Number.NEGATIVE_INFINITY, exitApr: Number.NEGATIVE_INFINITY },
  { label: 'in >= 5% APR, out < 0%', entryApr: 0.05, exitApr: 0 },
  { label: 'in >= 10% APR, out < 3%', entryApr: 0.10, exitApr: 0.03 },
  { label: 'in >= 20% APR, out < 5%', entryApr: 0.20, exitApr: 0.05 },
];

const f = (v: number, d = 2): string => v.toFixed(d).padStart(7);
console.log(`funding carry · ${new Date(fromMs).toISOString().slice(0, 10)} -> ${new Date(toMs).toISOString().slice(0, 10)} · perp ${leverage}x isolated · lookback ${lookback} intervals · min hold ${minHold} intervals`);
console.log(`costs per fill: spot ${(costs.spotFeeRate * 100).toFixed(3)}% + perp ${(costs.perpFeeRate * 100).toFixed(3)}% fees, ${(costs.slippageRate * 100).toFixed(3)}% slippage; one full cycle = four fills`);

const pooled = new Map<string, number[]>();
for (const symbol of symbols) {
  const [funding, perp, spot] = await Promise.all([
    fetchFunding(symbol),
    // Mark-price bars: Binance liquidates and settles funding on mark price, so last-price wicks must not trigger liquidations
    fetchBars('https://fapi.binance.com', '/fapi/v1/markPriceKlines', symbol, 1500),
    fetchBars('https://api.binance.com', '/api/v3/klines', symbol, 1000),
  ]);
  if (funding.length < lookback + 2 || perp.length === 0 || spot.length === 0) { console.log(`\n${symbol}: not enough data`); continue; }
  const rates = funding.map((x) => x.rate);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const negative = rates.filter((r) => r < 0).length / rates.length;
  console.log(`\n${symbol}: ${funding.length} funding intervals · mean funding ${(mean * 3 * 365 * 100).toFixed(2)}% APR · negative ${(negative * 100).toFixed(0)}% of intervals`);
  console.log('  rule                       cycles  inMkt%  funding%  basis%  costs%   net%  net%/cap  APR%/cap  maxDD%  liq');
  for (const g of grid) {
    const params: CarryParams = { entryApr: g.entryApr, exitApr: g.exitApr, lookback, perpLeverage: leverage, maintenanceMarginRate: 0.005, costs, minHoldIntervals: minHold };
    const r = simulateCarry(funding, spot, perp, params);
    (pooled.get(g.label) ?? pooled.set(g.label, []).get(g.label)!).push(r.annualisedOnCapitalPct);
    console.log(`  ${g.label.padEnd(26)} ${String(r.cycles.length).padStart(6)} ${f(r.timeInMarketPct, 0)} ${f(r.fundingPct)} ${f(r.basisPct)} ${f(r.costsPct)} ${f(r.netPct)} ${f(r.netOnCapitalPct)} ${f(r.annualisedOnCapitalPct)} ${f(r.maxDrawdownPct)} ${String(r.liquidations).padStart(4)}`);
  }
}

console.log('\nequal-weight mean of annualised return on capital across symbols');
for (const g of grid) {
  const v = pooled.get(g.label) ?? [];
  if (v.length > 0) console.log(`  ${g.label.padEnd(26)} ${f(v.reduce((a, b) => a + b, 0) / v.length)} % APR on capital (${v.length} symbols)`);
}
console.log('\nNo borrow cost, no spot yield and unlimited size assumed; funding regimes change. One window is a screen: re-run with --end-days-ago 365.');
