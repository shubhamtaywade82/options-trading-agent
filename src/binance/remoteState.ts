import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentId, ExitReason, Position, Side, TradeRecord } from '../types.js';
import type { ExchangeRiskEvent, PaperExchangeAccountSnapshot, PaperExchangePosition } from './paperExchangeClient.js';
import { directionOf } from './stopRules.js';

/** Owner label of positions the agent did not open (manual trades, a lost sidecar); strategies never touch them. */
export const EXTERNAL_OWNER: AgentId = 'EXECUTOR-ε';

/** Last exchange view of a position; lets a fresh process journal a position that vanished while it was offline. */
export interface LastSeen {
  side: Side;
  entry: number;
  qty: number;
  mark: number;
}

/** Strategy-side facts the exchange does not know about a position. */
export interface PositionMeta {
  owner: AgentId;
  stopLoss: number | null;
  takeProfit: number | null;
  initialRisk: number | null;
  openedAt: number;
  external?: boolean;
  lastSeen?: LastSeen;
  /** Decision lineage: the DecisionRecord id that opened this position. */
  decisionId?: string;
}

export interface ClosedPosition {
  symbol: string;
  owner: AgentId;
  side: Side;
  entry: number;
  qty: number;
  initialRisk?: number;
  decisionId?: string;
}

/** Journal record with gross pnl (fees and funding live in the wallet, not in per-trade records). */
export function closedTrade(closed: ClosedPosition, exit: number, reason: ExitReason, closedAt: number): TradeRecord {
  const pnl = (exit - closed.entry) * closed.qty * directionOf(closed.side);
  const risk = closed.initialRisk === undefined ? {} : { initialRisk: closed.initialRisk };
  const decision = closed.decisionId === undefined ? {} : { decisionId: closed.decisionId };
  return { symbol: closed.symbol, strategy: closed.owner, side: closed.side, entry: closed.entry, exit, qty: closed.qty, pnl, reason, closedAt, ...risk, ...decision };
}

export interface RemoteStateFile {
  version: 1;
  accountId: string;
  positions: Record<string, PositionMeta>;
  closedTrades: TradeRecord[];
}

const MAX_TRADES = 1000;
// Mark drift below this is not worth a disk write: lastSeen only prices a close the agent never observed.
const LAST_SEEN_MARK_DRIFT = 0.005;
// Exchange event stamps and the agent's openedAt come from different clocks.
const CLOCK_SKEW_MS = 5_000;
const SIDES: readonly unknown[] = ['LONG', 'SHORT'];

const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const isNumber = (raw: unknown): raw is number => typeof raw === 'number' && Number.isFinite(raw);
const isLevel = (raw: unknown): boolean => raw === null || isNumber(raw);

function isValidLastSeen(raw: unknown): boolean {
  return isRecord(raw) && SIDES.includes(raw.side) && [raw.entry, raw.qty, raw.mark].every(isNumber);
}

function isValidMeta(raw: unknown): raw is PositionMeta {
  if (!isRecord(raw)) return false;
  const hasValidLevels = [raw.stopLoss, raw.takeProfit, raw.initialRisk].every(isLevel);
  const hasValidFlags = (raw.external === undefined || typeof raw.external === 'boolean') && (raw.lastSeen === undefined || isValidLastSeen(raw.lastSeen));
  const hasValidDecision = raw.decisionId === undefined || typeof raw.decisionId === 'string';
  return typeof raw.owner === 'string' && isNumber(raw.openedAt) && hasValidLevels && hasValidFlags && hasValidDecision;
}

function isValidTrade(raw: unknown): raw is TradeRecord {
  if (!isRecord(raw)) return false;
  const hasValidText = typeof raw.symbol === 'string' && typeof raw.strategy === 'string' && typeof raw.reason === 'string' && SIDES.includes(raw.side);
  return hasValidText && [raw.entry, raw.exit, raw.qty, raw.pnl, raw.closedAt].every(isNumber);
}

