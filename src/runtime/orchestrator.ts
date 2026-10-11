import type { AgentConfig } from '../config.js';
import type { ExecutionPort } from '../execution/ports.js';
import type { TradeAdvisor } from '../llm/advisor.js';
import type { Tick, UnderlyingSpec } from '../domain/types.js';
import { instrumentKey } from '../domain/types.js';
import type { EventLog } from '../ops/eventLog.js';
import type { Logger } from '../ops/logger.js';
import { DayBook } from '../risk/dayBook.js';
import { istParts, shiftDateKey } from '../time/ist.js';
import { assertWarmupClock } from './clockGuard.js';
import type { FeedPort, MarketPort } from './ports.js';
import { UnderlyingAgent } from './underlyingAgent.js';
import type { CockpitSnapshot } from './views.js';

/** The live feed as the orchestrator sees it: routing, lifecycle and freshness. */
export interface OrchestratorFeed extends FeedPort {
  start(): Promise<void>;
  stop(): void;
  onTick(listener: (tick: Tick) => void): () => void;
}

export interface OrchestratorServices {
  /** Pre-restored book for the current IST day. A fresh book is created when omitted. */
  readonly dayBook?: DayBook;
  readonly market: MarketPort;
  readonly feed: OrchestratorFeed;
  readonly execution: ExecutionPort;
  readonly advisor: TradeAdvisor | undefined;
  readonly events: EventLog;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly clockIntervalMs?: number;
  readonly shutdownTimeoutMs?: number;
}

const DEFAULT_CLOCK_INTERVAL_MS = 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 60_000;

/**
 * Wires the feed, execution venue, market data and one agent per underlying
 * around a single shared DayBook.
 *
 * Breach ordering: a daily-loss breach first blocks new entries in the book,
 * then the agents flatten through their normal exit path, and only once every
 * agent is flat is the broker kill switch engaged. Engaging it first could block
 * the very exit orders that are meant to close the position.
 */
export class Orchestrator {
  private readonly book: DayBook;
  private readonly agents = new Map<string, UnderlyingAgent>();
  private readonly spotIndex = new Map<string, string>();
  private readonly optionIndex = new Map<string, string>();
  private readonly now: () => number;
  private readonly dailyLossLimitInr: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeTicks: (() => void) | undefined;
  private unsubscribeEvents: (() => void) | undefined;
  private brokerKillPending: string | undefined;
  private started = false;
  private phase: CockpitSnapshot['phase'] = 'IDLE';
  private phaseDetail: string | undefined;

  constructor(
    private readonly config: AgentConfig,
    private readonly specs: readonly UnderlyingSpec[],
    private readonly services: OrchestratorServices,
  ) {
    this.now = services.now ?? Date.now;
    this.book = services.dayBook ?? new DayBook(this.now(), config.exits.cooldownSeconds * 1000);
    this.dailyLossLimitInr = (config.capital.inr * config.capital.maxDailyLossPct) / 100;
    for (const spec of specs) {
      this.agents.set(spec.symbol, this.createAgent(spec));
      this.spotIndex.set(instrumentKey(spec.spot), spec.symbol);
    }
  }

  get dayBook(): DayBook {
    return this.book;
  }

  agent(symbol: string): UnderlyingAgent | undefined {
    return this.agents.get(symbol);
  }

  /** Starts the agent. A failed start is recorded in the snapshot so the cockpit can show why. */
  async start(): Promise<void> {
    this.phase = 'STARTING';
    try {
      await this.startInternal();
      this.phase = 'RUNNING';
    } catch (error) {
      this.phase = 'FAILED';
      this.phaseDetail = error instanceof Error ? error.message : String(error);
      this.services.logger.error('start failed', { reason: this.phaseDetail });
      throw error;
    }
  }

