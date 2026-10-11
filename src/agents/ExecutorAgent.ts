import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, RiskDecision, LogEntry, Mode } from '../types.js';
import type { BinanceService } from '../binance/client.js';
import { isRefusal } from '../binance/remoteOrders.js';
import { config } from '../config.js';
import { formatPrice, formatQty, getSymbolRules, roundPrice, roundQty, STEP_EPSILON } from '../binance/symbolRules.js';

interface SizedOrder {
  side: 'BUY' | 'SELL';
  qty: number;
}

export class ExecutorAgent extends BaseAgent {
  readonly id = 'EXECUTOR-ε' as const;
  readonly strategy = 'binance_order_routing';

  constructor(svc: BinanceService) {
    super(svc);
  }

  protected async analyze(_ctx: MarketContext): Promise<Signal[]> {
    return [];
  }

  /** The optional decisionId threads the decision lineage through the venue into the trade journal. */
  async execute(signal: Signal, risk: RiskDecision, decisionId?: string): Promise<LogEntry> {
    try {
      const { side, qty } = await this.buildOrder(signal, risk);
      const stopLoss = roundOptionalPrice(signal.symbol, signal.stopLoss);
      const res = await this.binance.openFuturesPosition({
        symbol: signal.symbol,
        side,
        qty,
        leverage: risk.leverage,
        strategy: signal.agent,
        stopLoss,
        takeProfit: roundOptionalPrice(signal.symbol, signal.takeProfit),
        entryPrice: roundOptionalPrice(signal.symbol, signal.entry),
        ...(decisionId === undefined ? {} : { decisionId }),
      });
      return this.log(`FILLED ${side} ${signal.symbol} qty=${formatQty(signal.symbol, qty)} orderId=${res.orderId} SL=${stopLoss === undefined ? '—' : formatPrice(signal.symbol, stopLoss)} ${stopPlacement(config.mode)}`, 'success');
    } catch (err: any) {
      if (isRefusal(err)) return this.log(`EXECUTION REFUSED: ${err.message}`, 'warn');
      return this.log(`EXECUTION FAILED: ${err.message}`, 'error');
    }
  }

  private log(msg: string, level: LogEntry['level']): LogEntry {
    return { ts: Date.now(), agent: this.id, msg, level };
  }

  /** Validates the symbol, sizes the order to the lot step and enforces the exchange minimums; throws if it cannot be placed. */
  private async buildOrder(signal: Signal, risk: RiskDecision): Promise<SizedOrder> {
    const { symbol } = signal;
    if (!config.symbols.includes(symbol)) {
      throw new Error(`${symbol} is not a tradable symbol (expected one of ${config.symbols.join(',')})`);
    }
    // OPEN_HEDGE carries only a USDT notional, so size it off the live mark
    const entryPrice = signal.entry ?? (await this.binance.getPremiumIndex(symbol)).markPrice;
    const qty = roundQty(symbol, risk.positionSizeUsdt / entryPrice);
    if (qty <= 0) {
      throw new Error(`${risk.positionSizeUsdt.toFixed(2)} USDT is below one lot of ${symbol} at ${entryPrice}`);
    }
    const { minQty, minNotional } = getSymbolRules(symbol);
    if (qty + STEP_EPSILON < minQty) {
      throw new Error(`qty ${formatQty(symbol, qty)} is below the minimum quantity ${minQty} for ${symbol}`);
    }
    if (qty * entryPrice + STEP_EPSILON < minNotional) {
      throw new Error(`notional ${(qty * entryPrice).toFixed(2)} USDT is below the minimum notional ${minNotional} for ${symbol}`);
    }
    // Funding harvest earns by shorting the perp when funding is positive
    const isShort = signal.type === 'OPEN_SHORT' || signal.type === 'OPEN_HEDGE' || signal.type === 'OPEN_FUNDING_SHORT';
    return { side: isShort ? 'SELL' : 'BUY', qty };
  }
}

function roundOptionalPrice(symbol: string, price?: number): number | undefined {
  return price === undefined ? undefined : roundPrice(symbol, price);
}

/** Paper exits are decided by the agent (the broker never evaluates resting orders); only live rests a stop on the exchange. */
export const stopPlacement = (mode: Mode): string => (mode === 'live' ? 'server-side ✓' : 'agent-side');
