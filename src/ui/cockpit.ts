import chalk from 'chalk';
import stringWidth from 'string-width';
import type { LogRecord } from '../ops/logger.js';
import type { AgentView, CockpitSnapshot, PositionView } from '../runtime/views.js';
import { formatMinuteOfDay, IST_OFFSET_MS, istParts } from '../time/ist.js';

/**
 * Pure renderer for the operator cockpit. It turns a read-only snapshot into lines of text.
 * It has no state of its own and calls nothing that trades, so it can be tested without a
 * terminal and used without any risk to the trading loop.
 */

const BORDER_COLS = 5;
// Column floors are the widest content each column shows at its normal size
const COL_FLOORS = { c1: 36, c2: 46, c3: 36, c4: 34 } as const;
export const COCKPIT_MIN_COLS = COL_FLOORS.c1 + COL_FLOORS.c2 + COL_FLOORS.c3 + COL_FLOORS.c4 + BORDER_COLS;

const HEADER_ROWS = 3;
const TABLE_FRAME_ROWS = 4;
const DETAIL_ROWS = 4;
const DETAIL_FRAME_ROWS = 4;
const LOG_FRAME_ROWS = 4;
const FOOTER_ROWS = 2;
const FIXED_ROWS = HEADER_ROWS + TABLE_FRAME_ROWS + DETAIL_FRAME_ROWS + DETAIL_ROWS + LOG_FRAME_ROWS + FOOTER_ROWS;
const BLOCK_ROWS = 5; // one underlying: four content rows and a spacer
const MIN_TABLE_ROWS = BLOCK_ROWS * 3;
const MAX_TABLE_ROWS = BLOCK_ROWS * 8;
const MIN_LOG_ROWS = 3;
export const COCKPIT_MIN_ROWS = FIXED_ROWS + MIN_TABLE_ROWS + MIN_LOG_ROWS;

export interface CockpitLayout {
  readonly cols: readonly [number, number, number, number];
  readonly tableRows: number;
  readonly logRows: number;
}

export function computeCockpitLayout(width: number, height: number): CockpitLayout {
  const extra = Math.max(0, width - COCKPIT_MIN_COLS);
  const c1 = COL_FLOORS.c1 + Math.floor(extra * 0.2);
  const c3 = COL_FLOORS.c3 + Math.floor(extra * 0.2);
  const c4 = COL_FLOORS.c4 + Math.floor(extra * 0.1);
  const c2 = Math.max(0, width - BORDER_COLS - c1 - c3 - c4);
  const available = Math.max(0, height - FIXED_ROWS);
  const tableRows = Math.max(MIN_TABLE_ROWS, Math.min(MAX_TABLE_ROWS, Math.round(available * 0.7)));
  return { cols: [c1, c2, c3, c4], tableRows, logRows: Math.max(MIN_LOG_ROWS, available - tableRows) };
}

export interface CockpitOptions {
  readonly width: number;
  readonly height: number;
  /** Index into snapshot.underlyings; clamped when out of range. */
  readonly selected: number;
  /** Last operator action result or a pending confirmation. */
  readonly notice: string | undefined;
  readonly logs: readonly LogRecord[];
}

const dim = (text: string) => chalk.gray(text);
const cyanBold = (text: string) => chalk.cyan.bold(text);
const red = (text: string) => chalk.red(text);
const green = (text: string) => chalk.green(text);
const yellow = (text: string) => chalk.yellow(text);

const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);

