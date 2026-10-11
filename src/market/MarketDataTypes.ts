import type { Candle } from '../types.js';

export type NativeTimeframe = '1m' | '5m' | '15m' | '1h' | '4h';

export interface DerivativesSnapshot {
  asOf: number;
  openInterest: number | null;
  openInterestChangePct: number | null;
  globalLongShortRatio: number | null;
  topTraderAccountLongShortRatio: number | null;
  topTraderPositionLongShortRatio: number | null;
  takerBuySellRatio: number | null;
  takerVolumeImbalance: number | null;
  orderBookImbalance: number | null;
  spreadBps: number | null;
  basisPct: number | null;
}

export interface MarketDataSnapshot {
  symbol: string;
  generatedAt: number;
  candles: Partial<Record<NativeTimeframe, Candle[]>>;
  derivatives: DerivativesSnapshot | null;
}