  private async startInternal(): Promise<void> {
    if (this.started) {
      throw new Error('orchestrator already started');
    }
    this.started = true;

    const openLegs = await this.services.market.brokerOpenOptionCount();
    if (openLegs > 0) {
      throw new Error(
        `broker reports ${openLegs} open option position(s) before start; close or adopt them before starting the agent`,
      );
    }

    const today = istParts(this.now()).date;
    const from = shiftDateKey(today, -(this.config.strategy.warmupDays * 2 + 2));
    const barMs = this.config.strategy.barMinutes * 60_000;
    for (const spec of this.specs) {
      const history = await this.services.market.intradayCandles(spec.spot, this.config.strategy.barMinutes, from, today);
      assertWarmupClock(history[history.length - 1], this.now(), this.config.strategy.barMinutes);
      // The newest warmup bar may still be forming on the exchange; only fully closed bars are seeded.
      const complete = history.filter((bar) => bar.time + barMs <= this.now());
      this.agents.get(spec.symbol)?.seedBars(complete);
      this.services.logger.info('warmup loaded', { underlying: spec.symbol, bars: complete.length });
    }

    this.unsubscribeTicks = this.services.feed.onTick((tick) => this.route(tick));
    this.unsubscribeEvents = this.services.execution.onEvent((event) => {
      this.agents.get(event.underlying)?.onExecutionEvent(event);
    });
    this.services.execution.start?.();
    await this.services.feed.start();
    this.services.feed.subscribe(this.specs.map((spec) => spec.spot));

    this.timer = setInterval(() => this.onClock(), this.services.clockIntervalMs ?? DEFAULT_CLOCK_INTERVAL_MS);
    this.timer.unref?.();
    this.services.logger.info('agent running', {
      mode: this.config.mode,
      underlyings: this.specs.map((spec) => spec.symbol),
    });
  }

