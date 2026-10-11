import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MinuteAggregator, type StreamEvent } from '../src/marketdata/MinuteAggregator.js';
import { parseOpenInterest, parseStreamMessage, parseTakerRatio } from '../src/marketdata/parsers.js';

const T = Date.UTC(2026, 8, 30, 10, 0, 0); // a minute boundary
const S = 'BTCUSDT';
const trade = (dt: number, qty: number, price: number, buyerIsMaker: boolean, symbol = S): StreamEvent => ({ kind: 'trade', symbol, time: T + dt, price, qty, buyerIsMaker });

test('trades are split by aggressor side: buyerIsMaker means the aggressor sold', () => {
  const agg = new MinuteAggregator();
  agg.push(trade(1_000, 2, 100, false)); // aggressive buy
  agg.push(trade(2_000, 3, 100, true)); // aggressive sell
  const [rec] = agg.push(trade(61_000, 1, 100, false));
  assert.equal(rec.t, T);
  assert.deepEqual([rec.trades, rec.buyQty, rec.sellQty, rec.buyQuote, rec.sellQuote], [2, 2, 3, 200, 300]);
});

test('a minute is emitted only when the next one begins, and symbols are independent', () => {
  const agg = new MinuteAggregator();
  assert.equal(agg.push(trade(1_000, 1, 100, false)).length, 0);
  assert.equal(agg.push(trade(2_000, 1, 50, false, 'ETHUSDT')).length, 0);
  const out = agg.push(trade(65_000, 1, 100, false));
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, S);
  assert.equal(agg.flush(T + 61_000).map((r) => r.symbol).join(), 'ETHUSDT');
});

test('liquidations: a SELL order closes a long, a BUY order closes a short', () => {
  const agg = new MinuteAggregator();
  agg.push({ kind: 'liquidation', symbol: S, time: T + 1, side: 'SELL', qty: 5, price: 100 });
  agg.push({ kind: 'liquidation', symbol: S, time: T + 2, side: 'BUY', qty: 2, price: 100 });
  const [rec] = agg.flush(T + 120_000);
  assert.deepEqual([rec.liqLongQty, rec.liqShortQty, rec.liqCount], [5, 2, 2]);
});

test('book snapshots average into spread (bps) and imbalance over the top levels', () => {
  const agg = new MinuteAggregator();
  agg.push({ kind: 'book', symbol: S, time: T + 1, bids: [[99.9, 3], [99.8, 1]], asks: [[100.1, 1], [100.2, 1]] }); // imb (4-2)/6
  agg.push({ kind: 'book', symbol: S, time: T + 2, bids: [[99.9, 1]], asks: [[100.1, 3]] }); // imb -0.5
  const [rec] = agg.flush(T + 120_000);
  assert.equal(rec.bookSamples, 2);
  assert.ok(Math.abs(rec.spreadBps! - (0.2 / 100) * 10_000) < 1e-6);
  assert.ok(Math.abs(rec.bookImbalance! - ((2 / 6 + -0.5) / 2)) < 1e-9);
});

test('mark, funding, OI and taker ratio carry forward into quiet minutes', () => {
  const agg = new MinuteAggregator();
  agg.push({ kind: 'mark', symbol: S, time: T + 1, mark: 100, index: 99.9, funding: 0.0001 });
  agg.push({ kind: 'oi', symbol: S, time: T + 2, openInterest: 12345 });
  agg.push({ kind: 'taker', symbol: S, time: T + 3, ratio: 1.2 });
  agg.push(trade(130_000, 1, 100, false)); // two minutes later; nothing else updated
  const [second] = agg.flush(T + 400_000);
  assert.deepEqual([second.mark, second.index, second.funding, second.openInterest, second.takerRatio], [100, 99.9, 0.0001, 12345, 1.2]);
  assert.equal(second.trades, 1);
});

