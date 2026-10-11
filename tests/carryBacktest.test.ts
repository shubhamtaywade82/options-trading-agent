import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aprToRate, simulateCarry, type Bar, type CarryParams, type FundingPoint } from '../src/backtesting/CarryBacktest.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const costs = { spotFeeRate: 0.001, perpFeeRate: 0.0004, slippageRate: 0.0002 };
const params = (over: Partial<CarryParams> = {}): CarryParams => ({
  entryApr: 0, exitApr: -10, lookback: 3, perpLeverage: 3, maintenanceMarginRate: 0.005, costs, ...over,
});
const fundingSeries = (rates: number[]): FundingPoint[] => rates.map((rate, i) => ({ time: T0 + i * 8 * H, rate }));
/** Hourly bars from T0; `price(hour)` gives the open, high/low default to it. */
const bars = (hours: number, price: (h: number) => number, high: (h: number) => number = price): Bar[] =>
  Array.from({ length: hours }, (_, h) => ({ openTime: T0 + h * H, open: price(h), high: high(h), low: price(h), close: price(h) }));
const flat = (hours: number) => bars(hours, () => 100);

// one entry (spot + perp) and one exit: 2 * ((0.001+0.0002) + (0.0004+0.0002)) = 0.0036
const ROUND_TRIP = 0.0036;

test('constant funding on flat prices earns funding minus four fills, and nothing from the interval that triggered entry', () => {
  const n = 60;
  const r = simulateCarry(fundingSeries(Array(n).fill(0.0001)), flat(n * 8 + 8), flat(n * 8 + 8), params());
  assert.equal(r.cycles.length, 1);
  // entry after seeing 3 intervals (index 2): accrues intervals 3..59
  assert.equal(r.cycles[0].intervals, n - 3);
  assert.ok(Math.abs(r.cycles[0].fundingPct - (n - 3) * 0.0001 * 100) < 1e-9);
  assert.ok(Math.abs(r.cycles[0].basisPct) < 1e-9);
  assert.ok(Math.abs(r.cycles[0].costsPct - ROUND_TRIP * 100) < 1e-9);
  assert.ok(Math.abs(r.netPct - ((n - 3) * 0.0001 - ROUND_TRIP) * 100) < 1e-9);
  assert.equal(r.cycles[0].reason, 'END');
});

test('below the entry threshold it never trades', () => {
  const rate = aprToRate(0.05) ;
  const r = simulateCarry(fundingSeries(Array(40).fill(rate)), flat(400), flat(400), params({ entryApr: 0.10 }));
  assert.equal(r.cycles.length, 0);
  assert.equal(r.netPct, 0);
  assert.equal(r.timeInMarketPct, 0);
});

test('it leaves when the trailing mean funding drops below the exit level, and re-enters only on a new signal', () => {
  const rates = [...Array(10).fill(0.0003), ...Array(10).fill(-0.0003), ...Array(10).fill(0.0003)];
  const r = simulateCarry(fundingSeries(rates), flat(30 * 8 + 8), flat(30 * 8 + 8), params({ entryApr: 0.05, exitApr: 0 }));
  assert.equal(r.cycles.length, 2);
  assert.equal(r.cycles[0].reason, 'SIGNAL');
  assert.equal(r.cycles[1].reason, 'END');
  assert.ok(r.cycles[0].exitedAt < r.cycles[1].enteredAt);
});

test('the legs hedge: equal moves in spot and perp leave no basis result', () => {
  const up = (h: number) => 100 * (1 + (0.02 * h) / 400);
  const r = simulateCarry(fundingSeries(Array(50).fill(0.0001)), bars(408, up), bars(408, up), params());
  assert.ok(Math.abs(r.cycles[0].basisPct) < 1e-6, `basis ${r.cycles[0].basisPct}`);
});

test('a perp that rallies against the short while spot stays flat loses the difference as basis', () => {
  const perpUp = (h: number) => 100 * (1 + (0.01 * h) / 400);
  const r = simulateCarry(fundingSeries(Array(50).fill(0.0001)), flat(408), bars(408, perpUp), params());
  assert.ok(r.cycles[0].basisPct < -0.5 && r.cycles[0].basisPct > -1.0, `basis ${r.cycles[0].basisPct}`);
});

