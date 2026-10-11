import type { Decimal } from 'decimal.js';
import type { Side } from '../types.js';
import type { ContractSpec } from './contractSpec.js';
import { ceilToStep, dec, floorToStep } from './primitives.js';
import type { RiskLimits } from './riskConfig.js';

// Lot flooring and fee rounding leave a sliver of slack; beyond it a trade is genuinely over budget
const RISK_BUDGET_TOLERANCE = 1.02;
const DEFAULT_FUNDING_PERIODS = 3;
const ROUND_TRIP_LEGS = 2;

export interface SizingInput {
  readonly equity: number;
  readonly availableMargin: number;
  readonly direction: Side;
  readonly entry: number;
  readonly stop: number;
  readonly requestedLeverage: number;
  /** Per-8h funding rate (e.g. 0.0001 = 0.01%). */
  readonly fundingRate?: number;
  /** Expected holding time in 8h funding periods (default 3). */
  readonly fundingPeriods?: number;
  readonly spec: ContractSpec;
  readonly limits: RiskLimits;
  readonly circuitMultiplier: number;
  /** Extra budget scaling (volatility, setup score); defaults to 1 and is capped at 1 so it can only shrink the budget. */
  readonly riskMultiplier?: number;
}

export interface SizingResult {
  readonly ok: boolean;
  readonly rejection?: string;
  readonly quantity: number;
  readonly notional: number;
  readonly marginRequired: number;
  readonly leverage: number;
  readonly riskAmount: number;
  readonly effectiveRiskPerUnit: number;
  readonly feePerUnit: number;
  readonly fundingPerUnit: number;
  readonly warnings: readonly string[];
}

interface CostModel {
  readonly feePerUnit: number;
  readonly fundingPerUnit: number;
  readonly effectiveRiskPerUnit: number;
}

const clampedLeverage = (input: SizingInput): number =>
  Math.min(input.requestedLeverage, input.limits.maxLeverage, input.spec.maxLeverage);

const fail = (input: SizingInput, rejection: string, warnings: readonly string[]): SizingResult => ({
  ok: false, rejection, quantity: 0, notional: 0, marginRequired: 0, leverage: clampedLeverage(input),
  riskAmount: 0, effectiveRiskPerUnit: 0, feePerUnit: 0, fundingPerUnit: 0, warnings,
});

/** A sizing failure produced before any sizing input exists (e.g. the real instrument spec was unavailable). */
export const failedSizing = (rejection: string): SizingResult => ({
  ok: false, rejection, quantity: 0, notional: 0, marginRequired: 0, leverage: 0,
  riskAmount: 0, effectiveRiskPerUnit: 0, feePerUnit: 0, fundingPerUnit: 0, warnings: [],
});

const FINITE_FIELDS = ['equity', 'availableMargin', 'entry', 'stop', 'requestedLeverage', 'circuitMultiplier', 'riskMultiplier', 'fundingRate'] as const;

// Every comparison against NaN is false, so a NaN margin would skip the margin check instead of failing it
const firstNonFinite = (input: SizingInput): string | undefined =>
  FINITE_FIELDS.find((field) => input[field] !== undefined && !Number.isFinite(input[field]));

function buildCosts(input: SizingInput, stopDistance: number): CostModel {
  const entry = dec(input.entry);
  const feeRate = input.limits.feeRateTaker + input.limits.slippageBufferRate;
  const feePerUnit = entry.times(feeRate).times(ROUND_TRIP_LEGS).toNumber();
  const periods = input.fundingPeriods ?? DEFAULT_FUNDING_PERIODS;
  // Funding is charged as a cost in both signs: a receiving position is not credited, keeping risk conservative
  const fundingPerUnit = entry.times(Math.abs(input.fundingRate ?? 0)).times(periods).toNumber();
  return { feePerUnit, fundingPerUnit, effectiveRiskPerUnit: stopDistance + feePerUnit + fundingPerUnit };
}