test('late events are counted, malformed ones rejected, neither corrupts a bucket', () => {
  const agg = new MinuteAggregator();
  agg.push(trade(70_000, 1, 100, false));
  agg.push(trade(10_000, 9, 100, false)); // belongs to a flushed-or-never-opened earlier minute
  agg.push({ kind: 'trade', symbol: S, time: T + 71_000, price: Number.NaN, qty: 1, buyerIsMaker: false });
  agg.push({ kind: 'book', symbol: S, time: T + 71_000, bids: [], asks: [] });
  assert.equal(agg.late, 1);
  assert.equal(agg.rejected, 2);
  const [rec] = agg.flush(T + 400_000);
  assert.equal(rec.buyQty, 1);
});

// Field names follow Binance's public USD-M futures stream docs; the recorder's --self-check reports per-type counts so a
// format drift shows up immediately as a zero.
test('aggTrade, forceOrder, depth and markPrice messages parse from a combined stream', () => {
  const trade = parseStreamMessage({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: 1, s: 'BTCUSDT', a: 1, p: '84000.5', q: '0.25', f: 1, l: 1, T: 1_790_000_000_000, m: true } });
  assert.deepEqual(trade, { kind: 'trade', symbol: 'BTCUSDT', time: 1_790_000_000_000, price: 84000.5, qty: 0.25, buyerIsMaker: true });
  const liq = parseStreamMessage({ e: 'forceOrder', E: 5, o: { s: 'ETHUSDT', S: 'SELL', o: 'LIMIT', q: '2', p: '2600', ap: '2598', z: '1.5', X: 'FILLED', T: 1_790_000_000_500 } });
  assert.deepEqual(liq, { kind: 'liquidation', symbol: 'ETHUSDT', time: 1_790_000_000_500, side: 'SELL', qty: 1.5, price: 2598 });
  const book = parseStreamMessage({ e: 'depthUpdate', E: 9, T: 10, s: 'BTCUSDT', b: [['99', '1'], ['98', '2']], a: [['101', '3']] });
  assert.deepEqual(book, { kind: 'book', symbol: 'BTCUSDT', time: 10, bids: [[99, 1], [98, 2]], asks: [[101, 3]] });
  const mark = parseStreamMessage({ e: 'markPriceUpdate', E: 11, s: 'SOLUSDT', p: '120.1', i: '120.0', P: '120', r: '0.0001', T: 12 });
  assert.deepEqual(mark, { kind: 'mark', symbol: 'SOLUSDT', time: 11, mark: 120.1, index: 120, funding: 0.0001 });
});

test('unknown, malformed and incomplete messages are dropped rather than guessed', () => {
  assert.equal(parseStreamMessage(null), null);
  assert.equal(parseStreamMessage('x'), null);
  assert.equal(parseStreamMessage({ e: 'kline', s: 'BTCUSDT' }), null);
  assert.equal(parseStreamMessage({ e: 'aggTrade' }), null); // no symbol
  assert.equal(parseStreamMessage({ e: 'forceOrder', o: { s: 'BTCUSDT', S: 'HOLD' } }), null);
});

test('REST polls parse: open interest and the latest taker ratio row', () => {
  assert.deepEqual(parseOpenInterest({ openInterest: '10659.509', symbol: 'BTCUSDT', time: 1_790_000_000_000 }), { kind: 'oi', symbol: 'BTCUSDT', time: 1_790_000_000_000, openInterest: 10659.509 });
  assert.equal(parseOpenInterest({ symbol: 'BTCUSDT' }), null);
  const rows = [{ buySellRatio: '0.9', buyVol: '1', sellVol: '2', timestamp: 1 }, { buySellRatio: '1.3', buyVol: '1', sellVol: '2', timestamp: 2 }];
  assert.deepEqual(parseTakerRatio('BTCUSDT', rows), { kind: 'taker', symbol: 'BTCUSDT', time: 2, ratio: 1.3 });
  assert.equal(parseTakerRatio('BTCUSDT', []), null);
});
