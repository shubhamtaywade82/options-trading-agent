import chalk from 'chalk';
import type { AgentView, ChainWatchRowView, ChainWatchView } from '../runtime/views.js';
import { fit } from './terminalFit.js';

const dim = (text: string) => chalk.gray(text);
const cyanBold = (text: string) => chalk.cyan.bold(text);
const green = (text: string) => chalk.green(text);
const red = (text: string) => chalk.red(text);
const yellow = (text: string) => chalk.yellow(text);

export const CHAIN_PANEL_ROWS = 9;

function price(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(1);
}

function spreadText(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(1)}%`;
}

function oiBar(oi: number | undefined, maxOi: number, width: number): string {
  if (oi === undefined || oi <= 0 || maxOi <= 0) {
    return dim('·'.repeat(width));
  }
  const filled = Math.max(1, Math.round((oi / maxOi) * width));
  return green('▮'.repeat(Math.min(width, filled))) + dim('▯'.repeat(Math.max(0, width - filled)));
}

function markerSuffix(markers: ChainWatchRowView['markers']): string {
  const parts: string[] = [];
  if (markers.includes('ATM')) {
    parts.push(yellow('ATM'));
  }
  if (markers.includes('CE_ENTRY')) {
    parts.push(green('CE▸'));
  }
  if (markers.includes('PE_ENTRY')) {
    parts.push(red('PE▸'));
  }
  if (markers.includes('OPEN')) {
    parts.push(cyanBold('OPEN'));
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

function legCell(leg: ChainWatchView['rows'][number]['call'], width: number): string {
  const quote = `${price(leg.bid)}/${price(leg.ask)}`;
  const spread = spreadText(leg.spreadPct);
  const tone = leg.passesGate ? quote : dim(quote);
  const spreadTone = leg.passesGate ? spread : red(spread);
  return fit(`${tone} ${spreadTone}`, width);
}

function strikeRow(row: ChainWatchView['rows'][number], maxOi: number, inner: number): string {
  const strikeW = 9;
  const legW = Math.max(14, Math.floor((inner - strikeW - 4) / 2));
  const oiW = 4;
  const strike = fit(`${row.strike.toLocaleString('en-IN')}${markerSuffix(row.markers)}`, strikeW);
  const callOi = oiBar(row.call.openInterest, maxOi, oiW);
  const putOi = oiBar(row.put.openInterest, maxOi, oiW);
  return fit(`${strike} │${legCell(row.call, legW)}${callOi}│${legCell(row.put, legW)}${putOi}│`, inner);
}

function statusLine(watch: ChainWatchView, agent: AgentView | undefined, inner: number): string {
  if (watch.status === 'loading' || watch.status === 'idle') {
    return dim(fit('  fetching option chain from Dhan…', inner));
  }
  if (watch.status === 'waiting_spot') {
    return dim(fit('  waiting for a live index tick before anchoring strikes', inner));
  }
  if (watch.status === 'error') {
    return red(fit(`  ${watch.error ?? 'chain unavailable'}`, inner));
  }
  const age =
    watch.fetchedAgeMs === undefined
      ? ''
      : watch.fetchedAgeMs < 2000
        ? dim(' fresh')
        : dim(` ${Math.round(watch.fetchedAgeMs / 1000)}s ago`);
  const spot = watch.spot === undefined ? '—' : watch.spot.toFixed(2);
  const hint =
    agent?.lastSignal?.direction === 'BULLISH'
      ? green(' bias CE entry')
      : agent?.lastSignal?.direction === 'BEARISH'
        ? red(' bias PE entry')
        : '';
  return fit(
    `  spot ${spot}  ATM ${watch.atmStrike?.toLocaleString('en-IN') ?? '—'}  expiry ${watch.expiry ?? '—'}${age}${hint}`,
    inner,
  );
}

function legend(inner: number, maxSpread: number, minOi: number): string {
  return dim(
    fit(`  CE▸/PE▸ entry strikes · quotes pass spread≤${maxSpread}% & OI≥${minOi.toLocaleString('en-IN')}`, inner),
  );
}

export function chainWatchLines(
  watch: ChainWatchView | undefined,
  agent: AgentView | undefined,
  inner: number,
  maxSpreadPct: number,
  minOpenInterest: number,
): string[] {
  const title = watch === undefined ? 'OPTION CHAIN' : `OPTION CHAIN · ${watch.symbol}`;
  const lines: string[] = [fit(cyanBold(title), inner)];
  if (watch === undefined) {
    lines.push(dim(fit('  select an underlying with ↑↓', inner)));
    while (lines.length < CHAIN_PANEL_ROWS) {
      lines.push(fit('', inner));
    }
    return lines;
  }
  lines.push(statusLine(watch, agent, inner));
  if (watch.status === 'ready' && watch.rows.length > 0) {
    lines.push(dim(fit('      CALL bid/ask spr│OI │      PUT bid/ask spr│OI ', inner)));
    for (const row of watch.rows) {
      lines.push(strikeRow(row, watch.maxOpenInterest, inner));
    }
    lines.push(legend(inner, maxSpreadPct, minOpenInterest));
  } else {
    lines.push(dim(fit('  ladder appears once the chain loads', inner)));
  }
  while (lines.length < CHAIN_PANEL_ROWS) {
    lines.push(fit('', inner));
  }
  return lines.slice(0, CHAIN_PANEL_ROWS);
}
