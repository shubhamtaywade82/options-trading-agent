import {
  advanceSmcTradeLifecycle,
  createSmcTradeLifecycle,
  type SmcLifecycleAction,
  type SmcTradeLifecycle,
} from './SmcTradeLifecycle.js';

export interface SmcLifecyclePosition {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
}

export interface SmcLifecycleOrder {
  orderId: number;
  type: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  stopPrice?: number;
  status: string;
}

export interface SmcLifecycleExchangeState {
  position: SmcLifecyclePosition | null;
  openOrders: SmcLifecycleOrder[];
}

export interface SmcLifecycleExchange {
  reconcile(symbol: string): Promise<SmcLifecycleExchangeState>;
  partialClose(symbol: string, portion: number): Promise<{ ok: boolean; orderId?: number; reason?: string }>;
  modifyOrder(
    symbol: string,
    orderId: number,
    input: { quantity: number; stopPrice?: number; side: 'BUY' | 'SELL'; type: string },
  ): Promise<SmcLifecycleOrder>;
  closeRemaining(symbol: string): Promise<{ ok: boolean; orderId?: number; reason?: string }>;
  cancelOrder(symbol: string, orderId: number): Promise<void>;
}

export interface RegisteredSmcLifecycle {
  lifecycle: SmcTradeLifecycle;
  stopOrderId: number;
  tp2OrderId?: number;
}

export interface SmcLifecycleCoordinatorResult {
  state: SmcTradeLifecycle | null;
  actions: SmcLifecycleAction[];
  transitionIds: string[];
}

export class SmcTradeLifecycleCoordinator {
  private readonly active = new Map<string, RegisteredSmcLifecycle>();
  private readonly positionCache = new Map<string, SmcLifecyclePosition | null>();
  private readonly cacheKnown = new Set<string>();
  private readonly lastUserEventAt = new Map<string, number>();

  constructor(private readonly exchange: SmcLifecycleExchange) {}

  register(params: Omit<Parameters<typeof createSmcTradeLifecycle>[0], 'config'> & {
    config?: Parameters<typeof createSmcTradeLifecycle>[0]['config'];
    stopOrderId: number;
    tp2OrderId?: number;
  }): SmcTradeLifecycle {
    const lifecycle = createSmcTradeLifecycle(params);
    this.active.set(lifecycle.symbol, {
      lifecycle,
      stopOrderId: params.stopOrderId,
      tp2OrderId: params.tp2OrderId,
    });
    return lifecycle;
  }

  replace(symbol: string, lifecycle: SmcTradeLifecycle): void {
    const current = this.active.get(symbol.toUpperCase());
    if (!current) throw new Error(`No lifecycle registered for ${symbol}`);
    this.active.set(symbol.toUpperCase(), { ...current, lifecycle });
  }

  get(symbol: string): SmcTradeLifecycle | null {
    return this.active.get(symbol.toUpperCase())?.lifecycle ?? null;
  }

  clear(symbol: string): void {
    const key = symbol.toUpperCase();
    this.active.delete(key);
    this.positionCache.delete(key);
    this.cacheKnown.delete(key);
    this.lastUserEventAt.delete(key);
  }

  private async knownPosition(symbol: string): Promise<SmcLifecyclePosition | null> {
    const key = symbol.toUpperCase();
    if (this.cacheKnown.has(key)) return this.positionCache.get(key) ?? null;
    const state = await this.exchange.reconcile(key);
    this.setPositionCache(key, state.position);
    return state.position;
  }

  private setPositionCache(symbol: string, position: SmcLifecyclePosition | null): void {
    const key = symbol.toUpperCase();
    this.positionCache.set(key, position);
    this.cacheKnown.add(key);
  }

  async onMarkPrice(symbol: string, markPrice: number): Promise<SmcLifecycleCoordinatorResult> {
    const key = symbol.toUpperCase();
    const registered = this.active.get(key);
    if (!registered) return { state: null, actions: [], transitionIds: [] };

    const position = await this.knownPosition(key);
    const before: SmcLifecycleExchangeState = { position, openOrders: [] };
    if (!before.position) {
      this.setPositionCache(key, null);
      const state = {
        ...registered.lifecycle,
        phase: 'CLOSED' as const,
        remainingQty: 0,
        closedReason: 'EXTERNAL_CLOSE' as const,
      };
      this.active.set(key, { ...registered, lifecycle: state });
      return { state, actions: [], transitionIds: [] };
    }

    this.assertDirection(registered.lifecycle, before.position);
    const transition = advanceSmcTradeLifecycle(registered.lifecycle, {
      markPrice,
      positionQty: before.position.quantity,
    });

    if (transition.actions.length === 0) {
      this.active.set(key, { ...registered, lifecycle: transition.state });
      return { state: transition.state, actions: [], transitionIds: [] };
    }

    let state = transition.state;
    const transitionIds: string[] = [];

    for (const action of transition.actions) {
      const transitionId = smcLifecycleTransitionId(state, action);
      transitionIds.push(transitionId);
      state = await this.executeAction(
        key,
        registered,
        state,
        action,
      );
    }

    this.active.set(key, { ...registered, lifecycle: state });
    return { state, actions: transition.actions, transitionIds };
  }

