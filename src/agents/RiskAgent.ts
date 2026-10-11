import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, RiskDecision, Position } from '../types.js';
import type { BinanceService } from '../binance/client.js';
import { config } from '../config.js';
import type { KillSwitch } from '../ops/killSwitch.js';
import { atr } from '../binance/indicators.js';
import { getSymbolRules } from '../binance/symbolRules.js';
import { contractSpecFor } from '../risk/contractSpec.js';
import type { PerformanceSnapshot } from '../risk/performanceEngine.js';
import { sizePosition, type SizingResult } from '../risk/positionSizer.js';
import { circuitRiskMultiplier, clusterOf, riskLimitsFromConfig, type RiskLimits } from '../risk/riskConfig.js';
import { evaluateRisk, openRiskOf, type PortfolioView } from '../risk/riskEngine.js';
import { combinedSizeMultiplier, type SizeScaling } from '../risk/sizeMultipliers.js';
import type { PeakEquitySource } from '../risk/equityHwm.js';
import { costAdjustedRr, minRrFor, type RrProfile } from '../risk/rrProfile.js';

export interface RiskAgentOptions {
  /** Defaults to `config.riskEngine`; injectable so tests never mutate process.env. */
  riskEngine?: 'on' | 'off';
  /** Defaults to the limits derived from `config.risk` at call time. */
  limits?: RiskLimits;
  /** When halted, every entry is refused whatever RISK_ENGINE says; exits never pass through this agent. */
  killSwitch?: Pick<KillSwitch, 'state'>;
  /** Persistent equity high-water mark; when absent the agent tracks a session-local peak (legacy behaviour). */
  hwm?: PeakEquitySource;
  /** Calibrated per-strategy RR floors; when present the RR check uses cost-adjusted RR against the strategy's floor. */
  rrProfile?: RrProfile;
  /** Live gate: when set, OPEN signals from strategies outside `approvedStrategies` are refused. */
  requireApproval?: boolean;
  approvedStrategies?: ReadonlySet<string>;
  /** Defaults to the SIZE_VOL_SCALING / SIZE_SCORE_SCALING config. */
  sizeScaling?: SizeScaling;
}

export interface GateOptions {
  evidenceScore?: number;
}

// Strategies place stops in multiples of the state layer's closed-candle ATR; the gate must measure with the same ruler,
// and float noise must not turn a stop at exactly N ATR into "N-0.0001 < N".
const STOP_WIDTH_TOLERANCE = 0.01;

const NO_PERFORMANCE = 'risk-engine: performance snapshot unavailable';

const isShort = (signal: Signal): boolean => signal.type === 'OPEN_SHORT';
const notionalOf = (positions: Position[]): number => positions.reduce((sum, p) => sum + p.qty * p.mark, 0);

/** Long stops must sit below entry and short stops above it; the sizer measures distance only, so a wrong-side stop would size a trade that is not protected. */
function isStopOnWrongSide(signal: Signal): boolean {
  return isShort(signal) ? signal.stopLoss! <= signal.entry! : signal.stopLoss! >= signal.entry!;
}

function rewardRisk(signal: Signal): number | undefined {
  if (signal.takeProfit === undefined) return undefined;
  return Math.abs(signal.takeProfit - signal.entry!) / Math.abs(signal.entry! - signal.stopLoss!);
}

// Isolated margin per position is notional / leverage; positions absent from ctx are treated as using none
function availableMargin(ctx: MarketContext): number {
  const inUse = (ctx.positions ?? []).reduce((sum, p) => sum + (p.qty * p.mark) / Math.max(1, p.leverage), 0);
  return Math.max(0, ctx.equity - inUse);
}

function portfolioView(ctx: MarketContext, performance: PerformanceSnapshot): PortfolioView {
  const positions = ctx.positions ?? [];
  return {
    equity: ctx.equity,
    openPositions: positions.length,
    grossExposure: notionalOf(positions),
    symbolExposure: (symbol) => notionalOf(positions.filter((p) => p.symbol === symbol)),
    clusterExposure: (cluster) => notionalOf(positions.filter((p) => clusterOf(p.symbol) === cluster)),
    performance,
    openRisk: openRiskOf(positions),
  };
}

