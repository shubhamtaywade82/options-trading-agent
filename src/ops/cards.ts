import { formatPrice, formatQty } from '../binance/symbolRules.js';
import type { PerformanceSummary } from '../binance/performance.js';
import type { ExitReason, Side, TradeRecord, WsStatus } from '../types.js';
import { escapeHtml } from './telegram.js';

const MAX_CARD_CHARS = 3_500;
const MAX_FIELD_CHARS = 300;
const NO_VALUE = '—';
const ELLIPSIS = '…';

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

// Reference cards print IST because the operator reads them in India
const istStamp = (at: number): string =>
  `${new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST`;

const field = (emoji: string, label: string, value: string): string => `${emoji} <b>${label}:</b> ${value}`;

const text = (raw: string): string => {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return escapeHtml(flat.length > MAX_FIELD_CHARS ? `${flat.slice(0, MAX_FIELD_CHARS)}${ELLIPSIS}` : flat);
};

const groupedMoney = (value: number): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const signedMoney = (value: number | undefined): string => {
  if (!finite(value)) return NO_VALUE;
  const digits = groupedMoney(Math.abs(value));
  return `${value < 0 && digits !== '0.00' ? '-' : '+'}${digits}`;
};

const percent = (value: number | undefined): string => (finite(value) ? `${value.toFixed(2)}%` : NO_VALUE);

const stampLine = (at: number): string => field('🕒', 'Time', istStamp(at));

