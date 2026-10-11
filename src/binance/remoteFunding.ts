export interface FundingObservation {
  nextFundingTime: number;
  funding: Record<string, number>;
  marks: Record<string, number>;
}

/** Resolves true when the exchange accepted the event. */
type PushFunding = (symbol: string, fundingRate: number, markPrice: number, fundingTime: number) => Promise<boolean>;

export interface FundingLine {
  message: string;
  isFailure: boolean;
}

/** Binance's `nextFundingTime` jumps forward when a settlement passes; the boundary it jumped from is the one to settle. */
export class FundingBoundaryWatcher {
  private lastBoundary = 0;

  constructor(private readonly symbols: string[], private readonly push: PushFunding) {}

  /** Pushes one event per symbol for a boundary that just passed; returns one line per push, failures marked. */
  async observe(market: FundingObservation): Promise<FundingLine[]> {
    if (!(market.nextFundingTime > 0)) return [];
    const settled = this.lastBoundary;
    this.lastBoundary = market.nextFundingTime;
    // The first observation after startup only records the boundary: settlements from before this process are not replayed.
    if (settled === 0 || market.nextFundingTime <= settled) return [];
    const lines: FundingLine[] = [];
    const boundary = new Date(settled).toISOString();
    for (const symbol of this.symbols) {
      const rate = market.funding[symbol];
      const mark = market.marks[symbol];
      if (rate === undefined || !(mark > 0)) continue;
      const isPushed = await this.push(symbol, rate, mark, settled);
      const outcome = isPushed ? 'settled' : 'push FAILED (not retried)';
      lines.push({ message: `Funding ${outcome} for ${symbol} rate=${rate.toExponential(4)} mark=${mark.toFixed(2)} @ ${boundary}`, isFailure: !isPushed });
    }
    return lines;
  }
}
