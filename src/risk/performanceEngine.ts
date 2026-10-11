import type { TradeRecord } from '../types.js';
import { foldPartials } from '../position/foldPartials.js';

export interface PerformanceSnapshot {
  dailyLossPercent: number;
  drawdownPercent: number;
  lossStreak: number;
  winStreak: number;
  realizedToday: number;
  profitFactor: number;
  expectancy: number;
}

const DAY_MS = 86_400_000;
const FULL_LOSS_PERCENT = 100;

const utcDay = (timestamp: number): number => Math.floor(timestamp / DAY_MS);
const sum = (pnls: number[]): number => pnls.reduce((total, pnl) => total + pnl, 0);

/** Consecutive same-sign results from the newest trade backwards; break-even trades are neutral. */
function trailingRun(pnls: number[], sign: 1 | -1): number {
  let run = 0;
  for (let index = pnls.length - 1; index >= 0; index -= 1) {
    if (pnls[index] === 0) continue;
    if (Math.sign(pnls[index]) !== sign) break;
    run += 1;
  }
  return run;
}

function profitFactorOf(pnls: number[]): number {
  const grossWin = sum(pnls.filter((pnl) => pnl > 0));
  const grossLoss = Math.abs(sum(pnls.filter((pnl) => pnl < 0)));
  if (grossLoss > 0) return grossWin / grossLoss;
  return grossWin > 0 ? Number.POSITIVE_INFINITY : 0;
}

/**
 * Journal-derived risk metrics feeding the circuit breaker; rebuilt from the closed-trade journal so a restart
 * cannot reset the governor.
 */
export class PerformanceEngine {
  private trades: TradeRecord[] = [];
  private positions: TradeRecord[] = [];
  // Unrealized peaks matter for drawdown but are not in the journal, so hydrate must not erase them
  private observedPeakEquity = 0;
  // Realized peaks before this time are ignored (operator drawdown reset); 0 counts the whole journal
  private drawdownEpoch = 0;

  constructor(private readonly initialEquity: number, private readonly now: () => number = Date.now) {}

  /** Replaces the journal-derived state; calling it twice with the same trades changes nothing. */
  hydrate(trades: TradeRecord[]): void {
    this.trades = [...trades].sort((a, b) => a.closedAt - b.closedAt);
    // Streaks and expectancy count positions: a partial take-profit followed by a stopped-out remainder is one trade, not a win and a loss
    this.positions = foldPartials(this.trades);
  }

  /** Starts the drawdown baseline at `epoch` (epoch ms): the realized equity at that moment becomes the first peak. 0 = whole journal. */
  setDrawdownEpoch(epoch: number): void {
    this.drawdownEpoch = Number.isFinite(epoch) && epoch > 0 ? epoch : 0;
  }

  /** Records a live equity reading so unrealized peaks count towards the drawdown high-water mark. */
  onEquity(equity: number): void {
    if (Number.isFinite(equity)) this.observedPeakEquity = Math.max(this.observedPeakEquity, equity);
  }

  /**
   * Folds in a peak persisted by a previous session (EquityHwmStore). Restarts
   * cannot erase unrealized peaks: hydrate() only replays the journal, which
   * never contains equity readings between trades, and observedPeakEquity is
   * memory-only otherwise.
   */
  seedObservedPeak(peak: number): void {
    if (Number.isFinite(peak) && peak > 0) this.observedPeakEquity = Math.max(this.observedPeakEquity, peak);
  }

  /** Risk metrics as of the injected clock, with drawdown measured against the given current equity. */
  snapshot(equity: number): PerformanceSnapshot {
    const today = utcDay(this.now());
    const todayPnls = this.trades.filter((t) => utcDay(t.closedAt) === today).map((t) => t.pnl);
    const allPnls = this.positions.map((t) => t.pnl);
    const todayPositionPnls = this.positions.filter((t) => utcDay(t.closedAt) === today).map((t) => t.pnl);
    return {
      dailyLossPercent: this.dailyLossPercent(today, todayPnls),
      drawdownPercent: this.drawdownPercent(equity),
      lossStreak: trailingRun(todayPositionPnls, -1),
      winStreak: trailingRun(allPnls, 1),
      realizedToday: sum(todayPnls),
      profitFactor: profitFactorOf(allPnls),
      expectancy: allPnls.length > 0 ? sum(allPnls) / allPnls.length : 0,
    };
  }

  private dailyLossPercent(today: number, todayPnls: number[]): number {
    const loss = Math.max(0, -sum(todayPnls));
    if (loss === 0) return 0;
    const realizedBeforeToday = sum(this.trades.filter((t) => utcDay(t.closedAt) < today).map((t) => t.pnl));
    const startOfDayEquity = this.initialEquity + realizedBeforeToday;
    return startOfDayEquity > 0 ? (loss / startOfDayEquity) * 100 : FULL_LOSS_PERCENT;
  }

  private drawdownPercent(equity: number): number {
    const peak = Math.max(this.realizedPeakEquity(), this.observedPeakEquity, equity);
    return peak > 0 ? ((peak - equity) / peak) * 100 : 0;
  }

  private realizedPeakEquity(): number {
    let running = this.initialEquity;
    // After an operator reset the peak is undefined until the journal reaches the reset time, then restarts at the equity held then
    let peak: number | undefined = this.drawdownEpoch > 0 ? undefined : running;
    for (const trade of this.trades) {
      if (peak === undefined && trade.closedAt >= this.drawdownEpoch) peak = running;
      running += trade.pnl;
      if (peak !== undefined) peak = Math.max(peak, running);
    }
    return peak ?? running;
  }
}