// A hedge is sized by notional, not by stop distance, so it carries no per-unit risk
function hedgeSizing(notional: number, leverage: number): SizingResult {
  return {
    ok: true, quantity: 0, notional, marginRequired: notional / leverage, leverage, riskAmount: 0,
    effectiveRiskPerUnit: 0, feePerUnit: 0, fundingPerUnit: 0, warnings: [],
  };
}

/**
 * Gating authority. Every OPEN signal MUST pass this agent.
 * Deterministic formulas, no LLM involvement.
 */
export class RiskAgent extends BaseAgent {
  readonly id = 'RISK-MGR-δ' as const;
  readonly strategy = 'liquidation_guard_isolated';
  status = 'WATCHING' as const;

  constructor(svc: BinanceService, private readonly options: RiskAgentOptions = {}) {
    super(svc);
  }

  protected async analyze(_ctx: MarketContext): Promise<Signal[]> {
    return [];
  }

  /** `evidenceScore` is the 0-100 score the entry was taken on; it only shrinks the size (see sizeMultipliers). */
  gate(signal: Signal, ctx: MarketContext, opts: GateOptions = {}): RiskDecision {
    if (this.options.requireApproval && signal.type.startsWith('OPEN_') && !this.options.approvedStrategies?.has(signal.agent)) {
      return this.reject(`strategy ${signal.agent} is not approved for live trading`);
    }
    const halt = this.options.killSwitch?.state();
    if (!halt?.halted || !signal.type.startsWith('OPEN_')) return this.gateSafety(signal, ctx, opts);
    this.isDrawdownBreached(ctx); // only to keep the session equity peak tracking while halted
    return this.reject(`kill-switch: ${halt.reason}`);
  }

  /** Priority-0 market safety (stale feed, bad mark, exchange status, shock) blocks new entries only. */
  private gateSafety(signal: Signal, ctx: MarketContext, opts: GateOptions): RiskDecision {
    const verdict = signal.type.startsWith('OPEN_') ? ctx.safety?.[signal.symbol] : undefined;
    if (verdict && verdict.level !== 'NORMAL') return this.reject(`safety ${verdict.level}: ${verdict.reasons.join('; ')}`);
    return this.gateEntry(signal, ctx, opts);
  }

  private gateEntry(signal: Signal, ctx: MarketContext, opts: GateOptions): RiskDecision {
    const equity = ctx.equity;
    const maxNotional = equity * (config.risk.maxExposurePct / 100);
    const riskBudget = equity * (config.risk.riskPerTradePct / 100);

    if (this.isDrawdownBreached(ctx)) {
      return this.reject(`drawdown kill-switch: current drawdown exceeds ${config.risk.maxDrawdownPct}%`);
    }

    if (signal.type === 'OPEN_HEDGE' || signal.type === 'OPEN_FUNDING_SHORT') return this.gateHedge(signal, ctx, riskBudget, maxNotional);

    if (!signal.stopLoss || !signal.entry) {
      return this.reject('missing entry/SL');
    }

    const slDistancePct = Math.abs(signal.entry - signal.stopLoss) / signal.entry;
    if (slDistancePct === 0) {
      return this.reject('stop loss matches entry');
    }

    if (this.isEngineOn() && isStopOnWrongSide(signal)) {
      return this.reject('stop on wrong side of entry');
    }

    const currentGross = notionalOf(ctx.positions ?? []);
    const remainingHeadroom = Math.max(0, maxNotional - currentGross);
    if (!this.isEngineOn()) {
      if ((ctx.positions ?? []).length >= config.risk.maxConcurrentPositions) {
        return this.reject(`max concurrent positions (${config.risk.maxConcurrentPositions}) reached`);
      }
      if (remainingHeadroom <= 0) {
        return this.reject(`max gross exposure reached (${currentGross.toFixed(0)} / ${maxNotional.toFixed(0)})`);
      }
    }

    const positionSizeUsdt = riskBudget / slDistancePct;
    const cappedSize = Math.min(positionSizeUsdt, this.isEngineOn() ? maxNotional : remainingHeadroom);
    return this.checkBuffer(signal, ctx, cappedSize, slDistancePct, opts);
  }

