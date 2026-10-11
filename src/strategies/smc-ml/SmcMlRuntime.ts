import { BinanceClient, type KlineInterval } from '@nemesis-oss/binance-sdk';
import type { Candle } from '../../types.js';
import { config } from '../../config.js';
import { analyzeSmcMultiTimeframe } from './SmcMlEngine.js';
import { buildSmcConfluence } from './SmcConfluence.js';
import { SmcExecutionAdvisor } from './SmcExecutionAdvisor.js';
import { BinanceSmcLifecycleExchange } from './SmcBinanceLifecycleExchange.js';
import { SmcTradeLifecycleCoordinator } from './SmcTradeLifecycleCoordinator.js';
import {
  DEFAULT_SMC_TRADE_LIFECYCLE_CONFIG,
  type SmcTradeLifecycleConfig,
} from './SmcTradeLifecycle.js';
import {
  DEFAULT_SMC_CONFIG,
  type ExecutionCandidate,
  type SMCAnalysis,
  type SMCConfig,
  type SMCConfluence,
  type SMCDecisionContext,
  type SMCFrame,
  type PortfolioState,
  type SMCTradeDecision,
} from './types.js';

export interface SmcMlRuntimeOptions {
  timeframes: SMCFrame[];
  candleLimit: number;
  config?: Partial<SMCConfig>;
  confluenceMinimum?: number;
  riskPct: number;
  leverage: number;
  lifecycle?: Partial<SmcTradeLifecycleConfig>;
}

export const DEFAULT_SMC_RUNTIME_OPTIONS: SmcMlRuntimeOptions = {
  timeframes: ['5m', '15m', '1h', '4h'],
  candleLimit: 300,
  confluenceMinimum: 0.35,
  riskPct: 1,
  leverage: 5,
  lifecycle: { ...DEFAULT_SMC_TRADE_LIFECYCLE_CONFIG },
};

export interface SmcMlCycle {
  analysis: SMCAnalysis;
  portfolioState: PortfolioState;
  positionQty: number;
  currentEntry?: number;
  decision: SMCTradeDecision;
  selectedCandidate: ExecutionCandidate | null;
}

export function executionPositionGuard(
  action: SMCTradeDecision['action'],
  expected: PortfolioState,
  actual: PortfolioState,
): 'PROCEED' | 'REJECT' | 'ALREADY_FLAT' {
  if (action === 'EXIT') {
    if (actual === 'NO_POSITION') return 'ALREADY_FLAT';
    return actual === expected ? 'PROCEED' : 'REJECT';
  }

  if (action === 'OPEN') {
    return actual === 'NO_POSITION' && expected === 'NO_POSITION' ? 'PROCEED' : 'REJECT';
  }

  if (action === 'ADD') {
    return expected !== 'NO_POSITION' && actual === expected ? 'PROCEED' : 'REJECT';
  }

  return 'REJECT';
}

export function applySmcPortfolioSafety(
  portfolioState: PortfolioState,
  confluence: SMCConfluence,
): SMCTradeDecision | null {
  if (
    portfolioState === 'NO_POSITION' ||
    confluence.direction === 'NEUTRAL' ||
    confluence.direction === portfolioState ||
    confluence.noTradeReasons.length > 0 ||
    confluence.agreement < 0.5 ||
    Math.abs(confluence.score) === 0
  ) {
    return null;
  }

  return {
    action: 'EXIT',
    side: portfolioState,
    entrySource: null,
    reason: 'deterministic portfolio policy: MTF confluence is opposite to the open position',
  };
}

export class SmcMlRuntime {
  private readonly options: SmcMlRuntimeOptions;
  private readonly advisor: SmcExecutionAdvisor;
  private readonly client: BinanceClient;
  private readonly executedFingerprints = new Set<string>();
  private readonly lifecycle: SmcTradeLifecycleCoordinator;

  constructor(
    client: BinanceClient,
    advisor: SmcExecutionAdvisor,
    options: Partial<SmcMlRuntimeOptions> = {},
  ) {
    this.client = client;
    this.advisor = advisor;
    this.lifecycle = new SmcTradeLifecycleCoordinator(new BinanceSmcLifecycleExchange(client));
    this.options = {
      ...DEFAULT_SMC_RUNTIME_OPTIONS,
      ...options,
      timeframes: options.timeframes ?? DEFAULT_SMC_RUNTIME_OPTIONS.timeframes,
      config: { ...DEFAULT_SMC_CONFIG, ...(options.config ?? {}) },
      lifecycle: { ...DEFAULT_SMC_TRADE_LIFECYCLE_CONFIG, ...(options.lifecycle ?? {}) },
    };
  }

