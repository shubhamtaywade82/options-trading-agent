import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { fetchArchiveKlines, parseKlineCsv, readFirstZipEntry, type FetchLike } from '../src/backtesting/archiveKlines.js';

const DAY = 86_400_000;
const T = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

/** Minimal single-entry zip, deflated or stored. */
function zip(text: string, method: 0 | 8 = 8): Buffer {
  const raw = Buffer.from(text);
  const body = method === 8 ? deflateRawSync(raw) : raw;
  const name = Buffer.from('k.csv');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const centralOffset = local.length + name.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, body, central, name, eocd]);
}

const HEADER = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n';
const row = (t: number, close: number) => `${t},${close - 1},${close + 1},${close - 2},${close},10,${t + 899_999},0,1,0,0,0\n`;
const csvFor = (day: number) => HEADER + row(day, 100) + row(day + 900_000, 101);

test('should read deflated and stored entries and reject non-zip data', () => {
  assert.equal(readFirstZipEntry(zip('hello,world\n', 8)), 'hello,world\n');
  assert.equal(readFirstZipEntry(zip('hello,world\n', 0)), 'hello,world\n');
  assert.throws(() => readFirstZipEntry(Buffer.from('not a zip at all, definitely')), /not a zip/);
});

test('should parse archive rows with or without a header and skip malformed lines', () => {
  const candles = parseKlineCsv(HEADER + '1000,1,2,0.5,1.5,9,1,0,1,0,0,0\nbroken,row\n\n2000,2,3,1,2.5,8,1,0,1,0,0,0\n');
  assert.deepEqual(candles, [
    { openTime: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 },
    { openTime: 2000, open: 2, high: 3, low: 1, close: 2.5, volume: 8 },
  ]);
  assert.equal(parseKlineCsv('1000,1,2,0.5,1.5,9\n').length, 1);
});

/** A fake archive: serves the given URL suffixes, 404 for everything else. */
function archive(files: Record<string, string>): { fetchImpl: FetchLike; requested: string[] } {
  const requested: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    requested.push(url.replace('https://data.binance.vision/data/futures/um/', ''));
    const text = files[requested[requested.length - 1]!];
    if (text === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = zip(text);
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
  };
  return { fetchImpl, requested };
}

test('should use the monthly file for a complete month and daily files for the partial month, in order', async () => {
  const now = T(2026, 10, 5, 12);
  const { fetchImpl, requested } = archive({
    'monthly/klines/BTCUSDT/15m/BTCUSDT-15m-2026-09.zip': csvFor(T(2026, 9, 1)) + row(T(2026, 9, 30), 102),
    'daily/klines/BTCUSDT/15m/BTCUSDT-15m-2026-10-01.zip': csvFor(T(2026, 10, 1)),
    'daily/klines/BTCUSDT/15m/BTCUSDT-15m-2026-10-02.zip': csvFor(T(2026, 10, 2)),
  });
  const { candles, missingDays } = await fetchArchiveKlines('BTCUSDT', '15m', T(2026, 9, 1), T(2026, 10, 3), fetchImpl, now);
  assert.deepEqual(candles.map((c) => c.openTime), [...candles.map((c) => c.openTime)].sort((a, b) => a - b));
  assert.equal(candles.length, 3 + 2 + 2); // Sep monthly + Oct 1 + Oct 2
  assert.deepEqual(missingDays, []);
  assert.equal(requested.filter((r) => r.startsWith('monthly')).length, 1);
  assert.equal(requested.filter((r) => r.startsWith('daily')).length, 2);
});

test('should clip to the requested window', async () => {
  const now = T(2026, 10, 5, 12);
  const { fetchImpl } = archive({ 'daily/klines/BTCUSDT/15m/BTCUSDT-15m-2026-10-02.zip': csvFor(T(2026, 10, 2)) });
  const { candles } = await fetchArchiveKlines('BTCUSDT', '15m', T(2026, 10, 2, 0, 10), T(2026, 10, 3), fetchImpl, now);
  assert.deepEqual(candles.map((c) => c.openTime), [T(2026, 10, 2, 0, 15)]); // the 00:00 candle opens before the window
});

test('should fall back to daily files when a complete month has no monthly file yet', async () => {
  const now = T(2026, 10, 2, 6);
  const files: Record<string, string> = {};
  for (let d = 1; d <= 30; d += 1) files[`daily/klines/ETHUSDT/1h/ETHUSDT-1h-2026-09-${String(d).padStart(2, '0')}.zip`] = csvFor(T(2026, 9, d));
  const { fetchImpl, requested } = archive(files);
  const { candles, missingDays } = await fetchArchiveKlines('ETHUSDT', '1h', T(2026, 9, 1), T(2026, 10, 1), fetchImpl, now);
  assert.equal(candles.length, 60);
  assert.deepEqual(missingDays, []);
  assert.ok(requested[0]!.startsWith('monthly')); // tried the monthly first
});

test('should never ask for today or the future and should report gaps instead of failing', async () => {
  const now = T(2026, 10, 5, 12);
  const { fetchImpl, requested } = archive({
    'daily/klines/BTCUSDT/4h/BTCUSDT-4h-2026-10-03.zip': csvFor(T(2026, 10, 3)),
  });
  const { candles, missingDays } = await fetchArchiveKlines('BTCUSDT', '4h', T(2026, 10, 3), T(2026, 10, 9), fetchImpl, now);
  assert.equal(candles.length, 2);
  assert.deepEqual(missingDays, ['2026-10-04']); // 10-05 is today (not published) and 10-06+ is the future
  assert.ok(!requested.some((r) => r.includes('2026-10-05') || r.includes('2026-10-06')));
});

test('should surface a server error instead of treating it as a gap', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(fetchArchiveKlines('BTCUSDT', '15m', T(2026, 10, 1), T(2026, 10, 2), fetchImpl, T(2026, 10, 5)), /HTTP 503/);
});
