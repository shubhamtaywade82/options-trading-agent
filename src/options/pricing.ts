export interface BracketLevels {
  readonly entryReference: number;
  readonly stopLossPrice: number;
  readonly targetPrice: number;
  /** Premium points lost per unit if the stop is hit. */
  readonly riskPerUnit: number;
}

function decimalPlaces(value: number): number {
  const text = value.toString();
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Snaps to the tick grid and strips floating-point residue (e.g. 0.1 * 3 = 0.30000000000000004). */
function snap(steps: number, tickSize: number): number {
  return Number((steps * tickSize).toFixed(decimalPlaces(tickSize)));
}

export function roundUpToTick(price: number, tickSize: number): number {
  assertTick(tickSize);
  return snap(Math.ceil(price / tickSize - 1e-9), tickSize);
}

export function roundDownToTick(price: number, tickSize: number): number {
  assertTick(tickSize);
  return snap(Math.floor(price / tickSize + 1e-9), tickSize);
}

function assertTick(tickSize: number): void {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new RangeError(`tick size must be positive, got ${tickSize}`);
  }
}

/**
 * Stop and target for a long option bought at `entryReference`. The stop is
 * rounded up (exits no later than requested) and the target rounded down
 * (never promises more than the geometry allows). Returns undefined when the
 * tick grid cannot express a valid bracket at this premium.
 */
export function bracketLevels(input: {
  entryReference: number;
  stopLossPct: number;
  targetRr: number;
  tickSize: number;
}): BracketLevels | undefined {
  const { entryReference, stopLossPct, targetRr, tickSize } = input;
  if (!Number.isFinite(entryReference) || entryReference <= 0) {
    return undefined;
  }
  const stopLossPrice = roundUpToTick(entryReference * (1 - stopLossPct / 100), tickSize);
  const riskPerUnit = Number((entryReference - stopLossPrice).toFixed(decimalPlaces(tickSize)));
  if (stopLossPrice <= 0 || riskPerUnit < tickSize) {
    return undefined;
  }
  const targetPrice = roundDownToTick(entryReference + targetRr * riskPerUnit, tickSize);
  if (targetPrice < entryReference + tickSize) {
    return undefined;
  }
  return { entryReference, stopLossPrice, targetPrice, riskPerUnit };
}

/**
 * Statutory and broker charges for one option round trip (buy, then sell), as a percentage of premium unless named
 * in rupees. An estimate for the day book: the contract note is authoritative, and these rates change by budget
 * and exchange circular (STT on the options sell side rose from 0.10% to 0.15% on 2026-04-01).
 */
const BROKERAGE_PER_ORDER_INR = 20;
const STT_SELL_PCT = 0.15;
const EXCHANGE_TXN_PCT: Readonly<Record<string, number>> = { NSE_FNO: 0.03503, BSE_FNO: 0.0325 };
const SEBI_FEE_PCT = 0.0001;
const STAMP_DUTY_BUY_PCT = 0.003;
const GST_PCT = 18;

export function roundTripChargesInr(input: {
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  exchangeSegment: string;
}): number {
  const buyPremium = input.quantity * input.buyPrice;
  const sellPremium = input.quantity * input.sellPrice;
  const turnover = buyPremium + sellPremium;
  const exchangeTxnPct = EXCHANGE_TXN_PCT[input.exchangeSegment] ?? EXCHANGE_TXN_PCT['NSE_FNO'] ?? 0;
  const brokerage = 2 * BROKERAGE_PER_ORDER_INR;
  const exchangeTxn = (turnover * exchangeTxnPct) / 100;
  const sebiFee = (turnover * SEBI_FEE_PCT) / 100;
  const stt = (sellPremium * STT_SELL_PCT) / 100;
  const stampDuty = (buyPremium * STAMP_DUTY_BUY_PCT) / 100;
  const gst = ((brokerage + exchangeTxn + sebiFee) * GST_PCT) / 100;
  return Number((brokerage + exchangeTxn + sebiFee + stt + stampDuty + gst).toFixed(2));
}
