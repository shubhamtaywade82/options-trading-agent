import type { Candle, Side } from '../types.js';

export interface BacktestTrade {
  symbol: string;
  side: Side;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  returnPct: number;
  exitReason: 'STOP_LOSS' | 'TAKE_PROFIT';
}

export interface BacktestResult {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  netPnl: number;
  finalEquity: number;
  trades: BacktestTrade[];
}

export interface SimulatedPosition {
  symbol: string;
  side: Side;
  entryPrice: number;
  entryTime: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
}

const TAKER_FEE_RATE = 0.0005; // 0.05% typical crypto taker fee

function evaluateExit(pos: SimulatedPosition, bar: Candle): { exitPrice: number; reason: 'STOP_LOSS' | 'TAKE_PROFIT' } | null {
  if (pos.side === 'LONG') {
    if (bar.low <= pos.stopLoss) return { exitPrice: pos.stopLoss, reason: 'STOP_LOSS' };
    if (bar.high >= pos.takeProfit) return { exitPrice: pos.takeProfit, reason: 'TAKE_PROFIT' };
  } else {
    if (bar.high >= pos.stopLoss) return { exitPrice: pos.stopLoss, reason: 'STOP_LOSS' };
    if (bar.low <= pos.takeProfit) return { exitPrice: pos.takeProfit, reason: 'TAKE_PROFIT' };
  }
  return null;
}

function calculatePnl(pos: SimulatedPosition, exitPrice: number): number {
  const gross = pos.side === 'LONG' ? (exitPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPrice) * pos.qty;
  const fees = (pos.entryPrice + exitPrice) * pos.qty * TAKER_FEE_RATE;
  return gross - fees;
}

/** Deterministic candle replay engine with crypto fee and execution friction modeling. */
export class ReplayEngine {
  private equity: number;
  private peakEquity: number;
  private maxDrawdown = 0;
  private trades: BacktestTrade[] = [];

  constructor(private initialEquity = 10_000) {
    this.equity = initialEquity;
    this.peakEquity = initialEquity;
  }

  run(
    candles: Candle[],
    getSignals: (closed: Candle[], equity: number) => { side: Side; stopLoss: number; takeProfit: number; notional: number } | null
  ): BacktestResult {
    let position: SimulatedPosition | null = null;

    for (let i = 50; i < candles.length; i++) {
      const closed = candles.slice(0, i);
      const currentBar = candles[i];

      if (position) {
        const exit = evaluateExit(position, currentBar);
        if (exit) {
          const pnl = calculatePnl(position, exit.exitPrice);
          this.recordTrade(position, exit.exitPrice, currentBar.openTime, pnl, exit.reason);
          position = null;
        }
      }

      if (!position) {
        const sig = getSignals(closed, this.equity);
        if (sig && currentBar.open > 0) {
          const qty = sig.notional / currentBar.open;
          position = {
            symbol: 'BTCUSDT',
            side: sig.side,
            entryPrice: currentBar.open,
            entryTime: currentBar.openTime,
            qty,
            stopLoss: sig.stopLoss,
            takeProfit: sig.takeProfit,
          };
        }
      }
    }

    return this.buildReport();
  }

  private recordTrade(pos: SimulatedPosition, exitPrice: number, exitTime: number, pnl: number, reason: 'STOP_LOSS' | 'TAKE_PROFIT'): void {
    this.equity += pnl;
    if (this.equity > this.peakEquity) this.peakEquity = this.equity;
    const dd = ((this.peakEquity - this.equity) / this.peakEquity) * 100;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;

    this.trades.push({
      symbol: pos.symbol,
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime,
      entryPrice: pos.entryPrice,
      exitPrice,
      pnl: Number(pnl.toFixed(2)),
      returnPct: Number(((pnl / (pos.entryPrice * pos.qty)) * 100).toFixed(2)),
      exitReason: reason,
    });
  }

  private buildReport(): BacktestResult {
    const wins = this.trades.filter((t) => t.pnl > 0);
    const losses = this.trades.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99 : 0;
    const winRatePct = this.trades.length > 0 ? Number(((wins.length / this.trades.length) * 100).toFixed(1)) : 0;

    return {
      totalTrades: this.trades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRatePct,
      profitFactor,
      maxDrawdownPct: Number(this.maxDrawdown.toFixed(2)),
      netPnl: Number((this.equity - this.initialEquity).toFixed(2)),
      finalEquity: Number(this.equity.toFixed(2)),
      trades: this.trades,
    };
  }
}