  handleAccountUpdate(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const raw = event as { e?: unknown; E?: unknown; a?: { P?: Array<Record<string, unknown>> } };
    if (raw.e !== 'ACCOUNT_UPDATE' || !Array.isArray(raw.a?.P)) return;

    const eventTime = Number(raw.E);
    const touchedSymbols = new Set<string>();
    for (const p of raw.a.P) {
      const symbol = typeof p.s === 'string' ? p.s.toUpperCase() : '';
      const amount = Number(p.pa);
      const entryPrice = Number(p.ep);
      if (!symbol || !Number.isFinite(amount) || !Number.isFinite(entryPrice)) continue;
      const previousEventTime = this.lastUserEventAt.get(symbol) ?? -Infinity;
      if (Number.isFinite(eventTime) && eventTime < previousEventTime) continue;
      touchedSymbols.add(symbol);
      if (amount === 0) {
        // ACCOUNT_UPDATE contains changed position legs, not necessarily a
        // complete symbol snapshot. Force one REST reconciliation instead of
        // treating a zero leg as proof that the whole symbol is flat.
        this.positionCache.delete(symbol);
        this.cacheKnown.delete(symbol);
        continue;
      }

      this.setPositionCache(symbol, {
        symbol,
        direction: amount > 0 ? 'LONG' : 'SHORT',
        quantity: Math.abs(amount),
        entryPrice,
      });
    }

    if (Number.isFinite(eventTime)) {
      for (const symbol of touchedSymbols) this.lastUserEventAt.set(symbol, eventTime);
    }
  }

  handleOrderTradeUpdate(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const raw = event as { e?: unknown; E?: unknown; o?: Record<string, unknown> };
    if (raw.e !== 'ORDER_TRADE_UPDATE' || !raw.o) return;

    const symbol = typeof raw.o.s === 'string' ? raw.o.s.toUpperCase() : '';
    const orderId = typeof raw.o.i === 'number' ? raw.o.i : Number(raw.o.i);
    const status = raw.o.X;
    const eventTime = Number(raw.E);
    if (!symbol || !Number.isFinite(orderId) || status !== 'FILLED') return;
    const previousEventTime = this.lastUserEventAt.get(symbol) ?? -Infinity;
    if (Number.isFinite(eventTime) && eventTime <= previousEventTime) return;
    if (Number.isFinite(eventTime)) this.lastUserEventAt.set(symbol, eventTime);

    const registered = this.active.get(symbol);
    if (!registered || registered.lifecycle.phase === 'CLOSED') return;

    if (orderId === registered.stopOrderId) {
      this.setPositionCache(symbol, null);
      this.active.set(symbol, {
        ...registered,
        lifecycle: {
          ...registered.lifecycle,
          phase: 'CLOSED',
          remainingQty: 0,
          closedReason: 'STOP',
        },
      });
      return;
    }

    if (registered.tp2OrderId !== undefined && orderId === registered.tp2OrderId) {
      this.setPositionCache(symbol, null);
      this.active.set(symbol, {
        ...registered,
        lifecycle: {
          ...registered.lifecycle,
          phase: 'CLOSED',
          remainingQty: 0,
          closedReason: 'TP2',
        },
      });
    }
  }