  // Funding harvest positions in futures
  private gateHedge(signal: Signal, ctx: MarketContext, riskBudget: number, maxNotional: number): RiskDecision {
    const currentGross = notionalOf(ctx.positions ?? []);
    const remainingHeadroom = Math.max(0, maxNotional - currentGross);
    if (!this.isEngineOn() && remainingHeadroom <= 0) return this.reject('max gross exposure reached');
    const leverage = config.risk.minLeverage;
    const harvest: RiskDecision = {
      approved: true,
      positionSizeUsdt: Math.min(signal.notionalUsdt ?? riskBudget, this.isEngineOn() ? maxNotional : remainingHeadroom),
      leverage,
      marginType: 'ISOLATED',
      liqBufferAtr: Infinity,
      reason: `funding harvest ${leverage}x isolated`,
    };
    return this.isEngineOn() ? this.vetoHedge(signal, ctx, harvest) : harvest;
  }

  private vetoHedge(signal: Signal, ctx: MarketContext, harvest: RiskDecision): RiskDecision {
    if (!ctx.performance) return this.reject(NO_PERFORMANCE);
    // A market-neutral hedge has no stop to derive reward:risk from, so that check cannot apply to it
    const limits = { ...this.limits(), minRiskRewardRatio: 0 };
    const verdict = evaluateRisk({
      symbol: signal.symbol,
      sizing: hedgeSizing(harvest.positionSizeUsdt, harvest.leverage),
      portfolio: portfolioView(ctx, ctx.performance.snapshot),
      limits,
    });
    return verdict.approved ? harvest : this.reject(`risk-engine: ${verdict.reasons.join('; ')}`);
  }

  private isEngineOn(): boolean {
    return (this.options.riskEngine ?? config.riskEngine) === 'on';
  }

  private limits(): RiskLimits {
    return this.options.limits ?? riskLimitsFromConfig();
  }

  private evaluateWithEngine(signal: Signal, ctx: MarketContext, leverage: number, liqBufferAtr: number, opts: GateOptions): RiskDecision {
    if (!ctx.performance) return this.reject(NO_PERFORMANCE);
    const baseLimits = this.limits();
    const profile = this.options.rrProfile;
    const limits = profile
      ? { ...baseLimits, minRiskRewardRatio: minRrFor(profile, signal.agent, baseLimits.minRiskRewardRatio) }
      : baseLimits;
    const sizeMultiplier = combinedSizeMultiplier(
      this.options.sizeScaling ?? { volatility: config.sizing.volatilityScaling, score: config.sizing.scoreScaling },
      { atrPercentile: ctx.marketState?.[signal.symbol]?.regime?.volatilityPercentile ?? undefined, evidenceScore: opts.evidenceScore },
    );
    const sizing = sizePosition({
      equity: ctx.equity,
      availableMargin: availableMargin(ctx),
      direction: isShort(signal) ? 'SHORT' : 'LONG',
      entry: signal.entry!,
      stop: signal.stopLoss!,
      requestedLeverage: leverage,
      fundingRate: ctx.funding[signal.symbol],
      spec: contractSpecFor(signal.symbol, getSymbolRules(signal.symbol), limits),
      limits,
      circuitMultiplier: circuitRiskMultiplier(ctx.performance.circuit),
      riskMultiplier: sizeMultiplier,
    });
    const portfolio = portfolioView(ctx, ctx.performance.snapshot);
    const rr = profile && signal.takeProfit !== undefined
      ? costAdjustedRr(
        { entry: signal.entry!, stopLoss: signal.stopLoss!, takeProfit: signal.takeProfit, side: isShort(signal) ? 'SHORT' : 'LONG' },
        { feeRate: limits.feeRateTaker, slippageRate: limits.slippageBufferRate },
      )
      : rewardRisk(signal);
    const verdict = evaluateRisk({ symbol: signal.symbol, sizing, portfolio, limits, rr });
    if (!verdict.approved) return this.reject(`risk-engine: ${verdict.reasons.join('; ')}`);
    return {
      approved: true,
      positionSizeUsdt: sizing.notional,
      leverage: sizing.leverage,
      marginType: 'ISOLATED',
      liqBufferAtr,
      reason: `qty ${sizing.quantity} notional $${sizing.notional.toFixed(0)} lev ${sizing.leverage}x circuit ${verdict.circuit}${sizeMultiplier < 1 ? ` size×${sizeMultiplier.toFixed(2)}` : ''}`,
    };
  }

