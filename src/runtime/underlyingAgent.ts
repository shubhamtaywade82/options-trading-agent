import type { AgentConfig } from '../config.js';
import { correlationIdFor } from '../execution/brokerIds.js';
import { TradeStateMachine, type TradeEvent, type TradeState } from '../domain/fsm.js';
import {
  instrumentKey,
  type Candle,
  type Direction,
  type ExitReason,
  type InstrumentRef,
  type OpenPosition,
  type OptionContract,
  type OptionType,
  type Signal,
  type Tick,
  type UnderlyingSpec,
} from '../domain/types.js';
import type { EntryOrder, ExecutionEvent, ExecutionPort, ExitOrder } from '../execution/ports.js';
import type { EntrySnapshot, TradeAdvisor } from '../llm/advisor.js';
import { BarSeries, CandleBuilder } from '../market/barSeries.js';
import { bracketLevels, calculateTrailingStop, roundDownToTick, roundTripChargesInr, roundUpToTick } from '../options/pricing.js';
import { analyzeOptionChain, checkOptionBuyingConfluence } from '../options/chainAnalyzer.js';
import { pickExpiry, selectContract } from '../options/selector.js';
import { sizePosition } from '../options/sizing.js';
import { evaluateOrbSupertrend, sessionRange, type OrbSupertrendParams } from '../strategy/orbSupertrend.js';
import { StrategySession } from '../strategy/session.js';
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
  /** Active session posture and strategy toggles shared across agents. */
  readonly strategySession?: StrategySession;
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
interface SideSlot {
  readonly optionType: OptionType;
  readonly fsm: TradeStateMachine;
  pending: EntryOrder | undefined;
  position: OpenPosition | undefined;
  lastMark: number | undefined;
  exitRetryAfterMs: number;
  manualExit: boolean;
  /** An exit for the current position was sent and has no known outcome yet. A halted slot never resends one. */
  exitSent: boolean;
  lastTradedFlipBarTime?: number | undefined;
  lastTradedBarTime?: number | undefined;
}

export class UnderlyingAgent {
  readonly symbol: string;
  private readonly ce: SideSlot;
  private readonly pe: SideSlot;
  private readonly queue: SerialQueue;
  private readonly bars = new BarSeries();
  private readonly candles: CandleBuilder;
  private readonly now: () => number;
  private readonly orb: OrbSupertrendParams;
  private readonly strategySession: StrategySession;
  private readonly dailyLossLimitInr: number;
  private haltReason: string | undefined;
  private shuttingDown = false;
  private sequence = 0;
  /** Counts agent exits, so a retried exit in the same millisecond still gets its own id. */
  private exitSequence = 0;
  private lastSpot: { price: number; receivedAt: number } | undefined;
  private lastSignal: SignalView | undefined;
  private lastDrop: DropView | undefined;
  private lastCandidate: CandidateView | undefined;
  private lastExit: ExitView | undefined;
  private withheldReason: string | undefined;

