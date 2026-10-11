import { inflateRawSync } from 'node:zlib';
import type { Candle } from '../types.js';

/**
 * Klines from Binance's public data archive (data.binance.vision), for environments where the REST API is geo-blocked.
 * Monthly files cover complete months; the current month (and any month whose monthly file is not published yet) is
 * assembled from daily files. Today's candles are never available, the archive lags by about a day.
 */
const BASE = 'https://data.binance.vision/data/futures/um';
const DAY_MS = 86_400_000;
const BATCH = 6;

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Text of the first entry of a zip. Handles stored and deflated entries, which is all the archive uses. */
export function readFirstZipEntry(zip: Buffer): string {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const central = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(central) !== CENTRAL_SIGNATURE) throw new Error('corrupt zip central directory');
  const method = zip.readUInt16LE(central + 10);
  const compressedSize = zip.readUInt32LE(central + 20);
  const localOffset = zip.readUInt32LE(central + 42);
  if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('corrupt zip local header');
  const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
  const body = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return body.toString('utf8');
  if (method === 8) return inflateRawSync(body).toString('utf8');
  throw new Error(`unsupported zip compression method ${method}`);
}

/** Archive CSV rows (with or without a header line) to candles; malformed rows are skipped. */
export function parseKlineCsv(text: string): Candle[] {
  const out: Candle[] = [];
  for (const line of text.split('\n')) {
    const cells = line.trim().split(',');
    if (cells.length < 6) continue;
    const [openTime, open, high, low, close, volume] = cells.slice(0, 6).map(Number);
    if ([openTime, open, high, low, close, volume].some((n) => !Number.isFinite(n))) continue; // the header row lands here
    out.push({ openTime: openTime!, open: open!, high: high!, low: low!, close: close!, volume: volume! });
  }
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const dayKey = (ms: number): string => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const monthKey = (ms: number): string => dayKey(ms).slice(0, 7);
const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
const startOfNextMonth = (ms: number): number => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

async function fetchZip(url: string, fetchImpl: FetchLike): Promise<Candle[] | null> {
  const response = await fetchImpl(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return parseKlineCsv(readFirstZipEntry(Buffer.from(await response.arrayBuffer())));
}

export interface ArchiveResult {
  candles: Candle[];
  /** Days the archive had no file for (not yet published, or a gap) inside the requested window. */
  missingDays: string[];
}

/** Candles with openTime in [fromMs, toMs), oldest first, de-duplicated. */
export async function fetchArchiveKlines(
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: number = Date.now(),
): Promise<ArchiveResult> {
  const lastDay = Math.min(startOfDay(toMs - 1), startOfDay(now) - DAY_MS); // the archive has nothing for today
  const byTime = new Map<number, Candle>();
  const missingDays: string[] = [];
  const add = (candles: Candle[]): void => { for (const c of candles) if (c.openTime >= fromMs && c.openTime < toMs) byTime.set(c.openTime, c); };

  const dailyTasks: number[] = [];
  for (let monthStart = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1); monthStart <= lastDay; monthStart = startOfNextMonth(monthStart)) {
    const nextMonth = startOfNextMonth(monthStart);
    const firstDay = Math.max(startOfDay(fromMs), monthStart);
    const lastDayOfMonth = Math.min(lastDay, nextMonth - DAY_MS);
    const wholeMonth = firstDay === monthStart && lastDayOfMonth === nextMonth - DAY_MS;
    const monthly = wholeMonth ? await fetchZip(`${BASE}/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${monthKey(monthStart)}.zip`, fetchImpl) : null;
    if (monthly) { add(monthly); continue; }
    for (let day = firstDay; day <= lastDayOfMonth; day += DAY_MS) dailyTasks.push(day);
  }
  for (let i = 0; i < dailyTasks.length; i += BATCH) {
    const batch = dailyTasks.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((day) => fetchZip(`${BASE}/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${dayKey(day)}.zip`, fetchImpl)));
    results.forEach((candles, index) => (candles ? add(candles) : missingDays.push(dayKey(batch[index]!))));
  }
  return { candles: [...byTime.values()].sort((a, b) => a.openTime - b.openTime), missingDays };
}
