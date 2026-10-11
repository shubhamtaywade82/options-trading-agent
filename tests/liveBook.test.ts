import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LiveBook, LiveStateStore, type LiveManagerMode, type LiveOpenOrder, type LiveOrderPort, type LivePositionRaw } from '../src/binance/liveBook.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { PositionDriver } from '../src/position/PositionDriver.js';
import { DEFAULT_PM_CONFIG, pmKey } from '../src/position/PositionManager.js';
import { PositionManagerStore } from '../src/position/PositionManagerStore.js';

setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 });

const NOW = Date.UTC(2026, 9, 5, 9);
const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'live-book-')), 'live-state.json');

/** A scripted exchange: records every call in order, and any step can be made to fail. */
class FakeExchange implements LiveOrderPort {
  calls: string[] = [];
  positions: LivePositionRaw[] = [];
  orders: LiveOpenOrder[] = [];
  nextId = 100;
  failPlace = 0;            // number of upcoming placeConditional calls that throw
  failCancel = false;
  failReduce = false;
  reduceFill: number | null = null; // executed quantity override (null = full)
  reduceStatus = 'FILLED';
  openOrdersFails = false;
  latencyMs = 0;

  private async pause(): Promise<void> { if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs)); }
  async fetchPositions() { this.calls.push('positions'); await this.pause(); return this.positions.map((p) => ({ ...p })); }
  async openOrders(symbol: string) {
    this.calls.push(`openOrders ${symbol}`); await this.pause();
    if (this.openOrdersFails) throw new Error('rate limited');
    return this.orders.map((o) => ({ ...o }));
  }
  async placeConditional(o: { symbol: string; side: 'BUY' | 'SELL'; type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'; stopPrice: number }) {
    this.calls.push(`place ${o.type} ${o.side} ${o.stopPrice}`); await this.pause();
    if (this.failPlace > 0) { this.failPlace -= 1; throw new Error('Order would immediately trigger'); }
    const orderId = this.nextId++;
    this.orders.push({ orderId, type: o.type, side: o.side, stopPrice: o.stopPrice, closePosition: true });
    return { orderId };
  }
  async cancel(_symbol: string, orderId: number) {
    this.calls.push(`cancel ${orderId}`); await this.pause();
    if (this.failCancel) throw new Error('Unknown order sent');
    this.orders = this.orders.filter((o) => o.orderId !== orderId);
  }
  async marketReduce(o: { symbol: string; side: 'BUY' | 'SELL'; quantity: number; clientOrderId: string }) {
    this.calls.push(`reduce ${o.side} ${o.quantity}`); await this.pause();
    if (this.failReduce) throw new Error('Margin is insufficient');
    return { status: this.reduceStatus, executedQty: this.reduceFill ?? o.quantity };
  }
}

const longPosition = (over: Partial<LivePositionRaw> = {}): LivePositionRaw =>
  ({ symbol: 'BTCUSDT', positionAmt: 1, entryPrice: 100, markPrice: 100, unrealizedProfit: 0, liquidationPrice: 80, leverage: 5, isolated: true, ...over });

function setup(mode: LiveManagerMode = 'on', file = tmp()) {
  const exchange = new FakeExchange();
  const logs: Array<[string, string]> = [];
  const book = new LiveBook(exchange, new LiveStateStore(file), { mode, log: (m, l) => logs.push([l, m]), now: () => NOW, placeAttempts: 3 });
  const text = () => logs.map(([, m]) => m).join('\n');
  return { exchange, book, logs, text, file };
}

/** A long BTC position bought at 100 with a stop at 95 (1R = 5) and a target at 130, protection orders 1 (stop) and 2 (target). */
async function openLong(ctx: ReturnType<typeof setup>) {
  ctx.exchange.positions = [longPosition()];
  ctx.exchange.orders = [
    { orderId: 1, type: 'STOP_MARKET', side: 'SELL', stopPrice: 95, closePosition: true },
    { orderId: 2, type: 'TAKE_PROFIT_MARKET', side: 'SELL', stopPrice: 130, closePosition: true },
  ];
  ctx.book.recordEntry({ symbol: 'BTCUSDT', side: 'LONG', strategy: 'STRUCTURE-TREND-η', stopLoss: 95, takeProfit: 130, stopOrderId: 1, tpOrderId: 2, decisionId: 'd1' });
  await ctx.book.refresh();
  ctx.exchange.calls.length = 0;
}