  constructor(private readonly deps: AgentDependencies) {
    this.symbol = deps.spec.symbol;
    this.now = deps.now ?? Date.now;
    this.ce = {
      optionType: 'CE',
      fsm: new TradeStateMachine(this.now),
      pending: undefined,
      position: undefined,
      lastMark: undefined,
      exitRetryAfterMs: 0,
      manualExit: false,
      exitSent: false,
    };
    this.pe = {
      optionType: 'PE',
      fsm: new TradeStateMachine(this.now),
      pending: undefined,
      position: undefined,
      lastMark: undefined,
      exitRetryAfterMs: 0,
      manualExit: false,
      exitSent: false,
    };
    this.strategySession = deps.strategySession ?? new StrategySession(deps.config.session.initialPosture, deps.config.strategy.enabledStrategies);
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
      maxBarsSinceFlip: strategy.maxBarsSinceFlip,
      minDistanceAtr: strategy.minDistanceAtr,
    };
    this.dailyLossLimitInr = (deps.config.capital.inr * deps.config.capital.maxDailyLossPct) / 100;
  }

  get state(): TradeState {
    if (this.ce.fsm.state === 'HALTED' || this.pe.fsm.state === 'HALTED') {
      return 'HALTED';
    }
    if (this.ce.fsm.state !== 'IDLE') {
      return this.ce.fsm.state;
    }
    return this.pe.fsm.state;
  }

  get openPosition(): OpenPosition | undefined {
    return this.ce.position ?? this.pe.position;
  }

  get openPositions(): readonly OpenPosition[] {
    const list: OpenPosition[] = [];
    if (this.ce.position !== undefined) {
      list.push(this.ce.position);
    }
    if (this.pe.position !== undefined) {
      list.push(this.pe.position);
    }
    return list;
  }

  get haltedBecause(): string | undefined {
    return this.haltReason;
  }

  /** Flat only when both CE and PE sides have no open position, pending order or in-flight signal. */
  isFlat(): boolean {
    return (
      this.ce.position === undefined &&
      this.ce.pending === undefined &&
      this.ce.fsm.state !== 'SIGNAL_DETECTED' &&
      this.pe.position === undefined &&
      this.pe.pending === undefined &&
      this.pe.fsm.state !== 'SIGNAL_DETECTED'
    );
  }

  /** An entry order was sent and has not filled or been rejected. */
  hasPendingEntry(): boolean {
    return this.ce.pending !== undefined || this.pe.pending !== undefined;
  }

  /** Adopts an existing open position into active risk management on startup. */
  adoptPosition(position: OpenPosition): void {
    const slot = this.slotForOptionType(position.contract.optionType);
    if (slot.position !== undefined) {
      this.deps.logger.warn('cannot adopt position: slot already occupied', {
        underlying: this.symbol,
        optionType: slot.optionType,
        positionId: position.positionId,
      });
      return;
    }
    slot.position = position;
    slot.lastMark = position.averagePrice;
    slot.fsm.adopt('RISK_MANAGEMENT_ACTIVE');
    this.deps.book.markOpen(this.symbol, slot.optionType);
    this.deps.book.setOpenPnl(this.symbol, 0, slot.optionType);
    this.deps.book.setOpenRisk(this.symbol, riskAtStop(position.quantity, position.averagePrice, position.stopLossPrice), slot.optionType);
    this.deps.feed.subscribe([instrumentRefOf(position.contract)]);
    this.deps.logger.info('open position adopted into risk management', {
      underlying: this.symbol,
      optionType: slot.optionType,
      positionId: position.positionId,
      quantity: position.quantity,
      averagePrice: position.averagePrice,
    });
  }

  /** Warmup history. Bars are upserted, so a bar that also arrives live is not duplicated. */
  seedBars(history: readonly Candle[]): void {
    for (const bar of history) {
      this.bars.upsert(bar);
    }
  }

  evaluateWarmupSignal(): void {
    if (this.bars.length > 0) {
      this.queue.run(() => this.evaluateSignal());
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
    this.queue.run(async () => {
      await this.checkExitForSlot(this.ce, false);
      await this.checkExitForSlot(this.pe, false);
    });
  }

  onOptionTick(tick: Tick): void {
    for (const slot of this.allSlots()) {
      const position = slot.position;
      if (position !== undefined && instrumentKey(tick) === instrumentKey(position.contract)) {
        slot.lastMark = tick.ltp;
        this.deps.book.setOpenPnl(this.symbol, (tick.ltp - position.averagePrice) * position.quantity, slot.optionType);
        this.updateTrailingStop(slot, tick.ltp);
        this.queue.run(() => this.checkExitForSlot(slot, false));
      }
    }
  }

  private updateTrailingStop(slot: SideSlot, ltp: number): void {
    const position = slot.position;
    if (position === undefined || position.trailingJump === undefined || position.trailingJump <= 0) {
      return;
    }
    const hwm = Math.max(position.highWaterMark ?? position.averagePrice, ltp);
    const newStop = calculateTrailingStop({
      entryPrice: position.averagePrice,
      initialStopPrice: position.initialStopPrice ?? position.stopLossPrice,
      currentStopPrice: position.stopLossPrice,
      highWaterMark: hwm,
      trailingJump: position.trailingJump,
      breakevenAtRr: position.breakevenAtRr,
      tickSize: position.contract.tickSize,
    });
    if (newStop > position.stopLossPrice || hwm !== position.highWaterMark) {
      const moved = newStop > position.stopLossPrice;
      slot.position = { ...position, highWaterMark: hwm, stopLossPrice: newStop };
      if (moved) {
        this.deps.book.setOpenRisk(this.symbol, riskAtStop(position.quantity, position.averagePrice, newStop), slot.optionType);
        this.record('trailing_stop_updated', { positionId: position.positionId, stopLossPrice: newStop, highWaterMark: hwm });
        this.deps.logger.info('trailing stop updated', { underlying: this.symbol, positionId: position.positionId, stopLossPrice: newStop });
      }
    }
  }

  onExecutionEvent(event: ExecutionEvent): void {
    if (event.underlying !== this.symbol) {
      return;
    }
    let slot: SideSlot | undefined;
    if ('correlationId' in event && event.correlationId !== undefined) {
      slot = this.slotForCorrelationId(event.correlationId);
    }
    if (slot === undefined && 'positionId' in event && event.positionId !== undefined) {
      slot = this.slotForPositionId(event.positionId);
    }
    if (slot === undefined) {
      if (event.kind === 'BROKER_MISMATCH') {
        this.halt(`broker mismatch (${event.positionId}): ${event.reason}`, 'HALT');
        return;
      }
      if (event.kind === 'ENTRY_UNCONFIRMED') {
        this.halt(`entry unconfirmed (${event.correlationId}): ${event.reason}`, 'ENTRY_UNCONFIRMED');
        return;
      }
      if (event.kind === 'EXIT_UNCONFIRMED') {
        this.halt(`exit unconfirmed (${event.positionId}): ${event.reason}`, 'EXIT_UNCONFIRMED');
        return;
      }
      this.deps.logger.warn('execution event for unknown order/position', { underlying: this.symbol, event });
      return;
    }
    this.queue.run(() => this.handleExecution(event, slot!));
  }

  requestShutdown(): void {
    this.shuttingDown = true;
    this.queue.run(async () => {
      await this.checkExitForSlot(this.ce, true);
      await this.checkExitForSlot(this.pe, true);
    });
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }

  /**
   * Re-runs the exit check without a market event. Shutdown uses it, since a rejected exit would
   * otherwise wait for an option tick that may never come. The rejection backoff still applies.
   */
  retryExit(): void {
    for (const slot of this.allSlots()) {
      if (this.canExit(slot) && this.now() >= slot.exitRetryAfterMs) {
        this.queue.run(() => this.checkExitForSlot(slot, false));
      }
    }
  }

  /**
   * Operator request to close the open position(s). It goes through the normal exit path, so
   * the same order checks apply. Returns why it was not accepted, if it was not.
   */
  requestManualExit(optionType?: OptionType): 'ACCEPTED' | 'NO_OPEN_POSITION' | 'NOT_MANAGEABLE' {
    const targets = optionType !== undefined ? [this.slotForOptionType(optionType)] : this.allSlots().filter((s) => s.position !== undefined);
    if (targets.length === 0) {
      return 'NO_OPEN_POSITION';
    }
    const held = targets.filter((slot) => slot.position !== undefined);
    if (held.length === 0) {
      return 'NO_OPEN_POSITION';
    }
    // Each side is judged on its own, so one side mid-exit does not stop closing the other.
    const closable = held.filter((slot) => this.canExit(slot));
    for (const slot of closable) {
      slot.manualExit = true;
      this.queue.run(() => this.checkExitForSlot(slot, false));
    }
    return closable.length > 0 ? 'ACCEPTED' : 'NOT_MANAGEABLE';
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
    const openPositions = this.openPositions;
    const positions = openPositions.map((p) => {
      const slot = this.slotForOptionType(p.contract.optionType);
      return positionView(p, slot.lastMark, nowMs, slot.manualExit);
    });
    const cooldownUntil = this.deps.book.cooldownUntilFor(this.symbol);
    return {
      symbol: this.symbol,
      state: this.state,
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
      position: positions[0],
      positions,
      cooldownUntil,
    };
  }

  private slotForDirection(direction: Direction): SideSlot {
    return direction === 'BULLISH' ? this.ce : this.pe;
  }

  private slotForOptionType(optionType: OptionType): SideSlot {
    return optionType === 'CE' ? this.ce : this.pe;
  }

  private slotForCorrelationId(correlationId: string): SideSlot | undefined {
    if (this.ce.pending?.correlationId === correlationId) return this.ce;
    if (this.pe.pending?.correlationId === correlationId) return this.pe;
    return undefined;
  }

  private slotForPositionId(positionId: string): SideSlot | undefined {
    if (this.ce.position?.positionId === positionId) return this.ce;
    if (this.pe.position?.positionId === positionId) return this.pe;
    return undefined;
  }

  private allSlots(): readonly SideSlot[] {
    return [this.ce, this.pe];
  }

  private acceptClosedBar(bar: Candle): void {
    if (this.bars.upsert(bar)) {
      this.queue.run(() => this.evaluateSignal());
    }
  }

  private async evaluateSignal(): Promise<void> {
    if (this.shuttingDown || this.haltReason !== undefined) {
      return;
    }
    const { session } = this.deps.config;
    const minute = istParts(this.now()).minuteOfDay;
    if (minute < session.entryStartMinute || minute >= session.entryEndMinute) {
      return;
    }
    const signal = this.strategySession.evaluate(this.bars.all(), this.orb);
    if (signal !== undefined) {
      const slot = this.slotForDirection(signal.direction);
      if (slot.fsm.state === 'IDLE') {
        if (signal.flipBarTime !== undefined && slot.lastTradedFlipBarTime === signal.flipBarTime) {
          return;
        }
        if (slot.lastTradedBarTime === signal.barTime) {
          return;
        }
        slot.lastTradedFlipBarTime = signal.flipBarTime;
        slot.lastTradedBarTime = signal.barTime;
        await this.processSignal(signal, slot);
      }
    }
  }

  /** Trend direction according to SuperTrend, EMA or price action. */
  currentTrendDirection(): Direction {
    const bars = this.bars.all();
    const { strategy } = this.deps.config;
    const trend = superTrend(bars, strategy.supertrendPeriod, strategy.supertrendMultiplier);
    if (trend?.trend === 'DOWN') {
      return 'BEARISH';
    }
    if (trend?.trend === 'UP') {
      return 'BULLISH';
    }
    const closes = bars.map((b) => b.close);
    const fast = ema(closes, strategy.emaFast);
    const slow = ema(closes, strategy.emaSlow);
    if (fast !== undefined && slow !== undefined && fast < slow) {
      return 'BEARISH';
    }
    return 'BULLISH';
  }

  /** Injects a test signal on the live market for fast end-to-end verification without waiting for a candle close. */
  triggerTestSignal(direction?: Direction): string {
    const dir = direction ?? this.currentTrendDirection();
    const slot = this.slotForDirection(dir);
    if (slot.fsm.state !== 'IDLE') {
      return `${this.symbol}: cannot test trade while ${slot.optionType} state is ${slot.fsm.state}`;
    }
    const spot = this.lastSpot?.price;
    if (spot === undefined) {
      return `${this.symbol}: no spot tick received yet; wait for market data`;
    }
    const signal: Signal = {
      underlying: this.symbol,
      direction: dir,
      barTime: this.now(),
      spot,
      reasons: [`operator test trade (${dir})`],
      strategy: 'test',
    };
    this.queue.run(() => this.processSignal(signal, slot));
    return `${this.symbol}: test ${dir} signal triggered at spot ${spot}`;
  }

  private async processSignal(signal: Signal, slot: SideSlot): Promise<void> {
    slot.fsm.dispatch('SIGNAL_FOUND');
    this.lastSignal = { direction: signal.direction, barTime: signal.barTime, spot: signal.spot, reasons: signal.reasons, at: this.now() };
    this.record('signal_detected', { direction: signal.direction, spot: signal.spot, reasons: signal.reasons });
    this.deps.logger.info('signal detected', { underlying: this.symbol, direction: signal.direction, spot: signal.spot });

    // The REST calls and the advisor take seconds. They run off the queue so the other side's exits are not held
    // behind them. The slot stays SIGNAL_DETECTED meanwhile, and the submit step re-enters the queue to recheck.
    void this.prepareSafely(signal, slot).then((prepared) => {
      this.queue.run(() => this.finishSignal(prepared, slot));
    });
  }

  private async prepareSafely(signal: Signal, slot: SideSlot): Promise<Preparation> {
    if (this.shuttingDown) {
      return { ok: false, code: 'ENTRY_BLOCKED', detail: 'shutdown requested' };
    }
    try {
      const prepared = await this.prepareEntry(signal, slot);
      if (this.shuttingDown) {
        return { ok: false, code: 'ENTRY_BLOCKED', detail: 'shutdown requested' };
      }
      return prepared;
    } catch (error) {
      if (this.shuttingDown) {
        return { ok: false, code: 'ENTRY_BLOCKED', detail: 'shutdown requested' };
      }
      return { ok: false, code: 'DATA_UNAVAILABLE', detail: describe(error) };
    }
  }

  /** Runs on the queue: anything that changed while the entry was prepared is checked here, before the order. */
  private async finishSignal(prepared: Preparation, slot: SideSlot): Promise<void> {
    if (!prepared.ok) {
      this.drop(prepared.code, prepared.detail, slot);
      return;
    }
    const blocked = this.entryBlockReason();
    if (blocked !== undefined) {
      this.drop('ENTRY_BLOCKED', blocked, slot);
      return;
    }
    const stale = this.staleAtSubmit();
    if (stale !== undefined) {
      this.drop('STALE_AT_SUBMIT', stale, slot);
      return;
    }
    await this.submitPreparedOrder(prepared.order, prepared.snapshot, slot);
  }

  /**
   * The advisor can take seconds after the risk gate passed. The entry window and the spot feed must still hold
   * when the order goes out. The option quote is not re-read: the entry is a LIMIT at the gated price, so a moved
   * market can only leave it unfilled, never fill it above the sized risk.
   */
  private staleAtSubmit(): string | undefined {
    const { session, feed } = this.deps.config;
    const minute = istParts(this.now()).minuteOfDay;
    if (minute >= session.entryEndMinute) {
      return `entry window closed at minute ${session.entryEndMinute}`;
    }
    const spotAgeMs = this.deps.feed.ageMs(this.deps.spec.spot);
    if (spotAgeMs === undefined || spotAgeMs > feed.staleMs) {
      return `spot tick age ${spotAgeMs ?? 'unknown'} ms exceeds ${feed.staleMs} ms`;
    }
    return undefined;
  }

  private async submitPreparedOrder(order: EntryOrder, snapshot: EntrySnapshot, slot: SideSlot): Promise<void> {
    try {
      await withDeadline(
        this.durableRecord('entry_submitted', {
          correlationId: order.correlationId,
          contract: order.contract.symbol,
          quantity: order.quantity,
          entryReference: order.entryReference,
          stopLossPrice: order.stopLossPrice,
          targetPrice: order.targetPrice,
          // The setup behind the trade, so the performance report can judge each one on its own results.
          strategy: snapshot.strategy,
          posture: this.strategySession.view().posture,
          direction: snapshot.direction,
          optionType: order.contract.optionType,
          expiry: snapshot.expiry,
          daysToExpiry: snapshot.daysToExpiry,
          minuteOfDayIst: snapshot.minuteOfDayIst,
        }),
        INTENT_DEADLINE_MS,
        `entry intent was not durable within ${INTENT_DEADLINE_MS} ms`,
      );
    } catch (error) {
      this.deps.logger.error('entry not submitted: its intent is not durable', { underlying: this.symbol, error: describe(error) });
      this.drop('INTENT_NOT_DURABLE', describe(error), slot);
      return;
    }
    const blockedAfterIntent = this.entryBlockReason();
    if (blockedAfterIntent !== undefined) {
      this.record('entry_rejected', { correlationId: order.correlationId, reason: `ABORTED_AFTER_INTENT: ${blockedAfterIntent}` });
      this.drop('ENTRY_BLOCKED', blockedAfterIntent, slot);
      return;
    }
    this.dispatchEntry(order, slot);
  }

  private dispatchEntry(order: EntryOrder, slot: SideSlot): void {
    slot.fsm.dispatch('ENTRY_SUBMITTED');
    slot.pending = order;
    this.deps.book.recordEntry(this.symbol, slot.optionType);
    this.deps.book.setOpenRisk(this.symbol, riskAtStop(order.quantity, order.entryReference, order.stopLossPrice), slot.optionType);
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
      void this.deps.execution.submitEntry(order);
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
  private drop(code: string, detail: string, slot?: SideSlot): void {
    this.lastDrop = { code, detail, at: this.now() };
    if (slot !== undefined && slot.fsm.can('SIGNAL_DROPPED')) {
      slot.fsm.dispatch('SIGNAL_DROPPED');
      slot.lastTradedFlipBarTime = undefined;
    }
    this.record('signal_dropped', { code, detail });
    this.deps.logger.info('signal dropped', { underlying: this.symbol, code, detail });
  }

  /** A journal write that must reach the ledger. The caller decides what a failure means. */
  private durableRecord(type: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    return this.deps.events.durable(type, { underlying: this.symbol, ...payload });
  }

  /** Builds and validates one entry from a signal. Every rejection carries a stable code. */
  private async prepareEntry(signal: Signal, slot: SideSlot): Promise<Preparation> {
    const { config, spec, market } = this.deps;
    const now = this.now();
    const today = istParts(now);
    const fail = (code: string, detail: string): Preparation => ({ ok: false, code, detail });

    const killSwitchReason = this.deps.book.snapshot().killSwitchReason;
    if (killSwitchReason !== undefined) {
      return fail('KILL_SWITCH_ACTIVE', killSwitchReason);
    }

    const expiries = await market.listExpiries(spec.spot);
    const expiry = pickExpiry(expiries, today.date, config.contract.minDaysToExpiry, config.contract.maxDaysToExpiry);
    if (expiry === undefined) {
      const window = config.contract.maxDaysToExpiry > 0
        ? `between ${config.contract.minDaysToExpiry} and ${config.contract.maxDaysToExpiry} day(s) out`
        : `at least ${config.contract.minDaysToExpiry} day(s) out`;
      return fail('NO_EXPIRY', `no expiry ${window}`);
    }

    const chain = await market.optionChain(spec.spot, expiry);
    if (config.chainAnalysis.enabled) {
      const analysis = analyzeOptionChain(chain, signal.spot);
      const confluence = checkOptionBuyingConfluence(analysis, signal.direction, config.chainAnalysis.minHeadroomPts);
      if (!confluence.ok) {
        return fail('OPTION_CHAIN_RESISTANCE', confluence.reason ?? 'option chain resistance detected');
      }
    }
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

    // The entry is a LIMIT at this price, so any fill is at or below it and the realised risk stays inside the
    // budget. Sizing off the bare ask with a MARKET order let a slipped fill widen the fixed stop distance.
    const entryLimit = roundUpToTick(quote.ask * (1 + config.contract.entryLimitBufferPct / 100), contract.tickSize);
    const bracket = bracketLevels({
      entryReference: entryLimit,
      stopLossPct: config.exits.stopLossPct,
      targetRr: config.exits.targetRr,
      tickSize: contract.tickSize,
      trailingJumpPct: config.exits.trailingJumpPct,
    });
    if (bracket === undefined) {
      return fail('BRACKET_UNREPRESENTABLE', `cannot place stop and target at premium ${entryLimit} on tick ${contract.tickSize}`);
    }
    const targetPrice = config.exits.runnerMode
      ? roundDownToTick(bracket.entryReference + Math.max(10 * bracket.riskPerUnit, bracket.entryReference * 5), contract.tickSize)
      : bracket.targetPrice;

    const funds = await market.availableFunds();
    // CAPITAL_INR is a ceiling: the daily loss limit is a percentage of it, so sizing off a larger
    // broker balance would let one stop-out breach the day. A smaller balance shrinks risk with it.
    const capital = Math.min(config.capital.inr, funds);
    const sizing = sizePosition({
      capitalInr: capital,
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
    // The clock too: the expiry, chain and funds calls took time, and the quote's age must include it.
    const snapshot = this.deps.book.snapshot();
    const gateNow = this.now();
    const verdict = evaluatePreTrade({
      side: 'BUY',
      entryReference: bracket.entryReference,
      stopLossPrice: bracket.stopLossPrice,
      targetPrice,
      lots: sizing.lots,
      lotSize: contract.lotSize,
      maxLotsPerOrder: config.capital.maxLotsPerOrder,
      maxRiskInr: sizing.riskBudgetInr,
      availableFundsInr: funds,
      nowMs: gateNow,
      minuteOfDay: istParts(gateNow).minuteOfDay,
      entryStartMinute: config.session.entryStartMinute,
      entryEndMinute: config.session.entryEndMinute,
      isExpiryDay: expiry === today.date,
      expiryDayCutoffMinute: config.contract.expiryDayEntryCutoffMinute,
      killSwitchActive: snapshot.killSwitchReason !== undefined,
      dailyPnlInr: snapshot.dayPnlInr,
      dailyLossLimitInr: this.dailyLossLimitInr,
      realizedPnlInr: snapshot.realizedPnlInr,
      openRiskInr: snapshot.openRiskInr,
      tradesToday: snapshot.tradesToday,
      maxTradesPerDay: config.capital.maxTradesPerDay,
      openPositions: snapshot.openPositions,
      maxOpenPositions: config.capital.maxOpenPositions,
      sideOpen: this.deps.book.isSideOpen(this.symbol, slot.optionType) || slot.position !== undefined,
      underlyingOpenPositions: this.deps.book.underlyingOpenPositions(this.symbol),
      maxPositionsPerUnderlying: config.capital.maxPositionsPerUnderlying,
      cooldownUntilMs: this.deps.book.cooldownUntilFor(this.symbol),
      spotTickAgeMs: this.deps.feed.ageMs(spec.spot),
      optionQuoteAgeMs: gateNow - quote.observedAt,
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
      targetPrice,
      spreadPct: ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 100,
      openInterest: quote.oi ?? 0,
      lots: sizing.lots,
      riskInr: verdict.riskInr,
      strategy: signal.strategy ?? 'unknown',
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
      targetPrice,
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
    const correlationId = correlationIdFor('E', now, this.sequence);
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
        targetPrice,
        initialStopPrice: bracket.stopLossPrice,
        trailingJump: bracket.trailingJump,
        breakevenAtRr: config.exits.breakevenAtRr,
        runner: config.exits.runnerMode,
      },
    };
  }

  private async handleExecution(event: ExecutionEvent, slot: SideSlot): Promise<void> {
    switch (event.kind) {
      case 'ENTRY_FILLED':
        this.onEntryFilled(event, slot);
        return;
      case 'ENTRY_REJECTED':
        this.onEntryRejected(event, slot);
        return;
      case 'ENTRY_UNCONFIRMED':
        this.halt(`entry unconfirmed (${event.correlationId}): ${event.reason}`, 'ENTRY_UNCONFIRMED');
        return;
      case 'EXIT_FILLED':
        this.onExitFilled(event, slot);
        return;
      case 'EXIT_REJECTED':
        this.onExitRejected(event, slot);
        return;
      case 'EXIT_UNCONFIRMED':
        this.halt(`exit unconfirmed (${event.positionId}): ${event.reason}`, 'EXIT_UNCONFIRMED');
        return;
      case 'PROTECTIVE_EXIT_FILLED':
        this.onProtectiveExit(event, slot);
        return;
      case 'BROKER_MISMATCH':
        this.halt(`broker mismatch (${event.positionId}): ${event.reason}`, 'HALT');
        return;
    }
  }

  private onEntryFilled(event: Extract<ExecutionEvent, { kind: 'ENTRY_FILLED' }>, slot: SideSlot): void {
    const { correlationId, quantity, averagePrice, at } = event;
    const pending = slot.pending;
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
      initialStopPrice: pending.initialStopPrice ?? pending.stopLossPrice,
      stopLossPrice: pending.stopLossPrice,
      highWaterMark: averagePrice,
      targetPrice: pending.targetPrice,
      trailingJump: pending.trailingJump,
      breakevenAtRr: pending.breakevenAtRr,
      runner: pending.runner,
      openedAt: at,
    };
    slot.position = position;
    slot.lastMark = averagePrice;
    this.deps.book.setOpenPnl(this.symbol, 0, slot.optionType);
    this.deps.book.setOpenRisk(this.symbol, riskAtStop(quantity, averagePrice, position.stopLossPrice), slot.optionType);

    if (slot.fsm.state === 'ENTRY_PENDING') {
      slot.fsm.dispatch('ENTRY_FILLED');
      slot.fsm.dispatch('PROTECTION_ARMED');
      slot.pending = undefined;
      this.record('entry_filled', { correlationId, quantity, averagePrice, stopLossPrice: position.stopLossPrice, targetPrice: position.targetPrice });
      this.deps.logger.info('position open', { underlying: this.symbol, quantity, averagePrice, optionType: slot.optionType });
      if (this.shuttingDown) {
        this.queue.run(() => this.checkExitForSlot(slot, true));
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

  private onEntryRejected(event: Extract<ExecutionEvent, { kind: 'ENTRY_REJECTED' }>, slot: SideSlot): void {
    const { correlationId, reason } = event;
    if (slot.fsm.state !== 'ENTRY_PENDING' || slot.pending?.correlationId !== correlationId) {
      this.deps.logger.warn('entry rejection for unknown order ignored', { underlying: this.symbol, correlationId });
      return;
    }
    const pending = slot.pending;
    slot.fsm.dispatch('ENTRY_REJECTED');
    slot.pending = undefined;
    this.deps.book.releaseUnfilled(this.symbol, slot.optionType);
    this.deps.feed.unsubscribe([instrumentRefOf(pending.contract)]);
    this.record('entry_rejected', { correlationId, reason });
    this.deps.logger.warn('entry rejected', { underlying: this.symbol, reason, optionType: slot.optionType });
  }

  private onExitFilled(event: Extract<ExecutionEvent, { kind: 'EXIT_FILLED' }>, slot: SideSlot): void {
    if (slot.position?.positionId !== event.positionId) {
      this.deps.logger.warn('exit fill for unknown position ignored', { underlying: this.symbol, positionId: event.positionId });
      return;
    }
    if (slot.fsm.state === 'EXIT_PENDING') {
      slot.fsm.dispatch('EXIT_FILLED');
      this.closePosition(event, slot);
      slot.fsm.dispatch('CLOSE_ACKNOWLEDGED');
      return;
    }
    this.closePosition(event, slot);
  }

  private onExitRejected(event: Extract<ExecutionEvent, { kind: 'EXIT_REJECTED' }>, slot: SideSlot): void {
    const state = slot.fsm.state;
    if ((state !== 'EXIT_PENDING' && state !== 'HALTED') || slot.position?.positionId !== event.positionId) {
      return;
    }
    if (state === 'EXIT_PENDING') {
      slot.fsm.dispatch('EXIT_REJECTED');
    }
    // A definitive rejection means nothing reached the market, so the exit may be sent again.
    slot.exitSent = false;
    slot.exitRetryAfterMs = this.now() + EXIT_RETRY_BACKOFF_MS;
    this.record('exit_rejected', { positionId: event.positionId, reason: event.reason });
    this.deps.logger.warn('exit rejected; position still open, will retry', { underlying: this.symbol, reason: event.reason, optionType: slot.optionType });
  }

  private onProtectiveExit(event: Extract<ExecutionEvent, { kind: 'PROTECTIVE_EXIT_FILLED' }>, slot: SideSlot): void {
    if (slot.position?.positionId !== event.positionId) {
      this.deps.logger.warn('protective exit for unknown position ignored', { underlying: this.symbol, positionId: event.positionId });
      return;
    }
    const state = slot.fsm.state;
    if (state === 'POSITION_OPEN' || state === 'RISK_MANAGEMENT_ACTIVE' || state === 'EXIT_PENDING') {
      slot.fsm.dispatch('PROTECTIVE_EXIT_FILLED');
      this.closePosition(event, slot);
      slot.fsm.dispatch('CLOSE_ACKNOWLEDGED');
      return;
    }
    this.closePosition(event, slot);
  }

  private closePosition(fill: { averagePrice: number; quantity: number; reason: ExitReason; at: number }, slot: SideSlot): void {
    const position = slot.position;
    if (position === undefined) {
      return;
    }
    const { grossPnlInr, chargesInr, pnlInr } = this.closedPnl(position, fill);
    this.lastExit = { reason: fill.reason, pnlInr, at: fill.at };
    slot.manualExit = false;
    slot.exitSent = false;
    this.deps.book.recordClose({ underlying: this.symbol, optionType: slot.optionType, pnlInr, closedAtMs: fill.at });
    this.deps.feed.unsubscribe([instrumentRefOf(position.contract)]);
    slot.position = undefined;
    slot.pending = undefined;
    slot.lastMark = undefined;
    // The close is durable: a standby that restores the day must see the realised P&L. The position is already
    // closed in memory, so a failure is logged and, through unconfirmed events, holds new entries until it is recorded.
    this.durableRecord('trade_closed', {
      positionId: position.positionId,
      contract: position.contract.symbol,
      quantity: fill.quantity,
      entryPrice: position.averagePrice,
      exitPrice: fill.averagePrice,
      grossPnlInr,
      chargesInr,
      pnlInr,
      reason: fill.reason,
      optionType: slot.optionType,
    }).catch((error: unknown) => {
      this.deps.logger.error('trade close is not durable yet; entries wait until it is recorded', {
        underlying: this.symbol,
        positionId: position.positionId,
        error: describe(error),
      });
    });
    this.deps.logger.info('position closed', { underlying: this.symbol, reason: fill.reason, pnlInr, optionType: slot.optionType });
  }

  /**
   * Rounded once, here, so the book, the journal and the restored day all carry the same figure. Net of charges:
   * on a small premium, brokerage, STT and exchange fees are a real share of the risk budget.
   */
  private closedPnl(
    position: OpenPosition,
    fill: { averagePrice: number; quantity: number },
  ): { grossPnlInr: number; chargesInr: number; pnlInr: number } {
    const grossPnlInr = Number(((fill.averagePrice - position.averagePrice) * fill.quantity).toFixed(2));
    const chargesInr =
      this.deps.execution.chargesInFills === true
        ? 0
        : roundTripChargesInr({
            quantity: fill.quantity,
            buyPrice: position.averagePrice,
            sellPrice: fill.averagePrice,
            exchangeSegment: position.contract.exchangeSegment,
          });
    return { grossPnlInr, chargesInr, pnlInr: Number((grossPnlInr - chargesInr).toFixed(2)) };
  }

  /**
   * A halt stops entries, not protection. A halted slot still exits a position (a late fill, or one open on
   * the other side when this underlying halted), unless an exit was already sent for it: that exit's fate is
   * unknown, and a second SELL could leave the account net short.
   */
  private canExit(slot: SideSlot): boolean {
    if (slot.position === undefined) {
      return false;
    }
    return slot.fsm.state === 'RISK_MANAGEMENT_ACTIVE' || (slot.fsm.state === 'HALTED' && !slot.exitSent);
  }

  private async checkExitForSlot(slot: SideSlot, shutdown: boolean): Promise<void> {
    const position = slot.position;
    if (position === undefined || !this.canExit(slot)) {
      return;
    }
    const now = this.now();
    const reason = this.exitReason(slot, now, shutdown);
    if (reason === undefined) {
      return;
    }
    if (!shutdown && now < slot.exitRetryAfterMs) {
      return;
    }

    const order: ExitOrder = {
      side: 'SELL',
      correlationId: correlationIdFor('X', now, (this.exitSequence += 1)),
      underlying: this.symbol,
      positionId: position.positionId,
      contract: position.contract,
      quantity: position.quantity,
      reason,
      referencePrice: slot.lastMark ?? position.averagePrice,
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
    slot.exitSent = true;
    if (slot.fsm.state !== 'HALTED') {
      slot.fsm.dispatch('EXIT_SUBMITTED');
    }
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

  private exitReason(slot: SideSlot, now: number, shutdown: boolean): ExitReason | undefined {
    // Keyed on the flag as well as the argument: a rejected shutdown exit is retried through the
    // ordinary tick path, and that retry must still be a shutdown exit.
    if (shutdown || this.shuttingDown) {
      return 'SHUTDOWN';
    }
    if (slot.manualExit) {
      return 'MANUAL';
    }
    if (this.deps.book.snapshot().dayPnlInr <= -this.dailyLossLimitInr) {
      return 'DAILY_LOSS';
    }
    if (istParts(now).minuteOfDay >= this.deps.config.exits.flattenByMinute) {
      return 'EOD_FLATTEN';
    }
    const position = slot.position;
    if (position !== undefined && now - position.openedAt >= this.deps.config.exits.maxHoldMinutes * 60_000) {
      return 'TIME_STOP';
    }
    return undefined;
  }

  /** Enters HALTED (or applies the given event) and tells the orchestrator, which may disengage the book. */
  private halt(reason: string, event: TradeEvent = 'HALT'): void {
    for (const slot of this.allSlots()) {
      if (slot.fsm.can(event)) {
        slot.fsm.dispatch(event);
      } else if (slot.fsm.state !== 'HALTED' && slot.fsm.can('HALT')) {
        slot.fsm.dispatch('HALT');
      }
    }
    this.haltReason = reason;
    this.deps.logger.error('underlying halted', { underlying: this.symbol, reason });
    // A halt cannot be re-derived on restart, so it is durable. The halt itself does not wait for the write.
    this.durableRecord('halted', { reason, state: this.state }).catch((error: unknown) => {
      this.deps.logger.error('halt is not durable yet; entries wait until it is recorded', { underlying: this.symbol, error: describe(error) });
    });
    this.deps.onHalt(this.symbol, reason);
  }

  private record(type: string, payload: Readonly<Record<string, unknown>>): void {
    this.deps.events.record(type, { underlying: this.symbol, ...payload });
  }
}

function riskAtStop(quantity: number, entryPrice: number, stopLossPrice: number): number {
  return quantity * (entryPrice - stopLossPrice);
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
