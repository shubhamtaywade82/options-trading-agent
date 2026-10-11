import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ApiResponseError } from '@nemesis-oss/dhanhq-sdk';
import { classifyPlacementError, LiveExecutionPort, type LiveClient } from '../src/dhan/liveExecution.js';
import type { EntryOrder, ExecutionEvent, ExitOrder } from '../src/execution/ports.js';
import { contract } from './support/fixtures.js';

const SILENT = { info() {}, warn() {}, error() {} };
const OPTION = contract({ optionType: 'CE', strike: 22_450, securityId: '48001' });
const SEG = 'NSE_FNO';

interface FakeOptions {
  placeError?: unknown;
  sellError?: unknown;
  cancelError?: unknown;
  positions?: Array<Record<string, unknown>>;
  positionsError?: unknown;
}

function fakeBroker(options: FakeOptions = {}) {
  const orderHandlers: Array<(state: unknown) => void> = [];
  const calls = {
    superPlace: [] as Array<Record<string, unknown>>,
    superCancel: [] as Array<Record<string, unknown>>,
    place: [] as Array<Record<string, unknown>>,
    kill: [] as string[],
  };
  const client = {
    ws: {
      orders: {
        on: (event: string, handler: (state: unknown) => void) => {
          if (event === 'order') {
            orderHandlers.push(handler);
          }
        },
      },
    },
    superOrders: {
      place: async (request: Record<string, unknown>) => {
        calls.superPlace.push(request);
        if (options.placeError !== undefined) {
          throw options.placeError;
        }
        return { correlationId: request['correlationId'], data: { orderId: 'SUPER-1' } };
      },
      cancel: async (request: Record<string, unknown>) => {
        calls.superCancel.push(request);
        if (options.cancelError !== undefined) {
          throw options.cancelError;
        }
        return {};
      },
    },
    orders: {
      place: async (request: Record<string, unknown>) => {
        calls.place.push(request);
        if (options.sellError !== undefined) {
          throw options.sellError;
        }
        return { correlationId: request['correlationId'], data: {} };
      },
    },
    positions: {
      list: async () => {
        if (options.positionsError !== undefined) {
          throw options.positionsError;
        }
        return options.positions ?? [];
      },
    },
    traderControls: {
      setKillSwitch: async (status: string) => {
        calls.kill.push(status);
        return {};
      },
    },
  };
  const emitOrder = (state: Record<string, unknown>) => {
    for (const handler of orderHandlers) {
      handler(state);
    }
  };
  return { client: client as unknown as LiveClient, calls, emitOrder };
}

function entry(correlationId = 'ENT-1', quantity = 75): EntryOrder {
  return {
    side: 'BUY',
    correlationId,
    underlying: 'NIFTY',
    contract: OPTION,
    quantity,
    entryReference: 101,
    stopLossPrice: 70.05,
    targetPrice: 162.05,
  };
}

function exit(quantity = 75): ExitOrder {
  return {
    side: 'SELL',
    correlationId: 'EXT-1',
    underlying: 'NIFTY',
    positionId: 'ENT-1',
    contract: OPTION,
    quantity,
    reason: 'TIME_STOP',
    referencePrice: 112,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

function port(broker: ReturnType<typeof fakeBroker>, orderTimeoutMs = 200, reconcileIntervalMs = 60_000) {
  const live = new LiveExecutionPort(broker.client, { mode: 'live', orderTimeoutMs, reconcileIntervalMs, logger: SILENT });
  const events: ExecutionEvent[] = [];
  live.onEvent((event) => events.push(event));
  return { live, events };
}

function brokerRow(netQty: number, extra: Record<string, unknown> = {}) {
  return { securityId: '48001', exchangeSegment: SEG, netQty, ...extra };
}

describe('classifyPlacementError', () => {
  it('treats definitive client rejections as REJECTED', () => {
    assert.equal(classifyPlacementError(new ApiResponseError('bad quantity', 400)), 'REJECTED');
    assert.equal(classifyPlacementError(new ApiResponseError('forbidden', 403)), 'REJECTED');
  });

  it('treats anything that may have reached the venue as UNCONFIRMED', () => {
    assert.equal(classifyPlacementError(new ApiResponseError('server error', 500)), 'UNCONFIRMED');
    assert.equal(classifyPlacementError(new ApiResponseError('token expired', 401)), 'UNCONFIRMED');
    assert.equal(classifyPlacementError(new ApiResponseError('too many requests', 429)), 'UNCONFIRMED');
    assert.equal(classifyPlacementError(new Error('socket hang up')), 'UNCONFIRMED');
  });
});

describe('LiveExecutionPort entries', () => {
  it('confirms a fill only from the order-update stream and reports its average price', async () => {
    const broker = fakeBroker();
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    assert.equal(events.length, 0, 'HTTP acceptance alone is not a fill');
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101.5, securityId: '48001', raw: {} });
    await settle();
    assert.deepEqual(events, [
      { kind: 'ENTRY_FILLED', correlationId: 'ENT-1', underlying: 'NIFTY', quantity: 75, averagePrice: 101.5, at: events[0] && (events[0] as { at: number }).at },
    ]);
    assert.equal(broker.calls.superPlace[0]?.['stopLossPrice'], 70.05, 'stop and target travel with the entry');
    assert.equal(broker.calls.superPlace[0]?.['productType'], 'INTRADAY');
    assert.equal(broker.calls.superPlace[0]?.['transactionType'], 'BUY');
    await live.close();
  });

  it('reports a definitive placement rejection as ENTRY_REJECTED without tracking a position', async () => {
    const { live, events } = port(fakeBroker({ placeError: new ApiResponseError('margin short', 400) }));
    await live.submitEntry(entry());
    assert.equal(events[0]?.kind, 'ENTRY_REJECTED');
    await live.close();
  });

  it('reports an ambiguous placement failure as ENTRY_UNCONFIRMED so trading halts', async () => {
    const { live, events } = port(fakeBroker({ placeError: new ApiResponseError('gateway timeout', 504) }));
    await live.submitEntry(entry());
    assert.equal(events[0]?.kind, 'ENTRY_UNCONFIRMED');
    await live.close();
  });

  it('reports ENTRY_UNCONFIRMED when no terminal status arrives before the timeout', async () => {
    const { live, events } = port(fakeBroker(), 30);
    await live.submitEntry(entry());
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.equal(events.at(-1)?.kind, 'ENTRY_UNCONFIRMED');
    await live.close();
  });

  it('reports a rejected order with no fill as ENTRY_REJECTED', async () => {
    const broker = fakeBroker();
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'REJECTED', tradedQty: 0, securityId: '48001', raw: {} });
    await settle();
    assert.equal(events[0]?.kind, 'ENTRY_REJECTED');
    await live.close();
  });
});

