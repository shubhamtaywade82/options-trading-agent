import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractSpec } from '../src/risk/contractSpec.js';
import { dec } from '../src/risk/primitives.js';
import { failedSizing, sizePosition, type SizingInput, type SizingResult } from '../src/risk/positionSizer.js';
import type { RiskLimits } from '../src/risk/riskConfig.js';

const limits: RiskLimits = {
  maxRiskPerTradePercent: 1, maxLeverage: 10, minLeverage: 5, maxDailyLossPercent: 3, maxDrawdownPercent: 5,
  maxLossStreak: 4, maxConcurrentPositions: 4, maxSymbolExposurePercent: 80, maxPortfolioGrossExposurePercent: 80,
  maxCorrelatedExposurePercent: 80, maxNotionalPerTrade: 1e9, minRiskRewardRatio: 0, feeRateTaker: 0.0004,
  slippageBufferRate: 0.0002,
};

const solSpec: ContractSpec = {
  symbol: 'SOLUSDT', lotSize: 0.01, minQuantity: 0.01, maxQuantity: 10_000, minNotional: 20, tickSize: 0.01, maxLeverage: 15,
};

const makeInput = (over: Partial<SizingInput> = {}): SizingInput => ({
  equity: 10_000, availableMargin: 10_000, direction: 'LONG', entry: 150, stop: 148, requestedLeverage: 2,
  fundingRate: 0.0001, fundingPeriods: 3, spec: solSpec, limits, circuitMultiplier: 1, ...over,
});

test('should keep effective risk within the budget and widen the stop by fees and funding', () => {
  const result = sizePosition(makeInput());
  assert.equal(result.ok, true);
  assert.ok(result.riskAmount <= (10_000 * limits.maxRiskPerTradePercent) / 100 * 1.02);
  const expectedPerUnit = 2 + 150 * (limits.feeRateTaker + limits.slippageBufferRate) * 2 + 150 * 0.0001 * 3;
  assert.ok(Math.abs(result.effectiveRiskPerUnit - expectedPerUnit) < 1e-8);
});

test('should round quantity down to the lot step', () => {
  const result = sizePosition(makeInput({ spec: { ...solSpec, lotSize: 0.001 } }));
  assert.equal(result.ok, true);
  assert.equal(dec(result.quantity).mod(0.001).isZero(), true);
});

test('should reduce size when the circuit multiplier shrinks the budget', () => {
  const full = sizePosition(makeInput());
  const reduced = sizePosition(makeInput({ circuitMultiplier: 0.5 }));
  assert.ok(reduced.quantity < full.quantity);
  assert.ok(reduced.riskAmount < full.riskAmount);
});

test('should reject with no size when the circuit multiplier is zero', () => {
  const result = sizePosition(makeInput({ circuitMultiplier: 0 }));
  assert.equal(result.ok, false);
  assert.match(result.rejection ?? '', /risk budget/);
  assert.equal(result.quantity, 0);
});

test('should reject when min notional cannot fit the risk budget', () => {
  const result = sizePosition(makeInput({
    equity: 50, entry: 100_000, stop: 99_000,
    spec: { ...solSpec, minNotional: 100, minQuantity: 0.001, lotSize: 0.001 },
  }));
  assert.equal(result.ok, false);
});

test('should reject a bump to min notional that exceeds budget x 1.02', () => {
  // budget 1 floors to 0.89 units (notional 89); the 1.00 units min notional needs would risk 1.12 > 1.02
  const result = sizePosition(makeInput({
    equity: 100, entry: 100, stop: 99, fundingRate: 0, spec: { ...solSpec, minNotional: 100 },
  }));
  assert.equal(result.ok, false);
  assert.match(result.rejection ?? '', /min notional/);
});

test('should enforce the max notional cap', () => {
  const result = sizePosition(makeInput({ limits: { ...limits, maxNotionalPerTrade: 500 } }));
  assert.equal(result.ok, true);
  assert.ok(result.notional <= 500 + 1e-9);
  assert.ok(result.warnings.includes('quantity reduced by max notional cap'));
});

test('should reject when the max notional cap leaves less than the min notional', () => {
  // cap 10 floors to 0.06 units (notional 9) which is below the 20 min notional; the reduced size must not be approved
  const result = sizePosition(makeInput({ limits: { ...limits, maxNotionalPerTrade: 10 } }));
  assert.equal(result.ok, false);
  assert.equal(result.rejection, 'max notional cap below min notional');
  assert.equal(result.quantity, 0);
});

