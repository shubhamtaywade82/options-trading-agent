import type { AgentConfig } from '../config.js';
import { TradeStateMachine, type TradeEvent, type TradeState } from '../domain/fsm.js';
import {
  instrumentKey,
  type Candle,
  type ExitReason,
  type InstrumentRef,
  type OpenPosition,
  type OptionContract,
  type Signal,
  type Tick,
  type UnderlyingSpec,
} from '../domain/types.js';
import type { EntryOrder, ExecutionEvent, ExecutionPort, ExitOrder } from '../execution/ports.js';
import type { EntrySnapshot, TradeAdvisor } from '../llm/advisor.js';
import { BarSeries, CandleBuilder } from '../market/barSeries.js';
import { bracketLevels } from '../options/pricing.js';
import { pickExpiry, selectContract } from '../options/selector.js';
import { sizePosition } from '../options/sizing.js';
import { evaluateOrbSupertrend, sessionRange, type OrbSupertrendParams } from '../strategy/orbSupertrend.js';
import { ema, superTrend } from '../market/indicators.js';
import type { AgentView, CandidateView, DropView, ExitView, PositionView, SignalView } from './views.js';
import type { EventLog } from '../ops/eventLog.js';
import type { Logger } from '../ops/logger.js';
import { dayDifference } from '../time/calendar.js';
import { istParts, NSE_SESSION_OPEN_MINUTE } from '../time/ist.js';
import { DayBook } from '../risk/dayBook.js';
import { evaluatePreTrade } from '../risk/riskEngine.js';
import type { FeedPort, MarketPort } from './ports.js';
import { SerialQueue } from './serialQueue.js';
import { withDeadline } from './deadline.js';
import { OPEN_GATE, type TradingGate } from './tradingGate.js';

/**
 * The longest an entry intent may take to become durable. It runs inside the serial queue, so a stalled
 * database must not hold up exits. A timeout drops the entry. A late write is counted as a trade on restore.
 */
const INTENT_DEADLINE_MS = 2_000;

export interface AgentDependencies {
  readonly spec: UnderlyingSpec;
  readonly config: AgentConfig;
  readonly market: MarketPort;
  readonly execution: ExecutionPort;
  readonly feed: FeedPort;
  readonly advisor: TradeAdvisor | undefined;
  readonly book: DayBook;
  readonly events: EventLog;
  readonly logger: Logger;
  readonly onHalt: (underlying: string, reason: string) => void;
  readonly now?: () => number;
  /** Process-level conditions (leader lock, unconfirmed events) that stop orders. Open when omitted. */
  readonly gate?: TradingGate;
}

type Preparation =
  | { readonly ok: true; readonly order: EntryOrder; readonly snapshot: EntrySnapshot }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** After a venue rejection, wait before retrying an exit so a broken endpoint is not hammered. */
const EXIT_RETRY_BACKOFF_MS = 10_000;

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 240) : String(error).slice(0, 240);
}

/**
 * One deterministic trading agent per index. It owns the trade state machine
 * for its underlying and is the only component that mutates that state.
 *
 * Inputs (spot ticks, option ticks, clock, execution events) all enter the same
 * SerialQueue, so each transition completes before the next begins. The strategy
 * runs only on closed bars; the risk gate and advisor can only stop an entry.
 */
export class UnderlyingAgent {
  readonly symbol: string;
  private readonly fsm: TradeStateMachine;
  private readonly queue: SerialQueue;
  private readonly bars = new BarSeries();
  private readonly candles: CandleBuilder;
  private readonly now: () => number;
  private readonly orb: OrbSupertrendParams;
  private readonly dailyLossLimitInr: number;
  private pending: EntryOrder | undefined;
  private position: OpenPosition | undefined;
  private lastMark: number | undefined;
  private exitRetryAfterMs = 0;
  private haltReason: string | undefined;
  private shuttingDown = false;
  private manualExit = false;
  private sequence = 0;
  private lastSpot: { price: number; receivedAt: number } | undefined;
  private lastSignal: SignalView | undefined;
  private lastDrop: DropView | undefined;
  private lastCandidate: CandidateView | undefined;
  private lastExit: ExitView | undefined;
  private withheldReason: string | undefined;

