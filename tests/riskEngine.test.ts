import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DayBook } from '../src/risk/dayBook.js';
import { evaluatePreTrade, type PreTradeInput, type RiskCode } from '../src/risk/riskEngine.js';
import { istEpoch } from './support/fixtures.js';

function approvedInput(overrides: Partial<PreTradeInput> = {}): PreTradeInput {
  return {
    side: 'BUY',
    entryReference: 100,
    stopLossPrice: 70,
    targetPrice: 160,
    lots: 1,
    lotSize: 75,
    maxLotsPerOrder: 2,
    maxRiskInr: 3000,
    availableFundsInr: 100_000,
    nowMs: istEpoch('2026-10-12', '10:00'),
    minuteOfDay: 600,
    entryStartMinute: 570,
    entryEndMinute: 870,
    isExpiryDay: false,
    expiryDayCutoffMinute: 810,
    killSwitchActive: false,
    dailyPnlInr: 0,
    dailyLossLimitInr: 3000,
    tradesToday: 0,
    maxTradesPerDay: 3,
    openPositions: 0,
    maxOpenPositions: 1,
    underlyingOpen: false,
    cooldownUntilMs: undefined,
    spotTickAgeMs: 200,
    optionQuoteAgeMs: 300,
    staleMs: 5_000,
    ...overrides,
  };
}

function codes(input: PreTradeInput): RiskCode[] {
  return evaluatePreTrade(input).violations.map((violation) => violation.code);
}

describe('evaluatePreTrade', () => {
  it('approves a well-formed, in-budget, in-window BUY', () => {
    const verdict = evaluatePreTrade(approvedInput());
    assert.equal(verdict.approved, true);
    assert.equal(verdict.riskInr, 2250);
  });

  it('never approves anything but a BUY, so option selling cannot be expressed', () => {
    assert.deepEqual(codes(approvedInput({ side: 'SELL' })), ['NOT_A_BUY_ORDER']);
  });

  it('reports every violation at once rather than the first one', () => {
    const found = codes(
      approvedInput({ killSwitchActive: true, tradesToday: 3, underlyingOpen: true, spotTickAgeMs: undefined }),
    );
    assert.deepEqual(found, ['KILL_SWITCH_ACTIVE', 'TRADE_COUNT_LIMIT', 'UNDERLYING_ALREADY_OPEN', 'SPOT_DATA_STALE']);
  });

  it('blocks entries once day P&L reaches the negative daily limit', () => {
    assert.ok(codes(approvedInput({ dailyPnlInr: -3000 })).includes('DAILY_LOSS_LIMIT'));
    assert.ok(!codes(approvedInput({ dailyPnlInr: -2999 })).includes('DAILY_LOSS_LIMIT'));
  });

  it('enforces the entry window and the expiry-day cutoff', () => {
    assert.ok(codes(approvedInput({ minuteOfDay: 569 })).includes('OUTSIDE_ENTRY_WINDOW'));
    assert.ok(codes(approvedInput({ minuteOfDay: 870 })).includes('OUTSIDE_ENTRY_WINDOW'));
    assert.ok(codes(approvedInput({ isExpiryDay: true, minuteOfDay: 810 })).includes('EXPIRY_DAY_CUTOFF'));
    assert.ok(!codes(approvedInput({ isExpiryDay: true, minuteOfDay: 809 })).includes('EXPIRY_DAY_CUTOFF'));
  });

  it('refuses stale spot or option data, including data that has never arrived', () => {
    assert.ok(codes(approvedInput({ spotTickAgeMs: 5_001 })).includes('SPOT_DATA_STALE'));
    assert.ok(codes(approvedInput({ optionQuoteAgeMs: undefined })).includes('OPTION_QUOTE_STALE'));
  });

  it('requires a stop strictly below entry and a target strictly above it', () => {
    assert.ok(codes(approvedInput({ stopLossPrice: 0 })).includes('STOP_LOSS_INVALID'));
    assert.ok(codes(approvedInput({ stopLossPrice: 100 })).includes('STOP_LOSS_INVALID'));
    assert.ok(codes(approvedInput({ targetPrice: 100 })).includes('TARGET_INVALID'));
  });

  it('recomputes risk from the order itself and rejects anything over budget', () => {
    assert.ok(codes(approvedInput({ lots: 2 })).includes('RISK_EXCEEDS_BUDGET'));
  });

  it('rejects zero lots and lots beyond the per-order cap', () => {
    assert.ok(codes(approvedInput({ lots: 0 })).includes('LOTS_OUT_OF_RANGE'));
    assert.ok(codes(approvedInput({ lots: 3, maxLotsPerOrder: 2, maxRiskInr: 1e9 })).includes('LOTS_OUT_OF_RANGE'));
  });

  it('rejects a premium the available funds cannot pay in full', () => {
    assert.ok(codes(approvedInput({ availableFundsInr: 7_000 })).includes('INSUFFICIENT_FUNDS'));
  });

  it('honours cooldown until it has elapsed', () => {
    const now = istEpoch('2026-10-12', '10:00');
    assert.ok(codes(approvedInput({ nowMs: now, cooldownUntilMs: now + 1 })).includes('COOLDOWN_ACTIVE'));
    assert.ok(!codes(approvedInput({ nowMs: now, cooldownUntilMs: now })).includes('COOLDOWN_ACTIVE'));
  });

  it('rejects when underlying side is already open', () => {
    assert.ok(codes(approvedInput({ sideOpen: true })).includes('UNDERLYING_SIDE_ALREADY_OPEN'));
    assert.ok(!codes(approvedInput({ sideOpen: false })).includes('UNDERLYING_SIDE_ALREADY_OPEN'));
  });

  it('rejects when underlying positions reach maxPositionsPerUnderlying', () => {
    assert.ok(codes(approvedInput({ underlyingOpenPositions: 2, maxPositionsPerUnderlying: 2 })).includes('UNDERLYING_POSITION_LIMIT'));
    assert.ok(!codes(approvedInput({ underlyingOpenPositions: 1, maxPositionsPerUnderlying: 2 })).includes('UNDERLYING_POSITION_LIMIT'));
  });

  it('allows entry when another side is open on the same underlying if under limit', () => {
    const verdict = evaluatePreTrade(
      approvedInput({
        sideOpen: false,
        underlyingOpenPositions: 1,
        maxPositionsPerUnderlying: 2,
        openPositions: 1,
        maxOpenPositions: 6,
      }),
    );
    assert.equal(verdict.approved, true);
  });
});