// ---- reconciliation ----

test('should expose a recorded entry as a managed position with the exchange entry, quantity and mark', async () => {
  const ctx = setup();
  await openLong(ctx);
  const [pos] = ctx.book.positions({ BTCUSDT: 103 });
  assert.deepEqual(
    [pos!.symbol, pos!.side, pos!.strategy, pos!.entry, pos!.qty, pos!.mark, pos!.serverSl, pos!.serverTp, pos!.initialRisk, pos!.decisionId, pos!.marginType],
    ['BTCUSDT', 'LONG', 'STRUCTURE-TREND-η', 100, 1, 103, '95', '130', 5, 'd1', 'ISOLATED'],
  );
  assert.equal(pos!.upnl, 3);
});

test('should not manage a position it has no recorded entry for, and say so once', async () => {
  const ctx = setup();
  ctx.exchange.positions = [longPosition()];
  await ctx.book.refresh();
  await ctx.book.refresh();
  assert.deepEqual(ctx.book.positions(), []);
  assert.equal(ctx.logs.filter(([, m]) => /no recorded entry/.test(m)).length, 1);
});

test('should forget the entry when the position is gone or has flipped sides', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.positions = [];
  await ctx.book.refresh();
  assert.deepEqual(ctx.book.positions(), []);
  await openLong(ctx);
  ctx.exchange.positions = [longPosition({ positionAmt: -1 })];
  await ctx.book.refresh();
  assert.deepEqual(ctx.book.positions(), []);
});

test('should keep a same-side add on the original 1R and opening time', async () => {
  const ctx = setup();
  await openLong(ctx);
  // The add's entry flow replaces the protective orders on the exchange, then records them
  ctx.exchange.orders = [
    { orderId: 5, type: 'STOP_MARKET', side: 'SELL', stopPrice: 96, closePosition: true },
    { orderId: 6, type: 'TAKE_PROFIT_MARKET', side: 'SELL', stopPrice: 125, closePosition: true },
  ];
  ctx.book.recordEntry({ symbol: 'BTCUSDT', side: 'LONG', strategy: 'STRUCTURE-TREND-η', stopLoss: 96, takeProfit: 125, stopOrderId: 5, tpOrderId: 6 });
  ctx.exchange.positions = [longPosition({ positionAmt: 2, entryPrice: 101 })];
  await ctx.book.refresh();
  const [pos] = ctx.book.positions();
  assert.deepEqual([pos!.initialRisk, pos!.serverSl, pos!.qty], [5, '96', 2]);
});

test('should survive a restart: the recorded entry is reloaded from disk', async () => {
  const file = tmp();
  const first = setup('on', file);
  await openLong(first);
  const second = setup('on', file);
  second.exchange.positions = [longPosition()];
  await second.book.refresh();
  assert.equal(second.book.positions().length, 1);
});

test('should start empty from a corrupt state file instead of crashing', () => {
  const file = tmp();
  writeFileSync(file, '{ not json');
  assert.deepEqual(new LiveStateStore(file).symbols(), []);
  writeFileSync(file, JSON.stringify({ version: 1, positions: { BTCUSDT: { symbol: 'BTCUSDT', side: 'SIDEWAYS' } } }));
  assert.deepEqual(new LiveStateStore(file).symbols(), []);
});

// ---- partial reduce ----

test('should send a reduce-only market order on the exit side and report what executed', async () => {
  const ctx = setup();
  await openLong(ctx);
  const [pos] = ctx.book.positions();
  const result = await ctx.book.venue().reducePosition(pos!, 0.35);
  assert.deepEqual(ctx.exchange.calls, ['reduce SELL 0.35']);
  assert.deepEqual(result, { executedQty: 0.35 });
});

test('should report a partial fill honestly, and refuse a reduce that executed nothing', async () => {
  const ctx = setup();
  await openLong(ctx);
  const [pos] = ctx.book.positions();
  ctx.exchange.reduceFill = 0.1;
  assert.deepEqual(await ctx.book.venue().reducePosition(pos!, 0.35), { executedQty: 0.1 });
  assert.match(ctx.text(), /filled 0\.1 of 0\.35/);
  ctx.exchange.reduceFill = 0;
  ctx.exchange.reduceStatus = 'EXPIRED';
  await assert.rejects(ctx.book.venue().reducePosition(pos!, 0.35), /executed nothing \(status EXPIRED\)/);
});