  /** Stops new entries, flattens through the normal exit path, then waits (bounded) for flat before closing I/O. */
  async stop(): Promise<void> {
    this.phase = 'STOPPING';
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Ticks and execution events stay subscribed until flat: the exit fills arrive through them.
    for (const agent of this.agents.values()) {
      agent.requestShutdown();
    }
    const flat = await this.waitUntil(
      () => [...this.agents.values()].every((agent) => agent.isFlat()),
      this.services.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    if (!flat) {
      this.services.logger.error('shutdown timed out with open positions; live brackets remain at the broker', {});
    }
    this.unsubscribeTicks?.();
    this.unsubscribeEvents?.();
    await Promise.all([...this.agents.values()].map((agent) => agent.drain()));
    this.services.feed.stop();
    await this.services.execution.close();
    await this.services.events.flush();
    this.phase = 'STOPPED';
    this.services.logger.info('agent stopped', { flat });
  }

  /** Read-only state for the operator cockpit. Building it never changes trading state. */
  snapshot(nowMs: number = this.now()): CockpitSnapshot {
    const day = this.book.snapshot();
    return {
      at: nowMs,
      mode: this.config.mode,
      phase: this.phase,
      phaseDetail: this.phaseDetail,
      capitalInr: this.config.capital.inr,
      riskBudgetInr: (this.config.capital.inr * this.config.capital.maxRiskPerTradePct) / 100,
      dailyLossLimitInr: this.dailyLossLimitInr,
      maxTradesPerDay: this.config.capital.maxTradesPerDay,
      maxOpenPositions: this.config.capital.maxOpenPositions,
      maxHoldMinutes: this.config.exits.maxHoldMinutes,
      staleMs: this.config.feed.staleMs,
      day: {
        dayKey: day.dayKey,
        realizedPnlInr: day.realizedPnlInr,
        unrealizedPnlInr: day.unrealizedPnlInr,
        dayPnlInr: day.dayPnlInr,
        tradesToday: day.tradesToday,
        openUnderlyings: day.openUnderlyings,
        killSwitchReason: day.killSwitchReason,
      },
      underlyings: this.specs.flatMap((spec) => {
        const agent = this.agents.get(spec.symbol);
        return agent === undefined ? [] : [agent.view(nowMs)];
      }),
    };
  }

  /** Operator request to close one underlying's position. Returns a message for the operator. */
  requestManualExit(symbol: string): string {
    const agent = this.agents.get(symbol);
    if (agent === undefined) {
      return `${symbol}: not traded by this agent`;
    }
    const outcome = agent.requestManualExit();
    const message = {
      ACCEPTED: `${symbol}: close requested; the normal exit checks apply`,
      NO_OPEN_POSITION: `${symbol}: no open position to close`,
      NOT_MANAGEABLE: `${symbol}: position is not in a state that accepts a close right now`,
    }[outcome];
    this.services.logger.warn('operator close request', { underlying: symbol, outcome });
    return message;
  }

  /**
   * Operator toggle for the entry block. Blocking is always allowed. Clearing is refused while
   * any underlying is halted or the day has breached its loss limit, because those need a
   * restart and a review, not a keypress.
   */
  toggleEntryBlock(): string {
    const day = this.book.snapshot();
    if (day.killSwitchReason === undefined) {
      this.book.activateKillSwitch(`operator entry block (${new Date(this.now()).toISOString()})`);
      this.services.logger.warn('operator blocked new entries');
      return 'new entries blocked; press k again to clear';
    }
    const halted = [...this.agents.values()].find((agent) => agent.haltedBecause !== undefined);
    if (halted !== undefined) {
      return `cannot clear: ${halted.symbol} is halted (${halted.haltedBecause}); restart after review`;
    }
    if (day.dayPnlInr <= -this.dailyLossLimitInr) {
      return 'cannot clear: the daily loss limit is breached for today';
    }
    this.book.clearKillSwitch();
    this.services.logger.warn('operator cleared the entry block');
    return 'entry block cleared; new entries may resume';
  }

  private createAgent(spec: UnderlyingSpec): UnderlyingAgent {
    const feed: FeedPort = {
      ageMs: (ref) => this.services.feed.ageMs(ref),
      subscribe: (refs) => {
        for (const ref of refs) {
          this.optionIndex.set(instrumentKey(ref), spec.symbol);
        }
        this.services.feed.subscribe(refs);
      },
      unsubscribe: (refs) => {
        for (const ref of refs) {
          this.optionIndex.delete(instrumentKey(ref));
        }
        this.services.feed.unsubscribe(refs);
      },
    };
    return new UnderlyingAgent({
      spec,
      config: this.config,
      market: this.services.market,
      execution: this.services.execution,
      feed,
      advisor: this.services.advisor,
      book: this.book,
      events: this.services.events,
      logger: this.services.logger,
      onHalt: (underlying, reason) => this.onHalt(underlying, reason),
      now: this.now,
    });
  }

  private route(tick: Tick): void {
    const key = instrumentKey(tick);
    const spotSymbol = this.spotIndex.get(key);
    if (spotSymbol !== undefined) {
      this.agents.get(spotSymbol)?.onSpotTick(tick);
      return;
    }
    const optionSymbol = this.optionIndex.get(key);
    if (optionSymbol !== undefined) {
      this.services.execution.onOptionTick(tick);
      this.agents.get(optionSymbol)?.onOptionTick(tick);
    }
  }

  private onClock(): void {
    const now = this.now();
    this.book.observe(now);
    for (const agent of this.agents.values()) {
      agent.onClock(now);
    }
    this.enforceDailyLoss();
    this.maybeEngageBrokerKillSwitch();
  }

  private enforceDailyLoss(): void {
    const snapshot = this.book.snapshot();
    if (snapshot.dayPnlInr > -this.dailyLossLimitInr || snapshot.killSwitchReason !== undefined) {
      return;
    }
    const reason = `daily loss ${snapshot.dayPnlInr.toFixed(2)} breached -${this.dailyLossLimitInr.toFixed(2)}`;
    this.book.activateKillSwitch(reason);
    this.services.logger.error('daily loss limit breached; flattening', { reason });
    this.services.events.record('daily_loss_breach', { dayPnlInr: snapshot.dayPnlInr, limitInr: this.dailyLossLimitInr });
    this.brokerKillPending = reason;
  }

  /**
   * A halt means an order's fate is unknown or the broker disagrees with us.
   * No exit is being managed in that state, so the broker switch engages at once.
   */
  private onHalt(underlying: string, reason: string): void {
    const fullReason = `${underlying}: ${reason}`;
    this.book.activateKillSwitch(fullReason);
    this.services.events.record('book_kill_switch', { reason: fullReason });
    this.engageBrokerKillSwitch(fullReason);
  }

  /** Engages the broker kill switch only once every position is flat, so it cannot block the exits themselves. */
  private maybeEngageBrokerKillSwitch(): void {
    if (this.brokerKillPending === undefined) {
      return;
    }
    if (![...this.agents.values()].every((agent) => agent.isFlat())) {
      return;
    }
    const reason = this.brokerKillPending;
    this.brokerKillPending = undefined;
    this.engageBrokerKillSwitch(reason);
  }

  private engageBrokerKillSwitch(reason: string): void {
    const engage = this.services.execution.engageBrokerKillSwitch;
    if (!this.config.ops.brokerKillSwitchOnBreach || engage === undefined) {
      return;
    }
    void engage.call(this.services.execution, reason).catch((error: unknown) => {
      this.services.logger.error('broker kill switch call failed', { reason, error: String(error) });
    });
  }

  private async waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return true;
  }
}