// Whole lines are dropped so an open <b> tag is never cut; the hard slice is only for one line that alone exceeds the cap
export function finishCard(lines: readonly string[]): string {
  const joined = lines.join('\n');
  if (joined.length <= MAX_CARD_CHARS) return joined;
  const kept: string[] = [];
  let used = ELLIPSIS.length + 1;
  for (const line of lines) {
    if (used + line.length + 1 > MAX_CARD_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length === 0) return `${lines[0].slice(0, MAX_CARD_CHARS - 1).replace(/(&[a-z]*|<[^>]*)$/, '')}${ELLIPSIS}`;
  return `${kept.join('\n')}\n${ELLIPSIS}`;
}

const sideEmoji = (side: Side): string => (side === 'LONG' ? '🟢' : '🔴');

const strategyLine = (strategy: string, leverage?: number): string =>
  field('📊', 'Strategy', `${text(strategy)}${finite(leverage) ? ` · ${leverage}x` : ''}`);

export type TradeCardInput =
  | {
    kind: 'OPEN' | 'SCALE_IN' | 'FLIP'; symbol: string; side: Side; qty: number; price: number;
    strategy: string; leverage?: number; at: number;
  }
  | { kind: 'EXIT'; trade: TradeRecord; leverage?: number; initialRisk?: number };

const ENTRY_TITLES = { OPEN: '🚀 POSITION OPENED', SCALE_IN: '➕ SCALE-IN', FLIP: '🔄 FLIPPED' } as const;

const EXIT_TITLES: Readonly<Record<ExitReason, string>> = {
  'STOP LOSS': '🛑 STOP LOSS', 'TAKE PROFIT': '✅ TAKE PROFIT', LIQUIDATED: '💥 LIQUIDATED', CLOSE: '🔒 CLOSED', FLIP: '🔄 FLIP EXIT', 'PARTIAL TP': '🎯 PARTIAL TAKE PROFIT',
};

const rMultipleLine = (trade: TradeRecord, initialRisk?: number): string[] => {
  if (!finite(initialRisk) || initialRisk <= 0 || trade.qty <= 0) return [];
  const multiple = trade.pnl / (initialRisk * trade.qty);
  return finite(multiple) ? [field('🎯', 'Result', `${multiple < 0 ? '-' : '+'}${Math.abs(multiple).toFixed(2)}R`)] : [];
};

const exitCard = (input: Extract<TradeCardInput, { kind: 'EXIT' }>): string[] => {
  const { trade } = input;
  return [
    `<b>[ TRADE ]</b> ${text(trade.symbol)}`,
    `<b>${EXIT_TITLES[trade.reason]}</b>`,
    field(sideEmoji(trade.side), 'Side', `${trade.side} · ${formatQty(trade.symbol, trade.qty)}`),
    field('📥', 'Entry', formatPrice(trade.symbol, trade.entry)),
    field('📤', 'Exit', formatPrice(trade.symbol, trade.exit)),
    field('💰', 'PnL', `${signedMoney(trade.pnl)} USDT (gross)`),
    ...rMultipleLine(trade, input.initialRisk),
    strategyLine(trade.strategy, input.leverage),
    stampLine(trade.closedAt),
  ];
};

/** HTML card for a fill (open, scale-in, flip) or a closed trade with reason, gross PnL and R multiple. */
export function tradeCard(input: TradeCardInput): string {
  if (input.kind === 'EXIT') return finishCard(exitCard(input));
  return finishCard([
    `<b>[ TRADE ]</b> ${text(input.symbol)}`,
    `<b>${ENTRY_TITLES[input.kind]}</b>`,
    field(sideEmoji(input.side), 'Side', `${input.side} · ${formatQty(input.symbol, input.qty)}`),
    field('📥', 'Entry', formatPrice(input.symbol, input.price)),
    strategyLine(input.strategy, input.leverage),
    stampLine(input.at),
  ]);
}

export interface SignalCardInput {
  outcome: 'PROPOSED' | 'ACCEPTED' | 'REFUSED' | 'VETOED';
  symbol: string;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  qty?: number;
  notionalUsdt?: number;
  regime?: string;
  strategy: string;
  reason: string;
  note?: string;
  at: number;
}

const signalTitle = (input: SignalCardInput): string => {
  const headline = { PROPOSED: sideEmoji(input.side), ACCEPTED: '✅', REFUSED: '⛔', VETOED: '🧠' }[input.outcome];
  const verb = { PROPOSED: 'PROPOSAL', ACCEPTED: 'ACCEPTED', REFUSED: 'REFUSED', VETOED: 'VETOED' }[input.outcome];
  return `<b>${headline} ENTRY ${verb} — ${input.side}</b>`;
};

const riskRewardLine = (input: SignalCardInput): string[] => {
  const ratio = Math.abs(input.takeProfit - input.entry) / Math.abs(input.entry - input.stopLoss);
  return finite(ratio) ? [field('⚖️', 'RR', ratio.toFixed(2))] : [];
};

const sizeLine = (input: SignalCardInput): string[] => {
  const qty = finite(input.qty) ? formatQty(input.symbol, input.qty) : undefined;
  const notional = finite(input.notionalUsdt) ? `${groupedMoney(input.notionalUsdt)} USDT` : undefined;
  if (qty && notional) return [field('💼', 'Size', `${qty} (${notional})`)];
  return qty || notional ? [field('💼', 'Size', qty ?? notional ?? '')] : [];
};

const verdictLine = (input: SignalCardInput): string[] => {
  if (!input.note) return [];
  if (input.outcome === 'REFUSED') return [field('⛔', 'Refused', text(input.note))];
  return input.outcome === 'VETOED' ? [field('🧠', 'Vetoed', text(input.note))] : [];
};

/** HTML card for an entry proposal and what became of it: accepted, refused by the risk gate, or vetoed. */
export function signalCard(input: SignalCardInput): string {
  const { symbol } = input;
  return finishCard([
    `<b>[ SIGNAL ]</b> ${text(symbol)}`,
    signalTitle(input),
    field('🎯', 'Entry', formatPrice(symbol, input.entry)),
    field('🛑', 'SL', formatPrice(symbol, input.stopLoss)),
    field('✅', 'TP', formatPrice(symbol, input.takeProfit)),
    ...riskRewardLine(input),
    ...sizeLine(input),
    ...(input.regime ? [field('🧭', 'Regime', text(input.regime))] : []),
    strategyLine(input.strategy),
    field('📝', 'Why', text(input.reason)),
    ...verdictLine(input),
    stampLine(input.at),
  ]);
}

export type SystemCardInput =
  | { kind: 'VENUE'; state: 'degraded' | 'down' | 'recovered'; venue: string; account?: string; detail?: string; at: number }
  | { kind: 'WS'; status: WsStatus; at: number }
  | { kind: 'LOOP_CRASH'; error: string; at: number }
  | { kind: 'CIRCUIT'; from: string; to: string; dailyLossPercent: number; drawdownPercent: number; lossStreak: number; at: number }
  | { kind: 'KILL_SWITCH'; halted: boolean; reason: string; at: number }
  | { kind: 'UNPROTECTED'; equity: number; positions: readonly { symbol: string; side: string; owner: string; notionalUsdt: number; equityPct: number }[]; at: number };

const VENUE_TITLES = { degraded: '⚠️ VENUE DEGRADED', down: '🚨 VENUE DOWN', recovered: '✅ VENUE RECOVERED' } as const;
const WS_TITLES: Readonly<Record<WsStatus, string>> = {
  down: '🚨 WEBSOCKET DOWN', reconnecting: '⚠️ WEBSOCKET RECONNECTING', connected: '✅ WEBSOCKET RECOVERED',
};

const systemBody = (input: SystemCardInput): string[] => {
  switch (input.kind) {
    case 'VENUE': {
      const venue = input.account ? `${text(input.venue)} (${text(input.account)})` : text(input.venue);
      const detail = input.detail ? [field('⚠️', 'Detail', text(input.detail))] : [];
      return [`<b>${VENUE_TITLES[input.state]}</b>`, field('🏦', 'Venue', venue), ...detail];
    }
    case 'WS':
      return [`<b>${WS_TITLES[input.status]}</b>`, field('📡', 'Binance WebSocket', input.status)];
    case 'LOOP_CRASH':
      return ['<b>💥 LOOP CRASH</b>', field('⚠️', 'Error', text(input.error))];
    case 'CIRCUIT':
      return [
        `<b>${input.to === 'NORMAL' ? '✅ RISK NORMALIZED' : '🛡️ RISK ALERT'}</b>`,
        field('🔀', 'Circuit breaker', `${text(input.from)} → ${text(input.to)}`),
        field('📉', 'Daily loss', percent(input.dailyLossPercent)),
        field('📉', 'Drawdown', percent(input.drawdownPercent)),
        field('🔻', 'Loss streak', String(input.lossStreak)),
      ];
    case 'UNPROTECTED':
      return [
        '<b>🚨 POSITION WITHOUT A STOP</b>',
        ...input.positions.slice(0, 6).map((p) => `   • ${text(p.symbol)} ${text(p.side)} · $${p.notionalUsdt.toFixed(0)} (${p.equityPct.toFixed(0)}% of equity) · owner ${text(p.owner)}`),
        field('📝', 'Risk', 'no protective stop; this agent cannot enforce one on a position it does not own'),
        field('💼', 'Equity', `$${input.equity.toFixed(0)}`),
      ];
    case 'KILL_SWITCH':
      return [`<b>${input.halted ? '⛔ KILL SWITCH HALTED' : '▶️ KILL SWITCH RESUMED'}</b>`, field('📝', 'Reason', text(input.reason))];
  }
};

/** HTML card for operational events: venue health, websocket, loop crash, circuit breaker and kill-switch changes. */
export const systemCard = (input: SystemCardInput): string =>
  finishCard(['<b>[ SYSTEM ]</b>', ...systemBody(input), stampLine(input.at)]);

export interface DigestInput {
  period: string;
  summary: PerformanceSummary;
  trades: readonly TradeRecord[];
  refusals?: Readonly<Record<string, number>>;
  at: number;
}

// Zero losses gives Infinity (or NaN with no trades); both print as a dash rather than a misleading number
const profitFactor = (trades: readonly TradeRecord[]): string => {
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0);
  const ratio = grossWin / grossLoss;
  return Number.isFinite(ratio) ? ratio.toFixed(2) : NO_VALUE;
};

