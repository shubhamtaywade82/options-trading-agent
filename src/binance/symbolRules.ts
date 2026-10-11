import type { FuturesSymbolExchangeInfo } from 'binance';

export interface SymbolRules {
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  fundingIntervalHours?: number;
}

// Used until exchange info loads, and for symbols it does not list
const DEFAULT_RULES: SymbolRules = {
  pricePrecision: 2,
  quantityPrecision: 3,
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0,
  minNotional: 0,
};

// Absorbs float error such as 0.3 / 0.1 = 2.9999999999999996 before flooring to a step
export const STEP_EPSILON = 1e-9;

const rulesBySymbol = new Map<string, SymbolRules>();

export function setSymbolRules(symbol: string, rules: SymbolRules): void {
  rulesBySymbol.set(symbol, rules);
}

export function getSymbolRules(symbol: string): SymbolRules {
  return rulesBySymbol.get(symbol) ?? DEFAULT_RULES;
}

/** Builds rules from a Binance USD-M exchangeInfo symbol entry. */
export function rulesFromExchangeInfo(info: FuturesSymbolExchangeInfo): SymbolRules {
  const priceFilter = info.filters.find((f) => f.filterType === 'PRICE_FILTER');
  const lotFilter = info.filters.find((f) => f.filterType === 'LOT_SIZE');
  const notionalFilter = info.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
  const rules: SymbolRules = {
    pricePrecision: info.pricePrecision,
    quantityPrecision: info.quantityPrecision,
    tickSize: Number(priceFilter && 'tickSize' in priceFilter ? priceFilter.tickSize : 10 ** -info.pricePrecision),
    stepSize: Number(lotFilter && 'stepSize' in lotFilter ? lotFilter.stepSize : 10 ** -info.quantityPrecision),
    minQty: Number(lotFilter && 'minQty' in lotFilter ? lotFilter.minQty : 0),
    minNotional: Number(notionalFilter && 'notional' in notionalFilter ? notionalFilter.notional : 0),
  };
  if (typeof (info as any).fundingIntervalHours === 'number') {
    rules.fundingIntervalHours = (info as any).fundingIntervalHours;
  }
  return rules;
}

/** Nearest valid tick for the symbol; the exchange rejects prices off the tick grid. */
export function roundPrice(symbol: string, price: number): number {
  const { tickSize, pricePrecision } = getSymbolRules(symbol);
  return Number((Math.round(price / tickSize) * tickSize).toFixed(pricePrecision));
}

/** Rounds down to the lot step so an order never exceeds its intended size. */
export function roundQty(symbol: string, qty: number): number {
  const { stepSize, quantityPrecision } = getSymbolRules(symbol);
  return Number((Math.floor(qty / stepSize + STEP_EPSILON) * stepSize).toFixed(quantityPrecision));
}

export function formatPrice(symbol: string, price: number): string {
  const { pricePrecision } = getSymbolRules(symbol);
  return price.toLocaleString('en-US', { minimumFractionDigits: pricePrecision, maximumFractionDigits: pricePrecision });
}

export function formatQty(symbol: string, qty: number): string {
  const { quantityPrecision } = getSymbolRules(symbol);
  return qty.toFixed(quantityPrecision);
}