describe('LiveExecutionPort exits', () => {
  it('sends a SELL capped at the broker net long quantity after detaching the bracket legs', async () => {
    const broker = fakeBroker({ positions: [brokerRow(75)] });
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    await live.submitExit(exit(150));
    assert.deepEqual(broker.calls.superCancel.map((call) => call['orderLeg']), ['STOP_LOSS_LEG', 'TARGET_LEG']);
    assert.equal(broker.calls.place.length, 1);
    assert.equal(broker.calls.place[0]?.['transactionType'], 'SELL');
    assert.equal(broker.calls.place[0]?.['quantity'], 75, 'never sell more than the broker reports as held');
    broker.emitOrder({ orderId: 'EXIT-1', correlationId: 'EXT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 112, securityId: '48001', raw: {} });
    await settle();
    assert.equal(events.at(-1)?.kind, 'EXIT_FILLED');
    await live.close();
  });

  it('never sends a SELL when the broker reports no long quantity, and records the external close instead', async () => {
    const broker = fakeBroker({ positions: [brokerRow(0, { sellAvg: 70.1, sellQty: 75 })] });
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    await live.submitExit(exit());
    assert.equal(broker.calls.place.length, 0, 'a SELL here would open a short option');
    assert.deepEqual(events.at(-1), {
      kind: 'PROTECTIVE_EXIT_FILLED',
      underlying: 'NIFTY',
      positionId: 'ENT-1',
      quantity: 75,
      averagePrice: 70.1,
      reason: 'EXTERNAL',
      at: (events.at(-1) as { at: number }).at,
    });
    await live.close();
  });

  it('refuses to exit while a protective leg may still be active', async () => {
    const broker = fakeBroker({ positions: [brokerRow(75)], cancelError: new ApiResponseError('leg not cancellable', 400) });
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    await live.submitExit(exit());
    assert.equal(broker.calls.place.length, 0);
    assert.equal(events.at(-1)?.kind, 'EXIT_UNCONFIRMED');
    await live.close();
  });

  it('halts on a net short position rather than compounding the exposure', async () => {
    const broker = fakeBroker({ positions: [brokerRow(-75)] });
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    await live.submitExit(exit());
    assert.equal(broker.calls.place.length, 0);
    assert.equal(events.at(-1)?.kind, 'BROKER_MISMATCH');
    await live.close();
  });

  it('does not send an exit when broker positions cannot be read', async () => {
    const broker = fakeBroker({ positions: [brokerRow(75)] });
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    const failing = fakeBroker({ positionsError: new Error('read timeout') });
    const second = port(failing);
    await second.live.submitEntry(entry('ENT-2'));
    failing.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-2', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    await second.live.submitExit({ ...exit(), positionId: 'ENT-2' });
    assert.equal(failing.calls.place.length, 0);
    assert.equal(second.events.at(-1)?.kind, 'EXIT_UNCONFIRMED');
    assert.equal(events.at(-1)?.kind, 'ENTRY_FILLED');
    await live.close();
    await second.live.close();
  });
});

describe('LiveExecutionPort reconciliation', () => {
  it('reports an external (bracket) close seen only in positions, exactly once', async () => {
    const broker = fakeBroker({ positions: [brokerRow(75)] });
    const { live, events } = port(broker, 200, 10);
    live.start();
    await live.submitEntry(entry());
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    (broker.client as unknown as { positions: { list: () => Promise<unknown[]> } }).positions.list = async () => [brokerRow(0, { sellAvg: 162, sellQty: 75 })];
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const closes = events.filter((event) => event.kind === 'PROTECTIVE_EXIT_FILLED');
    assert.equal(closes.length, 1);
    assert.equal(closes[0]?.kind === 'PROTECTIVE_EXIT_FILLED' && closes[0].averagePrice, 162);
    await live.close();
  });

  it('turns an unconfirmed entry that shows up at the broker into a late ENTRY_FILLED once', async () => {
    const broker = fakeBroker({ placeError: new ApiResponseError('gateway timeout', 504) });
    const { live, events } = port(broker, 200, 10);
    live.start();
    await live.submitEntry(entry());
    (broker.client as unknown as { positions: { list: () => Promise<unknown[]> } }).positions.list = async () => [brokerRow(75, { buyAvg: 101.2 })];
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    const fills = events.filter((event) => event.kind === 'ENTRY_FILLED');
    assert.equal(fills.length, 1);
    assert.equal(events[0]?.kind, 'ENTRY_UNCONFIRMED');
    await live.close();
  });
});
