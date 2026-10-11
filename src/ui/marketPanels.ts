import chalk from 'chalk';
import stringWidth from 'string-width';
import { config } from '../config.js';
import { formatPrice, formatQty } from '../binance/symbolRules.js';
import type { AdaptiveInfo, LogEntry, MarketPriceInfo, Mode, Position, StrategyMetrics } from '../types.js';
import { boxLines, dp, fmtRange, fmtVol, orDash, padLine, pnlColor, rule, signedDp, signedUsd, usd, wrapTokens } from './format.js';
import type { CockpitProps } from './panels.js';

// Training period (100) plus ATR length (10) minus the first bar, which has no previous close
const ADAPTIVE_WARMUP_CANDLES = 109;
const PERCENT = 100;
const WARMING_UP = `warming up (needs ${ADAPTIVE_WARMUP_CANDLES} closed candles)`;
const LIVE_DISABLED = 'disabled in live mode'; // dynamic exits are paper-only, so no adaptive bars exist
const LOG_AGENT_WIDTH = 13; // longest AgentId, ADAPTIVE-ST-ζ
const LOG_LEVEL_COLOR: Record<LogEntry['level'], (text: string) => string> = { error: chalk.red, warn: chalk.yellow, success: chalk.green, info: chalk.white };

const shortName = (symbol: string) => symbol.replace('USDT', '');
const symbolsWith = (bySymbol: Record<string, unknown>) => config.symbols.filter((symbol) => symbol in bySymbol);
const arrow = (info: AdaptiveInfo) => (info.direction === 'BULLISH' ? chalk.green('▲') : chalk.red('▼'));
const separator = (width: number) => padLine(` ${chalk.gray(rule('─', Math.max(10, width - 2)))}`, width);
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

function formatTrend(trend: string | undefined): string {
  if (!trend || trend === '—') return chalk.gray('—');
  const upper = trend.toUpperCase();
  if (upper.includes('BULL') || upper.includes('UP')) return chalk.green('▲ BULLISH');
  if (upper.includes('BEAR') || upper.includes('DOWN')) return chalk.red('▼ BEARISH');
  if (upper.includes('NEUT') || upper.includes('FLAT') || upper.includes('RANGE')) return chalk.gray('■ NEUTRAL');
  return chalk.gray(trend);
}

function symbolTrend(p: CockpitProps, symbol: string, info: MarketPriceInfo | undefined): string | undefined {
  const short = shortName(symbol);
  return info?.trend
    ?? p.strategyMetrics?.adaptive[symbol]?.direction
    ?? p.strategyMetrics?.adaptive[short]?.direction
    ?? p.marketIntel?.[symbol]?.ltfTrend
    ?? p.marketIntel?.[short]?.ltfTrend;
}

function assetCells(symbol: string, info: MarketPriceInfo | undefined, trend?: string) {
  const chgCol = !info ? chalk.gray : info.changePct < 0 ? chalk.red : chalk.green;
  return {
    name: shortName(symbol),
    price: (info ? `$${formatPrice(symbol, info.price)}` : '—').padStart(11),
    chgCol,
    chg: (info ? `${signedDp(info.changePct)}%` : '—').padStart(8),
    trend: formatTrend(trend ?? info?.trend),
    range: fmtRange(symbol, info?.low24h, info?.high24h),
    vol: fmtVol(info?.volumeQuote),
  };
}

const WIDE_HEADER = ` ${chalk.gray('ASSET'.padEnd(5))} ${chalk.gray('PRICE'.padStart(11))}  ${chalk.gray('24h CHG'.padStart(8))}  ${chalk.gray('│ 24h RANGE'.padEnd(25))} ${chalk.gray('│ 24h VOLUME'.padStart(12))}  ${chalk.gray('│ 15m TREND')}`;

