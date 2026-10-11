import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { restoreDayBook } from '../src/ops/dayState.js';
import { DayBook } from '../src/risk/dayBook.js';
import { SESSION_DAY } from './support/fixtures.js';

const line = (ts: string, type: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts, type, ...extra });

const T = (hhmm: string, date = SESSION_DAY): string => `${date}T${hhmm}:00+05:30`;

describe('restoreDayBook', () => {
  it('rebuilds today\'s P&L, trade count and cooldown after a restart', () => {
    const book = new DayBook(Date.parse(T('09:20')), 300_000);
    const journal = [
      line(T('09:45'), 'entry_submitted', { underlying: 'NIFTY' }),
      line(T('10:10'), 'trade_closed', { underlying: 'NIFTY', pnlInr: -1200 }),
      line(T('10:30'), 'entry_submitted', { underlying: 'NIFTY' }),
      line(T('11:00'), 'trade_closed', { underlying: 'NIFTY', pnlInr: 800 }),
    ];
    const result = restoreDayBook(book, journal, SESSION_DAY);
    const snapshot = book.snapshot();
    assert.equal(result.eventsApplied, 4);
    assert.equal(snapshot.realizedPnlInr, -400);
    assert.equal(snapshot.tradesToday, 2);
    assert.deepEqual(snapshot.openUnderlyings, []);
    assert.equal(book.cooldownUntilFor('NIFTY'), Date.parse(T('11:00')) + 300_000);
  });

  it('restores a daily-loss breach so a restart cannot trade past the limit', () => {
    const book = new DayBook(Date.parse(T('12:00')), 0);
    restoreDayBook(book, [line(T('12:00'), 'daily_loss_breach', { dayPnlInr: -6000 })], SESSION_DAY);
    assert.match(book.snapshot().killSwitchReason ?? '', /daily loss/);
  });

  it('ignores journal lines from other IST days', () => {
    const book = new DayBook(Date.parse(T('09:20')), 0);
    const journal = [
      line(T('15:00', '2026-10-09'), 'trade_closed', { underlying: 'NIFTY', pnlInr: -9999 }),
      line(T('15:00', '2026-10-09'), 'daily_loss_breach', { dayPnlInr: -9999 }),
    ];
    restoreDayBook(book, journal, SESSION_DAY);
    assert.equal(book.snapshot().realizedPnlInr, 0);
    assert.equal(book.snapshot().killSwitchReason, undefined);
  });

  it('releases an entry that was journalled but never resolved, so it does not block the underlying', () => {
    const book = new DayBook(Date.parse(T('10:30')), 0);
    const result = restoreDayBook(book, [line(T('10:00'), 'entry_submitted', { underlying: 'BANKNIFTY' })], SESSION_DAY);
    assert.deepEqual(result.releasedUnresolved, ['BANKNIFTY']);
    assert.deepEqual(book.snapshot().openUnderlyings, []);
    assert.equal(book.snapshot().tradesToday, 1, 'the attempt still counts toward the trade limit');
  });

  it('fails closed on a malformed line rather than under-counting losses', () => {
    const book = new DayBook(Date.parse(T('10:30')), 0);
    assert.throws(
      () => restoreDayBook(book, [line(T('10:00'), 'trade_closed', { underlying: 'NIFTY', pnlInr: -10 }), '{"ts":"2026-10-12T1'], SESSION_DAY),
      /malformed/,
    );
  });

  it('treats blank lines as no-ops', () => {
    const book = new DayBook(Date.parse(T('10:30')), 0);
    assert.equal(restoreDayBook(book, ['', '   '], SESSION_DAY).eventsApplied, 0);
  });
});