  constructor(private readonly deps: AgentDependencies) {
    this.symbol = deps.spec.symbol;
    this.now = deps.now ?? Date.now;
    this.fsm = new TradeStateMachine(this.now);
    this.queue = new SerialQueue((error) => {
      this.deps.logger.error('agent task failed', { underlying: this.symbol, error: describe(error) });
    });
    this.candles = new CandleBuilder(deps.config.strategy.barMinutes * 60_000);
    const { strategy, session } = deps.config;
    this.orb = {
      underlying: this.symbol,
      orbMinutes: strategy.orbMinutes,
      supertrendPeriod: strategy.supertrendPeriod,
      supertrendMultiplier: strategy.supertrendMultiplier,
      emaFast: strategy.emaFast,
      emaSlow: strategy.emaSlow,
      entryStartMinute: session.entryStartMinute,
      entryEndMinute: session.entryEndMinute,
      sessionOpenMinute: NSE_SESSION_OPEN_MINUTE,
    };
    this.dailyLossLimitInr = (deps.config.capital.inr * deps.config.capital.maxDailyLossPct) / 100;
  }

  get state(): TradeState {
    return this.fsm.state;
  }

  get openPosition(): OpenPosition | undefined {
    return this.position;
  }

  get haltedBecause(): string | undefined {
    return this.haltReason;
  }

  /** No position, no pending order, and no entry still being prepared, since that one could yet be submitted. */
  isFlat(): boolean {
    return this.position === undefined && this.pending === undefined && this.fsm.state !== 'SIGNAL_DETECTED';
  }

  /** Warmup history. Bars are upserted, so a bar that also arrives live is not duplicated. */
  seedBars(history: readonly Candle[]): void {
    for (const bar of history) {
      this.bars.upsert(bar);
    }
  }

  barCount(): number {
    return this.bars.length;
  }

  onSpotTick(tick: Tick): void {
    this.lastSpot = { price: tick.ltp, receivedAt: this.now() };
    const closed = this.candles.onTick(tick);
    if (closed !== undefined) {
      this.acceptClosedBar(closed);
    }
  }

  onClock(nowMs: number): void {
    const closed = this.candles.flush(nowMs);
    if (closed !== undefined) {
      this.acceptClosedBar(closed);
    }
    this.queue.run(() => this.checkExits(false));
  }

  onOptionTick(tick: Tick): void {
    const position = this.position;
    if (position === undefined || instrumentKey(tick) !== instrumentKey(position.contract)) {
      return;
    }
    this.lastMark = tick.ltp;
    this.deps.book.setOpenPnl(this.symbol, (tick.ltp - position.averagePrice) * position.quantity);
    this.queue.run(() => this.checkExits(false));
  }

  onExecutionEvent(event: ExecutionEvent): void {
    if (event.underlying !== this.symbol) {
      return;
    }
    this.queue.run(() => this.handleExecution(event));
  }

  requestShutdown(): void {
    this.shuttingDown = true;
    this.queue.run(() => this.checkExits(true));
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }

  /**
   * Re-runs the exit check without a market event. Shutdown uses it, since a rejected exit would
   * otherwise wait for an option tick that may never come. The rejection backoff still applies.
   */
  retryExit(): void {
    if (this.position === undefined || this.fsm.state !== 'RISK_MANAGEMENT_ACTIVE' || this.now() < this.exitRetryAfterMs) {
      return;
    }
    this.queue.run(() => this.checkExits(false));
  }

  /**
   * Operator request to close the open position. It goes through the normal exit path, so
   * the same order checks apply. Returns why it was not accepted, if it was not.
   */
  requestManualExit(): 'ACCEPTED' | 'NO_OPEN_POSITION' | 'NOT_MANAGEABLE' {
    if (this.position === undefined) {
      return 'NO_OPEN_POSITION';
    }
    if (this.fsm.state !== 'RISK_MANAGEMENT_ACTIVE') {
      return 'NOT_MANAGEABLE';
    }
    this.manualExit = true;
    this.queue.run(() => this.checkExits(false));
    return 'ACCEPTED';
  }