test('should refuse to reduce the whole position or a quantity that rounds to zero', async () => {
  const ctx = setup();
  await openLong(ctx);
  const [pos] = ctx.book.positions();
  await assert.rejects(ctx.book.venue().reducePosition(pos!, 1), /refusing partial/);
  await assert.rejects(ctx.book.venue().reducePosition(pos!, 0.0004), /refusing partial/);
  assert.deepEqual(ctx.exchange.calls, []);
});

test('should surface an exchange rejection of the reduce', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.failReduce = true;
  await assert.rejects(ctx.book.venue().reducePosition(ctx.book.positions()[0]!, 0.35), /Margin is insufficient/);
});

// ---- stop replacement ----

test('should cancel the old stop by id, then place the new one, and record it', async () => {
  const ctx = setup();
  await openLong(ctx);
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1, 130, 'LONG');
  assert.deepEqual(ctx.exchange.calls, ['cancel 1', 'place STOP_MARKET SELL 100.1']);
  const [pos] = ctx.book.positions();
  assert.equal(pos!.serverSl, '100.1');
  assert.deepEqual(ctx.exchange.orders.filter((o) => o.type === 'STOP_MARKET').map((o) => o.stopPrice), [100.1]);
});

test('should abort and leave the old stop alone when it cannot be cancelled', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.failCancel = true;
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1, 130, 'LONG');
  assert.deepEqual(ctx.exchange.calls, ['cancel 1']); // never placed anything
  assert.equal(ctx.book.positions()[0]!.serverSl, '95');
  assert.match(ctx.text(), /could not cancel the old BTCUSDT stop/);
});

test('should restore the previous stop when the new one cannot be placed', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.failPlace = 3; // all three attempts at the new stop fail; the restore then succeeds
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1, 130, 'LONG');
  assert.deepEqual(ctx.exchange.calls, ['cancel 1', 'place STOP_MARKET SELL 100.1', 'place STOP_MARKET SELL 100.1', 'place STOP_MARKET SELL 100.1', 'place STOP_MARKET SELL 95']);
  assert.equal(ctx.book.positions()[0]!.serverSl, '95');
  assert.equal(ctx.exchange.orders.filter((o) => o.type === 'STOP_MARKET').length, 1);
  assert.match(ctx.text(), /previous stop at 95 was restored/);
});

test('should close the position at market as the last resort when neither stop can be placed', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.failPlace = 99;
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1, 130, 'LONG');
  assert.equal(ctx.exchange.calls.at(-1), 'reduce SELL 1');
  assert.match(ctx.text(), /EMERGENCY CLOSE BTCUSDT/);
});

test('should never loosen a stop: a request below the current one sends nothing', async () => {
  const ctx = setup();
  await openLong(ctx);
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 94, 130, 'LONG');
  assert.deepEqual(ctx.exchange.calls, []);
});

test('should round the new stop to the tick', async () => {
  const ctx = setup();
  await openLong(ctx);
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1234, 130, 'LONG');
  assert.equal(ctx.exchange.calls[1], 'place STOP_MARKET SELL 100.12');
});

test('should drop the fixed target by cancelling its order when the manager hands over to the trail', async () => {
  const ctx = setup();
  await openLong(ctx);
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 110, null, 'LONG');
  assert.deepEqual(ctx.exchange.calls, ['cancel 1', 'place STOP_MARKET SELL 110', 'cancel 2']);
  assert.equal(ctx.book.positions()[0]!.serverTp, 'trail');
});

test('should keep a target it cannot cancel rather than pretend it is gone', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.failCancel = false;
  const cancel = ctx.exchange.cancel.bind(ctx.exchange);
  ctx.exchange.cancel = async (symbol, id) => { if (id === 2) { ctx.exchange.calls.push('cancel 2'); throw new Error('boom'); } return cancel(symbol, id); };
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 110, null, 'LONG');
  assert.equal(ctx.book.positions()[0]!.serverTp, '130');
});

