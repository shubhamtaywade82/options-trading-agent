import { Box, Text } from 'ink';
import chalk from 'chalk';
import type { AppState } from '../types.js';
import { padLine, rule, runningCount } from './format.js';
import { renderHeaderLines, renderCol1Lines, renderCol3Lines, renderCol4Lines, renderPerfLines, renderFooterLines } from './accountPanels.js';
import { renderCol2Lines, renderMetricsLines, renderDetailLines, renderLogLines } from './marketPanels.js';

type StoreFields = 'mode' | 'equity' | 'upnl' | 'marginUsed' | 'positions' | 'agents' | 'logs' | 'spotPrices' | 'initialEquity' | 'totalPnl' | 'totalPnlPct'
  | 'successRate' | 'sharpe' | 'maxDd' | 'var95' | 'liqEvents' | 'sessionDecisions' | 'sessionExecuted' | 'sessionMonitored' | 'apiWeight' | 'wsStatus'
  | 'venue' | 'exposurePct' | 'minLiqDistancePct' | 'corrBtcEth' | 'funding' | 'strategyMetrics' | 'marketIntel';

export type CockpitProps = Pick<AppState, StoreFields> & { time: string; localTime?: string; selPos: number; isSyncing: boolean; totalWidth?: number; totalHeight?: number };

// Each floor is the widest realistic content of its column, so nothing is ellipsized at MIN_COLS; c1 fits `pos 12 win 100.00% pnl -$12,345.67`
const COL_FLOORS = { c1: 37, c2: 46, c3: 36, c4: 36 };
const BORDER_COLS = 5;
export const MIN_COLS = COL_FLOORS.c1 + COL_FLOORS.c2 + COL_FLOORS.c3 + COL_FLOORS.c4 + BORDER_COLS;

// Chrome outside the table and log bodies is 32 rows (header 3, table frame 4, detail 6, metrics 8, log frame 4, perf 3, footer 4); the 33rd keeps the output shorter than the
// terminal, because Ink clears the whole screen on every frame once the output is as tall as the terminal
const FIXED_ROWS = 33;
const MIN_TABLE_ROWS = 18; // the full six-agent fleet in compact form, which is also taller than the whole risk column
const MIN_LOG_ROWS = 2;
const MAX_TABLE_ROWS = 32;
const TABLE_ROW_SHARE = 0.7;
export const MIN_ROWS = FIXED_ROWS + MIN_TABLE_ROWS + MIN_LOG_ROWS;

/** Keeps a stale selection pointing at a real row; an empty list yields 0 and the caller finds no position there. */
export const clampSelection = (selection: number, count: number) => Math.max(0, Math.min(selection, count - 1));

export function computeColWidths(totalWidth: number) {
  const extra = Math.max(0, totalWidth - MIN_COLS);
  const c1 = Math.min(40, COL_FLOORS.c1 + Math.floor(extra * 0.15));
  const c3 = Math.min(64, COL_FLOORS.c3 + Math.floor(extra * 0.45));
  const c4 = Math.min(40, COL_FLOORS.c4 + Math.floor(extra * 0.1));
  return { c1, c2: totalWidth - BORDER_COLS - c1 - c3 - c4, c3, c4 };
}

export function computeRowHeights(totalHeight: number) {
  const available = Math.max(0, totalHeight - FIXED_ROWS);
  const tableRows = Math.max(MIN_TABLE_ROWS, Math.min(MAX_TABLE_ROWS, Math.round(available * TABLE_ROW_SHARE)));
  return { tableRows, logRows: Math.max(MIN_LOG_ROWS, available - tableRows) };
}

export function renderCockpitTable(cols: [string[], string[], string[], string[]], widths: [number, number, number, number], counts: { running: number; open: number }): string[] {
  const [c1, c2, c3, c4] = cols;
  const [w1, w2, w3, w4] = widths;
  const bar = (l: string, m: string, r: string) => chalk.cyan(l + rule('─', w1) + m + rule('─', w2) + m + rule('─', w3) + m + rule('─', w4) + r);
  const title = chalk.cyan('│') + padLine(' ' + chalk.cyan.bold(`AGENT FLEET (${counts.running} active)`), w1) +
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold('BINANCE USDT-M PERPETUAL FUTURES'), w2) +
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold(`POSITIONS (${counts.open} open)`), w3) +
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold('RISK & ACCOUNT'), w4) + chalk.cyan('│');
  const rows = [bar('┌', '┬', '┐'), title, bar('├', '┼', '┤')];
  const count = Math.min(c1.length, c2.length, c3.length, c4.length);
  for (let i = 0; i < count; i++) rows.push(chalk.cyan('│') + c1[i] + chalk.cyan('│') + c2[i] + chalk.cyan('│') + c3[i] + chalk.cyan('│') + c4[i] + chalk.cyan('│'));
  rows.push(bar('└', '┴', '┘'));
  return rows;
}

export function ResizeWarning({ cols, rows }: { cols: number; rows: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1} width={60}>
      <Text color="green" bold>⬡ INKUI AGENT TRADE v2.4.1</Text>
      <Text color="yellow" bold>Terminal size too small for cockpit:</Text>
      <Text color="gray">  Required: <Text color="white">{MIN_COLS} cols x {MIN_ROWS} rows minimum</Text></Text>
      <Text color="gray">  Current:  <Text color="red">{cols} cols × {rows} rows</Text></Text>
      <Text color="cyan">Please enlarge your terminal window.</Text>
    </Box>
  );
}

export function renderCockpit(input: CockpitProps): string[] {
  // A closed position can leave the selection past the end
  const props = { ...input, selPos: clampSelection(input.selPos, input.positions.length) };
  const width = Math.max(MIN_COLS, props.totalWidth ?? MIN_COLS); // callers show ResizeWarning below the minimum; this only stops a bad size from throwing
  const { c1, c2, c3, c4 } = computeColWidths(width);
  const { tableRows, logRows } = computeRowHeights(props.totalHeight ?? MIN_ROWS);
  const counts = { running: runningCount(props.agents), open: props.positions.length };

  const columns: [string[], string[], string[], string[]] = [
    renderCol1Lines(props, c1, tableRows), renderCol2Lines(props, c2, tableRows),
    renderCol3Lines(props, c3, tableRows), renderCol4Lines(props, c4, tableRows),
  ];
  return [
    ...renderHeaderLines(props, width),
    ...renderCockpitTable(columns, [c1, c2, c3, c4], counts),
    ...renderDetailLines(props.positions[props.selPos], width),
    ...renderMetricsLines(props.strategyMetrics, width, props.mode),
    ...renderLogLines(props.logs, logRows, width),
    ...renderPerfLines(props, width),
    ...renderFooterLines(props, width),
  ];
}
