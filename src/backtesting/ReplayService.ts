import type { AgentId, Candle, Signal } from '../types.js';
import type { BaseAgent, MarketContext } from '../agents/BaseAgent.js';
import type { BinanceService } from '../binance/client.js';
import { CrowdingAgent } from '../agents/CrowdingAgent.js';
import { FundingArbAgent } from '../agents/FundingArbAgent.js';
import { MeanReversionAgent } from '../agents/MeanReversionAgent.js';
import { MomentumAgent } from '../agents/MomentumAgent.js';
import { StructureTrendAgent } from '../agents/StructureTrendAgent.js';
import { StructureLiquidityAgent } from '../agents/StructureLiquidityAgent.js';
import { RiskAgent } from '../agents/RiskAgent.js';
import { RiskOps } from '../runtime/opsHooks.js';
import { riskLimitsFromConfig, type RiskLimits } from '../risk/riskConfig.js';
import { MarketStateBuilder } from '../market/MarketStateBuilder.js';
import type { MarketRegime } from '../market/types.js';
import type { NativeTimeframe } from '../market/MarketDataTypes.js';
import { config } from '../config.js';
import { buildDecisionRecord, decisionEvidence, runCandidateFlow } from '../decision/CandidateFlow.js';
import { tunedStructureLiquidityOptions } from '../decision/StructureLiquidityStrategy.js';
import { DecisionJournal } from '../decision/DecisionJournal.js';
import { evaluateExecutionQuality } from '../execution/ExecutionQuality.js';
import { getSymbolRules, roundQty } from '../binance/symbolRules.js';
import { featuresFromState } from '../position/features.js';
import type { SymbolFeatures } from '../position/PositionDriver.js';
import { pmConfigFromEnv } from '../position/pmConfig.js';
import { AgentLedger, type AgentStats } from '../learning/AgentLedger.js';
import { confidenceMultiplier } from '../learning/ConfidenceAdjuster.js';
import { TradeOutcomeRecorder } from '../learning/TradeOutcomeRecorder.js';
import { computeMetrics, type BacktestMetrics } from './BacktestMetrics.js';
import { ExecutionSimulator } from './ExecutionSimulator.js';
import { MarketDataFeed } from './MarketDataFeed.js';
import { foldSimTrades, PortfolioSimulator, type BarManager } from './PortfolioSimulator.js';
import {
  DEFAULT_REPLAY_CONFIG, FIFTEEN_MINUTES_MS,
  type EquityPoint, type ReplayConfig, type ReplayData, type SimTrade,
} from './types.js';

interface PendingOrder {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  leverage: number;
  strategy: AgentId;
  stopLoss?: number;
  takeProfit?: number;
  decisionId: string;
  regime: MarketRegime;
  evidenceScore: number | null;
}

export interface ReplayOptions {
  config?: Partial<ReplayConfig>;
  /** Same agent implementations the orchestrator runs; defaults to the market-state strategy fleet. */
  agents?: BaseAgent[];
  /** Progress log; silent by default. */
  log?: (line: string) => void;
}

export interface ReplayResult {
  metrics: BacktestMetrics;
  /** One record per position: partial take-profit legs are folded into their final close. */
  trades: SimTrade[];
  /** The partial take-profit legs on their own (empty when the position manager is off). */
  partials: SimTrade[];
  decisions: ReturnType<DecisionJournal['all']>;
  equityCurve: EquityPoint[];
  /** Per-agent learning stats the run accumulated (trades graded, wins, total R); empty when learning is off. */
  agentStats: Partial<Record<AgentId | string, AgentStats>>;
}

const NATIVE_TIMEFRAMES: NativeTimeframe[] = ['1m', '5m', '15m', '1h', '4h'];
const NOT_HALTED = { halted: false, reason: '', at: 0 };