test('should serialise a refresh behind a stop replacement on the same symbol, never interleaving with it', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.latencyMs = 5;
  const replacing = ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1, 130, 'LONG');
  const refreshing = ctx.book.refresh();
  await Promise.all([replacing, refreshing]);
  const placed = ctx.exchange.calls.indexOf('place STOP_MARKET SELL 100.1');
  const audited = ctx.exchange.calls.indexOf('openOrders BTCUSDT');
  assert.ok(placed >= 0 && audited >= 0);
  // The audit read the book before the replacement began, but its stop check ran only after it finished: no false "missing stop"
  assert.doesNotMatch(ctx.text(), /NO stop order/);
});

// ---- protection audit ----

test('should re-place a missing stop from the recorded level', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.orders = ctx.exchange.orders.filter((o) => o.type !== 'STOP_MARKET'); // cancelled by hand
  await ctx.book.refresh();
  assert.ok(ctx.exchange.calls.includes('place STOP_MARKET SELL 95'));
  assert.match(ctx.text(), /NO stop order on the exchange/);
  assert.equal(ctx.exchange.orders.filter((o) => o.type === 'STOP_MARKET').length, 1);
});

test('should close the position when a missing stop cannot be re-placed', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.orders = [];
  ctx.exchange.failPlace = 99;
  await ctx.book.refresh();
  assert.equal(ctx.exchange.calls.at(-1), 'reduce SELL 1');
});

test('should adopt a stop the operator replaced by hand, so the ratchet follows the exchange', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.orders = [{ orderId: 9, type: 'STOP_MARKET', side: 'SELL', stopPrice: 97, closePosition: true }];
  await ctx.book.refresh();
  assert.equal(ctx.book.positions()[0]!.serverSl, '97');
  assert.ok(!ctx.exchange.calls.some((c) => c.startsWith('place')));
});

test('should skip the audit, not guess, when open orders cannot be read', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.openOrdersFails = true;
  await ctx.book.refresh();
  assert.ok(!ctx.exchange.calls.some((c) => c.startsWith('place') || c.startsWith('reduce')));
  assert.match(ctx.text(), /stop audit skipped/);
});

// ---- shadow mode ----

test('should send nothing in shadow mode, only keep an overlay of what it would have done', async () => {
  const ctx = setup('shadow');
  await openLong(ctx);
  const venue = ctx.book.venue();
  await venue.reducePosition(ctx.book.positions()[0]!, 0.35);
  await venue.updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1, null, 'LONG');
  assert.deepEqual(ctx.exchange.calls, []);
  const [pos] = ctx.book.positions();
  assert.deepEqual([pos!.qty, pos!.serverSl, pos!.serverTp], [0.65, '100.1', 'trail']);
  assert.match(ctx.text(), /SHADOW would reduce BTCUSDT LONG by 0\.35/);
  assert.match(ctx.text(), /SHADOW would move BTCUSDT stop 95 -> 100\.1 and drop the target/);
});

test('should not audit protection in shadow mode, and should clear the overlay when the position closes', async () => {
  const ctx = setup('shadow');
  await openLong(ctx);
  await ctx.book.venue().reducePosition(ctx.book.positions()[0]!, 0.35);
  await ctx.book.refresh();
  assert.ok(!ctx.exchange.calls.some((c) => c.startsWith('openOrders')));
  ctx.exchange.positions = [];
  await ctx.book.refresh();
  assert.deepEqual(ctx.book.positions(), []);
  await openLong(ctx);
  assert.equal(ctx.book.positions()[0]!.qty, 1); // a new position starts without the old overlay
});

// ---- end to end with the driver ----

function driverFor(ctx: ReturnType<typeof setup>) {
  const store = new PositionManagerStore('live', path.join(mkdtempSync(path.join(tmpdir(), 'pm-live-')), 'pm.json'));
  const driverLogs: string[] = [];
  const driver = new PositionDriver({
    venue: ctx.book.venue(), store, cfg: { ...DEFAULT_PM_CONFIG, costBufferRate: 0.001 },
    lotOf: () => ({ step: 0.001, minQty: 0.001, minNotional: 5 }), log: (_a, m) => driverLogs.push(m), now: () => NOW,
  });
  driver.setFeatures('BTCUSDT', { atr: 2, vol: 'MEDIUM' });
  return { driver, store, driverLogs };
}