interface RawStateFile {
  version: 1;
  accountId: unknown;
  positions: Record<string, unknown>;
  closedTrades: unknown[];
}

const hasStateShape = (raw: unknown): raw is RawStateFile =>
  isRecord(raw) && raw.version === 1 && isRecord(raw.positions) && Array.isArray(raw.closedTrades);

/** Keeps what parses as valid; a hand-edited or half-written entry is dropped instead of trusted. */
function sanitized(raw: RawStateFile, accountId: string, notify: (message: string) => void): RemoteStateFile {
  const positions = Object.fromEntries(Object.entries(raw.positions).filter(([, meta]) => isValidMeta(meta))) as Record<string, PositionMeta>;
  const closedTrades = raw.closedTrades.filter(isValidTrade);
  const dropped = Object.keys(raw.positions).length - Object.keys(positions).length + raw.closedTrades.length - closedTrades.length;
  if (dropped > 0) notify(`sidecar: dropped ${dropped} malformed entries`);
  return { version: 1, accountId, positions, closedTrades };
}

/** Sidecar file holding per-position strategy state and the closed-trade journal for one exchange account. */
export class RemoteStore {
  private state: RemoteStateFile;
  private readonly pendingNotices: string[] = [];

  constructor(private readonly filePath: string, accountId: string) {
    this.state = this.load(accountId) ?? { version: 1, accountId, positions: {}, closedTrades: [] };
  }

  getMeta(symbol: string): PositionMeta | undefined {
    return this.state.positions[symbol];
  }

  setMeta(symbol: string, meta: PositionMeta): void {
    this.state.positions[symbol] = meta;
    this.persist();
  }

  /** Written only when the position changed or the mark drifted noticeably, so an idle loop does not rewrite the sidecar file. */
  updateLastSeen(symbol: string, seen: LastSeen): void {
    const meta = this.state.positions[symbol];
    if (!meta || (meta.lastSeen && !hasMoved(meta.lastSeen, seen))) return;
    this.setMeta(symbol, { ...meta, lastSeen: seen });
  }

  /** Queues a line for the cockpit log; the broker hands it out with the next markAll. */
  notice(message: string): void {
    this.pendingNotices.push(message);
  }

  drainNotices(): string[] {
    return this.pendingNotices.splice(0);
  }

  /** A recreated exchange account holds no positions, so strategy state left over from the old one must not be journaled as closes. */
  clearPositions(): void {
    const dropped = Object.keys(this.state.positions);
    if (dropped.length === 0) return;
    this.notice(`account was recreated on the exchange; dropped sidecar positions of ${dropped.join(', ')} without journaling them`);
    this.state.positions = {};
    this.persist();
  }

  deleteMeta(symbol: string): void {
    delete this.state.positions[symbol];
    this.persist();
  }

  metas(): Record<string, PositionMeta> {
    return { ...this.state.positions };
  }

  /** Journals the trade and drops the position's meta in one write, so a crash cannot leave a journaled position that is journaled again after restart. */
  recordClose(trade: TradeRecord): void {
    this.state.closedTrades.push(trade);
    if (this.state.closedTrades.length > MAX_TRADES) this.state.closedTrades.splice(0, this.state.closedTrades.length - MAX_TRADES);
    delete this.state.positions[trade.symbol];
    this.persist();
  }

  /** Journals a partial exit and leaves the position's meta (stops, 1R, owner) in place: the position is still open. */
  recordPartial(trade: TradeRecord): void {
    this.state.closedTrades.push({ ...trade, partial: true });
    if (this.state.closedTrades.length > MAX_TRADES) this.state.closedTrades.splice(0, this.state.closedTrades.length - MAX_TRADES);
    this.persist();
  }

  trades(): TradeRecord[] {
    return [...this.state.closedTrades];
  }

