import { Decimal } from 'decimal.js';

// 40 digits keeps qty * price * leverage products exact well past any exchange precision
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const dec = (value: Decimal.Value): Decimal => new Decimal(value);

/** Floors a value down to the exchange step size; a non-positive step leaves it unchanged. */
export function floorToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return value;
  return value.div(step).toDecimalPlaces(0, Decimal.ROUND_DOWN).times(step);
}

// Flooring a quantity that must satisfy a MINIMUM (min-notional) can land just below it; ceiling cannot
/** Ceils a value up to the exchange step size; a non-positive step leaves it unchanged. */
export function ceilToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return value;
  return value.div(step).toDecimalPlaces(0, Decimal.ROUND_UP).times(step);
}