test('should take TP1 on the exchange and move the stop to breakeven plus costs, in order', async () => {
  const ctx = setup();
  await openLong(ctx);
  const { driver } = driverFor(ctx);
  await driver.manage(ctx.book.positions({ BTCUSDT: 105 }));
  assert.deepEqual(ctx.exchange.calls, ['reduce SELL 0.35', 'cancel 1', 'place STOP_MARKET SELL 100.1']);
});

test('should count only what a partial fill executed, so the state matches the position the exchange reports', async () => {
  const ctx = setup();
  await openLong(ctx);
  const { driver, store, driverLogs } = driverFor(ctx);
  ctx.exchange.reduceFill = 0.1;
  await driver.manage(ctx.book.positions({ BTCUSDT: 105 }));
  assert.equal(store.get(pmKey('BTCUSDT', 'STRUCTURE-TREND-η'))?.reducedQty, 0.1);
  assert.match(driverLogs.join('\n'), /reduced 0\.1 of 0\.35 .*partially filled/);
});

test('should retry the stop move on the next tick when the exchange refused it, without re-taking the partial', async () => {
  const ctx = setup();
  await openLong(ctx);
  const { driver } = driverFor(ctx);
  ctx.exchange.failCancel = true;
  await driver.manage(ctx.book.positions({ BTCUSDT: 105 }));
  assert.equal(ctx.book.positions()[0]!.serverSl, '95'); // unchanged on the exchange
  ctx.exchange.failCancel = false;
  ctx.exchange.positions = [longPosition({ positionAmt: 0.65 })]; // the partial did execute
  await ctx.book.refresh();
  ctx.exchange.calls.length = 0;
  await driver.manage(ctx.book.positions({ BTCUSDT: 105 }));
  assert.deepEqual(ctx.exchange.calls, ['cancel 1', 'place STOP_MARKET SELL 100.1']);
});

// ---- races found in review ----

test('should not mistake a stop mid-replacement for a missing stop when a refresh lands between the cancel and the place', async () => {
  const ctx = setup();
  await openLong(ctx);
  let refreshing: Promise<void> | undefined;
  const place = ctx.exchange.placeConditional.bind(ctx.exchange);
  // The old stop is already cancelled when the new one starts to be placed: exactly when a naive audit would see "no stop"
  ctx.exchange.placeConditional = async (order) => {
    refreshing ??= ctx.book.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return place(order);
  };
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1, 130, 'LONG');
  await refreshing;
  assert.doesNotMatch(ctx.text(), /NO stop order/);
  assert.equal(ctx.exchange.calls.filter((c) => c.startsWith('place STOP_MARKET')).length, 1); // no duplicate stop
  assert.ok(!ctx.exchange.calls.some((c) => c.startsWith('reduce')));
  assert.equal(ctx.book.positions()[0]!.serverSl, '100.1');
});

test('should size an emergency close from the exchange, not from a quantity that a partial has since reduced', async () => {
  const ctx = setup();
  await openLong(ctx);
  await ctx.book.venue().reducePosition(ctx.book.positions()[0]!, 0.35);
  ctx.exchange.positions = [longPosition({ positionAmt: 0.65 })]; // what the exchange now holds; the book's last refresh still says 1
  ctx.exchange.failPlace = 99;
  ctx.exchange.calls.length = 0;
  await ctx.book.venue().updateStops('BTCUSDT', 'STRUCTURE-TREND-η', 100.1, 130, 'LONG');
  assert.equal(ctx.exchange.calls.at(-1), 'reduce SELL 0.65');
});

test('should not emergency-close, or re-place a stop, for a position that closed while its stop was being audited', async () => {
  const ctx = setup();
  await openLong(ctx);
  ctx.exchange.orders = []; // the stop is gone because it TRIGGERED...
  const fetch = ctx.exchange.fetchPositions.bind(ctx.exchange);
  let calls = 0;
  ctx.exchange.fetchPositions = async () => { calls += 1; if (calls >= 2) ctx.exchange.positions = []; return fetch(); }; // ...and the position is flat by the time it is re-read
  ctx.exchange.failPlace = 99;
  await ctx.book.refresh();
  assert.ok(!ctx.exchange.calls.some((c) => c.startsWith('reduce') || c.startsWith('place')));
  assert.deepEqual(ctx.book.positions(), []);
});