  /** Read-only snapshot for the cockpit. Computed from state; never changes it. */
  view(nowMs: number): AgentView {
    const bars = this.bars.all();
    const closes = bars.map((bar) => bar.close);
    const { strategy } = this.deps.config;
    const last = this.bars.last;
    const trend = superTrend(bars, strategy.supertrendPeriod, strategy.supertrendMultiplier);
    const lastParts = last === undefined ? undefined : istParts(last.time);
    const orb =
      lastParts === undefined
        ? undefined
        : sessionRange(bars, lastParts.date, NSE_SESSION_OPEN_MINUTE, NSE_SESSION_OPEN_MINUTE + strategy.orbMinutes);
    const position = this.position;
    const mark = position === undefined ? undefined : this.lastMark;
    const cooldownUntil = this.deps.book.cooldownUntilFor(this.symbol);
    return {
      symbol: this.symbol,
      state: this.fsm.state,
      halted: this.haltReason,
      spot: this.lastSpot?.price,
      spotAgeMs: this.lastSpot === undefined ? this.deps.feed.ageMs(this.deps.spec.spot) : nowMs - this.lastSpot.receivedAt,
      bars: bars.length,
      lastBarTime: last?.time,
      indicators: {
        emaFast: ema(closes, strategy.emaFast),
        emaSlow: ema(closes, strategy.emaSlow),
        supertrend: trend?.trend,
        supertrendLine: trend?.line,
        orbHigh: orb?.high,
        orbLow: orb?.low,
        orbFormed: lastParts !== undefined && lastParts.minuteOfDay >= NSE_SESSION_OPEN_MINUTE + strategy.orbMinutes && orb !== undefined,
      },
      lastSignal: this.lastSignal,
      lastDrop: this.lastDrop,
      lastCandidate: this.lastCandidate,
      lastExit: this.lastExit,
      position: position === undefined ? undefined : positionView(position, mark, nowMs, this.manualExit),
      cooldownUntil,
    };
  }

  private acceptClosedBar(bar: Candle): void {
    if (this.bars.upsert(bar)) {
      this.queue.run(() => this.evaluateSignal());
    }
  }

  private async evaluateSignal(): Promise<void> {
    if (this.fsm.state !== 'IDLE' || this.shuttingDown || this.haltReason !== undefined) {
      return;
    }
    const { session } = this.deps.config;
    const minute = istParts(this.now()).minuteOfDay;
    if (minute < session.entryStartMinute || minute >= session.entryEndMinute) {
      return;
    }
    const signal = evaluateOrbSupertrend(this.bars.all(), this.orb);
    if (signal === undefined) {
      return;
    }

    this.fsm.dispatch('SIGNAL_FOUND');
    this.lastSignal = { direction: signal.direction, barTime: signal.barTime, spot: signal.spot, reasons: signal.reasons, at: this.now() };
    this.record('signal_detected', { direction: signal.direction, spot: signal.spot, reasons: signal.reasons });
    this.deps.logger.info('signal detected', { underlying: this.symbol, direction: signal.direction, spot: signal.spot });

    let prepared: Preparation;
    try {
      prepared = await this.prepareEntry(signal);
    } catch (error) {
      prepared = { ok: false, code: 'DATA_UNAVAILABLE', detail: describe(error) };
    }
    // Checked after the awaits and again right before submission. An operator block, a halt, a breach
    // or a stop can land during market data or the advisor, and nothing downstream rechecks.
    if (prepared.ok) {
      const blocked = this.entryBlockReason();
      if (blocked !== undefined) {
        prepared = { ok: false, code: 'ENTRY_BLOCKED', detail: blocked };
      }
    }
    if (!prepared.ok) {
      this.drop(prepared.code, prepared.detail);
      return;
    }

    const { order } = prepared;
    // The intent must be durable before the broker call. A crash after the call must still find it on restart.
    try {
      await withDeadline(
        this.durableRecord('entry_submitted', {
          correlationId: order.correlationId,
          contract: order.contract.symbol,
          quantity: order.quantity,
          entryReference: order.entryReference,
          stopLossPrice: order.stopLossPrice,
          targetPrice: order.targetPrice,
        }),
        INTENT_DEADLINE_MS,
        `entry intent was not durable within ${INTENT_DEADLINE_MS} ms`,
      );
    } catch (error) {
      this.deps.logger.error('entry not submitted: its intent is not durable', { underlying: this.symbol, error: describe(error) });
      this.drop('INTENT_NOT_DURABLE', describe(error));
      return;
    }
    // The durable write is an await, so the gate is read again before the state moves and the order is sent.
    // An intent that is journalled but not sent is recorded as rejected, which restore reads as released.
    const blockedAfterIntent = this.entryBlockReason();
    if (blockedAfterIntent !== undefined) {
      this.record('entry_rejected', { correlationId: order.correlationId, reason: `ABORTED_AFTER_INTENT: ${blockedAfterIntent}` });
      this.drop('ENTRY_BLOCKED', blockedAfterIntent);
      return;
    }

    this.fsm.dispatch('ENTRY_SUBMITTED');
    this.pending = order;
    this.deps.book.recordEntry(this.symbol);
    this.deps.feed.subscribe([instrumentRefOf(order.contract)]);
    this.deps.logger.info('entry submitted', {
      underlying: this.symbol,
      contract: order.contract.symbol,
      quantity: order.quantity,
      entry: order.entryReference,
      stop: order.stopLossPrice,
      target: order.targetPrice,
    });
    try {
      await this.deps.execution.submitEntry(order);
    } catch (error) {
      this.halt(`entry submission threw: ${describe(error)}`, 'ENTRY_UNCONFIRMED');
    }
  }