/**
 * Deterministic full-system replay:
 *
 *   MarketDataFeed -> MarketStateBuilder -> strategy agents -> candidate flow
 *   -> RiskAgent -> execution quality -> ExecutionSimulator -> PortfolioSimulator
 *   -> trade journal + decision journal + learning ledger -> metrics
 *
 * The strategy, routing, fusion, risk-gate, evidence and learning code is the
 * SAME code the orchestrator runs each cycle — only the market/execution
 * adapters differ. Decisions at a bar close fill at the next bar's open with
 * spread, slippage and taker fees; intrabar exits resolve stop-before-target
 * (the conservative ordering), and stops that gap through the open fill at the
 * open. Closed trades feed the per-agent stats of an in-memory learning
 * ledger, and collected signals are confidence-adjusted from it exactly like
 * the orchestrator's collectSignals — so an agent that performs in the replay
 * earns the same bounded confidence boost (and a losing one the same
 * suppression) it would earn live. The ledger is never written to disk: one
 * replay never trains another.
 *
 * Known simplifications versus live: no LLM veto, no per-loop cooldowns, one
 * position per symbol with venue-parity scale-in/flip semantics, and
 * paper-only dynamic-exit strategies (Adaptive SuperTrend) are not part of
 * the default fleet because their trailing adapter is not wired here.
 */
export class ReplayService {
  constructor(private readonly options: ReplayOptions = {}) {}