  static fromConfig(
    options: Partial<SmcMlRuntimeOptions> = {},
  ): SmcMlRuntime {
    const client = new BinanceClient({
      apiKey: config.binance.apiKey,
      apiSecret: config.binance.apiSecret,
    });
    const advisor = new SmcExecutionAdvisor({
      host: config.ollama.host,
      model: config.ollama.model,
    });
    return new SmcMlRuntime(client, advisor, options);
  }

  async analyze(symbol: string, now = Date.now()): Promise<SmcMlCycle> {
    const s = symbol.toUpperCase();
    const candles = {} as Record<SMCFrame, Candle[]>;
    const intervals = this.options.timeframes as SMCFrame[];

    await Promise.all(
      intervals.map(async (tf) => {
        const raw = await this.client.futures.market.klines(
          s,
          tf as KlineInterval,
          { limit: this.options.candleLimit },
        );
        candles[tf] = raw
          .filter((k) => k.closeTime <= now)
          .map((k) => ({
            openTime: k.openTime,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume,
          }));
      }),
    );

    const marks = await this.client.futures.data.premiumIndex(s);
    const frames = analyzeSmcMultiTimeframe(candles, this.options.config);
    const price = Number(marks.markPrice);

    const confluence = buildSmcConfluence(frames, price, {
      minimumScore: this.options.confluenceMinimum,
    });

    const candidates = buildExecutionCandidates(frames, confluence.direction, price, this.options.config);
    const analysis: SMCAnalysis = {
      symbol: s,
      generatedAt: now,
      price,
      timeframes: frames,
      confluence,
      candidates,
    };

    const position = await this.getPosition(s);
    const portfolioState: PortfolioState =
      position === null ? 'NO_POSITION' :
      position.positionAmt > 0 ? 'LONG' : 'SHORT';

    const context: SMCDecisionContext = {
      analysis,
      portfolioState,
      positionQty: position ? Math.abs(position.positionAmt) : 0,
      currentEntry: position?.entryPrice,
      currentMark: price,
    };

    let decision = await this.advisor.decide(context);

    // Deterministic portfolio safety rule: when an admissible MTF thesis has flipped
    // against an existing position, flatten first. The LLM never gets to reverse
    // an opposite position directly.
    const safetyDecision = applySmcPortfolioSafety(portfolioState, confluence);
    if (safetyDecision) decision = safetyDecision;

    const selectedCandidate = decision.entrySource
      ? candidates.find((c) =>
          c.direction === decision.side &&
          c.entrySource === decision.entrySource
        ) ?? null
      : null;

    return { analysis, portfolioState, positionQty: Math.abs(position?.positionAmt ?? 0), currentEntry: position?.entryPrice, decision, selectedCandidate };
  }

  async onMarkPrice(symbol: string, markPrice: number): Promise<unknown> {
    return this.lifecycle.onMarkPrice(symbol, markPrice);
  }

  handleOrderTradeUpdate(event: unknown): void {
    this.lifecycle.handleOrderTradeUpdate(event);
  }

  handleAccountUpdate(event: unknown): void {
    this.lifecycle.handleAccountUpdate(event);
  }

  getLifecycle(symbol: string): import('./SmcTradeLifecycle.js').SmcTradeLifecycle | null {
    return this.lifecycle.get(symbol);
  }

