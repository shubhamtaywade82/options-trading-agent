import type { StreamEvent } from './MinuteAggregator.js';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN);
const levels = (v: unknown): [number, number][] =>
  Array.isArray(v) ? v.filter(Array.isArray).map((l) => [num((l as unknown[])[0]), num((l as unknown[])[1])] as [number, number]) : [];

/**
 * Parses one message from a combined USD-M futures stream (`{stream, data}`) or a bare event. Unknown or malformed
 * messages return null; the recorder counts them so a format change shows up as a zero, not as silent corruption.
 */
export function parseStreamMessage(raw: unknown): StreamEvent | null {
  const msg = isObj(raw) && isObj(raw.data) ? raw.data : raw;
  if (!isObj(msg) || typeof msg.e !== 'string') return null;
  const symbol = typeof msg.s === 'string' ? msg.s : undefined;
  switch (msg.e) {
    case 'aggTrade':
      if (!symbol) return null;
      return { kind: 'trade', symbol, time: num(msg.T), price: num(msg.p), qty: num(msg.q), buyerIsMaker: msg.m === true };
    case 'forceOrder': {
      const o = msg.o;
      if (!isObj(o) || typeof o.s !== 'string' || (o.S !== 'BUY' && o.S !== 'SELL')) return null;
      // Prefer the average fill price and filled quantity when present
      const qty = Number.isFinite(num(o.z)) && num(o.z) > 0 ? num(o.z) : num(o.q);
      const price = Number.isFinite(num(o.ap)) && num(o.ap) > 0 ? num(o.ap) : num(o.p);
      return { kind: 'liquidation', symbol: o.s, time: num(o.T ?? msg.E), side: o.S, qty, price };
    }
    case 'depthUpdate':
      if (!symbol) return null;
      return { kind: 'book', symbol, time: num(msg.T ?? msg.E), bids: levels(msg.b), asks: levels(msg.a) };
    case 'markPriceUpdate':
      if (!symbol) return null;
      return { kind: 'mark', symbol, time: num(msg.E), mark: num(msg.p), index: num(msg.i), funding: num(msg.r) };
    default:
      return null;
  }
}

/** `/fapi/v1/openInterest` response. */
export function parseOpenInterest(raw: unknown): StreamEvent | null {
  if (!isObj(raw) || typeof raw.symbol !== 'string') return null;
  const oi = num(raw.openInterest);
  const time = num(raw.time);
  return Number.isFinite(oi) && Number.isFinite(time) ? { kind: 'oi', symbol: raw.symbol, time, openInterest: oi } : null;
}

/** `/futures/data/takerlongshortRatio` response (latest row). */
export function parseTakerRatio(symbol: string, raw: unknown): StreamEvent | null {
  const row = Array.isArray(raw) ? raw[raw.length - 1] : undefined;
  if (!isObj(row)) return null;
  const ratio = num(row.buySellRatio);
  const time = num(row.timestamp);
  return Number.isFinite(ratio) && Number.isFinite(time) ? { kind: 'taker', symbol, time, ratio } : null;
}
