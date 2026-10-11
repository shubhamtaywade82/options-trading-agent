export interface CoinDcxContractSpec { lotSize: number; minQty: number; minNotional: number; maxLeverage: number }

export interface InstrumentClient {
  futures: { market: { getInstrumentDetails(pair: string): Promise<InstrumentDetails> } };
}

interface InstrumentDetails { lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }

// Absorbs float error such as 0.3 / 0.1 = 2.9999999999999996 before flooring to a step
const STEP_EPSILON = 1e-9;

const num = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function toSpec(details: InstrumentDetails): CoinDcxContractSpec {
  const minQty = num(details.min_quantity);
  return { lotSize: num(details.lot_size), minQty, minNotional: minQty * num(details.min_price), maxLeverage: num(details.max_leverage) };
}

/** Per-pair instrument metadata cache; used only for execution-time rounding — risk/ATR reasoning keeps reading Binance data. */
export class ContractSpecCache {
  private readonly cache = new Map<string, CoinDcxContractSpec>();
  constructor(private readonly client: InstrumentClient) {}

  async get(pair: string): Promise<CoinDcxContractSpec> {
    const cached = this.cache.get(pair);
    if (cached) return cached;
    const spec = toSpec(await this.client.futures.market.getInstrumentDetails(pair));
    this.cache.set(pair, spec);
    return spec;
  }
}

export function floorToLot(qty: number, lotSize: number): number {
  if (lotSize <= 0) return qty;
  return Math.floor(qty / lotSize + STEP_EPSILON) * lotSize;
}

export function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
  return Math.round(price / tickSize + STEP_EPSILON) * tickSize;
}