test('should accept a max notional cap that still satisfies the min notional', () => {
  const result = sizePosition(makeInput({ limits: { ...limits, maxNotionalPerTrade: 30 } }));
  assert.equal(result.ok, true);
  assert.ok(result.notional >= 20 && result.notional <= 30);
});

test('should reject a zero stop distance', () => {
  const result = sizePosition(makeInput({ stop: 150 }));
  assert.equal(result.ok, false);
  assert.match(result.rejection ?? '', /stop distance/);
});

test('should reject when margin exceeds what is available', () => {
  const result = sizePosition(makeInput({ availableMargin: 1 }));
  assert.equal(result.ok, false);
  assert.match(result.rejection ?? '', /margin/);
});

test('should clamp leverage to the limits and the spec maximum', () => {
  const result = sizePosition(makeInput({ requestedLeverage: 10, spec: { ...solSpec, maxLeverage: 2 } }));
  assert.equal(result.leverage, 2);
});

test('should round the min-notional quantity up to the lot step', () => {
  // entry 97, minNotional 100, lot 1: the budget floors to 1 lot (notional 97 < 100); flooring 100/97 again gives 1, ceiling gives 2
  const spec = { ...solSpec, lotSize: 1, minQuantity: 1, minNotional: 100 };
  const result = sizePosition(makeInput({ entry: 97, stop: 96, equity: 226, availableMargin: 100_000, spec }));
  assert.equal(result.ok, true);
  assert.equal(result.quantity, 2);
  assert.ok(result.notional >= 100);
  assert.ok(result.warnings.includes('quantity bumped to exchange minimum notional'));
});

test('should count funding in either direction as cost', () => {
  const none = sizePosition(makeInput({ fundingRate: 0 }));
  const paying = sizePosition(makeInput({ fundingRate: 0.001 }));
  const receiving = sizePosition(makeInput({ fundingRate: -0.001 }));
  assert.equal(none.fundingPerUnit, 0);
  assert.ok(paying.effectiveRiskPerUnit > none.effectiveRiskPerUnit);
  assert.equal(receiving.fundingPerUnit, paying.fundingPerUnit);
});

test('should build a rejected sizing without any input', () => {
  const result = failedSizing('contract spec unavailable');
  assert.equal(result.ok, false);
  assert.equal(result.rejection, 'contract spec unavailable');
  assert.equal(result.quantity, 0);
  assert.equal(result.leverage, 0);
});

// mulberry32: deterministic so a failing case reproduces from its index
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rand: () => number, low: number, high: number): number => low + rand() * (high - low);
const logBetween = (rand: () => number, low: number, high: number): number => Math.exp(between(rand, Math.log(low), Math.log(high)));
const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)];

const CAP_WARNING = 'quantity reduced by max notional cap';
const BUMP_WARNING = 'quantity bumped to exchange minimum notional';
const LOT_STEPS = [0.001, 0.01, 0.1, 1] as const;
const MIN_NOTIONALS = [5, 20, 100] as const;
const NOTIONAL_CAPS = [1e9, 1e9, 50_000, 2_000, 200, 30] as const;

function randomSpec(rand: () => number): ContractSpec {
  const lotSize = pick(rand, LOT_STEPS);
  return {
    symbol: 'RANDUSDT', lotSize, minQuantity: lotSize, maxQuantity: 1e9, minNotional: pick(rand, MIN_NOTIONALS),
    tickSize: 0.01, maxLeverage: Math.round(between(rand, 3, 20)),
  };
}

function randomInput(rand: () => number): SizingInput {
  const entry = logBetween(rand, 0.5, 120_000);
  const direction = pick(rand, ['LONG', 'SHORT'] as const);
  const stopDistance = entry * between(rand, 0.002, 0.08);
  const equity = logBetween(rand, 50, 1_000_000);
  return {
    equity,
    availableMargin: equity * pick(rand, [0.01, 0.2, 1, 1.5]),
    direction,
    entry,
    stop: direction === 'LONG' ? entry - stopDistance : entry + stopDistance,
    requestedLeverage: Math.round(between(rand, 1, 15)),
    fundingRate: between(rand, -0.001, 0.001),
    spec: randomSpec(rand),
    limits: { ...limits, maxNotionalPerTrade: pick(rand, NOTIONAL_CAPS) },
    circuitMultiplier: pick(rand, [0, 0.5, 0.75, 1, rand()]),
  };
}