  async run(data: ReplayData): Promise<ReplayResult> {
    const cfg: ReplayConfig = {
      ...DEFAULT_REPLAY_CONFIG, ...this.options.config,
      costs: { ...DEFAULT_REPLAY_CONFIG.costs, ...this.options.config?.costs },
      funding: { ...DEFAULT_REPLAY_CONFIG.funding, ...this.options.config?.funding },
    };
    const feed = new MarketDataFeed(data);
    const simulator = new ExecutionSimulator(cfg.costs);
    const portfolio = new PortfolioSimulator(cfg.initialEquity, simulator);
    const regime = cfg.regime === undefined ? (config.regime.scored ? config.regime.options : undefined) : (cfg.regime ?? undefined);
    const builder = new MarketStateBuilder(regime);
    const limits: RiskLimits = cfg.riskLimits ?? riskLimitsFromConfig();

    // In-memory equity high-water mark shared by the risk agent and the performance ops — replay never writes risk state to disk
    let peakEquity = 0;
    const hwm = { peak: () => peakEquity, observe: (equity: number) => (peakEquity = Math.max(peakEquity, equity)), reset: () => { peakEquity = 0; } };

    const riskOps = new RiskOps(() => undefined, { isEnabled: true, limits, hwm });
    const risk = new RiskAgent({} as BinanceService, {
      riskEngine: cfg.riskEngine,
      limits,
      killSwitch: { state: () => NOT_HALTED },
      hwm,
    });
    const journal = new DecisionJournal(cfg.decisionsPath);
    // Slow-loop inputs of the position manager: refreshed from each decision-phase context and read on the NEXT bar's
    // management, so the manager only ever sees features built from candles that had closed before that bar opened
    const features = new Map<string, SymbolFeatures>();
    const manager: BarManager | undefined = (cfg.positionManager ?? config.positionManager.enabled)
      ? {
        cfg: cfg.pm ?? pmConfigFromEnv(),
        features: (symbol) => features.get(symbol),
        lot: (symbol) => { const r = getSymbolRules(symbol); return { step: r.stepSize, minQty: r.minQty, minNotional: r.minNotional }; },
      }
      : undefined;
    const agents = this.options.agents ?? defaultReplayAgents();

    // The learning loop the orchestrator runs each cycle, scoped to this replay:
    // closed trades grade into the per-agent stats of an in-memory ledger, and
    // collected signals are confidence-adjusted from those stats. The ledger
    // never touches disk, so one replay never trains another (or live).
    const ledger = new AgentLedger(null);
    const recorder = new TradeOutcomeRecorder(ledger);
    let gradedTradeCount = 0;

    const curve: EquityPoint[] = [];
    let investedSteps = 0;
    let pending: PendingOrder[] = [];
    const reservedThisStep = new Set<string>();
    const fundingIntervalMs = cfg.funding.intervalHours * 3_600_000;

    for (let step = 0; step < feed.stepCount; step += 1) {
      const closeTime = feed.stepTime(step);

      // 1) Fill phase: orders decided at the previous close fill at this bar's open
      for (const order of pending) {
        const bar = feed.barFor(order.symbol, step);
        if (!bar) continue;
        const holder = portfolio.holderOf(order.symbol);
        if (holder && holder.strategy !== order.strategy) continue; // venue ownership rule: another strategy owns the symbol
        const quote = simulator.entry(order.side, bar.open, order.qty);
        const request = this.openRequest(order, quote.price, quote.fee, quote.slippage, bar.openTime);
        if (holder && holder.side === order.side) {
          portfolio.scaleIn(holder, request);
        } else if (holder) {
          portfolio.closeAt(holder, quote.price, 'FLIP', bar.openTime);
          portfolio.open(request);
        } else {
          portfolio.open(request);
        }
        journal.attachExecution(order.decisionId, {
          ts: bar.openTime,
          spreadBps: cfg.costs.spreadBps / 2,
          slippageBps: cfg.costs.slippageBps,
          effectiveCostBps: cfg.costs.spreadBps / 2 + cfg.costs.slippageBps + cfg.costs.takerFeeBps,
        });
      }
      pending = [];

      // 2) Exit phase: liquidation, stops and targets resolve on this bar
      for (const symbol of feed.universe) {
        const bar = feed.barFor(symbol, step);
        if (bar) portfolio.onBar(symbol, bar, manager);
      }

      // 3) Funding phase: boundaries crossed by this bar settle on held positions
      if (cfg.funding.enabled && fundingIntervalMs > 0) {
        const previousClose = step > 0 ? feed.stepTime(step - 1) : closeTime - FIFTEEN_MINUTES_MS;
        for (let boundary = Math.floor(previousClose / fundingIntervalMs) * fundingIntervalMs + fundingIntervalMs; boundary <= closeTime; boundary += fundingIntervalMs) {
          for (const symbol of feed.universe) {
            portfolio.applyFunding(symbol, this.fundingRateAt(cfg, symbol, boundary), boundary);
          }
        }
      }

      if (portfolio.positionCount() > 0) investedSteps += 1;

      // 3.5) Learning phase: trades that closed on this bar grade into the
      // per-agent ledger stats BEFORE the decision phase collects new signals,
      // the same ordering the orchestrator's cycle uses (exits observed at the
      // start of a loop, grading, then signal collection).
      if (cfg.learning) {
        const closed = portfolio.getTrades();
        if (closed.length > gradedTradeCount) {
          // The whole journal, not just the new tail: a final close needs its earlier partial legs to grade the position as one
          recorder.process(closed);
          gradedTradeCount = closed.length;
        }
      }

      // 4) Decision phase: the same pipeline the orchestrator runs, on data closed by this step
      if (step >= cfg.warmupBars && step + 1 < feed.stepCount) {
        const ctx = this.buildContext(feed, closeTime, portfolio, builder, riskOps, cfg);
        if (manager) for (const symbol of feed.universe) features.set(symbol, featuresFromState(ctx.marketState?.[symbol]));
        const raw: Signal[] = [];
        for (const agent of agents) raw.push(...(await agent.run(ctx)));
        // Learning feedback, same shape as the orchestrator's collectSignals:
        // proven agents collect with amplified confidence, losing ones damped
        const adjusted = cfg.learning
          ? raw.map((s) => ({ ...s, confidence: Math.min(1, s.confidence * confidenceMultiplier(s.agent, ledger, s.symbol)) }))
          : raw;
        const flow = runCandidateFlow(adjusted, ctx.marketState ?? {});
        reservedThisStep.clear();
        for (const signal of flow.signals) {
          const decisionId = `${signal.id}-${closeTime}`;
          const state = ctx.marketState?.[signal.symbol];
          const evidence = decisionEvidence(signal, state, flow.intents.get(`${signal.symbol}:${signal.agent}`));
          const decision = risk.gate(signal, ctx, { evidenceScore: evidence.score });
          const record = buildDecisionRecord({ decisionId, signal, state, decision, evidence, now: closeTime });
          if (!decision.approved) {
            journal.record(record);
            continue;
          }
          if (decision.positionSizeUsdt <= 0) {
            journal.record({ ...record, status: 'EXECUTION_REFUSED', rejectionReason: 'zero sized order' });
            continue;
          }
          const eq = evaluateExecutionQuality(
            {
              symbol: signal.symbol,
              side: signal.type.includes('SHORT') ? 'SHORT' : 'LONG',
              sourceAgent: signal.agent,
              evidenceScore: evidence.score,
              entry: signal.entry ?? 0,
              stopLoss: signal.stopLoss ?? 0,
              takeProfit: signal.takeProfit ?? 0,
              reasons: evidence.factors,
            },
            syntheticDerivatives(cfg.costs.spreadBps),
            decision.positionSizeUsdt,
          );
          if (!eq.approved) {
            journal.record({ ...record, status: 'EQ_REJECTED', rejectionReason: eq.reason });
            continue;
          }
          if (reservedThisStep.has(signal.symbol)) {
            // One order per symbol per cycle — the venue would net or refuse the rest
            journal.record({ ...record, status: 'EXECUTION_REFUSED', rejectionReason: 'symbol already has an order this cycle' });
            continue;
          }
          reservedThisStep.add(signal.symbol);
          const mark = ctx.marks[signal.symbol] ?? signal.entry ?? 0;
          const qty = roundQty(signal.symbol, decision.positionSizeUsdt / (mark > 0 ? mark : 1));
          if (!(qty > 0)) {
            journal.record({ ...record, status: 'EXECUTION_REFUSED', rejectionReason: 'order below one lot' });
            continue;
          }
          pending.push({
            symbol: signal.symbol,
            side: signal.type.includes('SHORT') ? 'SHORT' : 'LONG',
            qty,
            leverage: decision.leverage,
            strategy: signal.agent,
            ...(signal.stopLoss === undefined ? {} : { stopLoss: signal.stopLoss }),
            ...(signal.takeProfit === undefined ? {} : { takeProfit: signal.takeProfit }),
            decisionId,
            regime: state?.regime.regime ?? 'TRANSITION',
            evidenceScore: evidence.score,
          });
          journal.record({ ...record, status: 'EXECUTED' });
        }
      }

      // 5) Mark phase: the equity curve closes at this bar
      curve.push({ t: closeTime, equity: portfolio.equity() });
      if (this.options.log && step > 0 && step % 500 === 0) {
        this.options.log(`replay step ${step}/${feed.stepCount} equity ${portfolio.equity().toFixed(2)}`);
      }
    }

    // Close whatever is still open at the last seen marks so the journal and equity agree
    const lastClose = feed.stepCount > 0 ? feed.stepTime(feed.stepCount - 1) : 0;
    const lastMarks: Record<string, number> = {};
    for (const symbol of feed.universe) {
      const close = feed.lastClose(symbol, lastClose);
      if (close !== undefined) lastMarks[symbol] = close;
    }
    portfolio.forceCloseAll(lastMarks, lastClose, 'CLOSE');

    const legs = portfolio.getTrades();
    const trades = foldSimTrades(legs);
    for (const trade of trades) {
      if (!trade.decisionId) continue;
      const rMultiple = trade.initialRisk && trade.initialRisk > 0
        ? Number((((trade.exit - trade.entry) * (trade.side === 'LONG' ? 1 : -1)) / trade.initialRisk).toFixed(2))
        : trade.pnl > 0 ? 1 : -1;
      journal.attachOutcome(trade.decisionId, {
        closedAt: trade.closedAt,
        exit: trade.exit,
        qty: trade.qty,
        pnl: trade.pnl,
        rMultiple,
        reason: trade.reason,
      });
    }

    // Trades closed by the forced end-of-run close still belong in the ledger's
    // per-agent stats: in live trading those grades land on the next loop.
    if (cfg.learning && legs.length > gradedTradeCount) {
      recorder.process(legs);
      gradedTradeCount = legs.length;
    }
    const agentStats: Partial<Record<AgentId | string, AgentStats>> = {};
    if (cfg.learning) {
      const ids = new Set<string>(agents.map((agent) => agent.id));
      for (const trade of trades) ids.add(trade.strategy);
      for (const id of ids) agentStats[id] = ledger.get(id);
    }

    const firstDecisionStep = Math.min(cfg.warmupBars, Math.max(0, feed.stepCount - 1));
    const metrics = computeMetrics({
      trades,
      curve,
      initialEquity: cfg.initialEquity,
      investedSteps,
      period: {
        from: feed.stepTime(firstDecisionStep),
        to: lastClose,
        steps: Math.max(0, feed.stepCount - firstDecisionStep),
        symbols: feed.universe,
      },
    });

    return { metrics, trades, partials: legs.filter((t) => t.partial), decisions: journal.all(), equityCurve: curve, agentStats };
  }

