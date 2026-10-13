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
  return { securityId: '48001', exchangeSegment: SEG, productType: 'INTRADAY', netQty, ...extra };
}

function dayTotals(dayBuyQty: number, dayBuyValue: number, daySellQty: number, daySellValue: number) {
  return { dayBuyQty, dayBuyValue, daySellQty, daySellValue };
}

function setPositions(broker: ReturnType<typeof fakeBroker>, rows: Array<Record<string, unknown>>): void {
  (broker.client as unknown as { positions: { list: () => Promise<unknown[]> } }).positions.list = async () => rows;
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

describe('LiveExecutionPort broker id limit', () => {
  it('refuses an entry whose correlation id is over 30 characters, and never sends it', async () => {
    const broker = fakeBroker();
    const { live, events } = port(broker);
    await live.submitEntry(entry('ENT-LONG-ID-THAT-THE-BROKER-WOULD-REFUSE'));
    await settle();
    assert.equal(events[0]?.kind, 'ENTRY_REJECTED');
    assert.equal(broker.calls.superPlace.length, 0, 'the oversize id never reached Dhan');
  });

  it('refuses an exit whose correlation id is over 30 characters, and never sends the sell', async () => {
    const broker = fakeBroker({ positions: [brokerRow(75)] });
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    await settle();
    await live.submitExit({ ...exit(), correlationId: 'EXT-ENT-NIFTY-LONG-ID-THAT-OVERRUNS-THE-LIMIT' });
    await settle();
    assert.equal(events.at(-1)?.kind, 'EXIT_REJECTED');
    assert.equal(broker.calls.place.length, 0, 'no sell went to Dhan');
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

  it('should send the entry as a LIMIT at the entry reference so a fill cannot exceed the sized risk', async () => {
    const broker = fakeBroker();
    const { live } = port(broker);
    await live.submitEntry(entry());
    assert.equal(broker.calls.superPlace[0]?.['orderType'], 'LIMIT');
    assert.equal(broker.calls.superPlace[0]?.['price'], 101);
    await live.close();
  });

  it('reports ENTRY_UNCONFIRMED when the entry neither settles nor confirms its cancel', async () => {
    const broker = fakeBroker();
    const { live, events } = port(broker, 30);
    await live.submitEntry(entry());
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(broker.calls.superCancel, [{ orderId: 'SUPER-1', orderLeg: 'ENTRY_LEG' }]);
    assert.equal(events.at(-1)?.kind, 'ENTRY_UNCONFIRMED');
    await live.close();
  });

  it('should cancel an unfilled limit entry at the timeout and report it rejected', async () => {
    const broker = fakeBroker();
    const { live, events } = port(broker, 30);
    await live.submitEntry(entry());
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(broker.calls.superCancel, [{ orderId: 'SUPER-1', orderLeg: 'ENTRY_LEG' }]);
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'CANCELLED', tradedQty: 0, securityId: '48001', raw: {} });
    await settle();
    assert.equal(events.at(-1)?.kind, 'ENTRY_REJECTED');
    await live.close();
  });

  it('should report the filled part of a limit entry cancelled at the timeout', async () => {
    const broker = fakeBroker();
    const { live, events } = port(broker, 30);
    await live.submitEntry(entry());
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'CANCELLED', tradedQty: 25, averageTradedPrice: 100.5, securityId: '48001', raw: {} });
    await settle();
    const filled = events.at(-1);
    assert.equal(filled?.kind, 'ENTRY_FILLED');
    assert.equal((filled as { quantity: number }).quantity, 25);
    await live.close();
  });

  it('reports ENTRY_UNCONFIRMED when the cancel of an unfilled entry fails', async () => {
    const broker = fakeBroker({ cancelError: new ApiResponseError('gateway timeout', 504) });
    const { live, events } = port(broker, 30);
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
    const broker = fakeBroker();
    const { live, events } = port(broker);
    await live.submitEntry(entry());
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    setPositions(broker, [brokerRow(0, dayTotals(75, 7575, 75, 5257.5))]);
    await live.submitExit(exit());
    assert.equal(broker.calls.place.length, 0, 'a SELL here would open a short option');
    assert.deepEqual(events.at(-1), {
      kind: 'PROTECTIVE_EXIT_FILLED',
      underlying: 'NIFTY',
      positionId: 'ENT-1',
      quantity: 75,
      averagePrice: 5257.5 / 75,
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

describe('LiveExecutionPort broker position rows', () => {
  /** Rows before the entry, while the position is open, and after the bracket closed it. */
  async function bracketCloseAfter(
    before: Array<Record<string, unknown>>,
    open: Array<Record<string, unknown>>,
    after: Array<Record<string, unknown>>,
  ) {
    const broker = fakeBroker({ positions: before });
    const { live, events } = port(broker, 200, 10);
    live.start();
    await live.submitEntry(entry());
    setPositions(broker, open);
    broker.emitOrder({ orderId: 'SUPER-1', correlationId: 'ENT-1', status: 'TRADED', tradedQty: 75, averageTradedPrice: 101, securityId: '48001', raw: {} });
    await settle();
    setPositions(broker, after);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await live.close();
    return events.find((event) => event.kind === 'PROTECTIVE_EXIT_FILLED') as Extract<ExecutionEvent, { kind: 'PROTECTIVE_EXIT_FILLED' }> | undefined;
  }

  it('should price a close from this trade only when the contract was already traded today', async () => {
    // Earlier today: bought 75 @ 100, sold 75 @ 120. This trade: bought 75 @ 101, stopped out 75 @ 70.
    const earlier = dayTotals(75, 7_500, 75, 9_000);
    const close = await bracketCloseAfter(
      [brokerRow(0, earlier)],
      [brokerRow(75, dayTotals(150, 15_075, 75, 9_000))],
      [brokerRow(0, dayTotals(150, 15_075, 150, 14_250))],
    );
    assert.equal(close?.quantity, 75);
    assert.equal(close?.averagePrice, 70, 'not the blended day average of 95');
  });

  it('should ignore a position in the same contract held under another product', async () => {
    const manual = { ...brokerRow(75, dayTotals(75, 7_500, 0, 0)), productType: 'MARGIN' };
    const close = await bracketCloseAfter(
      [manual],
      [manual, brokerRow(75, dayTotals(75, 7_575, 0, 0))],
      [manual, brokerRow(0, dayTotals(75, 7_575, 75, 12_150))],
    );
    assert.equal(close?.averagePrice, 162, 'the INTRADAY row is read, and its bracket close is seen');
  });

  it('should book a close with no visible sell at the stop price, not as a total loss', async () => {
    const close = await bracketCloseAfter([], [brokerRow(75)], [brokerRow(0)]);
    assert.equal(close?.averagePrice, 70.05);
    assert.equal(close?.quantity, 75);
  });

  it('should still enter when the positions read before the entry fails', async () => {
    const broker = fakeBroker({ positionsError: new Error('read timeout') });
    const { live } = port(broker);
    await live.submitEntry(entry());
    assert.equal(broker.calls.superPlace.length, 1);
    await live.close();
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
    setPositions(broker, [brokerRow(0, dayTotals(75, 7575, 75, 12_150))]);
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
    setPositions(broker, [brokerRow(75, dayTotals(75, 7_590, 0, 0))]);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    const fills = events.filter((event) => event.kind === 'ENTRY_FILLED');
    assert.equal(fills.length, 1);
    assert.equal(fills[0]?.kind === 'ENTRY_FILLED' && fills[0].averagePrice, 101.2);
    assert.equal(events[0]?.kind, 'ENTRY_UNCONFIRMED');
    await live.close();
  });
});