  private load(accountId: string): RemoteStateFile | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!hasStateShape(parsed)) return null;
      if (parsed.accountId === accountId) return sanitized(parsed, accountId, (message) => this.notice(message));
      this.notice(`sidecar ${this.filePath} belongs to account ${String(parsed.accountId)}, not ${accountId}; its state is ignored and will be overwritten`);
      return null;
    } catch {
      // Missing or unreadable file: strategy state is rebuilt by adopting exchange positions, so starting empty is safe.
      return null;
    }
  }

  // Synchronous on purpose: the data is tiny and a crash between a fill and the write would orphan strategy state.
  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
    renameSync(tmpPath, this.filePath);
  }
}

const hasMoved = (old: LastSeen, seen: LastSeen): boolean =>
  old.side !== seen.side || old.entry !== seen.entry || old.qty !== seen.qty || Math.abs(seen.mark - old.mark) >= old.mark * LAST_SEEN_MARK_DRIFT;

// Pure projections of exchange rows plus sidecar meta into what the cockpit and the reconcile need.
export function seenFrom(p: PaperExchangePosition, localMark: number | undefined): LastSeen {
  return { side: sideOf(p), entry: p.averagePrice, qty: p.netQuantity, mark: localMark ?? p.currentPrice };
}

export const sideOf = (p: PaperExchangePosition): Side => (p.side === 'long' ? 'LONG' : 'SHORT');
const NO_LEVEL = '—';
const levelLabel = (level: number | null | undefined): string => (level ? String(level) : NO_LEVEL);

/** Exchange-reported unrealized pnl, or one re-marked from a newer local price. */
export function unrealizedAt(p: PaperExchangePosition, localMark: number | undefined): number {
  if (localMark === undefined) return p.unrealizedPnl;
  return directionOf(sideOf(p)) * (localMark - p.averagePrice) * p.netQuantity;
}

/** Wallet equity: fees and funding sit in availableBalance, which the exchange's own `equity` field ignores. */
export function walletEquity(account: PaperExchangeAccountSnapshot, positions: PaperExchangePosition[], marks: ReadonlyMap<string, number>): number {
  let unrealized = 0;
  for (const p of positions) unrealized += unrealizedAt(p, marks.get(p.symbol));
  return account.availableBalance + account.lockedMargin + unrealized;
}

export function toPosition(p: PaperExchangePosition, meta: PositionMeta | undefined, localMark: number | undefined): Position {
  const side = sideOf(p);
  const mark = localMark ?? p.currentPrice;
  const liq = p.liquidationPrice;
  return {
    id: `${p.symbol}_${side}`,
    symbol: p.symbol,
    side,
    strategy: meta && !meta.external ? meta.owner : EXTERNAL_OWNER,
    entry: p.averagePrice,
    qty: p.netQuantity,
    mark,
    upnl: unrealizedAt(p, localMark),
    upnlPct: p.averagePrice ? ((mark - p.averagePrice) / p.averagePrice) * 100 * directionOf(side) : 0,
    leverage: p.leverage,
    marginType: p.marginType === 'isolated' ? 'ISOLATED' : 'CROSS',
    liqDistancePct: liq !== null && liq > 0 ? (Math.abs(mark - liq) / mark) * 100 : null,
    serverSl: levelLabel(meta?.stopLoss),
    serverTp: levelLabel(meta?.takeProfit),
    initialRisk: meta?.initialRisk ?? undefined,
  };
}

/** Mark price of the newest liquidation of `symbol` that happened after the position was opened, or null. */
export function liquidationMarkSince(events: ExchangeRiskEvent[], symbol: string, openedAt: number): { mark: number } | null {
  const newest = events
    .filter((e) => e.eventType === 'POSITION_LIQUIDATED' && e.details.symbol === symbol && Date.parse(e.createdAt) > openedAt - CLOCK_SKEW_MS)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return newest ? { mark: Number(newest.details.mark_price) } : null;
}