  private openRequest(order: PendingOrder, fillPrice: number, fee: number, slippage: number, openedAt: number) {
    return {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      leverage: order.leverage,
      strategy: order.strategy,
      ...(order.stopLoss === undefined ? {} : { stopLoss: order.stopLoss }),
      ...(order.takeProfit === undefined ? {} : { takeProfit: order.takeProfit }),
      decisionId: order.decisionId,
      regime: order.regime,
      evidenceScore: order.evidenceScore,
      fillPrice,
      fee,
      slippage,
      openedAt,
    };
  }

  private buildContext(
    feed: MarketDataFeed,
    closeTime: number,
    portfolio: PortfolioSimulator,
    builder: MarketStateBuilder,
    riskOps: RiskOps,
    cfg: ReplayConfig,
  ): MarketContext {
    const candles: Record<string, Candle[]> = {};
    const marks: Record<string, number> = {};
    const funding: Record<string, number> = {};
    const inputs = feed.universe.map((symbol) => {
      const closed15m = feed.closedCandles(symbol, '15m', closeTime);
      candles[symbol] = closed15m;
      const candlesByTimeframe: Partial<Record<NativeTimeframe, Candle[]>> = {};
      for (const timeframe of NATIVE_TIMEFRAMES) {
        const series = feed.closedCandles(symbol, timeframe, closeTime);
        if (series.length > 0) candlesByTimeframe[timeframe] = series;
      }
      const mark = closed15m.length > 0 ? closed15m[closed15m.length - 1].close : 0;
      marks[symbol] = mark;
      const rate = this.fundingRateAt(cfg, symbol, closeTime);
      funding[symbol] = rate;
      return { symbol, candles: closed15m, candlesByTimeframe, mark, fundingRate: rate, derivatives: null };
    });
    const marketState = builder.buildAll(inputs);
    const account = portfolio.account();
    return {
      candles,
      funding,
      marks,
      spot: {},
      equity: account.equity,
      positions: portfolio.toPositions(),
      marketState,
      performance: riskOps.build(portfolio.getTrades(), account),
    };
  }