  private async executeAction(
    symbol: string,
    registered: RegisteredSmcLifecycle,
    state: SmcTradeLifecycle,
    action: SmcLifecycleAction,
  ): Promise<SmcTradeLifecycle> {
    const before = await this.exchange.reconcile(symbol);
    this.setPositionCache(symbol, before.position);
    if (!before.position) {
      return { ...state, phase: 'CLOSED', remainingQty: 0, closedReason: 'EXTERNAL_CLOSE' };
    }

    this.assertDirection(state, before.position);

    switch (action.type) {
      case 'PARTIAL_CLOSE': {
        const beforeQuantity = before.position.quantity;
        const result = await this.exchange.partialClose(symbol, action.fraction);
        const after = await this.exchange.reconcile(symbol);
        this.setPositionCache(symbol, after.position);

        if (!after.position) {
          return { ...state, phase: 'CLOSED', remainingQty: 0, closedReason: 'EXTERNAL_CLOSE' };
        }
        if (!result.ok || after.position.quantity >= beforeQuantity) {
          throw new Error(result.reason ?? 'TP1 partial close was not confirmed by reconciliation');
        }

        const nextState = { ...state, remainingQty: after.position.quantity };
        this.active.set(symbol, { ...registered, lifecycle: nextState });
        await this.syncProtection(symbol, registered, after.position.quantity, state.stopPrice);
        return nextState;
      }

      case 'MOVE_STOP': {
        const stop = before.openOrders.find((order) => order.orderId === registered.stopOrderId);
        if (!stop || !isOpenProtectiveStop(stop)) {
          throw new Error(`SMC lifecycle protective stop ${registered.stopOrderId} is missing`);
        }

        const improved =
          state.direction === 'LONG'
            ? action.stopPrice > (stop.stopPrice ?? 0)
            : action.stopPrice < (stop.stopPrice ?? Number.POSITIVE_INFINITY);

        if (!improved && action.stopPrice !== stop.stopPrice) {
          throw new Error('SMC lifecycle attempted to loosen the protective stop');
        }

        await this.exchange.modifyOrder(symbol, registered.stopOrderId, {
          quantity: before.position.quantity,
          stopPrice: action.stopPrice,
          side: stop.side,
          type: stop.type,
        });

        const nextState = { ...state, stopPrice: action.stopPrice };
        this.active.set(symbol, { ...registered, lifecycle: nextState });

        const after = await this.exchange.reconcile(symbol);
        this.setPositionCache(symbol, after.position);
        const updated = after.openOrders.find((order) => order.orderId === registered.stopOrderId);
        if (!updated || Math.abs((updated.stopPrice ?? NaN) - action.stopPrice) > Math.max(1e-12, Math.abs(action.stopPrice) * 1e-10)) {
          throw new Error('protective stop amendment was not confirmed by reconciliation');
        }

        if (registered.tp2OrderId !== undefined && after.position) {
          const tp2 = after.openOrders.find((order) => order.orderId === registered.tp2OrderId);
          if (tp2 && tp2.status === 'NEW') {
            await this.exchange.modifyOrder(symbol, registered.tp2OrderId, {
              quantity: after.position.quantity,
              ...(tp2.stopPrice === undefined ? {} : { stopPrice: tp2.stopPrice }),
              side: tp2.side,
              type: tp2.type,
            });
          }
        }

        return nextState;
      }

      case 'CLOSE_REMAINING': {
        const result = await this.exchange.closeRemaining(symbol);
        const after = await this.exchange.reconcile(symbol);
        this.setPositionCache(symbol, after.position);
        if (after.position) {
          throw new Error(result.reason ?? 'TP2 close was not confirmed by reconciliation');
        }

        const nextState = { ...state, phase: 'CLOSED' as const, remainingQty: 0, closedReason: 'TP2' as const };
        this.active.set(symbol, { ...registered, lifecycle: nextState });
        await this.cancelBoundOrders(symbol, registered, after);
        return nextState;
      }
    }
  }

  private async syncProtection(
    symbol: string,
    registered: RegisteredSmcLifecycle,
    quantity: number,
    stopPrice: number,
  ): Promise<void> {
    const state = await this.exchange.reconcile(symbol);
    const stop = state.openOrders.find((order) => order.orderId === registered.stopOrderId);
    if (!stop || !isOpenProtectiveStop(stop)) {
      throw new Error(`SMC lifecycle protective stop ${registered.stopOrderId} is missing after partial close`);
    }

    await this.exchange.modifyOrder(symbol, registered.stopOrderId, { quantity, stopPrice, side: stop.side, type: stop.type });

    if (registered.tp2OrderId !== undefined) {
      const tp2 = state.openOrders.find((order) => order.orderId === registered.tp2OrderId);
      if (tp2 && tp2.status === 'NEW') {
        await this.exchange.modifyOrder(symbol, registered.tp2OrderId, {
          quantity,
          ...(tp2.stopPrice === undefined ? {} : { stopPrice: tp2.stopPrice }),
          side: tp2.side,
          type: tp2.type,
        });
      }
    }

    const after = await this.exchange.reconcile(symbol);
    const updatedStop = after.openOrders.find((order) => order.orderId === registered.stopOrderId);
    if (!updatedStop || updatedStop.quantity > quantity + Math.max(1e-12, quantity * 1e-10)) {
      throw new Error('protective stop quantity was not synchronized');
    }
  }

  private async cancelBoundOrders(
    symbol: string,
    registered: RegisteredSmcLifecycle,
    state: SmcLifecycleExchangeState,
  ): Promise<void> {
    const ids = [registered.stopOrderId, registered.tp2OrderId].filter(
      (id): id is number => id !== undefined,
    );

    for (const id of ids) {
      const order = state.openOrders.find((item) => item.orderId === id);
      if (order && order.status === 'NEW') {
        await this.exchange.cancelOrder(symbol, id);
      }
    }
  }

  private assertDirection(
    lifecycle: SmcTradeLifecycle,
    position: SmcLifecyclePosition,
  ): void {
    if (lifecycle.direction !== position.direction) {
      throw new Error(`SMC lifecycle direction mismatch: expected ${lifecycle.direction}, got ${position.direction}`);
    }
  }
}

export function smcLifecycleTransitionId(
  lifecycle: SmcTradeLifecycle,
  action: SmcLifecycleAction,
): string {
  switch (action.type) {
    case 'PARTIAL_CLOSE':
      return `${lifecycle.symbol}:${lifecycle.setupId}:TP1`;
    case 'MOVE_STOP':
      return `${lifecycle.symbol}:${lifecycle.setupId}:${action.reason}:${action.stopPrice}`;
    case 'CLOSE_REMAINING':
      return `${lifecycle.symbol}:${lifecycle.setupId}:TP2`;
  }
}

function isOpenProtectiveStop(order: SmcLifecycleOrder): boolean {
  return order.status === 'NEW' && order.type === 'STOP_MARKET';
}
