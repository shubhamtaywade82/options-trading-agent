import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { closedTrade, liquidationMarkSince, RemoteStore, type PositionMeta } from '../src/binance/remoteState.js';
import type { TradeRecord } from '../src/types.js';

const meta: PositionMeta = {
  owner: 'MOMENTUM-γ', stopLoss: 90, takeProfit: 130, initialRisk: 10, openedAt: 1_000,
  lastSeen: { side: 'LONG', entry: 100, qty: 1, mark: 104 },
};

function trade(closedAt: number): TradeRecord {
  return { symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 110, qty: 1, pnl: 10, reason: 'TAKE PROFIT', closedAt };
}

function tempFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'remote-state-')), 'remote-state.json');
}

test('should round-trip metas and trades across a new instance on the same file', () => {
  const file = tempFile();
  const store = new RemoteStore(file, 'acct');
  store.setMeta('BTCUSDT', meta);
  store.setMeta('ETHUSDT', { ...meta, external: true });
  store.deleteMeta('ETHUSDT');
  store.recordClose({ ...trade(1), symbol: 'SOLUSDT' });

  const reloaded = new RemoteStore(file, 'acct');
  assert.deepEqual(reloaded.getMeta('BTCUSDT'), meta);
  assert.equal(reloaded.getMeta('ETHUSDT'), undefined);
  assert.deepEqual(Object.keys(reloaded.metas()), ['BTCUSDT']);
  assert.deepEqual(reloaded.trades(), [{ ...trade(1), symbol: 'SOLUSDT' }]);
});

test('should leave no temp file behind after a write', () => {
  const file = tempFile();
  new RemoteStore(file, 'acct').setMeta('BTCUSDT', meta);
  assert.deepEqual(readdirSync(path.dirname(file)), ['remote-state.json']);
});

test('should start empty when the file is corrupt JSON', () => {
  const file = tempFile();
  writeFileSync(file, '{not json');
  const store = new RemoteStore(file, 'acct');
  assert.deepEqual(store.metas(), {});
  assert.deepEqual(store.trades(), []);
});

test('should start empty when the file has an invalid shape', () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ version: 1, accountId: 'acct', positions: [], closedTrades: 'x' }));
  assert.deepEqual(new RemoteStore(file, 'acct').metas(), {});
});

test('should start empty when the file belongs to a different account', () => {
  const file = tempFile();
  new RemoteStore(file, 'acct-a').setMeta('BTCUSDT', meta);
  const other = new RemoteStore(file, 'acct-b');
  assert.deepEqual(other.metas(), {});
  assert.deepEqual(other.trades(), []);
});

test('should drop the oldest trade when the 1001st is added', () => {
  const file = tempFile();
  const store = new RemoteStore(file, 'acct');
  for (let i = 1; i <= 1001; i++) store.recordClose(trade(i));
  assert.equal(store.trades().length, 1000);
  assert.equal(store.trades()[0].closedAt, 2);
  assert.equal(new RemoteStore(file, 'acct').trades().at(-1)?.closedAt, 1001);
});

test('should journal the trade and delete the meta in one persisted step', () => {
  const file = tempFile();
  const store = new RemoteStore(file, 'acct');
  store.setMeta('BTCUSDT', meta);
  store.setMeta('ETHUSDT', meta);

  store.recordClose(trade(5));

  const reloaded = new RemoteStore(file, 'acct');
  assert.deepEqual(reloaded.trades(), [trade(5)]);
  assert.deepEqual(Object.keys(reloaded.metas()), ['ETHUSDT']);
});

test('should compute gross pnl by direction when building a closed trade', () => {
  const closed = { symbol: 'BTCUSDT', owner: 'MOMENTUM-γ' as const, entry: 100, qty: 2 };
  assert.equal(closedTrade({ ...closed, side: 'LONG' }, 110, 'TAKE PROFIT', 7).pnl, 20);
  assert.equal(closedTrade({ ...closed, side: 'SHORT' }, 110, 'STOP LOSS', 7).pnl, -20);
  assert.deepEqual(closedTrade({ ...closed, side: 'LONG' }, 110, 'CLOSE', 7), { ...trade(7), qty: 2, pnl: 20, reason: 'CLOSE' });
});

test('should carry the initial risk into the closed trade only when it is known', () => {
  const closed = { symbol: 'BTCUSDT', owner: 'MOMENTUM-γ' as const, side: 'LONG' as const, entry: 100, qty: 2 };
  assert.equal(closedTrade({ ...closed, initialRisk: 10 }, 110, 'CLOSE', 7).initialRisk, 10);
  assert.equal('initialRisk' in closedTrade(closed, 110, 'CLOSE', 7), false);
});

test('should keep initialRisk on a journaled trade across a reload', () => {
  const file = tempFile();
  new RemoteStore(file, 'acct').recordClose({ ...trade(3), initialRisk: 10 });
  assert.equal(new RemoteStore(file, 'acct').trades()[0].initialRisk, 10);
});

test('should queue a notice naming both account ids before a sidecar of another account is overwritten', (t) => {
  const file = tempFile();
  new RemoteStore(file, 'acct-a').setMeta('BTCUSDT', meta);
  const warn = t.mock.method(console, 'warn', () => undefined);

  const notices = new RemoteStore(file, 'acct-b').drainNotices();

  assert.equal(notices.length, 1);
  assert.match(notices[0], /acct-a.*acct-b/);
  assert.equal(warn.mock.calls.length, 0);
});

test('should drop malformed metas and trades from a hand-edited file, keep the valid ones and queue a notice', (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const file = tempFile();
  writeFileSync(file, JSON.stringify({
    version: 1,
    accountId: 'acct',
    positions: {
      BTCUSDT: meta,
      ETHUSDT: { ...meta, owner: 5 },
      SOLUSDT: { ...meta, stopLoss: 'high' },
      XRPUSDT: { ...meta, openedAt: 'yesterday' },
      ADAUSDT: { ...meta, lastSeen: { side: 'UP', entry: 1, qty: 1, mark: 1 } },
      DOGEUSDT: null,
    },
    closedTrades: [trade(1), { ...trade(2), pnl: 'lots' }, { symbol: 'BTCUSDT' }, null],
  }));

  const store = new RemoteStore(file, 'acct');

  assert.deepEqual(Object.keys(store.metas()), ['BTCUSDT']);
  assert.deepEqual(store.trades(), [trade(1)]);
  assert.deepEqual(store.drainNotices(), ['sidecar: dropped 8 malformed entries']);
  assert.deepEqual(store.drainNotices(), []);
  assert.equal(warn.mock.calls.length, 0);
});

test('should count a liquidation stamped within the clock-skew tolerance before the position opened', () => {
  const openedAt = 1_800_000_000_000;
  const event = (offsetMs: number) => [{
    id: 1, eventType: 'POSITION_LIQUIDATED', details: { symbol: 'BTCUSDT', mark_price: '50000' }, createdAt: new Date(openedAt + offsetMs).toISOString(),
  }];

  assert.deepEqual(liquidationMarkSince(event(-4_000), 'BTCUSDT', openedAt), { mark: 50_000 });
  assert.equal(liquidationMarkSince(event(-6_000), 'BTCUSDT', openedAt), null);
});
