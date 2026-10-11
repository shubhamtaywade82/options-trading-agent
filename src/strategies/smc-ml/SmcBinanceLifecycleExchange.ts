import { BinanceClient } from '@nemesis-oss/binance-sdk';
import type {
  SmcLifecycleExchange,
  SmcLifecycleExchangeState,
  SmcLifecycleOrder,
  SmcLifecyclePosition,
} from './SmcTradeLifecycleCoordinator.js';

export class BinanceSmcLifecycleExchange implements SmcLifecycleExchange {
  constructor(private readonly client: BinanceClient) {}

  async reconcile(symbol: string): Promise<SmcLifecycleExchangeState> {
    const s = symbol.toUpperCase();
    const [positions, openOrders] = await Promise.all([
      this.client.futures.account.positionRiskV3(s),
      this.client.futures.trading.getOpenOrders(s),
    ]);

    const open = positions.filter((p) => Math.abs(p.positionAmt) > 0);
    if (open.length > 1) {
      throw new Error(
        `SMC lifecycle requires one unambiguous position for ${s}; found ${open.length}`,
      );
    }

    const position = open[0];
    const normalizedPosition: SmcLifecyclePosition | null = position
      ? {
          symbol: position.symbol,
          direction: position.positionAmt > 0 ? 'LONG' : 'SHORT',
          quantity: Math.abs(position.positionAmt),
          entryPrice: position.entryPrice,
        }
      : null;

    const normalizedOrders: SmcLifecycleOrder[] = openOrders.map((order) => ({
      orderId: order.orderId,
      type: order.type,
      side: order.side as 'BUY' | 'SELL',
      quantity: order.origQty,
      stopPrice: order.stopPrice,
      status: order.status,
    }));

    return { position: normalizedPosition, openOrders: normalizedOrders };
  }

  async partialClose(
    symbol: string,
    portion: number,
  ): Promise<{ ok: boolean; orderId?: number; reason?: string }> {
    const position = await this.requirePosition(symbol);
    try {
      const result = await this.client.futures.ops.closePosition({
        symbol: symbol.toUpperCase(),
        portion,
        ...(normalizedPositionSide(position.positionSide) ? { positionSide: normalizedPositionSide(position.positionSide) } : {}),
      });
      if (!result.closed && result.reason !== 'dryRun') {
        const after = await this.reconcile(symbol);
        if (!after.position || after.position.quantity < Math.abs(position.positionAmt)) {
          return { ok: true, reason: 'position reduced while close response was unresolved' };
        }
        return { ok: false, reason: result.reason ?? 'partial close was not submitted' };
      }

      return {
        ok: result.closed,
        orderId: extractOrderId(result.order),
        reason: result.reason,
      };
    } catch (error) {
      const after = await this.reconcile(symbol);
      if (!after.position || after.position.quantity < Math.abs(position.positionAmt)) {
        return {
          ok: true,
          reason: 'partial close confirmed by post-error reconciliation',
        };
      }
      throw error;
    }
  }

  async modifyOrder(
    symbol: string,
    orderId: number,
    input: { quantity: number; stopPrice?: number; side: 'BUY' | 'SELL'; type: string },
  ): Promise<SmcLifecycleOrder> {
    const quantized = await this.client.futures.ops.quantize(symbol, {
      quantity: input.quantity,
      price: input.stopPrice,
    });

    try {
      const order = await this.client.futures.trading.modifyOrder({
        symbol: symbol.toUpperCase(),
        orderId,
        side: input.side,
        type: input.type,
        quantity: quantized.quantity,
        ...(quantized.price === undefined ? {} : { stopPrice: quantized.price }),
      });
      return normalizeOrder(order);
    } catch (error) {
      const reconciled = await this.client.futures.trading.getOrder(symbol.toUpperCase(), { orderId });
      const desiredPrice = input.stopPrice;
      const samePrice =
        desiredPrice === undefined ||
        (reconciled.stopPrice !== undefined &&
          Math.abs(reconciled.stopPrice - desiredPrice) <= Math.max(1e-12, Math.abs(desiredPrice) * 1e-10));
      const sameQty =
        Math.abs(reconciled.origQty - input.quantity) <= Math.max(1e-12, Math.abs(input.quantity) * 1e-10);

      if (samePrice && sameQty) return normalizeOrder(reconciled);
      throw error;
    }
  }

  async closeRemaining(
    symbol: string,
  ): Promise<{ ok: boolean; orderId?: number; reason?: string }> {
    const position = await this.requirePosition(symbol);
    try {
      const result = await this.client.futures.ops.closePosition({
        symbol: symbol.toUpperCase(),
        ...(normalizedPositionSide(position.positionSide) ? { positionSide: normalizedPositionSide(position.positionSide) } : {}),
      });
      if (!result.closed) {
        const after = await this.reconcile(symbol);
        if (!after.position) return { ok: true, reason: 'position closed while response was unresolved' };
      }

      return {
        ok: result.closed,
        orderId: extractOrderId(result.order),
        reason: result.reason,
      };
    } catch (error) {
      const after = await this.reconcile(symbol);
      if (!after.position) {
        return { ok: true, reason: 'close confirmed by post-error reconciliation' };
      }
      throw error;
    }
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    const result = await this.client.futures.execution.cancelOrder(symbol.toUpperCase(), {
      orderId,
      intentId: `smc-cancel-${symbol.toUpperCase()}-${orderId}`,
    });
    if (result.reconciliationState === 'unknown') {
      throw new Error(`unable to reconcile cancellation of order ${orderId}`);
    }
  }

  private async requirePosition(symbol: string) {
    const positions = await this.client.futures.account.positionRiskV3(symbol.toUpperCase());
    const open = positions.filter((p) => Math.abs(p.positionAmt) > 0);
    if (open.length !== 1) {
      throw new Error(
        `SMC lifecycle requires exactly one open position for ${symbol.toUpperCase()}; found ${open.length}`,
      );
    }
    return open[0];
  }
}

function normalizeOrder(order: {
  orderId: number;
  type: string;
  side: string;
  origQty: number;
  stopPrice?: number;
  status: string;
}): SmcLifecycleOrder {
  return {
    orderId: order.orderId,
    type: order.type,
    side: order.side as 'BUY' | 'SELL',
    quantity: order.origQty,
    stopPrice: order.stopPrice,
    status: order.status,
  };
}

function extractOrderId(order: unknown): number | undefined {
  if (!order || typeof order !== 'object') return undefined;
  const id = (order as { orderId?: unknown }).orderId;
  return typeof id === 'number' ? id : undefined;
}

function normalizedPositionSide(value: string): 'BOTH' | 'LONG' | 'SHORT' | undefined {
  return value === 'BOTH' || value === 'LONG' || value === 'SHORT' ? value : undefined;
}
