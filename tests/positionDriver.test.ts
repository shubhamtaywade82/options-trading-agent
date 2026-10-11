import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OrderInFlightError } from '../src/binance/remoteOrders.js';
import { PositionDriver, type PositionVenue } from '../src/position/PositionDriver.js';
import { DEFAULT_PM_CONFIG, pmKey, type PmConfig } from '../src/position/PositionManager.js';
import { PositionManagerStore } from '../src/position/PositionManagerStore.js';
import type { Position } from '../src/types.js';

const cfg: PmConfig = { ...DEFAULT_PM_CONFIG, costBufferRate: 0.001 };
const lot = { step: 0.001, minQty: 0.001, minNotional: 5 };

function pos(over: Partial<Position> = {}): Position {
  return {
    id: 'x', symbol: 'BTCUSDT', side: 'LONG', strategy: 'STRUCTURE-TREND-η', entry: 100, qty: 1, mark: 100, upnl: 0, upnlPct: 0,
    leverage: 5, marginType: 'ISOLATED', liqDistancePct: null, serverSl: '95', serverTp: '120', initialRisk: 5, ...over,
  };
}

function setup(failReduceWith?: Error) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-driver-'));
  const file = path.join(dir, 'pm.json');
  const store = new PositionManagerStore('paper', file);
  const calls: string[] = [];
  const venue: PositionVenue = {
    async reducePosition(p, qty) { if (failReduceWith) throw failReduceWith; calls.push(`reduce ${p.symbol} ${qty}`); },
    updateStops(symbol, _s, stop, target) { calls.push(`stops ${symbol} ${stop} ${target}`); },
  };
  const logs: string[] = [];
  const driver = new PositionDriver({ venue, store, cfg, lotOf: () => lot, log: (_a, m) => logs.push(m), now: () => 1_000 });
  driver.setFeatures('BTCUSDT', { atr: 2, vol: 'MEDIUM' });
  return { driver, store, calls, logs, file };
}

test('should reduce and move the stop to breakeven plus costs at 1R, in that order', async () => {
  const { driver, calls } = setup();
  await driver.manage([pos({ mark: 105 })]);
  assert.deepEqual(calls, ['reduce BTCUSDT 0.35', 'stops BTCUSDT 100.1 120']);
});

test('should not repeat the partial or the stop move on an unchanged tick', async () => {
  const { driver, calls } = setup();
  await driver.manage([pos({ mark: 105 })]);
  calls.length = 0;
  await driver.manage([pos({ mark: 105, qty: 0.65, serverSl: '100.1' })]);
  assert.deepEqual(calls, []);
});

test('should retry a partial that the venue refused, and say so', async () => {
  const { driver, store, calls, logs } = setup(new OrderInFlightError('busy'));
  await driver.manage([pos({ mark: 105 })]);
  assert.ok(!calls.some((c) => c.startsWith('reduce')));
  assert.match(logs.join('\n'), /PM TP1 BTCUSDT not sent/);
  assert.equal(store.get(pmKey('BTCUSDT', 'STRUCTURE-TREND-η'))?.tp1Done, false);
});

test('should take the venue stop as the truth and re-send a stop the venue did not apply', async () => {
  const { driver, calls } = setup();
  await driver.manage([pos({ mark: 105 })]);
  calls.length = 0;
  // the venue still shows the old stop (the update was ignored): the manager must try again
  await driver.manage([pos({ mark: 105, qty: 0.65, serverSl: '95' })]);
  assert.deepEqual(calls, ['stops BTCUSDT 100.1 120']);
});

test('should not manage positions without a numeric stop and should forget closed ones', async () => {
  const { driver, store, calls } = setup();
  await driver.manage([pos({ serverSl: 'server', mark: 110 })]);
  assert.deepEqual(calls, []);
  await driver.manage([pos({ mark: 105 })]);
  assert.ok(store.get(pmKey('BTCUSDT', 'STRUCTURE-TREND-η')));
  await driver.manage([]);
  assert.equal(store.get(pmKey('BTCUSDT', 'STRUCTURE-TREND-η')), undefined);
});

test('should rebuild its state when the position was scaled into outside the manager', async () => {
  const { driver, store, logs } = setup();
  await driver.manage([pos({ mark: 105 })]);
  await driver.manage([pos({ mark: 105, qty: 2, serverSl: '100.1' })]);
  assert.match(logs.join('\n'), /position changed outside the manager/);
  assert.equal(store.get(pmKey('BTCUSDT', 'STRUCTURE-TREND-η'))?.initialQty, 2);
});

test('should persist state atomically and reload it', async () => {
  const { driver, file } = setup();
  await driver.manage([pos({ mark: 105 })]);
  const reloaded = new PositionManagerStore('paper', file);
  const state = reloaded.get(pmKey('BTCUSDT', 'STRUCTURE-TREND-η'));
  assert.deepEqual([state?.tp1Done, state?.reducedQty, state?.phase], [true, 0.35, 'PROTECTED']);
  assert.equal(new PositionManagerStore('live', file).get(pmKey('BTCUSDT', 'STRUCTURE-TREND-η')), undefined); // paper and live are different books
});

test('should survive a corrupt state file by starting empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-corrupt-'));
  const file = path.join(dir, 'pm.json');
  new PositionManagerStore('paper', file).flush();
  assert.equal(new PositionManagerStore('paper', path.join(dir, 'missing.json')).keys().length, 0);
});

test('should only apply the SuperTrend line to positions of the strategy that owns it', async () => {
  const { driver, calls } = setup();
  driver.setFeatures('BTCUSDT', { atr: 2, vol: 'MEDIUM', superTrend: { agent: 'ADAPTIVE-ST-ζ', level: 104.5 } });
  await driver.manage([pos({ mark: 105 })]);
  assert.ok(!calls.some((c) => c.includes('104.5')));
});
