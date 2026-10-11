import type { MarketContext } from '../agents/BaseAgent.js';
import { summarizePerformance } from '../binance/performance.js';
import type { VenueStatus } from '../binance/remoteBroker.js';
import { roundQty } from '../binance/symbolRules.js';
import type { PerformanceSnapshot } from '../risk/performanceEngine.js';
import type { LogEntry, RiskDecision, Side, Signal, TradeRecord, WsStatus } from '../types.js';
import { makeAlert, type AlertClass, type AlertEvent, type AlertSeverity, type NotificationEngine } from './alerts.js';
import { digestCard, signalCard, systemCard, tradeCard, type SignalCardInput, type SystemCardInput } from './cards.js';
import { buildSetupNotice } from './setupNotice.js';
import type { SetupMap } from '../decision/SetupEngine.js';
import type { AuditInput } from './eventStore.js';
import type { KillSwitchState } from './killSwitch.js';
import type { UnprotectedPosition } from '../risk/unprotected.js';

export interface OpsDeps {
  isAudit: boolean;
  isAlerts: boolean;
  store: { append(input: AuditInput): void };
  engine: Pick<NotificationEngine, 'submit'>;
  send: (event: AlertEvent, html: string) => Promise<boolean>;
  /** The journal as it stood at start: those trades were already reported by an earlier run. */
  seedTrades?: readonly TradeRecord[];
  now?: () => number;
  /** Leave scenarios the quality gate rejected (NO_TRADE) out of setup cards. */
  hideNoTradeSetups?: boolean;
}

export interface DigestRequest {
  trades: readonly TradeRecord[];
  initialEquity: number;
  /** The scheduled instant; a timer that wakes a millisecond early must not label the wrong day. */
  at?: number;
}

export interface OpsHooks {
  onSignal(signal: Signal): void;
  onSetup(setup: SetupMap): void;
  onGate(signal: Signal, decision: RiskDecision): void;
  onVeto(signal: Signal, reason: string): void;
  onOrder(signal: Signal, decision: RiskDecision, log: LogEntry, ctx: Pick<MarketContext, 'positions' | 'marks'>): void;
  onRefusal(signal: Signal, reason: string): void;
  onExit(trades: readonly TradeRecord[]): void;
  onVenueState(venue: VenueStatus | null, ws: WsStatus): void;
  onCircuit(from: string, to: string, snapshot: PerformanceSnapshot): void;
  onLoopCrash(err: unknown): void;
  onKillSwitch(state: KillSwitchState): void;
  onUnprotected(positions: readonly UnprotectedPosition[], equity: number): void;
  digest(request: DigestRequest): void;
}

interface Notice {
  cls: AlertClass;
  severity: AlertSeverity;
  fingerprint: string;
  html: string;
  symbol?: string;
  stateTo?: string;
}

const DAY_MS = 86_400_000;
const REASON_KEY_CHARS = 80;
const SETUP_COOLDOWN_MS = 15 * 60_000;
// A risk block is a standing state, not an event: say it once, then again only if the reason changes or after this long
const REFUSAL_REANNOUNCE_MS = 4 * 60 * 60_000;
// An unprotected position is a standing danger: say so when it appears or changes, then remind rarely
const UNPROTECTED_REMIND_MS = 6 * 60 * 60_000;

const noop = (): void => {};
const NOOP_HOOKS: OpsHooks = {
  onSignal: noop, onSetup: noop, onGate: noop, onVeto: noop, onOrder: noop, onRefusal: noop, onExit: noop, onVenueState: noop,
  onCircuit: noop, onLoopCrash: noop, onKillSwitch: noop, onUnprotected: noop, digest: noop,
};

const positionKey = (symbol: string, strategy: string): string => `${symbol}:${strategy}`;
const tradeKey = (t: TradeRecord): string => [t.closedAt, t.symbol, t.strategy, t.qty, t.exit, t.reason].join(':');
const sideOf = (signal: Signal): Side => (signal.type === 'OPEN_LONG' ? 'LONG' : 'SHORT');
const dayStartOf = (at: number): number => Math.floor(at / DAY_MS) * DAY_MS;
const sumPnl = (trades: readonly TradeRecord[]): number => trades.reduce((sum, t) => sum + t.pnl, 0);
const sumRefusals = (refusals: Record<string, number>): number => Object.values(refusals).reduce((sum, n) => sum + n, 0);

// Numbers are masked so "liq buffer 0.7x" and "liq buffer 0.9x" count and dedupe as one refusal
const reasonKey = (reason: string): string => reason.replace(/[\d.]+/g, '#').slice(0, REASON_KEY_CHARS);