  async execute(cycle: SmcMlCycle): Promise<unknown> {
    const { analysis, decision, selectedCandidate } = cycle;
    if (decision.action === 'HOLD') return { executed: false, reason: decision.reason };

    const currentPosition = await this.getPosition(analysis.symbol);
    const currentState: PortfolioState =
      currentPosition === null ? 'NO_POSITION' :
      currentPosition.positionAmt > 0 ? 'LONG' : 'SHORT';
    const guard = executionPositionGuard(decision.action, cycle.portfolioState, currentState);

    if (guard === 'ALREADY_FLAT') {
      return { executed: false, action: 'EXIT', reason: 'position already closed before execution' };
    }
    if (guard === 'REJECT') {
      return {
        executed: false,
        reason: 'portfolio state changed after analysis; execution rejected',
        expectedState: cycle.portfolioState,
        actualState: currentState,
      };
    }

    const breakTime = selectedCandidate?.sourceBreak.time ?? analysis.generatedAt;
    const fingerprint = [
      analysis.symbol,
      decision.action,
      decision.side,
      decision.entrySource ?? 'NONE',
      breakTime,
    ].join(':');

    if (decision.action !== 'EXIT' && this.executedFingerprints.has(fingerprint)) {
      return { executed: false, reason: 'same SMC setup already executed', fingerprint };
    }

    if (decision.action === 'EXIT') {
      const result = await this.client.futures.ops.closePosition({
        symbol: analysis.symbol,
      });
      return { executed: result.closed, action: 'EXIT', result };
    }

    if (!selectedCandidate) {
      return { executed: false, reason: 'LLM selected an entry source with no candidate' };
    }

    const sizing = await this.client.futures.ops.sizePosition({
      symbol: analysis.symbol,
      side: decision.side === 'LONG' ? 'BUY' : 'SELL',
      stopPrice: selectedCandidate.stopLoss,
      entryPrice: selectedCandidate.entryPrice,
      riskPct: this.options.riskPct,
      leverage: this.options.leverage,
      marketOrder: selectedCandidate.entrySource === 'MARKET',
    });

    if (!sizing.ok) {
      return { executed: false, reason: sizing.reasons.join('; '), sizing };
    }

    const result = await this.client.futures.ops.placeBracketOrder({
      symbol: analysis.symbol,
      side: decision.side === 'LONG' ? 'BUY' : 'SELL',
      quantity: sizing.quantityStr,
      entryPrice: selectedCandidate.entrySource === 'MARKET' ? undefined : selectedCandidate.entryPrice,
      stopLossPrice: selectedCandidate.stopLoss,
      takeProfitPrice: selectedCandidate.tp2,
      workingType: 'MARK_PRICE',
    });

    if (result.protectionComplete !== false) {
      this.executedFingerprints.add(fingerprint);
      await this.registerLifecycle(cycle, selectedCandidate, result);
    }
    return {
      executed: true,
      action: decision.action,
      decision,
      candidate: selectedCandidate,
      sizing,
      order: result,
    };
  }

  private async registerLifecycle(
    cycle: SmcMlCycle,
    candidate: ExecutionCandidate,
    bracketResult: Record<string, unknown>,
  ): Promise<void> {
    const existing = this.lifecycle.get(cycle.analysis.symbol);
    if (cycle.decision.action === 'ADD' && existing && existing.phase !== 'CLOSED') return;

    const position = await this.getPosition(cycle.analysis.symbol);
    const stopOrderId = extractOrderId(bracketResult.stopLoss);
    const tp2OrderId = extractOrderId(bracketResult.takeProfit);

    if (!position || stopOrderId === undefined) return;

    const entryPrice = position.entryPrice;
    const initialRisk = Math.abs(entryPrice - candidate.stopLoss);
    if (!(initialRisk > 0)) return;

    this.lifecycle.register({
      setupId: [
        cycle.analysis.symbol,
        candidate.sourceBreak.type,
        candidate.sourceBreak.timeframe,
        candidate.sourceBreak.time,
      ].join(':'),
      symbol: cycle.analysis.symbol,
      direction: candidate.direction,
      initialQty: Math.abs(position.positionAmt),
      entryPrice,
      initialRisk,
      tp1: candidate.tp1,
      tp2: candidate.tp2,
      stopPrice: candidate.stopLoss,
      config: this.options.lifecycle,
      stopOrderId,
      tp2OrderId,
    });
  }

  private async getPosition(symbol: string): Promise<{ positionAmt: number; entryPrice: number; positionSide: string } | null> {
    const positions = await this.client.futures.account.positionRiskV3(symbol);
    const open = positions.filter((p) => Math.abs(p.positionAmt) > 0);
    if (open.length > 1) throw new Error('SMC runtime requires a single unambiguous position; hedge mode needs explicit positionSide routing');
    return open[0] ?? null;
  }
}

