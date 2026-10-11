import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { MomentumAgent } from '../src/agents/MomentumAgent.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { config } from '../src/config.js';
import type { Candle } from '../src/types.js';

const symbol = config.symbols[0];
const BAR_MS = 15 * 60_000;

// Generates candles that cross above EMA50 at candle index 60
function buildCrossingCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    let close = 100;
    if (i === 59) close = 98;
    else if (i >= 60) close = 102;
    return {
      openTime: i * BAR_MS,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    };
  });
}

function makeContext(candleList: Candle[]): MarketContext {
  return {
    candles: { [symbol]: candleList },
    funding: {},
    marks: { [symbol]: 102 },
    spot: {},
    equity: 100_000,
  };
}

const createAgent = () => new MomentumAgent({} as BinanceService);

test('should emit OPEN_LONG signal on closed candle EMA50 crossover', async () => {
  // 62 candles: index 60 is the last closed candle, index 61 is forming
  const candles = buildCrossingCandles(62);
  const signals = await createAgent().run(makeContext(candles));
  assert.equal(signals.length, 1);
  const [s] = signals;
  assert.equal(s.type, 'OPEN_LONG');
  assert.equal(s.symbol, symbol);
  assert.ok(s.id.length >= 8);
  assert.equal(s.ts, candles[60].openTime);
});

test('should not evaluate the forming candle', async () => {
  // 61 candles: index 60 is the forming candle, closed is 0..59 (no crossover yet)
  const candles = buildCrossingCandles(61);
  const signals = await createAgent().run(makeContext(candles));
  assert.equal(signals.length, 0);
});

test('should deduplicate signals across multiple loops on the same closed candle', async () => {
  const candles = buildCrossingCandles(62);
  const agent = createAgent();
  const first = await agent.run(makeContext(candles));
  assert.equal(first.length, 1);
  const second = await agent.run(makeContext(candles));
  assert.equal(second.length, 0);
});

test('should produce deterministic signal IDs for identical inputs', async () => {
  const candles = buildCrossingCandles(62);
  const agent1 = createAgent();
  const agent2 = createAgent();
  const [sig1] = await agent1.run(makeContext(candles));
  const [sig2] = await agent2.run(makeContext(candles));
  assert.equal(sig1.id, sig2.id);
});