// A funding hedge is short the perp
function fillKind(signal: Signal, positions: MarketContext['positions']): 'OPEN' | 'SCALE_IN' | 'FLIP' {
  const held = positions?.find((p) => p.symbol === signal.symbol && p.strategy === signal.agent);
  if (!held) return 'OPEN';
  return held.side === sideOf(signal) ? 'SCALE_IN' : 'FLIP';
}

interface SignalNoticeInput { outcome: SignalCardInput['outcome']; signal: Signal; note: string; at: number; notionalUsdt?: number }

// A hedge has no entry/SL/TP to put on a signal card, so it is audited but not announced
function signalNotice({ outcome, signal, note, at, notionalUsdt }: SignalNoticeInput): Notice | undefined {
  const { entry, stopLoss, takeProfit } = signal;
  if (entry === undefined || stopLoss === undefined || takeProfit === undefined) return undefined;
  const html = signalCard({
    outcome, symbol: signal.symbol, side: sideOf(signal), entry, stopLoss, takeProfit, notionalUsdt,
    strategy: signal.agent, reason: signal.reason, note, at,
  });
  return {
    cls: 'SIGNAL', severity: outcome === 'ACCEPTED' ? 'SIGNAL' : 'WATCH', symbol: signal.symbol, stateTo: outcome, html,
    fingerprint: `SIGNAL:${signal.symbol}:${signal.agent}:${outcome}:${reasonKey(note)}`,
  };
}

function exitNotice(trade: TradeRecord): Notice {
  return {
    cls: 'TRADE', severity: trade.reason === 'LIQUIDATED' ? 'CRITICAL' : 'IMPORTANT', symbol: trade.symbol, stateTo: trade.reason,
    fingerprint: `TRADE:${trade.symbol}:${trade.closedAt}:exit`,
    html: tradeCard({ kind: 'EXIT', trade, initialRisk: trade.initialRisk }),
  };
}

function systemNotice(input: SystemCardInput, severity: AlertSeverity, fingerprint: string): Notice {
  return { cls: 'SYSTEM', severity, fingerprint, html: systemCard(input) };
}

class Ops implements OpsHooks {
  private readonly now: () => number;
  private readonly seen: Set<string>;
  private readonly startTime: number;
  private readonly openIds = new Map<string, string>();
  private readonly flippedIds = new Map<string, string>();
  private refusals: Record<string, number> = {};
  private readonly announcedRefusals = new Map<string, number>();
  private unprotectedKey = '';
  private unprotectedAt = 0;
  private unprotectedSeq = 0;
  private lastVenueState: string | null = null;
  private lastWsStatus: WsStatus | null = null;
  private wasWsUp = false;

  constructor(private readonly deps: OpsDeps) {
    this.now = deps.now ?? Date.now;
    this.seen = new Set((deps.seedTrades ?? []).map(tradeKey));
    this.startTime = this.now();
  }

  onSignal = (signal: Signal): void => this.safely(() => this.audit('signal', { ...signal }, signal));