  /** Why a new entry must not be submitted right now, or undefined when none applies. */
  private entryBlockReason(): string | undefined {
    if (this.shuttingDown) {
      return 'shutdown requested';
    }
    if (this.haltReason !== undefined) {
      return `halted: ${this.haltReason}`;
    }
    return this.deps.book.snapshot().killSwitchReason ?? (this.deps.gate ?? OPEN_GATE).entryBlock();
  }

  /** Ends a signal without an order. The state returns to IDLE, and the reason is journalled and shown. */
  private drop(code: string, detail: string): void {
    this.lastDrop = { code, detail, at: this.now() };
    this.fsm.dispatch('SIGNAL_DROPPED');
    this.record('signal_dropped', { code, detail });
    this.deps.logger.info('signal dropped', { underlying: this.symbol, code, detail });
  }

  /** A journal write that must reach the ledger. The caller decides what a failure means. */
  private durableRecord(type: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    return this.deps.events.durable(type, { underlying: this.symbol, ...payload });
  }

  /** Builds and validates one entry from a signal. Every rejection carries a stable code. */
  private async prepareEntry(signal: Signal): Promise<Preparation> {
    const { config, spec, market } = this.deps;
    const now = this.now();
    const today = istParts(now);
    const fail = (code: string, detail: string): Preparation => ({ ok: false, code, detail });

    const killSwitchReason = this.deps.book.snapshot().killSwitchReason;
    if (killSwitchReason !== undefined) {
      return fail('KILL_SWITCH_ACTIVE', killSwitchReason);
    }

    const expiries = await market.listExpiries(spec.spot);
    const expiry = pickExpiry(expiries, today.date, config.contract.minDaysToExpiry);
    if (expiry === undefined) {
      return fail('NO_EXPIRY', `no expiry at least ${config.contract.minDaysToExpiry} day(s) out`);
    }

    const chain = await market.optionChain(spec.spot, expiry);
    const contracts = await market.optionContracts(this.symbol, spec.optionSegment);
    const selection = selectContract({
      spot: signal.spot,
      direction: signal.direction,
      expiry,
      chain,
      contracts,
      offsetSteps: config.contract.strikeOffsetSteps,
      maxSpreadPct: config.contract.maxSpreadPct,
      minOpenInterest: config.contract.minOpenInterest,
      minVolume: config.contract.minVolume,
    });
    if (!selection.ok) {
      return fail(selection.code, selection.detail);
    }
    const { contract, quote } = selection;
    if (quote.ask === undefined || quote.bid === undefined) {
      return fail('QUOTE_MISSING', `no two-sided quote on ${contract.symbol}`);
    }

    const bracket = bracketLevels({
      entryReference: quote.ask,
      stopLossPct: config.exits.stopLossPct,
      targetRr: config.exits.targetRr,
      tickSize: contract.tickSize,
    });
    if (bracket === undefined) {
      return fail('BRACKET_UNREPRESENTABLE', `cannot place stop and target at premium ${quote.ask} on tick ${contract.tickSize}`);
    }

    const funds = await market.availableFunds();
    const sizing = sizePosition({
      capitalInr: config.capital.inr,
      maxRiskPerTradePct: config.capital.maxRiskPerTradePct,
      availableFundsInr: funds,
      entryReference: bracket.entryReference,
      stopLossPrice: bracket.stopLossPrice,
      lotSize: contract.lotSize,
      maxLotsPerOrder: config.capital.maxLotsPerOrder,
    });
    if (sizing.lots < 1) {
      return fail(
        'RISK_BUDGET_TOO_SMALL',
        `one lot risks ${(bracket.riskPerUnit * contract.lotSize).toFixed(2)} against a budget of ${sizing.riskBudgetInr.toFixed(2)} (limited by ${sizing.limitedBy})`,
      );
    }

    // Re-read after every await: another underlying may have changed the book while this one was waiting.
    const snapshot = this.deps.book.snapshot();
    const verdict = evaluatePreTrade({
      side: 'BUY',
      entryReference: bracket.entryReference,
      stopLossPrice: bracket.stopLossPrice,
      targetPrice: bracket.targetPrice,
      lots: sizing.lots,
      lotSize: contract.lotSize,
      maxLotsPerOrder: config.capital.maxLotsPerOrder,
      maxRiskInr: sizing.riskBudgetInr,
      availableFundsInr: funds,
      nowMs: now,
      minuteOfDay: today.minuteOfDay,
      entryStartMinute: config.session.entryStartMinute,
      entryEndMinute: config.session.entryEndMinute,
      isExpiryDay: expiry === today.date,
      expiryDayCutoffMinute: config.contract.expiryDayEntryCutoffMinute,
      killSwitchActive: snapshot.killSwitchReason !== undefined,
      dailyPnlInr: snapshot.dayPnlInr,
      dailyLossLimitInr: this.dailyLossLimitInr,
      tradesToday: snapshot.tradesToday,
      maxTradesPerDay: config.capital.maxTradesPerDay,
      openPositions: snapshot.openUnderlyings.length,
      maxOpenPositions: config.capital.maxOpenPositions,
      underlyingOpen: snapshot.openUnderlyings.includes(this.symbol),
      cooldownUntilMs: this.deps.book.cooldownUntilFor(this.symbol),
      spotTickAgeMs: this.deps.feed.ageMs(spec.spot),
      optionQuoteAgeMs: now - quote.observedAt,
      staleMs: config.feed.staleMs,
    });
    if (!verdict.approved) {
      return fail(
        verdict.violations[0]?.code ?? 'RISK_REJECTED',
        verdict.violations.map((violation) => `${violation.code}: ${violation.detail}`).join('; '),
      );
    }

    const entrySnapshot: EntrySnapshot = {
      underlying: this.symbol,
      direction: signal.direction,
      optionSymbol: contract.symbol,
      strike: contract.strike,
      expiry,
      daysToExpiry: dayDifference(today.date, expiry),
      minuteOfDayIst: today.minuteOfDay,
      spot: signal.spot,
      entryReference: bracket.entryReference,
      stopLossPrice: bracket.stopLossPrice,
      targetPrice: bracket.targetPrice,
      spreadPct: ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 100,
      openInterest: quote.oi ?? 0,
      lots: sizing.lots,
      riskInr: verdict.riskInr,
      signalReasons: signal.reasons,
    };

    this.lastCandidate = {
      contractSymbol: contract.symbol,
      optionType: contract.optionType,
      strike: contract.strike,
      expiry,
      entryReference: bracket.entryReference,
      bid: quote.bid,
      spreadPct: entrySnapshot.spreadPct,
      openInterest: entrySnapshot.openInterest,
      lots: sizing.lots,
      quantity: sizing.quantity,
      stopLossPrice: bracket.stopLossPrice,
      targetPrice: bracket.targetPrice,
      riskInr: verdict.riskInr,
      at: now,
    };

    if (this.deps.advisor !== undefined) {
      const advice = await this.deps.advisor.review(entrySnapshot);
      this.record('advisor_verdict', { decision: advice.decision, confidence: advice.confidence, source: advice.source, reason: advice.reason });
      if (advice.decision !== 'ENTER') {
        return fail('ADVISOR_SKIP', `${advice.source}: ${advice.reason}`);
      }
    }

    this.sequence += 1;
    const correlationId = `ENT-${this.symbol}-${now.toString(36)}-${this.sequence}`;
    return {
      ok: true,
      snapshot: entrySnapshot,
      order: {
        side: 'BUY',
        correlationId,
        underlying: this.symbol,
        contract,
        quantity: sizing.quantity,
        entryReference: bracket.entryReference,
        stopLossPrice: bracket.stopLossPrice,
        targetPrice: bracket.targetPrice,
      },
    };
  }