export function buildExecutionCandidates(
  frames: Partial<Record<SMCFrame, import('./types.js').SMCFrameAnalysis>>,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
  price: number,
  cfg: Partial<SMCConfig> | undefined,
): ExecutionCandidate[] {
  if (direction === 'NEUTRAL') return [];

  const candidates: ExecutionCandidate[] = [];
  const all = Object.values(frames).filter((f): f is import('./types.js').SMCFrameAnalysis => Boolean(f));

  const alignedBreaks = all
    .map((frame) => frame.latestBreak && (
      (direction === 'LONG' && frame.latestBreak.direction === 1) ||
      (direction === 'SHORT' && frame.latestBreak.direction === -1)
    ) ? { frame, break: frame.latestBreak } : null)
    .filter((x): x is { frame: import('./types.js').SMCFrameAnalysis; break: NonNullable<import('./types.js').SMCFrameAnalysis['latestBreak']> } => x !== null)
    .sort((a, b) => b.break.time - a.break.time);

  const best = alignedBreaks[0];
  if (!best || !best.break.riskUnit || !best.frame.atr14 || best.frame.atr14 <= 0) return [];

  const signalAge = best.frame.candleCount - best.break.index - 1;
  const maxSignalAge = cfg?.retestWindow ?? DEFAULT_SMC_CONFIG.retestWindow;
  if (signalAge > maxSignalAge) return [];

  const atr = best.frame.atr14;
  const sl = direction === 'LONG'
    ? best.break.protectedSwing - (cfg?.stopBufferAtr ?? DEFAULT_SMC_CONFIG.stopBufferAtr) * atr
    : best.break.protectedSwing + (cfg?.stopBufferAtr ?? DEFAULT_SMC_CONFIG.stopBufferAtr) * atr;
  const risk = Math.abs(price - sl);
  const riskAtr = risk / atr;
  const maxRiskAtr = cfg?.maxRiskAtr ?? DEFAULT_SMC_CONFIG.maxRiskAtr;
  if (!(risk > 0) || riskAtr > maxRiskAtr) return [];

  const tp1R = Math.min(cfg?.tp1R ?? DEFAULT_SMC_CONFIG.tp1R, cfg?.tp2R ?? DEFAULT_SMC_CONFIG.tp2R);
  const tp2R = Math.max(cfg?.tp1R ?? DEFAULT_SMC_CONFIG.tp1R, cfg?.tp2R ?? DEFAULT_SMC_CONFIG.tp2R);

  const validStopGeometry = direction === 'LONG' ? sl < price : sl > price;
  if (!validStopGeometry || tp1R <= 0 || tp2R <= 0) return [];

  candidates.push({
    direction,
    entrySource: 'MARKET',
    entryPrice: price,
    protectedSwing: best.break.protectedSwing,
    atr14: atr,
    stopLoss: sl,
    tp1: price + (direction === 'LONG' ? 1 : -1) * tp1R * risk,
    tp2: price + (direction === 'LONG' ? 1 : -1) * tp2R * risk,
    riskPerUnit: risk,
    riskAtr,
    sourceBreak: {
      type: best.break.type,
      timeframe: best.frame.timeframe,
      level: best.break.level,
      time: best.break.time,
      retestProbability: best.break.retestProbability,
    },
  });

  const newest = best.frame.candleCount - best.break.index - 1;
  if (best.break.retestOutcome === true && best.break.retestEntryPrice !== null) {
    const retestEntry = best.break.retestEntryPrice;
    const retestRisk = Math.abs(retestEntry - sl);
    if (retestRisk > 0 && retestRisk / atr <= maxRiskAtr) {
      candidates.push({
        direction,
        entrySource: 'RETEST_LEVEL',
        entryPrice: retestEntry,
        protectedSwing: best.break.protectedSwing,
        atr14: atr,
        stopLoss: sl,
        tp1: retestEntry + (direction === 'LONG' ? 1 : -1) * tp1R * retestRisk,
        tp2: retestEntry + (direction === 'LONG' ? 1 : -1) * tp2R * retestRisk,
        riskPerUnit: retestRisk,
        riskAtr: retestRisk / atr,
        sourceBreak: {
          type: best.break.type,
          timeframe: best.frame.timeframe,
          level: best.break.level,
          time: best.break.time,
          retestProbability: best.break.retestProbability,
        },
      });
    }
  }

  if (newest <= 1) {
    const breakRisk = Math.abs(best.break.breakClose - sl);
    if (breakRisk > 0 && breakRisk / atr <= maxRiskAtr) {
      candidates.push({
        direction,
        entrySource: 'BREAK_CLOSE',
        entryPrice: best.break.breakClose,
        protectedSwing: best.break.protectedSwing,
        atr14: atr,
        stopLoss: sl,
        tp1: best.break.breakClose + (direction === 'LONG' ? 1 : -1) * tp1R * breakRisk,
        tp2: best.break.breakClose + (direction === 'LONG' ? 1 : -1) * tp2R * breakRisk,
        riskPerUnit: breakRisk,
        riskAtr: breakRisk / atr,
        sourceBreak: {
          type: best.break.type,
          timeframe: best.frame.timeframe,
          level: best.break.level,
          time: best.break.time,
          retestProbability: best.break.retestProbability,
        },
      });
    }
  }

  return candidates;
}

function extractOrderId(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const orderId = (value as { orderId?: unknown }).orderId;
  return typeof orderId === 'number' ? orderId : undefined;
}