  /**
   * Drawdown kill-switch (issue #10). Compares current equity against the
   * account's high-water mark; if the drawdown from peak exceeds
   * MAX_DRAWDOWN_PCT, all OPEN signals are rejected until the account
   * recovers. Closes still pass — reducing exposure is correct here.
   *
   * The peak is the persisted EquityHwmStore when one is injected (survives
   * restarts — a process crash mid-drawdown no longer silently re-arms the
   * bot); without one, the agent tracks the peak in-process only.
   */
  private peakEquity = 0;
  private isDrawdownBreached(ctx: MarketContext): boolean {
    if (ctx.equity <= 0) return true;
    const peak = this.options.hwm
      ? this.options.hwm.observe(ctx.equity)
      : (this.peakEquity = Math.max(this.peakEquity, ctx.equity));
    const drawdownPct = ((peak - ctx.equity) / peak) * 100;
    return drawdownPct > config.risk.maxDrawdownPct;
  }

  private calculateDynamicLeverage(
    confidence: number,
    slDistancePct: number,
    atrBuffer: number
  ): number {
    const minLev = config.risk.minLeverage;
    const maxLev = config.risk.maxLeverage;
    const confFactor = Math.max(0, Math.min(1, (confidence - 0.5) / 0.5));
    const slFactor = Math.max(0, Math.min(1, 0.03 / Math.max(0.008, slDistancePct)));
    const bufferFactor = Math.max(0, Math.min(1, (atrBuffer - 1.5) / 2));
    const score = 0.5 * confFactor + 0.3 * slFactor + 0.2 * bufferFactor;
    const raw = minLev + score * (maxLev - minLev);
    return Math.round(Math.max(minLev, Math.min(maxLev, raw)));
  }

  private checkBuffer(
    signal: Signal,
    ctx: MarketContext,
    cappedSize: number,
    slDistancePct: number,
    opts: GateOptions,
  ): RiskDecision {
    const baseSymbol = signal.symbol.split('/')[0];
    const candles = ctx.candles[signal.symbol] ?? ctx.candles[baseSymbol] ?? ctx.candles[`${baseSymbol}USDT`];
    if (!candles?.length) {
      return this.reject('insufficient candle history');
    }

    // Same ATR the strategies used (closed 15m candles); ctx.candles still carries the forming candle, which understates it
    const stateAtr = ctx.marketState?.[signal.symbol]?.timeframes['15m'].atr14;
    const atr14 = stateAtr !== undefined && stateAtr !== null && stateAtr > 0 ? stateAtr : atr(candles, 14);
    if (atr14 <= 0) {
      return this.reject('invalid ATR calculation');
    }

    const atrDist = signal.symbol.includes('/') ? (signal.entry! * 0.015) : atr14;
    const buffer = Math.abs(signal.entry! - signal.stopLoss!) / atrDist;
    if (buffer * (1 + STOP_WIDTH_TOLERANCE) < config.risk.minLiqBufferAtr) {
      return this.reject(`liq buffer ${buffer.toFixed(1)}x ATR < ${config.risk.minLiqBufferAtr}x`);
    }

    const leverage = this.calculateDynamicLeverage(signal.confidence, slDistancePct, buffer);
    if (this.isEngineOn()) return this.evaluateWithEngine(signal, ctx, leverage, buffer, opts);
    return this.approveCapped(cappedSize, leverage, buffer);
  }

  private approveCapped(cappedSize: number, leverage: number, buffer: number): RiskDecision {
    return {
      approved: true,
      positionSizeUsdt: cappedSize,
      leverage,
      marginType: 'ISOLATED',
      liqBufferAtr: buffer,
      reason: `size=$${cappedSize.toFixed(0)} lev=${leverage}x buffer=${buffer.toFixed(1)}xATR`,
    };
  }

  private reject(reason: string): RiskDecision {
    return {
      approved: false,
      positionSizeUsdt: 0,
      leverage: 0,
      marginType: 'ISOLATED',
      liqBufferAtr: 0,
      reason,
    };
  }
}
