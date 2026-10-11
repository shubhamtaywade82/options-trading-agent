import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { AdaptiveSuperTrendAgent } from '../src/agents/AdaptiveSuperTrendAgent.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { config } from '../src/config.js';
import type { Candle, Position } from '../src/types.js';

const symbol = config.symbols[0];
const BAR_MS = 15 * 60_000;

// 120 flat bars then a steady climb: constant true range 2, so the bullish flip lands on bar 126
function candles(count: number, flatBars = 120): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = i < flatBars ? 100 : 100 + (i - flatBars + 1);
    return { openTime: i * BAR_MS, open: close, high: close + 1, low: close - 1, close, volume: 1 };
  });
}

function context(count: number, mark: number): MarketContext {
  return { candles: { [symbol]: candles(count) }, funding: {}, marks: { [symbol]: mark }, spot: {}, equity: 100_000 };
}

const agent = (options = {}) => new AdaptiveSuperTrendAgent({} as BinanceService, options);

test('should emit one long entry on a closed-candle flip, with SL on the SuperTrend line', async () => {
  // 128 candles: the last (index 127) is still forming, so the flip on index 126 is the last closed bar
  const signals = await agent().run(context(128, 107));
  assert.equal(signals.length, 1);
  const [signal] = signals;
  assert.equal(signal.type, 'OPEN_LONG');
  assert.equal(signal.entry, 107);
  assert.ok(signal.stopLoss! < 107);
  assert.ok(signal.takeProfit! > 107);
});

test('should not repaint: a flip on the still-forming candle emits nothing', async () => {
  assert.equal((await agent().run(context(127, 107))).length, 0);
});

test('should handle each closed candle once', async () => {
  const instance = agent();
  assert.equal((await instance.run(context(128, 107))).length, 1);
  assert.equal((await instance.run(context(128, 107))).length, 0);
});

test('should drop a stale flip when price already crossed the stop line', async () => {
  assert.equal((await agent().run(context(128, 50))).length, 0);
});

// ETH climbs exactly like BTC in `context`, so BTC's own state decides whether the ETH flip is allowed
function twoSymbolContext(btcCandles: Candle[]): MarketContext {
  return {
    candles: { BTCUSDT: btcCandles, ETHUSDT: candles(128) },
    funding: {}, marks: { BTCUSDT: 107, ETHUSDT: 107 }, spot: {}, equity: 100_000,
  };
}

test('should allow an alt flip that agrees with the BTC anchor', async () => {
  const signals = await agent({ requireAnchor: true }).run(twoSymbolContext(candles(128)));
  assert.deepEqual(signals.map((s) => s.symbol).sort(), ['BTCUSDT', 'ETHUSDT']);
});

test('should skip an alt flip while BTC has not flipped the same way when requireAnchor is true', async () => {
  const flatBtc = candles(128).map((c, i) => ({ ...c, open: 100, high: 101, low: 99, close: 100, openTime: i * BAR_MS }));
  const signals = await agent({ requireAnchor: true }).run(twoSymbolContext(flatBtc));
  assert.deepEqual(signals, []);
});

test('should allow independent alt flip when requireAnchor is false (default)', async () => {
  const flatBtc = candles(128).map((c, i) => ({ ...c, open: 100, high: 101, low: 99, close: 100, openTime: i * BAR_MS }));
  const signals = await agent().run(twoSymbolContext(flatBtc));
  assert.deepEqual(signals.map((s) => s.symbol), ['ETHUSDT']);
});

test('should not use the shared fill cooldown', () => {
  assert.equal(agent().cooldownMs, 0);
});

test('should trail an open position with rounded stops and skip unchanged ones', async () => {
  const instance = agent();
  await instance.run(context(128, 107));
  const state = instance.stateFor(symbol)!;
  const position: Position = {
    id: 'p', symbol, side: 'LONG', strategy: 'ADAPTIVE-ST-ζ', entry: 107, qty: 1, mark: 108, upnl: 1, upnlPct: 1,
    leverage: 5, marginType: 'ISOLATED', liqDistancePct: null, serverSl: String(state.superTrend - 10), serverTp: '130', initialRisk: 6,
  };
  const [update] = instance.stopUpdates([position]);
  assert.equal(update.stopLoss, Math.round(state.superTrend * 100) / 100);
  assert.deepEqual(instance.stopUpdates([{ ...position, serverSl: String(update.stopLoss) }]), []);
});

test('should skip an alt flip when the BTC state is older than the alt candle when requireAnchor is true', async () => {
  const instance = agent({ requireAnchor: true });
  // Loop 1: BTC flips bullish on closed bar 126; ETH stays flat (no flip)
  await instance.run({ ...twoSymbolContext(candles(128)), candles: { BTCUSDT: candles(128), ETHUSDT: candles(128, 500) } });
  // Loop 2: BTC data is missing; ETH flips bullish on closed bar 127 (flat until bar 121)
  const later = twoSymbolContext(candles(128));
  later.candles = { ETHUSDT: candles(129, 121) };
  assert.deepEqual(await instance.run(later), []);
});
