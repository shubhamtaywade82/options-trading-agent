import { DayBook } from '../risk/dayBook.js';
import { istParts } from '../time/ist.js';

export interface RestoreResult {
  readonly eventsApplied: number;
  /** Underlyings with an entry journalled today and no terminal outcome. Released so they are not blocked forever. */
  readonly releasedUnresolved: readonly string[];
}

/**
 * Rebuilds today's day-book state (P&L, trade count, cooldowns, breach state)
 * from the append-only journal. Without this, a restart would reset the daily
 * loss counter to zero and allow trading past the limit.
 *
 * Fail-closed: a malformed journal line for the current IST day throws, because
 * skipping it could under-count losses. A truncated final line from an
 * interrupted write is the usual cause, and the operator must inspect it first.
 */
export function restoreDayBook(book: DayBook, journalLines: readonly string[], dayKey: string): RestoreResult {
  const open = new Map<string, { index: number; at: number }>();
  let applied = 0;
  journalLines.forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    let event: {
      ts?: unknown;
      type?: unknown;
      underlying?: unknown;
      pnlInr?: unknown;
      reason?: unknown;
      baselineInr?: unknown;
      enabled?: unknown;
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      throw new Error(`event journal line ${index + 1} is malformed; inspect it before restarting`);
    }
    if (typeof event.ts !== 'string') {
      return;
    }
    const at = Date.parse(event.ts);
    if (Number.isNaN(at) || istParts(at).date !== dayKey) {
      return;
    }
    const underlying = typeof event.underlying === 'string' ? event.underlying : undefined;
    switch (event.type) {
      case 'entry_submitted':
        if (underlying !== undefined) {
          book.recordEntry(underlying);
          open.set(underlying, { index, at });
          applied += 1;
        }
        break;
      case 'entry_rejected':
        if (underlying !== undefined) {
          book.releaseUnfilled(underlying);
          open.delete(underlying);
          applied += 1;
        }
        break;
      case 'trade_closed':
        if (underlying !== undefined && typeof event.pnlInr === 'number') {
          book.recordClose({ underlying, pnlInr: event.pnlInr, closedAtMs: at });
          open.delete(underlying);
          applied += 1;
        }
        break;
      case 'book_kill_switch':
        book.activateKillSwitch(typeof event.reason === 'string' ? event.reason : 'restored breach');
        applied += 1;
        break;
      case 'daily_loss_breach':
        book.recordDailyLossBreach('daily loss limit breached earlier today');
        applied += 1;
        break;
      case 'daily_loss_reset':
        if (typeof event.baselineInr === 'number') {
          book.setDrawdownBaseline(event.baselineInr);
          book.clearKillSwitch();
          applied += 1;
        }
        break;
      case 'daily_loss_brake_toggled':
        if (typeof event.enabled === 'boolean') {
          book.setDailyLossBrake(event.enabled);
          applied += 1;
        }
        break;
      // Replayed in journal order, so a clear that followed a breach clears it here too, as it did at runtime.
      case 'operator_entry_block':
        book.activateKillSwitch(typeof event.reason === 'string' ? event.reason : 'operator entry block (restored)');
        applied += 1;
        break;
      case 'operator_entry_clear':
        book.clearKillSwitch();
        applied += 1;
        break;
      default:
        break;
    }
  });
  const released = [...open.keys()].sort();
  for (const underlying of released) {
    // An intent with no outcome may have reached the broker. It still starts a cooldown, so a restart cannot re-enter at once.
    book.recordClose({ underlying, pnlInr: 0, closedAtMs: open.get(underlying)?.at ?? 0 });
  }
  return { eventsApplied: applied, releasedUnresolved: released };
}