  private async handleExecution(event: ExecutionEvent): Promise<void> {
    switch (event.kind) {
      case 'ENTRY_FILLED':
        this.onEntryFilled(event.correlationId, event.quantity, event.averagePrice, event.at);
        return;
      case 'ENTRY_REJECTED':
        this.onEntryRejected(event.correlationId, event.reason);
        return;
      case 'ENTRY_UNCONFIRMED':
        this.halt(`entry unconfirmed (${event.correlationId}): ${event.reason}`, 'ENTRY_UNCONFIRMED');
        return;
      case 'EXIT_FILLED':
        this.onExitFilled(event.positionId, event.averagePrice, event.quantity, event.reason, event.at);
        return;
      case 'EXIT_REJECTED':
        this.onExitRejected(event.positionId, event.reason);
        return;
      case 'EXIT_UNCONFIRMED':
        this.halt(`exit unconfirmed (${event.positionId}): ${event.reason}`, 'EXIT_UNCONFIRMED');
        return;
      case 'PROTECTIVE_EXIT_FILLED':
        this.onProtectiveExit(event.positionId, event.averagePrice, event.quantity, event.reason, event.at);
        return;
      case 'BROKER_MISMATCH':
        this.halt(`broker mismatch (${event.positionId}): ${event.reason}`, 'HALT');
        return;
    }
  }

