import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildChainWatchView } from '../src/runtime/chainWatchView.js';

const chain = {
  expiry: '2026-10-15',
  fetchedAt: 1_000,
  strikes: [
    { strike: 22_400, call: { bid: 90, ask: 92, oi: 200_000 }, put: { bid: 10, ask: 11, oi: 50_000 } },
    { strike: 22_450, call: { bid: 60, ask: 61, oi: 500_000 }, put: { bid: 30, ask: 31, oi: 80_000 } },
    { strike: 22_500, call: { bid: 35, ask: 36, oi: 120_000 }, put: { bid: 55, ask: 56, oi: 90_000 } },
  ],
};

describe('buildChainWatchView', () => {
  it('centres strikes on ATM and marks entry legs', () => {
    const view = buildChainWatchView({
      symbol: 'NIFTY',
      spot: 22_461,
      chain,
      offsetSteps: 0,
      maxSpreadPct: 2,
      minOpenInterest: 100_000,
      openPosition: undefined,
      indicators: { supertrend: 'UP', emaFast: 22_500, emaSlow: 22_400, orbFormed: true },
      strikeScroll: 0,
      nowMs: 4_000,
      status: 'ready',
      error: undefined,
    });
    assert.equal(view.marketBias, 'BULLISH');
    assert.equal(view.status, 'ready');
    assert.equal(view.atmStrike, 22_450);
    assert.equal(view.bullishEntryStrike, 22_450);
    assert.equal(view.bearishEntryStrike, 22_450);
    const atmRow = view.rows.find((row) => row.markers.includes('ATM'));
    assert.ok(atmRow?.markers.includes('CE_ENTRY'));
    assert.ok(atmRow?.markers.includes('PE_ENTRY'));
    assert.equal(view.fetchedAgeMs, 3_000);
  });

  it('shifts the visible window with strikeScroll', () => {
    const wide = {
      expiry: '2026-10-15',
      fetchedAt: 1,
      strikes: Array.from({ length: 9 }, (_, i) => {
        const strike = 22_300 + i * 50;
        return { strike, call: { bid: 1, ask: 2, oi: 10_000 }, put: { bid: 1, ask: 2, oi: 10_000 } };
      }),
    };
    const centered = buildChainWatchView({
      symbol: 'NIFTY',
      spot: 22_450,
      chain: wide,
      offsetSteps: 0,
      maxSpreadPct: 2,
      minOpenInterest: 100,
      openPosition: undefined,
      indicators: { orbFormed: false },
      strikeScroll: 0,
      nowMs: 2,
      status: 'ready',
      error: undefined,
    });
    const shifted = buildChainWatchView({
      symbol: 'NIFTY',
      spot: 22_450,
      chain: wide,
      offsetSteps: 0,
      maxSpreadPct: 2,
      minOpenInterest: 100,
      openPosition: undefined,
      indicators: { orbFormed: false },
      strikeScroll: 2,
      nowMs: 2,
      status: 'ready',
      error: undefined,
    });
    assert.notDeepEqual(centered.rows.map((r) => r.strike), shifted.rows.map((r) => r.strike));
    assert.ok(shifted.rows.some((r) => r.strike > 22_450));
  });
});