describe('DayBook', () => {
  it('accumulates realised and unrealised P&L into the day figure', () => {
    const book = new DayBook(istEpoch('2026-10-12', '09:20'), 0);
    book.recordEntry('NIFTY');
    book.setOpenPnl('NIFTY', -400);
    book.recordClose({ underlying: 'BANKNIFTY', pnlInr: 1000, closedAtMs: istEpoch('2026-10-12', '09:30') });
    const snapshot = book.snapshot();
    assert.equal(snapshot.realizedPnlInr, 1000);
    assert.equal(snapshot.unrealizedPnlInr, -400);
    assert.equal(snapshot.dayPnlInr, 600);
    assert.equal(snapshot.tradesToday, 1);
    assert.deepEqual(snapshot.openUnderlyings, ['NIFTY']);
  });

  it('resets per-day counters on IST date rollover but keeps the kill switch', () => {
    const book = new DayBook(istEpoch('2026-10-12', '15:00'), 0);
    book.recordEntry('NIFTY');
    book.recordClose({ underlying: 'NIFTY', pnlInr: -3500, closedAtMs: istEpoch('2026-10-12', '15:10') });
    book.activateKillSwitch('daily loss');
    book.observe(istEpoch('2026-10-13', '09:00'));
    const snapshot = book.snapshot();
    assert.equal(snapshot.dayKey, '2026-10-13');
    assert.equal(snapshot.tradesToday, 0);
    assert.equal(snapshot.realizedPnlInr, 0);
    assert.equal(snapshot.killSwitchReason, 'daily loss', 'a breach must not silently re-arm overnight');
  });

  it('applies cooldown per underlying and clears it on rollover', () => {
    const closedAt = istEpoch('2026-10-12', '10:00');
    const book = new DayBook(closedAt, 300_000);
    book.recordClose({ underlying: 'NIFTY', pnlInr: 10, closedAtMs: closedAt });
    assert.equal(book.cooldownUntilFor('NIFTY'), closedAt + 300_000);
    assert.equal(book.cooldownUntilFor('BANKNIFTY'), undefined);
    book.observe(istEpoch('2026-10-13', '09:00'));
    assert.equal(book.cooldownUntilFor('NIFTY'), undefined);
  });

  it('keeps the first kill-switch reason rather than overwriting it', () => {
    const book = new DayBook(0, 0);
    book.activateKillSwitch('first');
    book.activateKillSwitch('second');
    assert.equal(book.snapshot().killSwitchReason, 'first');
    book.clearKillSwitch();
    assert.equal(book.snapshot().killSwitchReason, undefined);
  });

  it('tracks open positions per underlying and per side independently', () => {
    const book = new DayBook(istEpoch('2026-10-12', '09:20'), 0);
    book.recordEntry('NIFTY', 'CE');
    assert.equal(book.isSideOpen('NIFTY', 'CE'), true);
    assert.equal(book.isSideOpen('NIFTY', 'PE'), false);
    assert.equal(book.underlyingOpenPositions('NIFTY'), 1);
    assert.equal(book.snapshot().openPositions, 1);

    book.recordEntry('NIFTY', 'PE');
    assert.equal(book.isSideOpen('NIFTY', 'CE'), true);
    assert.equal(book.isSideOpen('NIFTY', 'PE'), true);
    assert.equal(book.underlyingOpenPositions('NIFTY'), 2);
    assert.equal(book.snapshot().openPositions, 2);

    book.setOpenPnl('NIFTY', 500, 'CE');
    book.setOpenPnl('NIFTY', -200, 'PE');
    assert.equal(book.snapshot().unrealizedPnlInr, 300);

    book.recordClose({ underlying: 'NIFTY', optionType: 'CE', pnlInr: 500, closedAtMs: istEpoch('2026-10-12', '09:30') });
    assert.equal(book.isSideOpen('NIFTY', 'CE'), false);
    assert.equal(book.isSideOpen('NIFTY', 'PE'), true);
    assert.equal(book.underlyingOpenPositions('NIFTY'), 1);
    assert.equal(book.snapshot().openPositions, 1);
    assert.equal(book.snapshot().unrealizedPnlInr, -200);
    assert.equal(book.snapshot().realizedPnlInr, 500);
  });
});
