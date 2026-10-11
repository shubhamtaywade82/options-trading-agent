import chalk from 'chalk';
import type { WorkerStatus } from './SymbolTraderWorker.js';

export interface DashboardContext {
  startTime: number;
  btcPrice: number;
  btcTrend1h: string;
  btcTrend15m: string;
  btcChange24h: number;
  workers: WorkerStatus[];
}

// Strip ANSI control codes for exact visual character length calculation
const stripAnsi = (str: string): string => str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

function padCell(content: string, visibleWidth: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const len = stripAnsi(content).length;
  const diff = visibleWidth - len;
  if (diff <= 0) return content;
  if (align === 'right') return ' '.repeat(diff) + content;
  if (align === 'center') {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return ' '.repeat(left) + content + ' '.repeat(right);
  }
  return content + ' '.repeat(diff);
}

function fmtPrice(val: number): string {
  if (val >= 1000) return val.toFixed(2);
  if (val >= 10) return val.toFixed(2);
  return val.toFixed(4);
}

function trajectoryMeter(current: number, entry: number, sl: number, tp: number, isLong: boolean): string {
  const span = Math.abs(tp - sl);
  if (span <= 0) return chalk.gray('───────────────');

  const ratio = isLong ? (current - sl) / span : (sl - current) / span;
  const clamped = Math.max(0, Math.min(1, ratio));
  const len = 14;
  const pin = Math.round(clamped * (len - 1));

  let out = '';
  for (let i = 0; i < len; i++) {
    if (i === pin) out += chalk.bold.yellow('◆');
    else if (i < pin) out += chalk.green('─');
    else out += chalk.gray('─');
  }
  return out;
}

interface DashboardTotals {
  equity: number;
  upnl: number;
  realized: number;
  activeCount: number;
}