  private fundingRateAt(cfg: ReplayConfig, symbol: string, at: number): number {
    if (!cfg.funding.enabled) return 0;
    const series = cfg.funding.series?.[symbol];
    if (!series || series.length === 0) return cfg.funding.rate;
    let rate = series[0].rate;
    for (const point of series) {
      if (point.time <= at) rate = point.rate;
      else break;
    }
    return rate;
  }
}

function syntheticDerivatives(spreadBps: number) {
  return { asOf: 0, openInterest: null, openInterestChangePct: null, globalLongShortRatio: null, topTraderAccountLongShortRatio: null, topTraderPositionLongShortRatio: null, takerBuySellRatio: null, takerVolumeImbalance: null, orderBookImbalance: null, spreadBps, basisPct: null };
}

/** The market-state strategy fleet — the same agent classes the orchestrator constructs. */
export function defaultReplayAgents(): BaseAgent[] {
  const binance = {} as BinanceService;
  return [
    new FundingArbAgent(binance),
    new MomentumAgent(binance),
    new StructureTrendAgent(binance),
    new StructureLiquidityAgent(
      binance,
      tunedStructureLiquidityOptions({
        maxSweepAgeCandles: config.structLiq.maxSweepAgeCandles,
        minimumRewardRisk: config.structLiq.minimumRewardRisk,
      }),
    ),
    new MeanReversionAgent(binance),
    new CrowdingAgent(binance),
  ];
}
