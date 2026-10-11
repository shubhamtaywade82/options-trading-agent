import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { BinanceService } from '../binance/client.js';
import type { Position, Signal, VetoSnapshot } from '../types.js';
import { calculateAdaptiveSuperTrend, TP_ATR_MULTIPLE, type AdaptiveSuperTrendBar, type TrendDirection } from '../binance/adaptiveSuperTrend.js';
import { rsi } from '../binance/indicators.js';
import { roundPrice } from '../binance/symbolRules.js';
import { nextStops } from './TrailingStopManager.js';
import { config } from '../config.js';

// BTC leads the alts: an alt flip that fights BTC's trend is skipped, while BTC itself is unfiltered
const ANCHOR_SYMBOL = 'BTCUSDT';
const ENTRY_CONFIDENCE = 0.75;
const RSI_PERIOD = 14;

export interface AdaptiveSuperTrendOptions {
  requireAnchor?: boolean;
}

export interface StopUpdate {
  symbol: string;
  strategy: Position['strategy'];
  stopLoss: number;
  takeProfit: number;
}

/** Enters on Adaptive SuperTrend flips (closed candles only) and trails stops by volatility regime. */
export class AdaptiveSuperTrendAgent extends BaseAgent {
  readonly id = 'ADAPTIVE-ST-ζ' as const;
  readonly strategy = 'ml_adaptive_supertrend';
  // One signal per closed candle is enforced below, so the shared fill cooldown would only swallow the next flip
  override readonly cooldownMs = 0;
  private readonly requireAnchor: boolean;
  private latest = new Map<string, AdaptiveSuperTrendBar>();
  private lastHandledOpenTime = new Map<string, number>();

  constructor(binance: BinanceService, options: AdaptiveSuperTrendOptions = {}) {
    super(binance);
    this.requireAnchor = options.requireAnchor ?? config.adaptiveSuperTrend.requireAnchor;
  }

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    // The anchor must be analysed first so its state is current when the alts are checked
    const anchorFirst = [...config.symbols].sort((a, b) => Number(b === ANCHOR_SYMBOL) - Number(a === ANCHOR_SYMBOL));
    for (const symbol of anchorFirst) {
      const signal = this.analyzeSymbol(symbol, ctx);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  /** Latest closed-candle indicator state for a symbol, if enough history has loaded. */
  stateFor(symbol: string): AdaptiveSuperTrendBar | undefined {
    return this.latest.get(symbol);
  }

  private analyzeSymbol(symbol: string, ctx: MarketContext): Signal | null {
    // The last candle is still forming; using it would repaint flips
    const closed = (ctx.candles[symbol] ?? []).slice(0, -1);
    const lastClosed = closed.at(-1);
    if (!lastClosed || this.lastHandledOpenTime.get(symbol) === lastClosed.openTime) return null;

    const bar = calculateAdaptiveSuperTrend(closed).at(-1);
    const mark = ctx.marks[symbol];
    if (!bar || !mark) return null;
    this.latest.set(symbol, bar);
    this.lastHandledOpenTime.set(symbol, lastClosed.openTime);
    // LOW-volatility flips are mostly chop
    if (!bar.trendShift || bar.regime === 'LOW') return null;
    if (!this.agreesWithAnchor(symbol, bar.trendShift, lastClosed.openTime)) return null;
    return this.entrySignal(symbol, bar, mark);
  }

  private agreesWithAnchor(symbol: string, direction: TrendDirection, candleOpenTime: number): boolean {
    if (!this.requireAnchor) return true;
    if (symbol === ANCHOR_SYMBOL || !config.symbols.includes(ANCHOR_SYMBOL)) return true;
    const anchor = this.latest.get(ANCHOR_SYMBOL);
    // Unknown or older-than-the-alt anchor state also blocks: a stale BTC read must not approve a fresh alt flip
    return !!anchor && anchor.candle.openTime >= candleOpenTime && anchor.direction === direction;
  }

  private entrySignal(symbol: string, bar: AdaptiveSuperTrendBar, mark: number): Signal | null {
    const isLong = bar.trendShift === 'BULLISH';
    const stopIsOnRiskSide = isLong ? bar.superTrend < mark : bar.superTrend > mark;
    // Price already crossed the line since the candle closed: the setup is stale
    if (!stopIsOnRiskSide) return null;

    const targetDistance = TP_ATR_MULTIPLE[bar.regime] * bar.assignedAtr;
    return this.signal({
      symbol,
      type: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: ENTRY_CONFIDENCE,
      entry: mark,
      stopLoss: bar.superTrend,
      takeProfit: isLong ? mark + targetDistance : mark - targetDistance,
      reason: `ST flip ${bar.trendShift} in ${bar.regime} volatility (ATR ${bar.assignedAtr.toFixed(4)})`,
    });
  }

  /** New SL/TP for this agent's open positions, rounded to the symbol tick; unchanged positions are omitted. */
  stopUpdates(positions: Position[]): StopUpdate[] {
    const updates: StopUpdate[] = [];
    for (const position of positions) {
      const state = position.strategy === this.id ? this.latest.get(position.symbol) : undefined;
      const next = state && nextStops(position, state);
      if (!next) continue;
      const stopLoss = roundPrice(position.symbol, next.stopLoss);
      const takeProfit = roundPrice(position.symbol, next.takeProfit);
      if (stopLoss === Number(position.serverSl) && takeProfit === Number(position.serverTp)) continue;
      updates.push({ symbol: position.symbol, strategy: position.strategy, stopLoss, takeProfit });
    }
    return updates;
  }

  /** Context handed to the LLM veto; null for signals from other agents. */
  vetoSnapshot(signal: Signal, ctx: MarketContext): VetoSnapshot | null {
    const bar = this.latest.get(signal.symbol);
    if (signal.agent !== this.id || !bar || !signal.entry || !signal.stopLoss || !signal.takeProfit) return null;
    const closes = (ctx.candles[signal.symbol] ?? []).map((c) => c.close);
    return {
      symbol: signal.symbol,
      side: signal.type === 'OPEN_LONG' ? 'LONG' : 'SHORT',
      regime: bar.regime,
      distanceFromLineAtr: Math.abs(signal.entry - bar.superTrend) / bar.assignedAtr,
      rsi: rsi(closes, RSI_PERIOD).at(-1) ?? 50,
      fundingRate: ctx.funding[signal.symbol] ?? 0,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
    };
  }
}