function wrapText(text: string, maxWidth: number): string[] {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    let current = '';
    for (const word of words) {
      if (word.length > maxWidth) {
        if (current) lines.push(current);
        current = '';
        for (let i = 0; i < word.length; i += maxWidth) lines.push(word.slice(i, i + maxWidth));
        continue;
      }
      if (!current) current = word;
      else if (current.length + 1 + word.length <= maxWidth) current += ' ' + word;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines.length > 0 ? lines : [''];
}

function calculateTotals(workers: WorkerStatus[]): DashboardTotals {
  let equity = 0;
  let upnl = 0;
  let realized = 0;
  let activeCount = 0;

  for (const w of workers) {
    if (w.account) {
      equity += w.account.equity;
      realized += w.account.realizedPnl;
    }
    if (w.activePosition) {
      upnl += w.activePosition.unrealizedPnl;
      activeCount++;
    }
  }

  return { equity, upnl, realized, activeCount };
}

function renderHeaderBox(ctx: DashboardContext, totals: DashboardTotals, boxWidth: number): void {
  const uptimeSec = Math.floor((Date.now() - ctx.startTime) / 1000);
  const timeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
  const btcChange = ctx.btcChange24h >= 0 ? chalk.green(`+${ctx.btcChange24h.toFixed(2)}%`) : chalk.red(`${ctx.btcChange24h.toFixed(2)}%`);
  const btcTrend = ctx.btcTrend1h === 'BULLISH' ? chalk.bold.green('▲ BULL') : ctx.btcTrend1h === 'BEARISH' ? chalk.bold.red('▼ BEAR') : chalk.gray('■ FLAT');
  const upnlColor = totals.upnl >= 0 ? chalk.bold.green(`+$${totals.upnl.toFixed(2)}`) : chalk.bold.red(`-$${Math.abs(totals.upnl).toFixed(2)}`);
  const realizedColor = totals.realized >= 0 ? chalk.green(`+$${totals.realized.toFixed(2)}`) : chalk.red(`-$${Math.abs(totals.realized).toFixed(2)}`);

  console.log(chalk.bold.cyan('╔' + '═'.repeat(boxWidth) + '╗'));
  const row1 =
    chalk.bold.white(' ⬡ MINICPM-2B COCKPIT v2.0 ') +
    chalk.gray('│ Uptime: ') + chalk.yellow(timeStr) +
    chalk.gray(' │ Active: ') + chalk.bold.white(`${totals.activeCount}/3 Symbols`) +
    chalk.gray(' │ BTC Anchor: ') + chalk.bold.white(`$${ctx.btcPrice > 0 ? ctx.btcPrice.toLocaleString() : '—'}`) + ' ' + btcTrend + ` (${btcChange})`;
  console.log(chalk.bold.cyan('║') + padCell(row1, boxWidth, 'left') + chalk.bold.cyan('║'));

  const row2 =
    chalk.gray(' PORTFOLIO: Total Equity: ') + chalk.bold.white(`$${totals.equity.toFixed(2)}`) +
    chalk.gray(' │ Open uPnL: ') + upnlColor +
    chalk.gray(' │ Realized: ') + realizedColor +
    chalk.gray(' │ Venue: ') + chalk.green('● paper_exchange');
  console.log(chalk.bold.cyan('║') + padCell(row2, boxWidth, 'left') + chalk.bold.cyan('║'));
}

function renderTableHeaders(): void {
  const headerRow =
    padCell(chalk.bold.cyan(' ASSET'), 8, 'left') + chalk.gray('│') +
    padCell(chalk.bold.cyan(' POSITION'), 11, 'left') + chalk.gray('│') +
    padCell(chalk.bold.cyan(' ENTRY ➔ MARK'), 22, 'center') + chalk.gray('│') +
    padCell(chalk.bold.cyan(' uPnL (RET%)'), 19, 'center') + chalk.gray('│') +
    padCell(chalk.bold.cyan(' TARGET TRAJECTORY (SL ➔ TP)'), 42, 'center');
  console.log(chalk.bold.cyan('║') + headerRow + chalk.bold.cyan('║'));

  const divRow =
    '─'.repeat(8) + chalk.gray('┼') +
    '─'.repeat(11) + chalk.gray('┼') +
    '─'.repeat(22) + chalk.gray('┼') +
    '─'.repeat(19) + chalk.gray('┼') +
    '─'.repeat(42);
  console.log(chalk.bold.cyan('╟') + chalk.gray(divRow) + chalk.bold.cyan('╢'));
}

function renderWorkerRow(w: WorkerStatus): void {
  const sym = ' ' + w.symbol.replace('USDT', '');
  const cellAsset = padCell(chalk.bold.white(sym), 8, 'left');

  if (!w.activePosition) {
    const cellSide = padCell(chalk.gray(' IDLE'), 11, 'left');
    const cellPrice = padCell(chalk.gray('—'), 22, 'center');
    const cellPnl = padCell(chalk.gray('$0.00 (0.0%)'), 19, 'center');
    const cellTraj = padCell(chalk.italic.gray('Scanning market with MiniCPM...'), 42, 'center');
    console.log(chalk.bold.cyan('║') + cellAsset + chalk.gray('│') + cellSide + chalk.gray('│') + cellPrice + chalk.gray('│') + cellPnl + chalk.gray('│') + cellTraj + chalk.bold.cyan('║'));
    return;
  }

  const pos = w.activePosition;
  const isLong = pos.side.toUpperCase() === 'LONG';
  const sideText = isLong ? chalk.bold.green(' LONG 10x') : chalk.bold.red(' SHORT 10x');
  const cellSide = padCell(sideText, 11, 'left');
  const cellPrice = padCell(`$${fmtPrice(pos.averagePrice)} ➔ $${fmtPrice(pos.currentPrice)}`, 22, 'center');

  const retPct = (pos.unrealizedPnl / 980) * 100;
  const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '-';
  const pnlText = `${pnlSign}$${Math.abs(pos.unrealizedPnl).toFixed(2)} (${retPct >= 0 ? '+' : ''}${retPct.toFixed(1)}%)`;
  const cellPnl = padCell(pos.unrealizedPnl >= 0 ? chalk.green(pnlText) : chalk.red(pnlText), 19, 'center');

  let traj = chalk.gray('— no levels —');
  if (w.stopLoss && w.takeProfit) {
    const bar = trajectoryMeter(pos.currentPrice, pos.averagePrice, w.stopLoss, w.takeProfit, isLong);
    traj = `${chalk.red(fmtPrice(w.stopLoss))} ${bar} ${chalk.green(fmtPrice(w.takeProfit))}`;
  }
  const cellTraj = padCell(traj, 42, 'center');
  console.log(chalk.bold.cyan('║') + cellAsset + chalk.gray('│') + cellSide + chalk.gray('│') + cellPrice + chalk.gray('│') + cellPnl + chalk.gray('│') + cellTraj + chalk.bold.cyan('║'));
}

function renderIntelligencePanel(workers: WorkerStatus[], boxWidth: number): void {
  const intelHeader = chalk.bold.white(' LATEST LLM INTELLIGENCE & REASONING:');
  console.log(chalk.bold.cyan('║') + padCell(intelHeader, boxWidth, 'left') + chalk.bold.cyan('║'));

  for (const w of workers) {
    const sym = w.symbol.replace('USDT', '');
    const prefix = `  ${chalk.bold.magenta(sym)}: `;
    const indent = '       ';
    const maxTextWidth = boxWidth - 12;
    const rawDecision = w.lastDecision.replace(/^Recovered:\s*/, '') + (w.breakEvenMoved ? ' [PROTECTED BREAK-EVEN]' : '');
    const wrapped = wrapText(rawDecision, maxTextWidth);

    for (let j = 0; j < wrapped.length; j++) {
      const linePrefix = j === 0 ? prefix : indent;
      const lineText = wrapped[j];
      const styledText = lineText.includes('[PROTECTED BREAK-EVEN]')
        ? chalk.white(lineText.replace(' [PROTECTED BREAK-EVEN]', '')) + chalk.bold.cyan(' [PROTECTED BREAK-EVEN]')
        : chalk.white(lineText);
      console.log(chalk.bold.cyan('║') + padCell(linePrefix + styledText, boxWidth, 'left') + chalk.bold.cyan('║'));
    }
  }

  console.log(chalk.bold.cyan('╚' + '═'.repeat(boxWidth) + '╝'));
  console.log(chalk.gray('  Rule: $980 Margin · 10x Isolated · Min +5% TP · Auto Break-Even Trailing · 24/7 Realtime'));
}

export function renderDashboard(ctx: DashboardContext): void {
  const BOX_WIDTH = 106;
  const totals = calculateTotals(ctx.workers);

  console.clear();
  renderHeaderBox(ctx, totals, BOX_WIDTH);
  console.log(chalk.bold.cyan('╠' + '═'.repeat(BOX_WIDTH) + '╣'));
  renderTableHeaders();
  for (const w of ctx.workers) renderWorkerRow(w);
  console.log(chalk.bold.cyan('╠' + '═'.repeat(BOX_WIDTH) + '╣'));
  renderIntelligencePanel(ctx.workers, BOX_WIDTH);
}