function raiseToMinNotional(
  qty: Decimal, input: SizingInput, riskBudget: number, costs: CostModel, warnings: string[],
): Decimal | string {
  const entry = dec(input.entry);
  if (qty.times(entry).gte(input.spec.minNotional)) return qty;
  // Flooring could leave the quantity just below the minimum; ceiling guarantees it, and the budget check bounds the risk
  const minQty = ceilToStep(dec(input.spec.minNotional).dividedBy(entry), dec(input.spec.lotSize));
  const bumped = minQty.gte(input.spec.minQuantity) ? minQty : dec(input.spec.minQuantity);
  if (bumped.times(costs.effectiveRiskPerUnit).gt(dec(riskBudget).times(RISK_BUDGET_TOLERANCE))) {
    return 'min notional would exceed risk budget';
  }
  warnings.push('quantity bumped to exchange minimum notional');
  return bumped;
}

function capNotional(qty: Decimal, input: SizingInput, warnings: string[]): Decimal | string {
  const entry = dec(input.entry);
  const cap = dec(Math.min(input.limits.maxNotionalPerTrade, input.spec.maxQuantity * input.entry));
  if (qty.times(entry).lte(cap)) return qty;
  const reduced = floorToStep(cap.dividedBy(entry), dec(input.spec.lotSize));
  warnings.push('quantity reduced by max notional cap');
  if (reduced.lt(input.spec.minQuantity)) return 'max notional cap below min quantity';
  // Flooring to the cap can undo the min-notional bump, and an order below the exchange minimum is rejected
  return reduced.times(entry).lt(input.spec.minNotional) ? 'max notional cap below min notional' : reduced;
}

function resolveQuantity(
  input: SizingInput, riskBudget: number, costs: CostModel, warnings: string[],
): number | string {
  const rawQty = dec(riskBudget).dividedBy(costs.effectiveRiskPerUnit);
  const floored = floorToStep(rawQty, dec(input.spec.lotSize));
  if (floored.lt(input.spec.minQuantity)) {
    return `quantity ${floored.toFixed(6)} below min ${input.spec.minQuantity}`;
  }
  const raised = raiseToMinNotional(floored, input, riskBudget, costs, warnings);
  if (typeof raised === 'string') return raised;
  const capped = capNotional(raised, input, warnings);
  return typeof capped === 'string' ? capped : capped.toNumber();
}

function buildAcceptedSizing(
  input: SizingInput, qty: number, riskBudget: number, costs: CostModel, warnings: string[],
): SizingResult {
  const notional = qty * input.entry;
  const leverage = Math.max(1, clampedLeverage(input));
  const marginRequired = notional / leverage;
  if (marginRequired > input.availableMargin) return fail(input, 'insufficient available margin', warnings);
  const riskAmount = qty * costs.effectiveRiskPerUnit;
  if (riskAmount > riskBudget * RISK_BUDGET_TOLERANCE) return fail(input, 'final risk exceeds risk budget', warnings);
  return {
    ok: true, quantity: qty, notional, marginRequired, leverage, riskAmount,
    effectiveRiskPerUnit: costs.effectiveRiskPerUnit, feePerUnit: costs.feePerUnit,
    fundingPerUnit: costs.fundingPerUnit, warnings,
  };
}

/**
 * Sizing pipeline: equity -> risk budget -> stop distance -> fees + slippage -> funding -> lot-step quantity
 * -> min notional -> notional cap -> margin/leverage -> final risk check. Every adjustment is conservative.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const invalidField = firstNonFinite(input);
  if (invalidField) return failedSizing(`non-finite input: ${invalidField}`);

  const warnings: string[] = [];
  const riskBudget = dec(input.equity)
    .times(input.limits.maxRiskPerTradePercent).dividedBy(100)
    .times(input.circuitMultiplier).times(Math.min(1, input.riskMultiplier ?? 1)).toNumber();
  if (riskBudget <= 0) return fail(input, 'zero risk budget (circuit state)', warnings);

  const stopDistance = Math.abs(input.entry - input.stop);
  if (stopDistance <= 0) return fail(input, 'stop distance must be positive', warnings);

  const costs = buildCosts(input, stopDistance);
  const qty = resolveQuantity(input, riskBudget, costs, warnings);
  if (typeof qty === 'string') return fail(input, qty, warnings);
  return buildAcceptedSizing(input, qty, riskBudget, costs, warnings);
}