  onSetup = (setup: SetupMap): void => {
    this.safely(() => {
      const notice = buildSetupNotice(setup, { hideNoTrade: this.deps.hideNoTradeSetups ?? false });
      if (!notice) return;
      this.audit('setup', { state: setup.state, bias: setup.bias, scenarioIds: notice.scenarioKey }, { symbol: setup.symbol });
      this.notify(notice);
    });
  };
  onGate = (signal: Signal, decision: RiskDecision): void => {
    this.safely(() => {
      const { approved, reason, positionSizeUsdt: sizeUsdt, leverage } = decision;
      this.audit('gate', { approved, reason, sizeUsdt, leverage }, signal);
      if (approved) this.notify(signalNotice({ outcome: 'ACCEPTED', signal, note: reason, at: this.now(), notionalUsdt: sizeUsdt }));
    });
  };
  onVeto = (signal: Signal, reason: string): void => {
    this.safely(() => {
      this.audit('veto', { reason }, signal);
      this.notify(signalNotice({ outcome: 'VETOED', signal, note: reason, at: this.now() }));
    });
  };
  onRefusal = (signal: Signal, reason: string): void => this.safely(() => this.refuse(signal, reason));
  onOrder = (signal: Signal, decision: RiskDecision, log: LogEntry, ctx: Pick<MarketContext, 'positions' | 'marks'>): void => {
    this.safely(() => {
      this.audit('order', { level: log.level, message: log.msg, sizeUsdt: decision.positionSizeUsdt, leverage: decision.leverage }, signal);
      if (log.level === 'warn') this.refuse(signal, log.msg);
      if (log.level === 'success') this.filled(signal, decision, ctx);
    });
  };
  // Detects closes from the journal rather than from log text, so exits the loop never logged (reconcile, liquidation) are still reported
  onExit = (trades: readonly TradeRecord[]): void => {
    this.safely(() => {
      for (const trade of trades) {
        const key = tradeKey(trade);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        // Trades closed before this session started were already reported by earlier runs
        if (trade.closedAt <= this.startTime) continue;
        this.recordExit(trade);
      }
    });
  };
  onVenueState = (venue: VenueStatus | null, ws: WsStatus): void => {
    this.safely(() => { this.noteVenue(venue); this.noteWs(ws); });
  };
  onCircuit = (from: string, to: string, snapshot: PerformanceSnapshot): void => {
    this.safely(() => {
      const { dailyLossPercent, drawdownPercent, lossStreak } = snapshot;
      this.audit('circuit', { from, to, dailyLossPercent, drawdownPercent, lossStreak });
      const severity = to === 'HALTED' || to === 'EMERGENCY' ? 'CRITICAL' : 'IMPORTANT';
      const input: SystemCardInput = { kind: 'CIRCUIT', from, to, dailyLossPercent, drawdownPercent, lossStreak, at: this.now() };
      this.notify(systemNotice(input, severity, `SYSTEM:circuit:${to}`));
    });
  };
  onLoopCrash = (err: unknown): void => {
    this.safely(() => {
      const error = err instanceof Error ? err.message : String(err);
      this.audit('crash', { error });
      this.notify(systemNotice({ kind: 'LOOP_CRASH', error, at: this.now() }, 'CRITICAL', `SYSTEM:crash:${reasonKey(error)}`));
    });
  };
  onKillSwitch = (state: KillSwitchState): void => {
    this.safely(() => {
      this.audit('killswitch', { halted: state.halted, reason: state.reason });
      const input: SystemCardInput = { kind: 'KILL_SWITCH', halted: state.halted, reason: state.reason, at: this.now() };
      // Keyed on the toggle time: two manual toggles inside one cooldown are two distinct operator actions
      this.notify(systemNotice(input, 'CRITICAL', `SYSTEM:killswitch:${state.at}`));
    });
  };
  onUnprotected = (positions: readonly UnprotectedPosition[], equity: number): void => {
    this.safely(() => {
      if (positions.length === 0) { this.unprotectedKey = ''; return; }
      // Frequency is decided here, so each announcement gets its own fingerprint rather than fighting the engine's cooldown
      // Sizes drift with price; identity is the set of symbols and sides
      const key = positions.map((p) => `${p.symbol}:${p.side}`).sort().join(',');
      const now = this.now();
      if (key === this.unprotectedKey && now - this.unprotectedAt < UNPROTECTED_REMIND_MS) return;
      this.unprotectedKey = key;
      this.unprotectedAt = now;
      this.audit('unprotected', { positions: positions.map((p) => ({ ...p })), equity });
      this.notify(systemNotice({ kind: 'UNPROTECTED', positions, equity, at: now }, 'CRITICAL', `SYSTEM:unprotected:${key}:${this.unprotectedSeq++}`));
    });
  };
  // The digest covers the UTC day that just ended; its equity baseline is the wallet before that day's realized PnL
  digest = ({ trades, initialEquity, at = this.now() }: DigestRequest): void => {
    this.safely(() => {
      const end = dayStartOf(at);
      const day = trades.filter((t) => t.closedAt >= end - DAY_MS && t.closedAt < end);
      const startEquity = initialEquity + sumPnl(trades.filter((t) => t.closedAt < end - DAY_MS));
      const summary = summarizePerformance([...day], startEquity, startEquity + sumPnl(day), at);
      const period = `${new Date(end - DAY_MS).toISOString().slice(0, 10)} UTC`;
      const html = digestCard({ period, summary, trades: day, refusals: this.refusals, at });
      this.audit('digest', { period, trades: day.length, pnl: sumPnl(day), refusals: sumRefusals(this.refusals) });
      this.refusals = {};
      this.notify({ cls: 'RESEARCH', severity: 'WATCH', fingerprint: `RESEARCH:digest:${period}`, html });
    });
  };
  private safely(run: () => void): void {
    try { run(); } catch { /* an ops failure must never reach the trading loop */ }
  }
  private audit(type: string, payload: Record<string, unknown>, ref?: { id?: string; symbol?: string }): void {
    if (!this.deps.isAudit) return;
    try {
      this.deps.store.append({ type, payload, decisionId: ref?.id, symbol: ref?.symbol, at: this.now() });
    } catch {
      // The audit trail is best effort; the trade it describes has already happened
    }
  }