test('funding on a perp that has rallied accrues on the larger notional', () => {
  const perpUp = (h: number) => (h < 24 ? 100 : 110);
  const r = simulateCarry(fundingSeries(Array(40).fill(0.0001)), flat(328), bars(328, perpUp), params());
  assert.ok(r.cycles[0].fundingPct > (40 - 3) * 0.0001 * 100);
});

test('a spike through the liquidation price loses the perp margin, is flagged, and is not re-entered the same step', () => {
  // leverage 3 => liquidation at +32.8%; one hourly high at +40% after entry
  const spike = (h: number) => (h === 100 ? 140 : 100);
  const r = simulateCarry(fundingSeries(Array(40).fill(0.0001)), flat(328), bars(328, () => 100, spike), params());
  assert.equal(r.liquidations, 1);
  const c = r.cycles.find((x) => x.reason === 'LIQUIDATED')!;
  assert.ok(Math.abs(c.basisPct - -(1 / 3) * 100) < 1e-6, `basis ${c.basisPct}`);
  assert.ok(c.netPct < -30);
  // spot-only exit cost on the liquidated cycle
  assert.ok(Math.abs(c.costsPct - (0.0012 + 0.0006 + 0.0012) * 100) < 1e-9);
});

test('higher leverage moves the liquidation closer: the same spike that 3x survives kills 10x', () => {
  const spike = (h: number) => (h === 100 ? 115 : 100);
  const at = (lev: number) => simulateCarry(fundingSeries(Array(40).fill(0.0001)), flat(328), bars(328, () => 100, spike), params({ perpLeverage: lev })).liquidations;
  assert.equal(at(3), 0);
  assert.equal(at(10), 1);
});

test('annualised return is on capital (spot leg plus perp margin), not on notional', () => {
  const n = 1095; // a year of intervals
  const r = simulateCarry(fundingSeries(Array(n).fill(0.0001)), flat(n * 8 + 8), flat(n * 8 + 8), params());
  assert.ok(Math.abs(r.capitalPerNotional - (1 + 1 / 3)) < 1e-12);
  assert.ok(Math.abs(r.netOnCapitalPct - r.netPct / (4 / 3)) < 1e-9);
  assert.ok(Math.abs(r.years - 1) < 0.01);
  // ~ (1095-3)*0.01% - 0.36% = 10.56% on notional => ~7.9% on capital
  assert.ok(r.annualisedOnCapitalPct > 7.5 && r.annualisedOnCapitalPct < 8.3, `${r.annualisedOnCapitalPct}`);
});

test('equity drawdown reflects an adverse basis move while positioned', () => {
  const perpSpike = (h: number) => (h >= 60 && h < 120 ? 108 : 100);
  const r = simulateCarry(fundingSeries(Array(40).fill(0.0001)), flat(328), bars(328, perpSpike), params());
  assert.ok(r.maxDrawdownPct > 7);
});

test('a minimum hold defers a signal exit, so a flickering rate stops churning fills', () => {
  // funding flips sign every 2 intervals: without a minimum hold it exits/re-enters constantly
  const rates = Array.from({ length: 60 }, (_, i) => (Math.floor(i / 2) % 2 === 0 ? 0.0003 : -0.0003));
  const churn = simulateCarry(fundingSeries(rates), flat(60 * 8 + 8), flat(60 * 8 + 8), params({ lookback: 2, entryApr: 0.05, exitApr: 0 }));
  const slow = simulateCarry(fundingSeries(rates), flat(60 * 8 + 8), flat(60 * 8 + 8), params({ lookback: 2, entryApr: 0.05, exitApr: 0, minHoldIntervals: 12 }));
  assert.ok(churn.cycles.length > slow.cycles.length);
  assert.ok(slow.costsPct < churn.costsPct);
  for (const c of slow.cycles.filter((x) => x.reason === 'SIGNAL')) assert.ok(c.intervals >= 12);
});

test('a minimum hold never delays a liquidation', () => {
  const spike = (h: number) => (h === 40 ? 150 : 100);
  const r = simulateCarry(fundingSeries(Array(40).fill(0.0001)), flat(328), bars(328, () => 100, spike), params({ minHoldIntervals: 1000 }));
  assert.equal(r.liquidations, 1);
});