function wideAssetRow(symbol: string, info: MarketPriceInfo | undefined, trend?: string): string {
  const c = assetCells(symbol, info, trend);
  return ` ${chalk.yellow.bold(c.name.padEnd(5))} ${chalk.white(c.price)}  ${c.chgCol(c.chg)}  ${chalk.gray('│ ')}${chalk.white(c.range.padEnd(23))} ${chalk.gray('│ ')}${chalk.cyan(c.vol.padStart(10))}  ${chalk.gray('│ ')}${c.trend}`;
}

function narrowAssetRows(symbol: string, info: MarketPriceInfo | undefined, trend: string | undefined, width: number): string[] {
  const c = assetCells(symbol, info, trend);
  const l1 = ` ${chalk.yellow.bold(c.name.padEnd(4))} ${chalk.white(c.price.trim().padStart(9))} ${c.chgCol(c.chg)} ${chalk.gray('│ ')}${c.trend}`;
  const l2 = `   ${chalk.gray('24h')} ${chalk.white(c.range.padEnd(24))} ${chalk.gray('│ ')}${chalk.cyan(('Vol ' + c.vol).padStart(11))}`;
  return [padLine(l1, width), padLine(l2, width)];
}

function momentumLabel({ up, total }: { up: number; total: number }): string {
  if (total === 0) return chalk.gray('—');
  const label = up === total ? chalk.green('BULLISH') : up === 0 ? chalk.red('BEARISH') : chalk.yellow('MIXED');
  return `${label} ${chalk.gray(`(${up} of ${total} above EMA50)`)}`;
}

function carryLabel(metrics: StrategyMetrics | null): string {
  const aprs = Object.values(metrics?.fundingBySymbol ?? {}).map((f) => f.apr);
  if (aprs.length === 0) return chalk.gray('—');
  const avg = mean(aprs);
  const label = Number(avg.toFixed(2)) > 0 ? chalk.green('POSITIVE') : Number(avg.toFixed(2)) < 0 ? chalk.red('NEGATIVE') : chalk.gray('FLAT');
  return `${label} ${chalk.gray(`(${signedDp(avg)}% APR avg)`)}`;
}

function trendRows(adaptive: Record<string, AdaptiveInfo>, width: number, mode: Mode): string[] {
  const tokens = symbolsWith(adaptive).map((symbol) => `${chalk.white(shortName(symbol))} ${arrow(adaptive[symbol])} ${chalk.gray(adaptive[symbol].regime)}`);
  if (tokens.length === 0) return [padLine(`   ${chalk.gray('Trend     │ ')}${chalk.gray(mode === 'live' ? LIVE_DISABLED : 'warming up')}`, width)];
  return wrapTokens(tokens, width - 15).map((line, i) => padLine(`   ${chalk.gray(i === 0 ? 'Trend     │ ' : '          │ ')}${line}`, width));
}

function intelRows(intel: Record<string, import('../types.js').MarketIntelSummary> | undefined, width: number): string[] {
  if (!intel || Object.keys(intel).length === 0) return [];
  const label = (text: string) => chalk.gray(`${text.padEnd(10)}│ `);
  const struct = Object.entries(intel).map(([sym, s]) => {
    const loc = s.discount ? chalk.green('disc') : s.premium ? chalk.red('prem') : chalk.gray('eq');
    const t = s.htfTrend === 'BULLISH' ? chalk.green('▲') : s.htfTrend === 'BEARISH' ? chalk.red('▼') : chalk.gray('■');
    return `${chalk.white(shortName(sym))} ${t}${loc}`;
  });
  const crowd = Object.entries(intel).map(([sym, s]) => {
    const c = s.crowding === 'LONG_CROWDED' ? chalk.red('LC') : s.crowding === 'SHORT_CROWDED' ? chalk.green('SC') : chalk.gray('BL');
    return `${chalk.white(shortName(sym))} ${c}`;
  });
  return [
    padLine(`   ${label('SMC Struct')}${struct.join(' ')}`, width),
    padLine(`   ${label('Crowding')}${crowd.join(' ')}`, width),
  ];
}