  private notify(notice: Notice | undefined): void {
    if (!this.deps.isAlerts || !notice) return;
    try {
      const event = makeAlert({
        class: notice.cls, severity: notice.severity, symbol: notice.symbol, title: notice.fingerprint, body: notice.html,
        fingerprint: notice.fingerprint, stateTo: notice.stateTo, at: this.now(),
      });
      if (this.deps.engine.submit(event).action !== 'emitted') return;
      // Fire and forget: trading never waits on Telegram
      void this.deps.send(event, notice.html).catch(() => {});
    } catch {
      // A broken alert path must not cost the caller its own work
    }
  }

  private refuse(signal: Signal, reason: string): void {
    const key = reasonKey(reason);
    this.refusals[key] = (this.refusals[key] ?? 0) + 1;
    this.audit('refusal', { reason }, signal);
    const blockKey = `${signal.symbol}:${signal.agent}:${signal.type}:${key}`;
    const announcedAt = this.announcedRefusals.get(blockKey);
    if (announcedAt !== undefined && this.now() - announcedAt < REFUSAL_REANNOUNCE_MS) return;
    this.announcedRefusals.set(blockKey, this.now());
    this.notify(signalNotice({ outcome: 'REFUSED', signal, note: reason, at: this.now() }));
  }

  private filled(signal: Signal, decision: RiskDecision, ctx: Pick<MarketContext, 'positions' | 'marks'>): void {
    const kind = fillKind(signal, ctx.positions);
    const key = positionKey(signal.symbol, signal.agent);
    const previous = this.openIds.get(key);
    if (kind === 'FLIP' && previous !== undefined) this.flippedIds.set(key, previous);
    this.openIds.set(key, signal.id);
    const price = signal.entry ?? ctx.marks[signal.symbol];
    if (!price) return;
    const qty = roundQty(signal.symbol, decision.positionSizeUsdt / price);
    this.notify({
      cls: 'TRADE', severity: 'SIGNAL', symbol: signal.symbol, stateTo: kind, fingerprint: `TRADE:${signal.id}:fill`,
      html: tradeCard({ kind, symbol: signal.symbol, side: sideOf(signal), qty, price, strategy: signal.agent, leverage: decision.leverage, at: this.now() }),
    });
  }

  private recordExit(trade: TradeRecord): void {
    const key = positionKey(trade.symbol, trade.strategy);
    // The flip's exit can be journaled before onOrder files the old id away, so fall back to the open one
    const ids = trade.reason === 'FLIP' && this.flippedIds.has(key) ? this.flippedIds : this.openIds;
    const ref = { id: ids.get(key), symbol: trade.symbol };
    ids.delete(key);
    this.audit('exit', { reason: trade.reason, exit: trade.exit, pnl: trade.pnl }, ref);
    this.audit('journal', { ...trade }, ref);
    this.notify(exitNotice(trade));
  }

  private noteVenue(venue: VenueStatus | null): void {
    if (venue === null || venue.state === this.lastVenueState) return;
    const previous = this.lastVenueState;
    this.lastVenueState = venue.state;
    this.audit('venue', { venue: venue.name, state: venue.state, error: venue.lastError ?? undefined });
    const state = venue.state === 'connected' ? (previous === null ? undefined : 'recovered') : venue.state;
    if (state === undefined) return;
    const input: SystemCardInput = { kind: 'VENUE', state, venue: venue.name, account: venue.accountId, detail: venue.lastError ?? undefined, at: this.now() };
    this.notify(systemNotice(input, state === 'down' ? 'CRITICAL' : 'IMPORTANT', `SYSTEM:venue:${state}`));
  }

  // The socket starts down before it first opens; only a drop after it was up is news
  private noteWs(ws: WsStatus): void {
    if (ws === this.lastWsStatus) return;
    this.lastWsStatus = ws;
    const wasUp = this.wasWsUp;
    this.wasWsUp = this.wasWsUp || ws === 'connected';
    if (!wasUp) return;
    this.audit('venue', { ws });
    const severity = ws === 'reconnecting' ? 'WATCH' : 'IMPORTANT';
    this.notify(systemNotice({ kind: 'WS', status: ws, at: this.now() }, severity, `SYSTEM:ws:${ws}`));
  }
}

/** Audit-trail and alert hooks for the trading loop; with both flags off every hook is a no-op, and no hook can throw. */
export function createOps(deps: OpsDeps): OpsHooks {
  return deps.isAudit || deps.isAlerts ? new Ops(deps) : NOOP_HOOKS;
}