function assertAcceptedSizing(input: SizingInput, result: SizingResult, label: string): void {
  const budget = (input.equity * input.limits.maxRiskPerTradePercent) / 100 * input.circuitMultiplier;
  const cap = Math.min(input.limits.maxNotionalPerTrade, input.spec.maxQuantity * input.entry);
  const maxLeverage = Math.min(input.requestedLeverage, input.limits.maxLeverage, input.spec.maxLeverage);
  const stopDistance = Math.abs(input.entry - input.stop);
  assert.ok(result.riskAmount <= budget * 1.02 * (1 + 1e-9), `${label} risk`);
  assert.ok(dec(result.quantity).mod(input.spec.lotSize).isZero(), `${label} lot step`);
  assert.ok(result.notional <= cap * (1 + 1e-9), `${label} cap`);
  assert.ok(result.marginRequired <= input.availableMargin * (1 + 1e-9), `${label} margin`);
  assert.ok(result.leverage <= maxLeverage, `${label} leverage`);
  assert.ok(result.quantity >= input.spec.minQuantity, `${label} min quantity`);
  assert.ok(result.effectiveRiskPerUnit > stopDistance, `${label} costs widen the stop`);
  assert.ok(Math.abs(result.effectiveRiskPerUnit - stopDistance - result.feePerUnit - result.fundingPerUnit) < 1e-9 * input.entry, `${label} cost sum`);
  assert.ok(result.notional >= input.spec.minNotional * (1 - 1e-9), `${label} min notional`);
}

test('should hold the sizing invariants over 1000 seeded random inputs', () => {
  const rand = seededRandom(20260922);
  let accepted = 0;
  let zeroBudgetRejections = 0;
  let capped = 0;
  for (let index = 0; index < 1000; index += 1) {
    const input = randomInput(rand);
    const result = sizePosition(input);
    if (input.circuitMultiplier === 0) {
      assert.equal(result.ok, false, `case ${index} zero multiplier`);
      zeroBudgetRejections += 1;
    }
    if (!result.ok) {
      assert.equal(result.quantity, 0, `case ${index} rejected size`);
      assert.ok(result.rejection, `case ${index} rejection reason`);
      continue;
    }
    accepted += 1;
    if (result.warnings.includes(CAP_WARNING)) capped += 1;
    assertAcceptedSizing(input, result, `case ${index}`);
  }
  assert.ok(accepted >= 200, `only ${accepted} accepted cases exercised`);
  assert.ok(zeroBudgetRejections > 0);
  assert.ok(capped >= 50, `only ${capped} capped cases exercised`);
});

test('should hold the sizing invariants while the budget sweeps across the min-notional boundary', () => {
  // Random inputs almost never land in the ~2% budget window where a bump is accepted, so sweep it deterministically
  const spec = { ...solSpec, lotSize: 1, minQuantity: 1, minNotional: 100 };
  let bumped = 0;
  for (let equity = 100; equity <= 400; equity += 0.5) {
    const input = makeInput({ entry: 97, stop: 96, equity, availableMargin: 1e6, spec });
    const result = sizePosition(input);
    if (!result.ok) continue;
    if (result.warnings.includes(BUMP_WARNING)) bumped += 1;
    assertAcceptedSizing(input, result, `equity ${equity}`);
  }
  assert.ok(bumped > 0);
});

const NON_FINITE_FIELDS = ['equity', 'availableMargin', 'entry', 'stop', 'requestedLeverage', 'circuitMultiplier', 'fundingRate'] as const;

for (const field of NON_FINITE_FIELDS) {
  for (const bad of [NaN, Infinity, -Infinity]) {
    test(`should reject with no size when ${field} is ${bad}`, () => {
      const result = sizePosition(makeInput({ [field]: bad }));
      assert.equal(result.ok, false);
      assert.equal(result.rejection, `non-finite input: ${field}`);
      assert.equal(result.quantity, 0);
    });
  }
}

test('should still size when the funding rate is unknown', () => {
  assert.equal(sizePosition(makeInput({ fundingRate: undefined })).ok, true);
});

test('should not approve a full-size trade when the available margin is NaN', () => {
  const result = sizePosition(makeInput({ availableMargin: NaN }));
  assert.equal(result.ok, false);
  assert.equal(result.quantity, 0);
});