function regimeRows(p: CockpitProps, width: number): string[] {
  const volumes = config.symbols.map((symbol) => p.spotPrices?.[shortName(symbol)]?.volumeQuote).filter((v): v is number => v !== undefined);
  const turnover = volumes.length === 0 ? '—' : `${fmtVol(volumes.reduce((sum, v) => sum + v, 0))} 24h futures vol`;
  const metrics = p.strategyMetrics;
  const label = (text: string) => chalk.gray(`${text.padEnd(10)}│ `);
  return [
    padLine(` ${chalk.cyan.bold('MARKET REGIME & VOLATILITY')}`, width),
    padLine(`   ${label('Turnover')}${chalk.white(turnover)}`, width),
    padLine(`   ${label('Momentum')}${metrics ? momentumLabel(metrics.momentumAboveEma50) : chalk.gray('—')}`, width),
    padLine(`   ${label('Carry')}${carryLabel(metrics)}`, width),
    ...trendRows(metrics?.adaptive ?? {}, width, p.mode),
    ...intelRows(p.marketIntel, width),
  ];
}

function fundingHeader(metrics: StrategyMetrics | null, width: number): string {
  const rates = Object.values(metrics?.fundingBySymbol ?? {}).map((f) => f.rate);
  const funding = rates.length === 0 ? '—' : `${signedDp(mean(rates) * PERCENT, 4)}%`;
  return padLine(` ${chalk.gray('USDM Funding 8h: ')}${chalk.white(funding)}${chalk.gray(' │ settle in ')}${chalk.cyan.bold(metrics?.nextFundingCountdown ?? '—')}`, width);
}

export function renderCol2Lines(p: CockpitProps, width: number = 52, rowCount: number = 29): string[] {
  const infoOf = (symbol: string) => p.spotPrices?.[shortName(symbol)];
  const trendOf = (symbol: string) => symbolTrend(p, symbol, infoOf(symbol));
  // Trends and ranges vary in width, so the wide layout is used only when every row really fits
  const wideRows = config.symbols.map((symbol) => wideAssetRow(symbol, infoOf(symbol), trendOf(symbol)));
  const isWide = [WIDE_HEADER, ...wideRows].every((row) => stringWidth(row) <= width);
  const rows: string[] = [fundingHeader(p.strategyMetrics, width), separator(width)];
  if (isWide) rows.push(padLine(WIDE_HEADER, width), separator(width), ...wideRows.map((row) => padLine(row, width)));
  else rows.push(...config.symbols.flatMap((symbol) => narrowAssetRows(symbol, infoOf(symbol), trendOf(symbol), width)));
  rows.push(separator(width), ...regimeRows(p, width));
  while (rows.length < rowCount) rows.push(rule(' ', width));
  return rows.slice(0, rowCount);
}

function levelText(symbol: string, level: string): string {
  const isNumeric = level.trim() !== '' && Number.isFinite(Number(level));
  return isNumeric ? `$${formatPrice(symbol, Number(level))}` : level || '—';
}

export function renderDetailLines(pos: Position | undefined, width: number = 128): string[] {
  if (!pos) return boxLines('POSITION DETAIL (selected)', [' ' + chalk.gray('no open position selected'), ' ' + chalk.gray('—')], width);
  const { symbol } = pos;
  const l1 = ' ' + chalk.yellow.bold(`${symbol} ${pos.side}`) + ' · ' + chalk.cyan(pos.strategy) + chalk.gray(' │ entry ') + chalk.white(`$${formatPrice(symbol, pos.entry)}`)
    + chalk.gray(' │ size ') + chalk.white(formatQty(symbol, pos.qty)) + chalk.gray(' │ mark ') + chalk.white(`$${formatPrice(symbol, pos.mark)}`)
    + chalk.gray(' │ uPnL ') + pnlColor(pos.upnl)(`${signedUsd(pos.upnl)} (${signedDp(pos.upnlPct)}%)`) + chalk.gray(' │ lev ') + chalk.yellow(`${pos.leverage}x ${pos.marginType}`);
  const margin = pos.leverage > 0 ? `$${usd((pos.qty * pos.mark) / pos.leverage)}` : '—';
  const oneR = orDash(pos.initialRisk, (risk) => `$${usd(risk * pos.qty)}`);
  const l2 = ' ' + chalk.gray('liq dist ') + chalk.cyan(orDash(pos.liqDistancePct, (d) => `${dp(d)}%`)) + chalk.gray(' │ SL ') + chalk.white(levelText(symbol, pos.serverSl))
    + chalk.gray(' │ TP ') + chalk.white(levelText(symbol, pos.serverTp)) + chalk.gray(' │ margin ') + chalk.white(margin) + chalk.gray(' │ 1R ') + chalk.white(oneR);
  return boxLines('POSITION DETAIL (selected)', [l1, l2], width);
}