/**
 * Fits a line to exactly `width` columns. A line that is too long is cut to plain text with an
 * ellipsis. Measuring every grapheme with string-width keeps the frame edges aligned for symbols
 * such as ◉ and ✖, which the ANSI-aware truncation library measures differently.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  const visible = stringWidth(text);
  if (visible === width) {
    return text;
  }
  if (visible < width) {
    return text + ' '.repeat(width - visible);
  }
  const plainText = text.replace(/\x1b\[[0-9;]*m/g, '');
  let out = '';
  let used = 0;
  for (const cell of graphemes(plainText)) {
    const cellWidth = stringWidth(cell);
    if (used + cellWidth > width - 1) {
      break;
    }
    out += cell;
    used += cellWidth;
  }
  return out + '…' + ' '.repeat(Math.max(0, width - used - 1));
}

/** Splits text into lines no wider than `width`, breaking on spaces; an oversize word is cut. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (stringWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      lines.push(current);
    }
    current = word;
  }
  if (current !== '') {
    lines.push(current);
  }
  const bounded = lines.slice(0, maxLines).map((line) => fit(line, width));
  if (lines.length > maxLines && bounded.length > 0) {
    bounded[bounded.length - 1] = fit(`${lines[maxLines - 1] ?? ''} …`, width);
  }
  return bounded;
}

const istClockHms = (epochMs: number): string => {
  const parts = istParts(epochMs);
  const seconds = Math.floor(((epochMs + IST_OFFSET_MS) % 60_000) / 1000);
  return `${formatMinuteOfDay(parts.minuteOfDay)}:${String(seconds).padStart(2, '0')}`;
};

export function formatIstClock(epochMs: number): string {
  return `${istClockHms(epochMs)} IST`;
}

export function formatInr(value: number): string {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatInrWhole(value: number): string {
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function formatSignedInr(value: number): string {
  const text = formatInr(Math.abs(value));
  const sign = value < 0 ? '-' : '+';
  const colored = value < 0 ? red : green;
  return colored(`${sign}${text}`);
}

function price(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(2);
}

function ageText(ms: number | undefined, staleMs: number): string {
  if (ms === undefined) {
    return red('no tick');
  }
  const text = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  return ms > staleMs ? red(text) : text;
}

function stateText(state: AgentView['state']): string {
  if (state === 'HALTED') {
    return red(state);
  }
  if (state === 'IDLE') {
    return dim(state);
  }
  return yellow(state);
}

function phaseTag(snapshot: CockpitSnapshot): string {
  switch (snapshot.phase) {
    case 'RUNNING':
      return green('● RUNNING');
    case 'STARTING':
      return yellow('◐ STARTING');
    case 'STOPPING':
      return yellow('◐ STOPPING');
    case 'FAILED':
      return red('✖ FAILED');
    case 'STOPPED':
      return dim('■ STOPPED');
    case 'IDLE':
      return dim('○ IDLE');
  }
}

function boxed(title: string, lines: readonly string[], width: number): string[] {
  const inner = Math.max(0, width - 2);
  const cyan = (text: string) => chalk.cyan(text);
  return [
    cyan(`┌${'─'.repeat(inner)}┐`),
    cyan('│') + fit(` ${cyanBold(title)}`, inner) + cyan('│'),
    cyan(`├${'─'.repeat(inner)}┤`),
    ...lines.map((line) => cyan('│') + fit(line, inner) + cyan('│')),
    cyan(`└${'─'.repeat(inner)}┘`),
  ];
}

function header(snapshot: CockpitSnapshot, width: number): string[] {
  const inner = width - 2;
  const tag =
    snapshot.mode === 'paper'
      ? chalk.yellow.bold('◉ PAPER')
      : snapshot.mode === 'sandbox'
        ? chalk.cyan.bold('◎ SANDBOX')
        : chalk.green.bold('● LIVE');
  const left = ` ${chalk.green.bold('⬡ NSE INDEX OPTIONS')}${dim(' v0.1.0 ')}${tag}  ${chalk.cyan.bold('◆ DHAN')}  ${phaseTag(snapshot)}`;
  const entriesOpen = snapshot.phase === 'RUNNING' && snapshot.day.killSwitchReason === undefined;
  const right = `${dim(formatIstClock(snapshot.at))} ${entriesOpen ? green('entries OPEN') : red('entries BLOCKED')} `;
  const gap = Math.max(1, inner - stringWidth(left) - stringWidth(right));
  return [
    chalk.cyan(`╭${'─'.repeat(inner)}╮`),
    chalk.cyan('│') + fit(left + ' '.repeat(gap) + right, inner) + chalk.cyan('│'),
    chalk.cyan(`╰${'─'.repeat(inner)}╯`),
  ];
}

function underlyingBlock(agent: AgentView, selected: boolean, width: number, staleMs: number): string[] {
  const marker = selected ? chalk.cyan('▸') : ' ';
  const halt = agent.halted === undefined ? '' : ` ${red('HALT')}`;
  const { emaFast, emaSlow, supertrend, supertrendLine, orbHigh, orbLow } = agent.indicators;
  const trend =
    supertrend === undefined
      ? dim('ST —')
      : supertrend === 'UP'
        ? green(`ST UP ${price(supertrendLine)}`)
        : red(`ST DOWN ${price(supertrendLine)}`);
  const alignment =
    emaFast === undefined || emaSlow === undefined ? dim('EMA warming up') : emaFast > emaSlow ? green('EMA up') : red('EMA down');
  const orb =
    orbHigh === undefined || orbLow === undefined ? dim('ORB forming') : `ORB ${price(orbLow)}–${price(orbHigh)}`;
  return [
    fit(`${marker} ${chalk.bold(agent.symbol)} ${stateText(agent.state)}${halt}`, width),
    fit(`  spot ${price(agent.spot)}  age ${ageText(agent.spotAgeMs, staleMs)}`, width),
    fit(`  ${trend}  ${alignment}`, width),
    fit(`  ${orb}`, width),
    fit('', width),
  ];
}

function underlyingColumn(snapshot: CockpitSnapshot, selected: number, width: number, rows: number): string[] {
  const lines: string[] = [];
  const blocks = snapshot.underlyings.length;
  const visibleBlocks = Math.max(1, Math.floor(rows / BLOCK_ROWS));
  const shown = blocks > visibleBlocks ? visibleBlocks - 1 : blocks;
  for (let index = 0; index < shown; index += 1) {
    const agent = snapshot.underlyings[index];
    if (agent !== undefined) {
      lines.push(...underlyingBlock(agent, index === selected, width, snapshot.staleMs));
    }
  }
  if (shown < blocks) {
    lines.push(fit(dim(`+${blocks - shown} more underlying(s)`), width));
  }
  return lines;
}

function signalColumn(agent: AgentView | undefined, width: number): string[] {
  if (agent === undefined) {
    return [fit(dim('no underlying selected'), width)];
  }
  const lines: string[] = [fit(cyanBold(`SELECTED ${agent.symbol}`), width), fit(cyanBold('LAST SIGNAL'), width)];
  if (agent.lastSignal === undefined) {
    lines.push(fit(dim('  none this session'), width));
  } else {
    const signal = agent.lastSignal;
    const direction = signal.direction === 'BULLISH' ? green('BULLISH') : red('BEARISH');
    lines.push(fit(`  ${direction} at ${formatIstClock(signal.at)} close ${price(signal.spot)}`, width));
    for (const reason of signal.reasons.slice(0, 2)) {
      lines.push(fit(`    ${dim(reason)}`, width));
    }
  }
  lines.push(fit(cyanBold('LAST REJECTION'), width));
  if (agent.lastDrop === undefined) {
    lines.push(fit(dim('  none'), width));
  } else {
    lines.push(fit(`  ${yellow(agent.lastDrop.code)} at ${formatIstClock(agent.lastDrop.at)}`, width));
    for (const line of wrap(agent.lastDrop.detail, Math.max(10, width - 4), 2)) {
      lines.push(fit(`    ${dim(line)}`, width));
    }
  }
  lines.push(fit(cyanBold('LAST CANDIDATE'), width));
  if (agent.lastCandidate === undefined) {
    lines.push(fit(dim('  none passed the risk gate'), width));
  } else {
    const c = agent.lastCandidate;
    lines.push(fit(`  ${c.contractSymbol} ${c.expiry}`, width));
    lines.push(fit(`    ask ${price(c.entryReference)} bid ${price(c.bid)} spread ${c.spreadPct.toFixed(2)}%`, width));
    lines.push(fit(`    OI ${c.openInterest.toLocaleString('en-IN')} lots ${c.lots} qty ${c.quantity}`, width));
    lines.push(fit(`    SL ${price(c.stopLossPrice)} TP ${price(c.targetPrice)} risk ${formatInr(c.riskInr)}`, width));
  }
  return lines;
}

function positionLines(position: PositionView, maxHoldMinutes: number, width: number): string[] {
  const pnl = position.unrealizedInr === undefined ? dim('—') : formatSignedInr(position.unrealizedInr);
  return [
    fit(`  ${position.contractSymbol}`, width),
    fit(`    qty ${position.quantity} avg ${price(position.averagePrice)}`, width),
    fit(`    mark ${price(position.mark)} P&L ${pnl}`, width),
    fit(`    SL ${price(position.stopLossPrice)} TP ${price(position.targetPrice)}`, width),
    fit(`    held ${position.heldMinutes}m of ${maxHoldMinutes}m${position.exitRequested ? yellow(' close requested') : ''}`, width),
  ];
}

function positionColumn(agent: AgentView | undefined, maxHoldMinutes: number, width: number): string[] {
  if (agent === undefined) {
    return [fit(dim('no underlying selected'), width)];
  }
  if (agent.position !== undefined) {
    return positionLines(agent.position, maxHoldMinutes, width);
  }
  const lines: string[] = [fit(dim('  flat'), width)];
  lines.push(fit(cyanBold('LAST EXIT'), width));
  if (agent.lastExit === undefined) {
    lines.push(fit(dim('  none this session'), width));
  } else {
    lines.push(fit(`  ${agent.lastExit.reason} ${formatSignedInr(agent.lastExit.pnlInr)}`, width));
    lines.push(fit(dim(`  at ${formatIstClock(agent.lastExit.at)}`), width));
  }
  return lines;
}

function riskBar(lossUsedPct: number, cells: number): string {
  const filled = Math.min(cells, Math.max(0, Math.round((lossUsedPct / 100) * cells)));
  const color = lossUsedPct >= 100 ? red : lossUsedPct >= 60 ? yellow : green;
  return color('█'.repeat(filled)) + dim('░'.repeat(cells - filled));
}

function riskColumn(snapshot: CockpitSnapshot, width: number): string[] {
  const day = snapshot.day;
  const lossUsedPct = day.dayPnlInr < 0 && snapshot.dailyLossLimitInr > 0 ? (-day.dayPnlInr / snapshot.dailyLossLimitInr) * 100 : 0;
  const lines: string[] = [
    fit(cyanBold(`DAY ${day.dayKey}`), width),
    fit(`P&L ${formatSignedInr(day.dayPnlInr)}`, width),
    fit(`  realised ${formatSignedInr(day.realizedPnlInr)}`, width),
    fit(`  open P&L ${formatSignedInr(day.unrealizedPnlInr)}`, width),
    fit(`loss ${riskBar(lossUsedPct, 12)} ${lossUsedPct.toFixed(0)}% of ${formatInrWhole(snapshot.dailyLossLimitInr)}`, width),
    fit(`trades ${day.tradesToday}/${snapshot.maxTradesPerDay}  open ${day.openUnderlyings.length}/${snapshot.maxOpenPositions}`, width),
    fit(`capital ${formatInrWhole(snapshot.capitalInr)}`, width),
    fit(`risk/trade ${formatInrWhole(snapshot.riskBudgetInr)}`, width),
    ...(day.killSwitchReason === undefined
      ? [fit(`kill switch ${green('off')}`, width)]
      : [fit(`kill switch ${red('ON')}`, width), fit(dim(`  ${day.killSwitchReason}`), width)]),
  ];
  const cooling = snapshot.underlyings.filter((agent) => agent.cooldownUntil !== undefined && agent.cooldownUntil > snapshot.at);
  for (const agent of cooling) {
    const remaining = Math.ceil(((agent.cooldownUntil ?? 0) - snapshot.at) / 1000);
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    lines.push(fit(`cooldown ${agent.symbol} ${mm}:${ss}`, width));
  }
  return lines;
}

function table(snapshot: CockpitSnapshot, options: CockpitOptions, layout: CockpitLayout): string[] {
  const [c1, c2, c3, c4] = layout.cols;
  const selected = Math.max(0, Math.min(options.selected, snapshot.underlyings.length - 1));
  const agent = snapshot.underlyings[selected];
  const columns: [string[], string[], string[], string[]] = [
    underlyingColumn(snapshot, selected, c1, layout.tableRows),
    signalColumn(agent, c2),
    positionColumn(agent, snapshot.maxHoldMinutes, c3),
    riskColumn(snapshot, c4),
  ];
  const rows = layout.tableRows;
  const pad = (lines: string[], width: number) => {
    const out = lines.slice(0, rows);
    while (out.length < rows) {
      out.push(' '.repeat(width));
    }
    return out;
  };
  const cells = columns.map((lines, index) => pad(lines, layout.cols[index] ?? 0));
  const titles = [
    `UNDERLYINGS (${snapshot.underlyings.length})`,
    'SIGNAL & CONTRACT',
    'POSITION',
    'RISK & DAY',
  ];
  const cyan = (text: string) => chalk.cyan(text);
  const bar = (left: string, middle: string, right: string) =>
    cyan(left + [c1, c2, c3, c4].map((width) => '─'.repeat(width)).join(middle) + right);
  const titleRow =
    cyan('│') +
    [c1, c2, c3, c4].map((width, index) => fit(` ${cyanBold(titles[index] ?? '')}`, width)).join(cyan('│')) +
    cyan('│');
  const out = [bar('┌', '┬', '┐'), titleRow, bar('├', '┼', '┤')];
  for (let row = 0; row < rows; row += 1) {
    out.push(cyan('│') + cells.map((column) => column[row] ?? '').join(cyan('│')) + cyan('│'));
  }
  out.push(bar('└', '┴', '┘'));
  return out;
}

function detail(snapshot: CockpitSnapshot, options: CockpitOptions): string[] {
  const agent = snapshot.underlyings[Math.max(0, Math.min(options.selected, snapshot.underlyings.length - 1))];
  const inner = Math.max(10, options.width - 4);
  const lines: string[] = [];
  if (snapshot.phase === 'FAILED') {
    lines.push(red(`start failed: ${snapshot.phaseDetail ?? 'unknown reason'}`));
    lines.push(dim('nothing is trading; fix the cause and restart'));
  } else if (agent === undefined) {
    lines.push(dim('no underlying configured'));
  } else if (agent.halted !== undefined) {
    lines.push(red(`${agent.symbol} HALTED: ${agent.halted}`));
    lines.push(dim('new entries stay blocked for this underlying until the process is restarted after review'));
  } else if (agent.lastDrop !== undefined) {
    lines.push(dim(`${agent.symbol} last rejection: ${agent.lastDrop.code} — ${agent.lastDrop.detail}`));
  } else if (agent.lastSignal !== undefined) {
    lines.push(dim(`${agent.symbol} last signal: ${agent.lastSignal.reasons.join(' · ')}`));
  } else {
    lines.push(dim(`${agent.symbol}: waiting for an opening-range breakout between entry start and entry end`));
  }
  const wrapped = lines.flatMap((line) => wrap(line, inner, DETAIL_ROWS)).slice(0, DETAIL_ROWS);
  while (wrapped.length < DETAIL_ROWS) {
    wrapped.push(fit('', inner));
  }
  return boxed('SELECTED DETAIL', wrapped, options.width);
}

function logLine(record: LogRecord, width: number): string {
  const time = dim(formatIstClock(record.ts));
  const level = record.level === 'error' ? red('ERR ') : record.level === 'warn' ? yellow('WARN') : dim('INFO');
  const data = record.data === undefined ? '' : ` ${dim(JSON.stringify(record.data))}`;
  return fit(`${time} ${level} ${record.message}${data}`, width);
}

function logBox(logs: readonly LogRecord[], rows: number, width: number): string[] {
  const inner = Math.max(0, width - 2);
  const content: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const record = logs[index];
    content.push(record === undefined ? fit('', inner) : logLine(record, inner));
  }
  return boxed('EVENT LOG (newest first)', content, width);
}

function footer(options: CockpitOptions): string[] {
  const keys = dim(' ↑↓ select   c close position   k entry block   s stop   ? help   (c, k, s need a second press)');
  const notice = options.notice === undefined ? '' : ` ${options.notice}`;
  return [fit(keys, options.width), fit(chalk.cyan(notice), options.width)];
}

/** Lines that fit the terminal. Callers show a resize notice below the minimum instead. */
export function renderOptionsCockpit(snapshot: CockpitSnapshot, options: CockpitOptions): string[] {
  const width = Math.max(COCKPIT_MIN_COLS, options.width);
  const height = Math.max(COCKPIT_MIN_ROWS, options.height);
  const layout = computeCockpitLayout(width, height);
  return [
    ...header(snapshot, width),
    ...table(snapshot, { ...options, width, height }, layout),
    ...detail(snapshot, { ...options, width, height }),
    ...logBox(options.logs, layout.logRows, width),
    ...footer({ ...options, width }),
  ];
}

export function resizeNotice(width: number, height: number): string[] {
  return [
    chalk.yellow.bold('Terminal too small for the operator cockpit'),
    dim(`need ${COCKPIT_MIN_COLS} columns × ${COCKPIT_MIN_ROWS} rows; have ${width} × ${height}`),
    dim('enlarge the window, or run with UI=off for plain log output'),
  ];
}