  private onEntryFilled(correlationId: string, quantity: number, averagePrice: number, at: number): void {
    const pending = this.pending;
    if (pending === undefined || pending.correlationId !== correlationId) {
      this.deps.logger.warn('entry fill for unknown order ignored', { underlying: this.symbol, correlationId });
      return;
    }
    const position: OpenPosition = {
      positionId: correlationId,
      underlying: this.symbol,
      contract: pending.contract,
      quantity,
      averagePrice,
      stopLossPrice: pending.stopLossPrice,
      targetPrice: pending.targetPrice,
      openedAt: at,
    };
    this.position = position;
    this.lastMark = averagePrice;
    this.deps.book.setOpenPnl(this.symbol, 0);

    if (this.fsm.state === 'ENTRY_PENDING') {
      this.fsm.dispatch('ENTRY_FILLED');
      this.fsm.dispatch('PROTECTION_ARMED');
      this.pending = undefined;
      this.record('entry_filled', { correlationId, quantity, averagePrice, stopLossPrice: position.stopLossPrice, targetPrice: position.targetPrice });
      this.deps.logger.info('position open', { underlying: this.symbol, quantity, averagePrice });
      if (this.shuttingDown) {
        this.queue.run(() => this.checkExits(true));
      }
      return;
    }
    this.deps.logger.error('late entry fill recorded while halted; manual review required', {
      underlying: this.symbol,
      correlationId,
      quantity,
      averagePrice,
    });
    this.record('late_entry_fill', { correlationId, quantity, averagePrice });
  }

  private onEntryRejected(correlationId: string, reason: string): void {
    if (this.fsm.state !== 'ENTRY_PENDING' || this.pending?.correlationId !== correlationId) {
      this.deps.logger.warn('entry rejection for unknown order ignored', { underlying: this.symbol, correlationId });
      return;
    }
    const pending = this.pending;
    this.fsm.dispatch('ENTRY_REJECTED');
    this.pending = undefined;
    this.deps.book.releaseUnfilled(this.symbol);
    this.deps.feed.unsubscribe([instrumentRefOf(pending.contract)]);
    this.record('entry_rejected', { correlationId, reason });
    this.deps.logger.warn('entry rejected', { underlying: this.symbol, reason });
  }

