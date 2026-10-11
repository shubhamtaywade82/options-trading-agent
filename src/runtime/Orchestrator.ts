import { EventEmitter } from 'node:events';
import type { Signal, LogEntry, AppState, Position, MarketPriceInfo, Candle, AgentId } from '../types.js';
import { DEFAULT_COOLDOWN_MS, startsCooldown, type BaseAgent, type MarketContext } from '../agents/BaseAgent.js';
import { BinanceService } from '../binance/client.js';
import { FundingArbAgent } from '../agents/FundingArbAgent.js';
import { MomentumAgent } from '../agents/MomentumAgent.js';
import { AdaptiveSuperTrendAgent } from '../agents/AdaptiveSuperTrendAgent.js';
import { StructureTrendAgent } from '../agents/StructureTrendAgent.js';
import { StructureLiquidityAgent } from '../agents/StructureLiquidityAgent.js';
import { MeanReversionAgent } from '../agents/MeanReversionAgent.js';
import { CrowdingAgent } from '../agents/CrowdingAgent.js';
import { RiskAgent } from '../agents/RiskAgent.js';
import { ExecutorAgent } from '../agents/ExecutorAgent.js';
import { OllamaAdvisor } from '../ollama/advisor.js';
import { errorText, isRefusal } from '../binance/remoteOrders.js';
import { sparkline } from '../binance/indicators.js';
import { accountFields, buildTelemetry, fleetRuntimes, singleFlight, venueInfo, type SessionCounters, type Telemetry, type TelemetryInput } from './telemetry.js';
import { formatPrice, roundPrice } from '../binance/symbolRules.js';
import { nextStops } from '../agents/TrailingStopManager.js';
import { KillSwitch } from '../ops/killSwitch.js';
import { EquityHwmStore } from '../risk/equityHwm.js';
import { announceStartup, buildOps, refreshPortfolio, RiskOps, toggleKillSwitch as flipKillSwitch } from './opsHooks.js';
import { config, LOOP_INTERVAL_MS } from '../config.js';
import type { AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';
import { MarketStateBuilder } from '../market/MarketStateBuilder.js';
import { runCandidateFlow, decisionEvidence, buildDecisionRecord } from '../decision/CandidateFlow.js';
import { tunedStructureLiquidityOptions, DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS } from '../decision/StructureLiquidityStrategy.js';
import { DecisionJournal } from '../decision/DecisionJournal.js';
import { evaluateExecutionQuality } from '../execution/ExecutionQuality.js';
import { AgentLedger } from '../learning/AgentLedger.js';
import { confidenceMultiplier } from '../learning/ConfidenceAdjuster.js';
import { TradeOutcomeRecorder } from '../learning/TradeOutcomeRecorder.js';
import { buildSetupMap } from '../decision/SetupEngine.js';
import { SetupLedger } from '../decision/SetupLedger.js';
import { loadRrProfile } from '../risk/rrProfile.js';
import { findUnprotected } from '../risk/unprotected.js';
import { loadApprovals } from '../risk/strategyApprovals.js';
import { liveStartBlockers } from '../ops/liveReadiness.js';
import { RefusalSuppressor } from './refusalSuppressor.js';
import { annotateSetupMap } from '../decision/SetupPipeline.js';
import { ThesisController } from '../decision/ThesisController.js';
import { FlowTracker } from '../market/FlowTracker.js';
import { SetupOutcomeLedger } from '../learning/SetupOutcomeLedger.js';
import { buildCouncilSignal, COUNCIL_SIGNAL_TTL_MS } from '../decision/CouncilSignal.js';
import { TradingCouncil } from '../llm/TradingCouncil.js';
import { assessSafety, type SafetyVerdict } from '../market/MarketSafety.js';
import { ShockDetector } from '../market/ShockDetector.js';
import { PositionDriver } from '../position/PositionDriver.js';
import type { LiveBook } from '../binance/liveBook.js';
import { featuresFromState } from '../position/features.js';
import { PositionManagerStore } from '../position/PositionManagerStore.js';
import { pmConfigFromEnv } from '../position/pmConfig.js';
import { getSymbolRules } from '../binance/symbolRules.js';

type CycleContext = MarketContext & { tickers: Record<string, MarketPriceInfo>; nextFundingTime: number };

// Debounce tick flushes to 4 Hz to keep live prices responsive without triggering terminal flicker
const TICK_FLUSH_INTERVAL_MS = 250;

export class Orchestrator extends EventEmitter {
  private binance = new BinanceService();
  private marketStateBuilder = new MarketStateBuilder(config.regime.scored ? config.regime.options : undefined);
  private adaptive = new AdaptiveSuperTrendAgent(this.binance);
  private structureTrend = new StructureTrendAgent(this.binance);
  private structLiq = new StructureLiquidityAgent(
    this.binance,
    tunedStructureLiquidityOptions({
      maxSweepAgeCandles: config.structLiq.maxSweepAgeCandles,
      minimumRewardRisk: config.structLiq.minimumRewardRisk,
    }),
  );
  private meanRevert = new MeanReversionAgent(this.binance);
  private crowding = new CrowdingAgent(this.binance);
  private agents: BaseAgent[] = [
    new FundingArbAgent(this.binance),
    new MomentumAgent(this.binance),
    ...(config.mode === 'paper' ? [this.adaptive] : []),
    this.structureTrend, this.meanRevert, this.crowding,
    ...(config.structLiq.enabled ? [this.structLiq] : []),
  ];
  private killSwitch = new KillSwitch();
  // Single authoritative equity high-water mark, shared by the risk agent and the
  // performance engine so both measure drawdown against the same persisted peak.
  private hwm = new EquityHwmStore();
  // Live trades only strategies that earned approval from measured evidence; an absent file approves nothing
  private readonly approved = loadApprovals(config.approvalsPath);
  private readonly requireApproval = config.mode === 'live';
  private readonly unapprovedLoggedAt = new Map<string, number>();
  private risk = new RiskAgent(this.binance, { killSwitch: this.killSwitch, hwm: this.hwm.forMode(config.mode), rrProfile: loadRrProfile(config.rrProfilePath), requireApproval: this.requireApproval, approvedStrategies: this.approved });
  private hooks = buildOps({ log: (line) => this.log('SYSTEM', line, 'info'), seedTrades: this.binance.getTrades() });
  private ops = new RiskOps((message) => this.log('SYSTEM', message, 'warn'), { killSwitch: this.killSwitch, onCircuit: (from, to, snapshot) => this.hooks.onCircuit(from, to, snapshot), hwm: this.hwm.forMode(config.mode) });
  private executor = new ExecutorAgent(this.binance);
  private advisor = new OllamaAdvisor();
  private timer: NodeJS.Timeout | null = null;
  private livePrices: Record<string, number> = {};
  private liveTickers: Record<string, MarketPriceInfo> = {};
  private stopWs: (() => void) | null = null;
  private pendingTickFlush = false;
  private cooldownStartedAt = new Map<string, number>();
  private readonly setupLedger = new SetupLedger();
  private readonly refusalSuppressor = new RefusalSuppressor();
  private readonly flowTracker = new FlowTracker();
  private readonly announcedVerdicts = new Map<string, string>();
  private setupCycles = 0;
  private readonly thesisController = new ThesisController();
  private readonly setupOutcomes = new SetupOutcomeLedger(config.setupOutcomesPath, { feeRate: config.risk.takerFeeRate, slippageRate: config.risk.slippageBufferRate });
  private counters: SessionCounters = { decisions: 0, executed: 0, monitored: 0 };
  private lastVenueState: string | null = null;
  private lastInitError: string | null = null;
  private ledger = new AgentLedger('data/agent-ledger.json');
  private journal = new DecisionJournal(config.decisionsPath);
  private recorder = new TradeOutcomeRecorder(this.ledger, this.journal);
  /** Winning fusion intents of the current cycle, keyed by `${symbol}:${agent}`; feeds decision evidence. */
  private fusionIntents = new Map<string, import('../decision/SignalFusion.js').TradeIntent>();
  private council = new TradingCouncil(this.advisor, this.ledger);
  /** Council TRADE verdicts queued for the next cycle's risk gate — the council runs detached from the tick loop, so its result always lands after collectSignals() for the cycle that requested it. */
  private pendingCouncilSignals: Signal[] = [];
  private shock = new ShockDetector(config.safety.shock);
  private safetyLevels = new Map<string, string>();
  /** Live position manager book (LIVE_POSITION_MANAGER=shadow|on); null otherwise, and then live keeps exchange-side stops only. */
  private liveBook: LiveBook | null = config.positionManager.enabled && config.mode === 'live' && config.positionManager.live !== 'off'
    ? this.binance.createLiveBook(config.positionManager.live, (message, level) => this.log('SYSTEM', message, level))
    : null;
  /** Tick-driven position manager (partials, breakeven, chandelier/structure trail): paper, remote paper, and live when LIVE_POSITION_MANAGER is shadow or on. */
  private positionDriver: PositionDriver | null = config.positionManager.enabled && (config.mode === 'paper' || this.liveBook !== null)
    ? new PositionDriver({
      venue: this.liveBook ? this.liveBook.venue() : this.binance,
      // Shadow decisions never touch real orders, so they must not leave state that a later real run would trust
      store: new PositionManagerStore(config.mode, this.liveBook?.mode === 'shadow' ? 'data/position-manager-shadow.json' : undefined),
      cfg: pmConfigFromEnv(),
      lotOf: (symbol) => { const r = getSymbolRules(symbol); return { step: r.stepSize, minQty: r.minQty, minNotional: r.minNotional }; },
      log: (agent, message, level) => this.log(agent, message, level),
    })
    : null;

  start() {
    const blockers = liveStartBlockers({ mode: config.mode, riskEngine: config.riskEngine, alerts: config.alerts });
    if (blockers.length > 0) {
      for (const b of blockers) this.log('SYSTEM', `LIVE START BLOCKED: ${b}`, 'error');
      throw new Error(`live start blocked: ${blockers.join('; ')}`);
    }
    if (this.requireApproval) this.log('SYSTEM', `LIVE: ${this.approved.size === 0 ? 'no strategies approved, nothing will trade (run scripts/live-readiness.ts)' : `approved strategies: ${[...this.approved].join(', ')}`}`, this.approved.size === 0 ? 'warn' : 'info');
    this.log('SYSTEM', `Orchestrator started in ${config.mode.toUpperCase()} mode`, 'info');
    announceStartup({ killSwitch: this.killSwitch, hooks: this.hooks, warn: (message) => this.log('SYSTEM', message, 'warn') });
    const dropped = this.binance.dropUnlistedPositions(config.symbols);
    if (dropped.length) this.log('SYSTEM', `Dropped ${dropped.length} saved position(s) outside SYMBOLS: ${dropped.join(', ')}`, 'warn');
    if (config.mode === 'live') this.log('SYSTEM', `${this.adaptive.id} disabled: dynamic exits are paper-only`, 'warn');
    if (this.liveBook) this.log('SYSTEM', this.liveBook.mode === 'shadow'
      ? 'LIVE position manager in SHADOW mode: it logs what it would do (partials, breakeven, trail) and sends no orders; exchange-side stops keep protecting positions'
      : 'LIVE position manager is ON: it sends real reduce-only orders and replaces exchange stop orders. Not exercised against the real exchange in CI; watch the first trades', 'warn');
    if (!config.structLiq.enabled) this.log('SYSTEM', `${this.structLiq.id} disabled by STRUCT_LIQ=off`, 'warn');
    else if (
      config.structLiq.maxSweepAgeCandles !== DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.maxSweepAgeCandles
      || config.structLiq.minimumRewardRisk !== DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.minimumRewardRisk
    ) this.log('SYSTEM', `${this.structLiq.id} tuned: maxSweepAgeCandles=${config.structLiq.maxSweepAgeCandles}, minimumRewardRisk=${config.structLiq.minimumRewardRisk}`, 'info');
    if (config.mode === 'paper' && config.paperExchange) this.log('SYSTEM', `Paper trading routed through ${config.paperExchange.url} (account ${config.paperExchange.accountId})`, 'info');
    const runLoop = singleFlight(() => this.loop().catch((err: Error) => this.log('SYSTEM', `Loop crashed: ${err.message}`, 'error')));
    this.binance.loadSymbolRules(config.symbols)
      .catch((err: Error) => this.log('SYSTEM', `Symbol precision load failed (${err.message}); using 2dp defaults`, 'warn'))
      .then(() => this.initVenue()).finally(runLoop);
    this.timer = setInterval(runLoop, LOOP_INTERVAL_MS);
    this.stopWs = this.binance.startRealtimeStream(config.symbols, (sym, price) => this.handleRealtimeTick(sym, price));
    this.hooks.start(this.binance);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.stopWs?.(); this.stopWs = null; this.hooks.stop(); }
  flushOnShutdown(): void { this.binance.flushPaperEngine(); }
  toggleKillSwitch(): void { flipKillSwitch(this.killSwitch, this.hooks, (message) => this.log('SYSTEM', message, 'warn')); }
  private handleRealtimeTick(sym: string, price: number): void {
    this.livePrices[sym] = price;
    this.putTicker(sym, { ...(this.liveTickers[sym] ?? { changePct: 0 }), price });
    if (this.pendingTickFlush) return;
    this.pendingTickFlush = true;
    setTimeout(() => {
      this.pendingTickFlush = false;
      this.flushRealtimeTick().catch((err: unknown) => this.logFailure('Tick flush failed', err));
    }, TICK_FLUSH_INTERVAL_MS);
  }
  private putTicker(sym: string, info: MarketPriceInfo): void { this.liveTickers[sym.replace('USDT', '')] = this.liveTickers[sym] = info; }
  private async flushRealtimeTick(): Promise<void> {
    this.logExits();
    if (config.mode !== 'paper' && !this.binance.hasVenueData()) return;
    const positions = await this.binance.getPositions(false);
    await this.positionDriver?.manage(this.liveBook ? this.liveBook.positions(this.livePrices) : positions);
    const account = await this.binance.getAccount();
    this.emit('state', { ...accountFields(account, positions), spotPrices: { ...this.liveTickers }, wsStatus: this.binance.getWsStatus() });
  }
  async closePosition(pos: Position) {
    this.log('SYSTEM', `Manual close ${pos.symbol} ${pos.side}`, 'warn');
    await this.binance.closePosition(pos).catch((err: unknown) => this.logFailure(`Close ${pos.symbol} failed`, err));
  }
  async cancelAll() { for (const sym of config.symbols) await this.binance.cancelAll(sym); this.log('SYSTEM', 'All pending orders cancelled', 'warn'); }
  pauseAgent(id: string) {
    const agent = [...this.agents, this.risk, this.executor].find((a) => a.id === id);
    if (!agent) return;
    agent.status = agent.status === 'PAUSED' ? 'RUNNING' : 'PAUSED';
    this.log('SYSTEM', `${id} ${agent.status}`, 'info');
  }
  async askAdvisor(question = 'Assess current portfolio risk and position exposures'): Promise<void> {
    if (!this.binance.hasVenueData()) return this.log('SYSTEM', 'Advisor unavailable: the venue has not returned account data yet', 'warn');
    const positions = await this.binance.getPositions(false);
    const account = await this.binance.getAccount();
    const entry = await this.advisor.ask(question, { positions, equity: account.equity });
    this.emit('log', entry);
  }
  private async loop() {
    try {
      this.emit('sync', true);
      if (await this.isVenueReady()) await this.runCycle();
    } catch (err) {
      this.logFailure('Loop error', err);
      if (!isRefusal(err)) this.hooks.onLoopCrash(err);
    } finally {
      this.noteVenue();
      this.emit('sync', false);
    }
  }

  private async runCycle(): Promise<void> {
    const ctx = await this.gatherContext();
    await this.guardEmergencyDrawdown(ctx);
    for (const { message, isFailure } of await this.binance.settleFunding(ctx)) this.log('SYSTEM', message, isFailure ? 'error' : 'info');
    for (const resolved of this.ledger.resolvePredictions(ctx.marks)) {
      this.log('SYSTEM', 'LEARNING ' + resolved.actorId + ' ' + resolved.symbol + ': ' + (resolved.correct ? 'correct' : 'incorrect') + ' after ' + resolved.horizonMinutes + 'm (' + resolved.realizedReturnPct?.toFixed(2) + '%)', 'info');
    }
    for (const g of this.recorder.process(this.binance.getTrades())) this.logGrade(g);
    const signals = await this.collectSignals(ctx);
    await this.processSignals(signals, ctx);
    this.trailStops(await this.binance.getPositions(), ctx);
    await this.consultAdvisor(signals, ctx.positions ?? []);
    await this.emitState(ctx);
  }
  private async guardEmergencyDrawdown(ctx: CycleContext): Promise<void> {
    const maxLoss = ctx.equity * (config.risk.maxDrawdownPct / 100);
    for (const pos of ctx.positions ?? []) {
      if (pos.upnl < 0 && Math.abs(pos.upnl) >= maxLoss) {
        this.log('SYSTEM', `EMERGENCY CLOSE ${pos.symbol}: loss $${Math.abs(pos.upnl).toFixed(2)} exceeds ${config.risk.maxDrawdownPct}% drawdown`, 'error');
        await this.binance.closePosition(pos).catch((err: unknown) => this.logFailure(`Emergency close ${pos.symbol} failed`, err));
      }
    }
  }
  private async isVenueReady(): Promise<boolean> {
    if (!this.binance.hasVenueData()) await this.initVenue();
    return config.mode === 'paper' || this.binance.hasVenueData();
  }
  private async initVenue(): Promise<void> {
    try { await this.binance.initVenue(); this.lastInitError = null; }
    catch (err) { if (errorText(err) !== this.lastInitError) this.log('SYSTEM', `Venue init failed: ${errorText(err)}`, 'error'); this.lastInitError = errorText(err); }
  }
  private noteVenue(): void {
    const venue = this.binance.getVenueStatus();
    this.emit('state', { venue: venueInfo(venue, config.mode), wsStatus: this.binance.getWsStatus() } satisfies Partial<AppState>);
    this.hooks.onVenueState(venue, this.binance.getWsStatus());
    if (venue === null || venue.state === this.lastVenueState) return;
    this.lastVenueState = venue.state;
    this.log('SYSTEM', `${venue.name} ${venue.state}${venue.lastError ? `: ${venue.lastError}` : ''}`, venue.state === 'connected' ? 'info' : 'warn');
  }

  private async collectSignals(ctx: MarketContext): Promise<Signal[]> {
    const raw: Signal[] = [];
    for (const agent of this.agents) {
      const out = await agent.run(ctx);
      for (const s of out) {
        const mult = confidenceMultiplier(agent.id as any, this.ledger, s.symbol);
        const adjusted = { ...s, confidence: Math.min(1, s.confidence * mult) };
        raw.push(adjusted);
        this.log(s.agent, `${s.symbol}: ${s.reason} (conf ${(adjusted.confidence * 100).toFixed(0)}%${mult !== 1 ? ` adj×${mult.toFixed(2)}` : ''})`, 'info');
      }
    }
    for (const s of this.drainCouncilSignals()) {
      const mult = confidenceMultiplier(s.agent as any, this.ledger, s.symbol);
      const adjusted = { ...s, confidence: Math.min(1, s.confidence * mult) };
      raw.push(adjusted);
      this.log(s.agent, `${s.symbol}: ${s.reason} (conf ${(adjusted.confidence * 100).toFixed(0)}%${mult !== 1 ? ` adj×${mult.toFixed(2)}` : ''})`, 'info');
    }
    // The canonical candidate pipeline (routing + fusion) — shared with the replay engine
    const flow = runCandidateFlow(raw, ctx.marketState ?? {});
    for (const g of flow.geometryDropped ?? []) this.log(g.agent as any, `DROPPED ${g.symbol}: degenerate geometry (planned RR ${g.rr === null ? 'n/a' : g.rr.toFixed(2)}${g.breakevenWinRate !== undefined ? `, needs ${(g.breakevenWinRate * 100).toFixed(0)}% win rate to break even after costs > ${(config.candidateMaxBreakevenWinRate * 100).toFixed(0)}%` : ` < ${config.candidateMinRr}`})`, 'info');
    for (const v of flow.routedOut) this.log(v.agent as any, `ROUTED OUT ${v.symbol}: ${v.agent} not allowed in ${v.regime}`, 'info');
    if (flow.fusionFiltered > 0) this.log('SYSTEM', `SignalFusion: ${flow.fusionFiltered} candidate(s) filtered by conflict resolution`, 'info');
    this.fusionIntents = flow.intents;
    return flow.signals;
  }

  private async processSignals(signals: Signal[], ctx: MarketContext): Promise<void> {
    for (const signal of signals) {
      // Dropped before the gate, journal and alerts: an unapproved strategy in live mode is expected silence, not a refusal stream
      if (this.requireApproval && signal.type.startsWith('OPEN_') && !this.approved.has(signal.agent)) {
        const last = this.unapprovedLoggedAt.get(signal.agent) ?? 0;
        if (Date.now() - last > 3_600_000) { this.unapprovedLoggedAt.set(signal.agent, Date.now()); this.log(signal.agent, `live: ${signal.agent} is not approved; its signals are ignored`, 'info'); }
        continue;
      }
      if (this.isCoolingDown(signal)) { this.counters.monitored += 1; continue; }
      const portfolio = { equity: ctx.equity, positions: ctx.positions ?? [], circuit: ctx.performance?.circuit };
      // A capacity/circuit block cannot clear while the book is unchanged: skip the gate instead of re-refusing
      if (this.refusalSuppressor.shouldSkip(signal, portfolio)) { this.counters.monitored += 1; continue; }
      this.counters.decisions += 1;
      this.hooks.onSignal(signal);
      const decisionId = `${signal.id}-${Date.now()}`;
      const evidence = decisionEvidence(signal, ctx.marketState?.[signal.symbol], this.fusionIntents.get(`${signal.symbol}:${signal.agent}`));
      const decision = this.risk.gate(signal, ctx, { evidenceScore: evidence.score });
      this.hooks.onGate(signal, decision);
      // Decision lineage: what the market looked like, what was proposed, and what risk said — persisted before anything else happens
      const record = this.buildDecisionRecord(decisionId, signal, ctx, decision, evidence);
      if (decision.approved) this.refusalSuppressor.noteApproval(signal);
      else this.refusalSuppressor.noteRefusal(signal, decision.reason, portfolio);
      if (!decision.approved) {
        this.journal.record(record);
        this.log('RISK-MGR-δ', `REJECTED ${signal.symbol}: ${decision.reason}`, 'warn');
        this.hooks.onRefusal(signal, decision.reason);
        this.counters.monitored += 1;
        continue;
      }
      if (await this.isVetoed(signal, ctx)) {
        this.journal.record({ ...record, status: 'VETOED', rejectionReason: 'advisor veto' });
        this.counters.monitored += 1;
        continue;
      }
      const derivatives = ctx.marketDataV2?.[signal.symbol]?.derivatives ?? null;
      const eq = evaluateExecutionQuality({ symbol: signal.symbol, side: signal.type.includes('SHORT') ? 'SHORT' : 'LONG', sourceAgent: signal.agent, evidenceScore: Math.round(signal.confidence * 100), entry: signal.entry ?? 0, stopLoss: signal.stopLoss ?? 0, takeProfit: signal.takeProfit ?? 0, reasons: [signal.reason] }, derivatives, decision.positionSizeUsdt);
      if (!eq.approved) {
        this.journal.record({ ...record, status: 'EQ_REJECTED', rejectionReason: eq.reason });
        this.log(signal.agent, `EQ BLOCK ${signal.symbol}: ${eq.reason}`, 'warn');
        this.counters.monitored += 1;
        continue;
      }
      const log = await this.executor.execute(signal, decision, decisionId);
      const executed: import('../decision/DecisionJournal.js').DecisionRecord = {
        ...record,
        execution: { ts: Date.now(), spreadBps: eq.spreadBps, slippageBps: eq.estimatedSlippageBps, effectiveCostBps: eq.effectiveCostBps },
        ...(log.level === 'success' ? { status: 'EXECUTED' as const } : {
          status: log.level === 'warn' ? 'EXECUTION_REFUSED' as const : 'EXECUTION_FAILED' as const,
          rejectionReason: log.msg,
        }),
      };
      this.journal.record(executed);
      this.log(log.agent, log.msg, log.level);
      this.hooks.onOrder(signal, decision, log, ctx);
      if (log.level === 'warn') this.counters.monitored += 1;
      if (startsCooldown(log.level, this.binance.getVenueStatus()?.state)) this.cooldownStartedAt.set(`${signal.symbol}:${signal.agent}`, Date.now());
      if (log.level === 'success') { this.counters.executed += 1; ctx = await refreshPortfolio(ctx, this.binance); }
    }
  }

  /** Delegates to the shared canonical builder so paper, live and replay produce identical records. */
  private buildDecisionRecord(decisionId: string, signal: Signal, ctx: MarketContext, decision: import('../types.js').RiskDecision, evidence: import('../decision/DecisionJournal.js').DecisionRecord['evidence']): import('../decision/DecisionJournal.js').DecisionRecord {
    return buildDecisionRecord({
      decisionId,
      signal,
      state: ctx.marketState?.[signal.symbol],
      decision,
      evidence,
      now: Date.now(),
    });
  }

  private isCoolingDown(signal: Signal): boolean {
    const cooldown = this.agents.find((a) => a.id === signal.agent)?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    return Date.now() - (this.cooldownStartedAt.get(`${signal.symbol}:${signal.agent}`) ?? 0) < cooldown;
  }

  private async isVetoed(signal: Signal, ctx: MarketContext): Promise<boolean> {
    const snapshot = this.adaptive.vetoSnapshot(signal, ctx);
    if (!snapshot) return false;
    const { verdict, reason } = await this.advisor.veto(snapshot);
    if (verdict === 'VETO') { this.log(signal.agent, `VETOED ${signal.type} ${signal.symbol}: ${reason}`, 'warn'); this.hooks.onVeto(signal, reason); }
    if (verdict === 'PROCEED' && reason.startsWith('advisor')) this.log(signal.agent, `veto skipped for ${signal.symbol}: ${reason}`, 'warn');
    return verdict === 'VETO';
  }
  private trailStops(positions: Position[], ctx: CycleContext): void {
    if (this.positionDriver) {
      this.positionDriver.manage(this.liveBook ? this.liveBook.positions(this.livePrices) : positions).catch((err: unknown) => this.logFailure('Position manager failed', err));
      return;
    }
    for (const pos of positions) {
      const adaptiveState = this.adaptive.stateFor(pos.symbol);
      const atr = adaptiveState?.assignedAtr ?? ctx.marketState?.[pos.symbol]?.timeframes?.['15m']?.atr14;
      if (!atr || atr <= 0) continue;
      const next = nextStops(pos, {
        assignedAtr: atr,
        regime: adaptiveState?.regime ?? (ctx.marketState?.[pos.symbol]?.regime?.volatility as 'LOW' | 'MEDIUM' | 'HIGH' | undefined),
        superTrend: pos.strategy === this.adaptive.id ? adaptiveState?.superTrend : undefined,
      });
      if (!next) continue;
      const stopLoss = roundPrice(pos.symbol, next.stopLoss);
      const takeProfit = roundPrice(pos.symbol, next.takeProfit);
      if (stopLoss === Number(pos.serverSl) && takeProfit === Number(pos.serverTp)) continue;
      this.binance.updateStops(pos.symbol, pos.strategy, stopLoss, takeProfit, pos.side);
      this.log(pos.strategy, `TRAIL ${pos.symbol} SL ${formatPrice(pos.symbol, stopLoss)} TP ${formatPrice(pos.symbol, takeProfit)}`, 'info');
    }
  }
  private logExits(): void { for (const line of this.binance.markAll(this.livePrices)) this.log('SYSTEM', line, 'warn'); this.hooks.onExit(this.binance.getTrades()); }
  private logFailure(what: string, err: unknown): void { this.log('SYSTEM', `${what}: ${errorText(err)}`, isRefusal(err) ? 'warn' : 'error'); }
  private async consultCouncil(state: import('../market/types.js').MarketState, setup: import('../decision/SetupTypes.js').SetupMap): Promise<void> {
    try {
      const result = await this.council.analyze(state, setup);
      if (!result) return;
      const votes = result.opinions.map((opinion) => opinion.persona + '=' + opinion.stance).join(' ');
      this.log('SYSTEM', 'AI-COUNCIL ' + state.symbol + ': ' + votes + ' | CHAIR=' + result.chair.action + '/' + result.chair.stance + ' ' + result.chair.rationale, 'info');
      if (!config.llmCouncil.autoTrade) return;
      const signal = buildCouncilSignal(state, setup, result, config.llmCouncil.minProbability);
      if (signal) {
        this.pendingCouncilSignals.push(signal);
        this.log('SYSTEM', `AI-COUNCIL queued ${signal.type} ${signal.symbol} for the next risk gate pass (${signal.reason})`, 'info');
      }
    } catch (err: unknown) {
      this.logFailure('AI council failed', err);
    }
  }

  /** Drains queued council signals, dropping anything the loop hasn't picked up within the TTL. */
  private drainCouncilSignals(): Signal[] {
    const now = Date.now();
    const [fresh, stale] = this.pendingCouncilSignals.reduce<[Signal[], Signal[]]>(
      ([keep, drop], s) => (now - s.ts <= COUNCIL_SIGNAL_TTL_MS ? [[...keep, s], drop] : [keep, [...drop, s]]),
      [[], []],
    );
    this.pendingCouncilSignals = [];
    for (const s of stale) this.log('SYSTEM', `AI-COUNCIL signal for ${s.symbol} expired unconsumed`, 'warn');
    return fresh;
  }

  private async consultAdvisor(signals: Signal[], positions: Position[]): Promise<void> {
    if (!signals.length) return;
    const advice = await this.advisor.advise(positions, signals.map((s) => s.reason));
    if (advice) this.log(advice.agent, advice.msg, advice.level);
  }

  private async gatherContext(): Promise<CycleContext> {
    const market = await this.binance.getMarketOverview(config.symbols);
    Object.assign(this.livePrices, market.marks);
    this.logExits();
    const [positions, account] = await Promise.all([this.binance.getPositions(), this.binance.getAccount()]);
    if (config.unprotectedAlertPct > 0) {
      const exposed = findUnprotected(positions, account.equity, config.unprotectedAlertPct);
      this.hooks.onUnprotected(exposed, account.equity);
    }
    const marketState = this.marketStateBuilder.buildAll(config.symbols.map((symbol) => ({
      symbol, candles: market.candles[symbol] ?? [],
      candlesByTimeframe: market.marketDataV2?.[symbol]?.candles,
      derivatives: market.marketDataV2?.[symbol]?.derivatives,
      mark: market.marks[symbol] ?? this.livePrices[symbol] ?? 0,
      fundingRate: market.funding[symbol] ?? 0,
    })));
    for (const state of Object.values(marketState)) {
      this.flowTracker.record(state.symbol, state.generatedAt, state.mark, state.derivatives ?? null, state.fundingRate);
      const flow = this.flowTracker.context(state.symbol, state.generatedAt);
      const raw = buildSetupMap(state, { minRewardRisk: config.setup.minRewardRisk });
      const { map: ledgered, transitions } = this.setupLedger.apply(raw, state.timeframes['15m'].atr14 ?? 0);
      const annotated = annotateSetupMap(state, ledgered, flow, { feeRate: config.risk.takerFeeRate, slippageRate: config.risk.slippageBufferRate });
      // Outcomes are recorded for every setup, including ones the thesis controller withholds from execution
      this.setupOutcomes.observe(annotated, transitions, state.generatedAt);
      const setup = this.thesisController.apply(annotated);
      this.logSetupPipeline(state.symbol, raw, annotated, setup, transitions);
      // Only material lifecycle events (created / advanced / thesis flip) are announced; re-derivations are not
      if (setup.thesisTransition || transitions.some((t) => t.kind === 'CREATED' || t.kind === 'ADVANCED') || this.verdictChanged(setup)) this.hooks.onSetup(setup);
      void this.consultCouncil(state, setup);
    }
    await this.refreshLiveBook();
    this.refreshPositionFeatures(marketState);
    const safety = config.safety.enabled ? this.assessSafety(market) : undefined;
    return { ...market, spot: this.livePrices, equity: account.equity, positions, marketState, ...(safety ? { safety } : {}), performance: this.ops.build(this.binance.getTrades(), account) };
  }

  /** Priority-0 market safety per symbol; transitions are logged once. Entries only: open positions keep their stops and manager. */
  private assessSafety(market: Awaited<ReturnType<BinanceService['getMarketOverview']>>): Record<string, SafetyVerdict> {
    const now = Date.now();
    const out: Record<string, SafetyVerdict> = {};
    for (const symbol of config.symbols) {
      const v2 = market.marketDataV2?.[symbol];
      // Snapshot candles are closed-only (parseCandles drops the forming bar)
      const closed1m = v2?.candles['1m'] ?? [];
      const shock = this.shock.evaluate(symbol, closed1m, v2?.derivatives?.spreadBps ?? undefined);
      const health = this.binance.getFeedHealth(symbol);
      const candles15m = market.candles[symbol] ?? [];
      const verdict = assessSafety({
        now, mark: market.marks[symbol], lastTickAt: health.lastTickAt, markAt: health.markAt, exchangeStatus: health.exchangeStatus,
        latestClosed15mOpen: candles15m[candles15m.length - 1]?.openTime,
        derivativesAsOf: config.marketDataV2.enabled && v2?.derivatives ? v2.derivatives.asOf : undefined,
        shock, tickStaleMs: config.safety.tickStaleMs, markStaleMs: config.safety.markStaleMs,
      });
      out[symbol] = verdict;
      const previous = this.safetyLevels.get(symbol) ?? 'NORMAL';
      if (previous !== verdict.level) {
        this.safetyLevels.set(symbol, verdict.level);
        this.log('SYSTEM', `SAFETY ${symbol} ${previous}→${verdict.level}${verdict.reasons.length ? `: ${verdict.reasons.join('; ')}` : ''}`, verdict.level === 'NORMAL' ? 'info' : 'warn');
      }
    }
    return out;
  }

  /** Once per cycle: reconcile the live book with the exchange. A failure is logged and the book keeps its last view. */
  private async refreshLiveBook(): Promise<void> {
    if (!this.liveBook) return;
    try { await this.liveBook.refresh(); }
    catch (err) { this.logFailure('Live position book refresh failed', err); }
  }

  /** Caches the slow-loop inputs the tick-driven manager needs, so the 250 ms path does no indicator work. */
  private refreshPositionFeatures(marketState: Record<string, import('../market/types.js').MarketState>): void {
    if (!this.positionDriver) return;
    for (const symbol of config.symbols) {
      const adaptiveState = this.adaptive.stateFor(symbol);
      this.positionDriver.setFeatures(symbol, featuresFromState(marketState[symbol], adaptiveState
        ? { agent: this.adaptive.id, assignedAtr: adaptiveState.assignedAtr, regime: adaptiveState.regime, superTrend: adaptiveState.superTrend }
        : undefined));
    }
  }

  /** One compact line per symbol when something moved, else a heartbeat every 20 cycles, so an empty pipeline is visible rather than silent. */
  private logSetupPipeline(
    symbol: string,
    raw: import('../decision/SetupTypes.js').SetupMap,
    annotated: import('../decision/SetupTypes.js').SetupMap,
    final: import('../decision/SetupTypes.js').SetupMap,
    transitions: readonly import('../decision/SetupLedger.js').SetupTransition[],
  ): void {
    this.setupCycles += 1;
    if (transitions.length === 0 && this.setupCycles % 20 !== 1) return;
    const kinds = transitions.map((t) => t.kind).join(',') || 'none';
    const verdicts = final.scenarios.map((s) => `${s.kind}:${s.state}/${s.quality?.verdict ?? '?'}`).join(' ') || 'none';
    this.log('SYSTEM', `SETUPS ${symbol}: engine ${raw.scenarios.length} (dead ${raw.invalidatedIds?.length ?? 0}) → ledger ${annotated.scenarios.length} → live ${final.scenarios.length}${final.withheldIds?.length ? ` (withheld ${final.withheldIds.length})` : ''} · transitions ${kinds} · ${verdicts} · outcomes ${this.setupOutcomes.all().length} → ${config.setupOutcomesPath}`, 'info');
  }

  /** A quality-verdict change (e.g. WATCH -> ENTRY_ELIGIBLE) is material even when the setup state did not move. */
  private verdictChanged(setup: import('../decision/SetupTypes.js').SetupMap): boolean {
    let changed = false;
    for (const s of setup.scenarios) {
      const id = s.lifecycle?.setupId;
      const verdict = s.quality?.verdict;
      if (!id || !verdict) continue;
      if (this.announcedVerdicts.get(id) !== verdict) { this.announcedVerdicts.set(id, verdict); changed = true; }
      if (this.announcedVerdicts.size > 2_000) this.announcedVerdicts.delete(this.announcedVerdicts.keys().next().value as string);
    }
    return changed;
  }

  private telemetryFor(ctx: CycleContext, account: TelemetryInput['account'], positions: Position[]): Telemetry {
    const adaptive: Record<string, AdaptiveSuperTrendBar | undefined> = Object.fromEntries(config.symbols.map((s) => [s, this.adaptive.stateFor(s)]));
    const running = [...this.agents, this.risk, this.executor].map(({ id, status, strategy }) => {
      const mult = confidenceMultiplier(id as any, this.ledger);
      return { id: id as AgentId, status, strategy, note: id === this.risk.id ? this.ops.note : undefined, edgeMultiplier: mult !== 1 ? mult : undefined };
    });
    return buildTelemetry({
      account, positions, adaptive, trades: this.binance.getTrades(),
      candles: ctx.candles, funding: ctx.funding, nextFundingTime: ctx.nextFundingTime,
      agents: fleetRuntimes(running, { adaptive: this.agents.includes(this.adaptive), structLiq: config.structLiq.enabled }), counters: this.counters,
      apiWeight: this.binance.getApiWeight(), wsStatus: this.binance.getWsStatus(), now: Date.now(),
      attributable: config.mode !== 'live', marketStates: ctx.marketState,
    });
  }

  private refreshLiveTickers(ctx: CycleContext): void {
    for (const [sym, t] of Object.entries(ctx.tickers)) {
      const closes = (ctx.candles[sym] ?? []).map((c: Candle) => c.close);
      const trend = this.adaptive.stateFor(sym)?.direction ?? ctx.marketState?.[sym]?.ltfStructure.trend;
      this.putTicker(sym, { ...t, price: this.livePrices[sym] ?? t.price, sparkline: sparkline(closes, 12), trend });
    }
  }

  private async emitState(ctx: CycleContext): Promise<void> {
    const [positions, account] = await Promise.all([this.binance.getPositions(false), this.binance.getAccount()]);
    this.refreshLiveTickers(ctx);
    this.emit('state', {
      mode: config.mode, ...accountFields(account, positions), funding: ctx.funding,
      spotPrices: { ...this.liveTickers }, ...this.telemetryFor(ctx, account, positions), serverTime: Date.now(),
    });
  }

  private log(agent: any, msg: string, level: LogEntry['level']) { this.emit('log', { ts: Date.now(), agent, msg, level } satisfies LogEntry); }
  private logGrade(g: import('../learning/TradeOutcomeRecorder.js').GradedTrade): void {
    const evidence = g.evidence ? ` ev ${Math.round(g.evidence.score)}` : '';
    this.log(g.trade.strategy, `GRADE ${g.grade} ${g.trade.symbol} ${g.rMultiple > 0 ? '+' : ''}${g.rMultiple}R${evidence} — ${g.commentary}`, g.trade.pnl >= 0 ? 'success' : 'warn');
  }
}
