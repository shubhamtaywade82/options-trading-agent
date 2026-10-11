import { istParts } from '../time/ist.js';

export interface DaySnapshot {
  readonly dayKey: string;
  readonly realizedPnlInr: number;
  readonly unrealizedPnlInr: number;
  readonly dayPnlInr: number;
  readonly tradesToday: number;
  readonly openUnderlyings: readonly string[];
  readonly killSwitchReason: string | undefined;
  /** Set once the day has breached its loss limit. Latched separately from killSwitchReason, which an operator block can occupy first. */
  readonly dailyLossBreach: string | undefined;
}

/**
 * Book-wide state shared by every underlying: realised and unrealised day P&L,
 * entry count, per-underlying cooldown and the kill switch. The kill switch
 * persists across IST day rollovers and clears only through an explicit operator
 * action, so a daily-loss breach cannot silently re-arm itself.
 */
export class DayBook {
  private dayKey: string;
  private realized = 0;
  private trades = 0;
  private readonly openPnl = new Map<string, number>();
  private readonly openUnderlyings = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private killSwitchReason: string | undefined;
  private dailyLossBreach: string | undefined;

  constructor(
    nowMs: number,
    private readonly cooldownMs: number,
  ) {
    this.dayKey = istParts(nowMs).date;
  }

  /** Resets per-day counters when the IST date changes. Idempotent within a day. */
  observe(nowMs: number): void {
    const dayKey = istParts(nowMs).date;
    if (dayKey === this.dayKey) {
      return;
    }
    this.dayKey = dayKey;
    this.realized = 0;
    this.trades = 0;
    this.cooldownUntil.clear();
  }

  recordEntry(underlying: string): void {
    this.trades += 1;
    this.openUnderlyings.add(underlying);
  }

  /** Marks an underlying as holding (or having a pending) position without counting an entry. */
  markOpen(underlying: string): void {
    this.openUnderlyings.add(underlying);
  }

  setOpenPnl(underlying: string, pnlInr: number): void {
    this.openPnl.set(underlying, pnlInr);
  }

  recordClose(input: { underlying: string; pnlInr: number; closedAtMs: number }): void {
    this.realized += input.pnlInr;
    this.openUnderlyings.delete(input.underlying);
    this.openPnl.delete(input.underlying);
    if (this.cooldownMs > 0) {
      this.cooldownUntil.set(input.underlying, input.closedAtMs + this.cooldownMs);
    }
  }

  /** Releases an underlying whose entry never reached the market (rejected or not filled). */
  releaseUnfilled(underlying: string): void {
    this.openUnderlyings.delete(underlying);
    this.openPnl.delete(underlying);
  }

  activateKillSwitch(reason: string): void {
    this.killSwitchReason ??= reason;
  }

  /**
   * Records a daily-loss breach. The first breach reason is kept. The kill switch is set only if
   * nothing else holds it, so an operator block keeps its own reason and the breach is still latched.
   */
  recordDailyLossBreach(reason: string): void {
    this.dailyLossBreach ??= reason;
    this.activateKillSwitch(reason);
  }

  /** Operator action only. Clears the kill switch and the breach latch after the cause has been dealt with. */
  clearKillSwitch(): void {
    this.killSwitchReason = undefined;
    this.dailyLossBreach = undefined;
  }

  cooldownUntilFor(underlying: string): number | undefined {
    return this.cooldownUntil.get(underlying);
  }

  snapshot(): DaySnapshot {
    let unrealized = 0;
    for (const value of this.openPnl.values()) {
      unrealized += value;
    }
    return {
      dayKey: this.dayKey,
      realizedPnlInr: this.realized,
      unrealizedPnlInr: unrealized,
      dayPnlInr: this.realized + unrealized,
      tradesToday: this.trades,
      openUnderlyings: [...this.openUnderlyings].sort(),
      killSwitchReason: this.killSwitchReason,
      dailyLossBreach: this.dailyLossBreach,
    };
  }
}