  private onExitFilled(positionId: string, averagePrice: number, quantity: number, reason: ExitReason, at: number): void {
    if (this.position?.positionId !== positionId) {
      this.deps.logger.warn('exit fill for unknown position ignored', { underlying: this.symbol, positionId });
      return;
    }
    if (this.fsm.state === 'EXIT_PENDING') {
      this.fsm.dispatch('EXIT_FILLED');
      this.closePosition(averagePrice, quantity, reason, at);
      this.fsm.dispatch('CLOSE_ACKNOWLEDGED');
      return;
    }
    this.closePosition(averagePrice, quantity, reason, at);
  }

  private onExitRejected(positionId: string, reason: string): void {
    if (this.fsm.state !== 'EXIT_PENDING' || this.position?.positionId !== positionId) {
      return;
    }
    this.fsm.dispatch('EXIT_REJECTED');
    this.exitRetryAfterMs = this.now() + EXIT_RETRY_BACKOFF_MS;
    this.record('exit_rejected', { positionId, reason });
    this.deps.logger.warn('exit rejected; position still open, will retry', { underlying: this.symbol, reason });
  }

  private onProtectiveExit(positionId: string, averagePrice: number, quantity: number, reason: ExitReason, at: number): void {
    if (this.position?.positionId !== positionId) {
      this.deps.logger.warn('protective exit for unknown position ignored', { underlying: this.symbol, positionId });
      return;
    }
    const state = this.fsm.state;
    if (state === 'POSITION_OPEN' || state === 'RISK_MANAGEMENT_ACTIVE' || state === 'EXIT_PENDING') {
      this.fsm.dispatch('PROTECTIVE_EXIT_FILLED');
      this.closePosition(averagePrice, quantity, reason, at);
      this.fsm.dispatch('CLOSE_ACKNOWLEDGED');
      return;
    }
    this.closePosition(averagePrice, quantity, reason, at);
  }

  private closePosition(averagePrice: number, quantity: number, reason: ExitReason, at: number): void {
    const position = this.position;
    if (position === undefined) {
      return;
    }
    // Rounded once, here, so the book, the journal and the restored day all carry the same figure.
    const pnlInr = Number(((averagePrice - position.averagePrice) * quantity).toFixed(2));
    this.lastExit = { reason, pnlInr, at };
    this.manualExit = false;
    this.deps.book.recordClose({ underlying: this.symbol, pnlInr, closedAtMs: at });
    this.deps.feed.unsubscribe([instrumentRefOf(position.contract)]);
    this.position = undefined;
    this.pending = undefined;
    this.lastMark = undefined;
    // The close is durable: a standby that restores the day must see the realised P&L. The position is already
    // closed in memory, so a failure is logged and, through unconfirmed events, holds new entries until it is recorded.
    this.durableRecord('trade_closed', {
      positionId: position.positionId,
      contract: position.contract.symbol,
      quantity,
      entryPrice: position.averagePrice,
      exitPrice: averagePrice,
      pnlInr,
      reason,
    }).catch((error: unknown) => {
      this.deps.logger.error('trade close is not durable yet; entries wait until it is recorded', {
        underlying: this.symbol,
        positionId: position.positionId,
        error: describe(error),
      });
    });
    this.deps.logger.info('position closed', { underlying: this.symbol, reason, pnlInr });
  }

