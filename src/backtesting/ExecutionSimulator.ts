import type { Candle, Side } from '../types.js';
import type { ExitReason } from '../types.js';
import type { ReplayCosts } from './types.js';

export interface FillQuote {
  /** Price the fill actually trades at (mid plus friction, direction-aware). */
  price: number;
  /** Taker fee on this fill, in quote currency. */
  fee: number;
  /** Friction versus the mid price on this fill, in quote currency (spread + slippage). */
  slippage: number;
  qty: number;
}

// Binance's lowest-tier maintenance margin rate; real tiers rise with notional
export const MAINTENANCE_MARGIN_RATE = 0.005;

/** Isolated-margin liquidation price; null when a 1x long cannot be liquidated. */
export function liquidationPrice(
  side: Side,
  entry: number,
  leverage: number,
  mmr = MAINTENANCE_MARGIN_RATE,
): number | null {
  if (side === 'LONG' && leverage <= 1) return null;
  const buffer = 1 / leverage - mmr;
  return side === 'LONG' ? entry * (1 - buffer) : entry * (1 + buffer);
}

/**
 * Bar-based execution with crypto frictions. Entries fill at the next bar's
 * open plus half-spread and slippage; exits are evaluated intrabar with the
 * conservative rule that a bar which touches both the stop and the target is
 * counted as a stop (the pessimistic ordering a backtest must assume when it
 * cannot see the path inside the bar). Stops that gap through at the open fill
 * at the open, never better than the level.
 */
export class ExecutionSimulator {
  constructor(private readonly costs: ReplayCosts) {}

  get takerFeeRate(): number {
    return this.costs.takerFeeBps / 10_000;
  }

  /** Quotes an entry fill against the next bar's open. */
  entry(side: Side, refPrice: number, qty: number): FillQuote {
    return this.quote(side === 'LONG' ? 1 : -1, refPrice, qty);
  }

  /** Quotes an exit fill against the fill price the evaluation produced. */
  exit(side: Side, refPrice: number, qty: number): FillQuote {
    return this.quote(side === 'LONG' ? -1 : 1, refPrice, qty);
  }

  private quote(direction: 1 | -1, mid: number, qty: number): FillQuote {
    const frictionRate = (this.costs.spreadBps / 2 + this.costs.slippageBps) / 10_000;
    const price = mid * (1 + direction * frictionRate);
    return {
      price,
      fee: Math.abs(price * qty) * this.takerFeeRate,
      slippage: Math.abs(price * qty) * frictionRate,
      qty,
    };
  }

  /**
   * Exit evaluation for one open position on one bar. Order of checks:
   * gap-through at the open (worst first), then intrabar stop before intrabar
   * target (conservative), then liquidation for unprotected positions.
   */
  evaluateExit(input: {
    side: Side;
    entry: number;
    stopLoss: number | null;
    takeProfit: number | null;
    leverage: number;
  }, bar: Candle): { price: number; reason: ExitReason } | null {
    const { side, entry, stopLoss, takeProfit, leverage } = input;
    const liq = liquidationPrice(side, entry, leverage);
    if (side === 'LONG') {
      if (stopLoss !== null) {
        if (bar.open <= stopLoss) return { price: bar.open, reason: 'STOP LOSS' };
        if (bar.low <= stopLoss) return { price: stopLoss, reason: 'STOP LOSS' };
      }
      if (takeProfit !== null) {
        if (bar.open >= takeProfit) return { price: bar.open, reason: 'TAKE PROFIT' };
        if (bar.high >= takeProfit) return { price: takeProfit, reason: 'TAKE PROFIT' };
      }
      if (liq !== null && bar.low <= liq) return { price: liq, reason: 'LIQUIDATED' };
      return null;
    }
    if (stopLoss !== null) {
      if (bar.open >= stopLoss) return { price: bar.open, reason: 'STOP LOSS' };
      if (bar.high >= stopLoss) return { price: stopLoss, reason: 'STOP LOSS' };
    }
    if (takeProfit !== null) {
      if (bar.open <= takeProfit) return { price: bar.open, reason: 'TAKE PROFIT' };
      if (bar.low <= takeProfit) return { price: takeProfit, reason: 'TAKE PROFIT' };
    }
    if (liq !== null && bar.high >= liq) return { price: liq, reason: 'LIQUIDATED' };
    return null;
  }
}
