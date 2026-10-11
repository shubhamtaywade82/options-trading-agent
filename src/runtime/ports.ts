import type { Candle, InstrumentRef, OptionContract, OptionSegment, UnderlyingSpec } from '../domain/types.js';
import type { ChainSnapshot } from '../options/selector.js';

/** Everything the agent needs from the market-data side, behind one seam for tests. */
export interface MarketPort {
  intradayCandles(spot: InstrumentRef, barMinutes: number, fromDate: string, toDate: string): Promise<Candle[]>;
  listExpiries(spot: InstrumentRef): Promise<string[]>;
  optionChain(spot: InstrumentRef, expiry: string): Promise<ChainSnapshot>;
  optionContracts(underlying: UnderlyingSpec['symbol'], optionSegment: OptionSegment): Promise<readonly OptionContract[]>;
  /** Funds the premium can be paid from. Paper uses configured capital; live uses the broker balance. */
  availableFunds(): Promise<number>;
  /** Live only: number of option legs with a non-zero net quantity at the broker. Paper returns 0. */
  brokerOpenOptionCount(): Promise<number>;
}

/** Feed-side view for the agent: LTP freshness and option subscription lifecycle. */
export interface FeedPort {
  ageMs(ref: InstrumentRef): number | undefined;
  subscribe(refs: readonly InstrumentRef[]): void;
  unsubscribe(refs: readonly InstrumentRef[]): void;
}