  private async checkExits(shutdown: boolean): Promise<void> {
    const position = this.position;
    if (position === undefined || this.fsm.state !== 'RISK_MANAGEMENT_ACTIVE') {
      return;
    }
    const now = this.now();
    const reason = this.exitReason(position, now, shutdown);
    if (reason === undefined) {
      return;
    }
    if (!shutdown && now < this.exitRetryAfterMs) {
      return;
    }

    const order: ExitOrder = {
      side: 'SELL',
      correlationId: `EXT-${position.positionId}-${now.toString(36)}`,
      underlying: this.symbol,
      positionId: position.positionId,
      contract: position.contract,
      quantity: position.quantity,
      reason,
      referencePrice: this.lastMark ?? position.averagePrice,
    };
    // An exit reduces risk, so it is never held for the ledger. The intent is written durably in the background,
    // and a failure is recorded as an audit gap. Gate-blocked exits (lost leader lock) do not reach the broker.
    const withheld = (this.deps.gate ?? OPEN_GATE).exitBlock();
    if (withheld !== undefined) {
      if (this.withheldReason !== withheld) {
        this.withheldReason = withheld;
        this.deps.logger.error('exit withheld', { underlying: this.symbol, reason: withheld });
      }
      return;
    }
    this.withheldReason = undefined;
    this.fsm.dispatch('EXIT_SUBMITTED');
    this.durableRecord('exit_submitted', { positionId: position.positionId, reason, referencePrice: order.referencePrice }).catch((error: unknown) => {
      this.record('audit_gap', { event: 'exit_submitted', positionId: position.positionId, error: describe(error) });
      this.deps.logger.error('exit intent is not durable; the exit is still sent', { underlying: this.symbol, error: describe(error) });
    });
    this.deps.logger.info('exit submitted', { underlying: this.symbol, reason, referencePrice: order.referencePrice });
    try {
      await this.deps.execution.submitExit(order);
    } catch (error) {
      this.halt(`exit submission threw: ${describe(error)}`, 'EXIT_UNCONFIRMED');
    }
  }

  private exitReason(position: OpenPosition, now: number, shutdown: boolean): ExitReason | undefined {
    // Keyed on the flag as well as the argument: a rejected shutdown exit is retried through the
    // ordinary tick path, and that retry must still be a shutdown exit.
    if (shutdown || this.shuttingDown) {
      return 'SHUTDOWN';
    }
    if (this.manualExit) {
      return 'MANUAL';
    }
    if (this.deps.book.snapshot().dayPnlInr <= -this.dailyLossLimitInr) {
      return 'DAILY_LOSS';
    }
    if (istParts(now).minuteOfDay >= this.deps.config.exits.flattenByMinute) {
      return 'EOD_FLATTEN';
    }
    if (now - position.openedAt >= this.deps.config.exits.maxHoldMinutes * 60_000) {
      return 'TIME_STOP';
    }
    return undefined;
  }

  /** Enters HALTED (or applies the given event) and tells the orchestrator, which may disengage the book. */
  private halt(reason: string, event: TradeEvent = 'HALT'): void {
    if (this.fsm.can(event)) {
      this.fsm.dispatch(event);
    } else if (this.fsm.state !== 'HALTED' && this.fsm.can('HALT')) {
      this.fsm.dispatch('HALT');
    }
    this.haltReason = reason;
    this.deps.logger.error('underlying halted', { underlying: this.symbol, reason });
    // A halt cannot be re-derived on restart, so it is durable. The halt itself does not wait for the write.
    this.durableRecord('halted', { reason, state: this.fsm.state }).catch((error: unknown) => {
      this.deps.logger.error('halt is not durable yet; entries wait until it is recorded', { underlying: this.symbol, error: describe(error) });
    });
    this.deps.onHalt(this.symbol, reason);
  }

  private record(type: string, payload: Readonly<Record<string, unknown>>): void {
    this.deps.events.record(type, { underlying: this.symbol, ...payload });
  }
}

function instrumentRefOf(contract: OptionContract): InstrumentRef {
  return { exchangeSegment: contract.exchangeSegment, securityId: contract.securityId };
}

function positionView(position: OpenPosition, mark: number | undefined, nowMs: number, exitRequested: boolean): PositionView {
  return {
    contractSymbol: position.contract.symbol,
    optionType: position.contract.optionType,
    strike: position.contract.strike,
    expiry: position.contract.expiry,
    quantity: position.quantity,
    averagePrice: position.averagePrice,
    stopLossPrice: position.stopLossPrice,
    targetPrice: position.targetPrice,
    mark,
    unrealizedInr: mark === undefined ? undefined : Number(((mark - position.averagePrice) * position.quantity).toFixed(2)),
    openedAt: position.openedAt,
    heldMinutes: Math.max(0, Math.floor((nowMs - position.openedAt) / 60_000)),
    exitRequested,
  };
}