function fundingRow(m: StrategyMetrics): string {
  const perSymbol = symbolsWith(m.fundingBySymbol).map((symbol) => {
    const { rate, apr } = m.fundingBySymbol[symbol];
    return `${shortName(symbol)} ${signedDp(rate * PERCENT, 4)}% (${dp(apr)}% APR)`;
  });
  return `${perSymbol.length > 0 ? perSymbol.join('  ') : '—'} │ next ${m.nextFundingCountdown ?? '—'} est ${orDash(m.estNextFundingUsd, signedUsd)}`;
}

function momentumRow(m: StrategyMetrics): string {
  const perSymbol = symbolsWith(m.atrBySymbol).map((symbol) => {
    const atr = m.atrBySymbol[symbol];
    return `${shortName(symbol)} ATR ${atr > 0 ? formatPrice(symbol, atr) : '—'}`;
  });
  return `${perSymbol.length > 0 ? perSymbol.join('  ') : 'ATR —'} │ EMA50 ${m.momentumAboveEma50.up}/${m.momentumAboveEma50.total}`;
}

function adaptiveRow(m: StrategyMetrics | null, mode: Mode): string {
  if (mode === 'live') return LIVE_DISABLED;
  if (!m) return WARMING_UP;
  const perSymbol = symbolsWith(m.adaptive).map((symbol) => {
    const info = m.adaptive[symbol];
    return `${shortName(symbol)} ${info.direction === 'BULLISH' ? '▲' : '▼'} ${info.regime} ${formatPrice(symbol, info.superTrend)} (${dp(info.distanceAtr)} ATR)`;
  });
  return perSymbol.length > 0 ? perSymbol.join('  ') : WARMING_UP;
}

export function renderMetricsLines(m: StrategyMetrics | null, width: number = 128, mode: Mode = 'paper'): string[] {
  const row = (label: string, body: string) => ' ' + chalk.cyan.bold(label.padEnd(12)) + chalk.gray('│ ' + body);
  const z = orDash(m?.zscoreBtcEth, (value) => signedDp(value));
  const rows = [
    row('FUNDING-ARB', m ? fundingRow(m) : '— │ next — est —'),
    row('DIVERGENCE', `BTC/ETH z ${z} (info only)`),
    row('MOMENTUM', m ? momentumRow(m) : 'ATR — │ EMA50 —'),
    row('ADAPTIVE-ST', adaptiveRow(m, mode)),
  ];
  return boxLines('STRATEGY METRICS (live agent telemetry · binance-only)', rows, width);
}

export function renderLogLines(logs: LogEntry[], maxRows: number = 10, width: number = 128): string[] {
  const content: string[] = [];
  for (let i = 0; i < maxRows; i++) {
    const entry = logs[i];
    if (!entry) {
      content.push('');
      continue;
    }
    const time = new Date(entry.ts).toISOString().slice(11, 19);
    content.push(' ' + chalk.gray(time) + ' ' + chalk.yellow.bold(entry.agent.padEnd(LOG_AGENT_WIDTH)) + ' ' + chalk.gray('├─ ') + LOG_LEVEL_COLOR[entry.level](entry.msg));
  }
  return boxLines('AGENT REASONING LOG (autonomous · server-side SL/TP · isolated margin)', content, width);
}