const extremes = (trades: readonly TradeRecord[]): string[] => {
  if (trades.length === 0) return [];
  const byPnl = [...trades].sort((a, b) => b.pnl - a.pnl);
  const best = byPnl[0];
  const worst = byPnl[byPnl.length - 1];
  return [
    field('🏆', 'Best', `${text(best.symbol)} ${signedMoney(best.pnl)}`),
    field('💔', 'Worst', `${text(worst.symbol)} ${signedMoney(worst.pnl)}`),
  ];
};

const refusalLines = (refusals: Readonly<Record<string, number>>): string[] => {
  const rows = Object.entries(refusals).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (rows.length === 0) return [];
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  return [field('🚫', 'Refusals', String(total)), ...rows.map(([reason, count]) => `   • ${text(reason)}: ${count}`)];
};

const strategyLines = (byStrategy: PerformanceSummary['byStrategy']): string[] => {
  const rows = Object.entries(byStrategy);
  if (rows.length === 0) return [];
  return [
    '🧩 <b>By strategy</b>',
    ...rows.map(([name, s]) => {
      const winPct = s.closed > 0 ? Math.round((s.wins / s.closed) * 100) : NO_VALUE;
      return `   ${text(name)}: ${s.closed} trade${s.closed === 1 ? '' : 's'} · ${winPct}% win · ${signedMoney(s.pnl)}`;
    }),
  ];
};

const pnlText = ({ totalPnl, totalPnlPct }: PerformanceSummary): string => {
  if (!finite(totalPnl)) return NO_VALUE;
  const pct = finite(totalPnlPct) ? `${totalPnlPct >= 0 ? '+' : ''}${percent(totalPnlPct)}` : NO_VALUE;
  return `${signedMoney(totalPnl)} USDT (${pct})`;
};

const drawdownText = (drawdownPct: number): string => (finite(drawdownPct) ? percent(Math.abs(drawdownPct)) : NO_VALUE);

/** HTML digest of a period: PnL, win rate, profit factor, best/worst, drawdown, refusals and per-strategy results. */
export function digestCard(input: DigestInput): string {
  const { summary } = input;
  const winRate = summary.winRate !== null && finite(summary.winRate) ? `${summary.winRate.toFixed(1)}%` : NO_VALUE;
  return finishCard([
    `<b>[ DIGEST ]</b> ${text(input.period)}`,
    '<b>📊 DAILY DIGEST</b>',
    field('💰', 'PnL', pnlText(summary)),
    field('🧾', 'Trades', `${summary.closedTrades} · win rate ${winRate}`),
    field('⚖️', 'Profit factor', profitFactor(input.trades)),
    ...extremes(input.trades),
    field('📉', 'Max drawdown', drawdownText(summary.maxDrawdownPct)),
    ...refusalLines(input.refusals ?? {}),
    ...strategyLines(summary.byStrategy),
    stampLine(input.at),
  ]);
}
