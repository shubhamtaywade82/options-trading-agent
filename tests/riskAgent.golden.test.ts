import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { RiskAgent } from '../src/agents/RiskAgent.js';
import { config } from '../src/config.js';
import type { Candle, RiskDecision, Signal } from '../src/types.js';

// The recorded values below depend on these limits and on the legacy sizing path; pinning both keeps the golden table independent of a local .env and of the RISK_ENGINE default
Object.assign(config.risk, { minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2 });
const legacyAgent = (): RiskAgent => new RiskAgent({} as BinanceService, { riskEngine: 'off' });

const flatCandles = (range: number): Candle[] =>
  Array.from({ length: 30 }, (_, i) => ({ openTime: i, open: 100, high: 100 + range / 2, low: 100 - range / 2, close: 100, volume: 1 }));

const signal = (over: Partial<Signal>): Signal =>
  ({ id: 's', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.75, entry: 100, stopLoss: 96, takeProfit: 110, reason: '', ts: 0, ...over });

const context = (over: Partial<MarketContext> = {}): MarketContext =>
  ({ candles: { BTCUSDT: flatCandles(1.5) }, funding: {}, marks: {}, spot: {}, equity: 100_000, ...over });

const decision = (positionSizeUsdt: number, leverage: number, liqBufferAtr: number, reason: string): RiskDecision =>
  ({ approved: true, positionSizeUsdt, leverage, marginType: 'ISOLATED', liqBufferAtr, reason });
const rejected = (reason: string): RiskDecision =>
  ({ approved: false, positionSizeUsdt: 0, leverage: 0, marginType: 'ISOLATED', liqBufferAtr: 0, reason });

interface Case { name: string; signal: Signal; ctx: MarketContext; expected: RiskDecision }

const cases: Case[] = [
  { name: 'long momentum with stop and take-profit', signal: signal({}), ctx: context(), expected: decision(25_000, 8, 2.6666666666666665, 'size=$25000 lev=8x buffer=2.7xATR') },
  { name: 'short with stop and take-profit', signal: signal({ type: 'OPEN_SHORT', stopLoss: 104, takeProfit: 90, confidence: 0.9 }), ctx: context(), expected: decision(25_000, 9, 2.6666666666666665, 'size=$25000 lev=9x buffer=2.7xATR') },
  { name: 'minimum confidence gets minimum leverage', signal: signal({ confidence: 0.5 }), ctx: context(), expected: decision(25_000, 7, 2.6666666666666665, 'size=$25000 lev=7x buffer=2.7xATR') },
  { name: 'stop capped by the exposure limit', signal: signal({ stopLoss: 99.5 }), ctx: context({ candles: { BTCUSDT: flatCandles(0.2) } }), expected: decision(80_000, 8, 2.500000000000142, 'size=$80000 lev=8x buffer=2.5xATR') },
  { name: 'slash symbol uses a 1.5% ATR proxy', signal: signal({ symbol: 'ETH/USDT' }), ctx: context({ candles: { ETHUSDT: flatCandles(1.5) } }), expected: decision(25_000, 8, 2.6666666666666665, 'size=$25000 lev=8x buffer=2.7xATR') },
  { name: 'missing stop', signal: signal({ stopLoss: undefined }), ctx: context(), expected: rejected('missing entry/SL') },
  { name: 'stop equal to entry', signal: signal({ stopLoss: 100 }), ctx: context(), expected: rejected('stop loss matches entry') },
  { name: 'hedge with notional', signal: signal({ type: 'OPEN_HEDGE', agent: 'FUNDING-ARB-α', entry: undefined, stopLoss: undefined, notionalUsdt: 5_000 }), ctx: context(), expected: decision(5_000, 5, Infinity, 'funding harvest 5x isolated') },
  { name: 'funding short with notional', signal: signal({ type: 'OPEN_FUNDING_SHORT', agent: 'FUNDING-ARB-α', entry: undefined, stopLoss: undefined, notionalUsdt: 5_000 }), ctx: context(), expected: decision(5_000, 5, Infinity, 'funding harvest 5x isolated') },
  { name: 'hedge without notional falls back to the risk budget', signal: signal({ type: 'OPEN_HEDGE', agent: 'FUNDING-ARB-α', entry: undefined, stopLoss: undefined }), ctx: context(), expected: decision(1_000, 5, Infinity, 'funding harvest 5x isolated') },
  { name: 'hedge above the exposure limit is capped', signal: signal({ type: 'OPEN_HEDGE', agent: 'FUNDING-ARB-α', entry: undefined, stopLoss: undefined, notionalUsdt: 90_000 }), ctx: context(), expected: decision(80_000, 5, Infinity, 'funding harvest 5x isolated') },
  { name: 'long with a stop above entry is still approved', signal: signal({ stopLoss: 104 }), ctx: context(), expected: decision(25_000, 8, 2.6666666666666665, 'size=$25000 lev=8x buffer=2.7xATR') },
  { name: 'short with a stop below entry is still approved', signal: signal({ type: 'OPEN_SHORT', stopLoss: 96 }), ctx: context(), expected: decision(25_000, 8, 2.6666666666666665, 'size=$25000 lev=8x buffer=2.7xATR') },
  { name: 'stop too tight for the ATR buffer', signal: signal({ stopLoss: 99 }), ctx: context(), expected: rejected('liq buffer 0.7x ATR < 2x') },
  { name: 'insufficient candles', signal: signal({}), ctx: context({ candles: {} }), expected: rejected('insufficient candle history') },
  { name: 'zero ATR', signal: signal({}), ctx: context({ candles: { BTCUSDT: flatCandles(0) } }), expected: rejected('invalid ATR calculation') },
  { name: 'zero equity trips the kill-switch', signal: signal({}), ctx: context({ equity: 0 }), expected: rejected('drawdown kill-switch: current drawdown exceeds 5%') },
];
for (const c of cases) {
  test(`golden: ${c.name}`, () => {
    const actual = legacyAgent().gate(c.signal, c.ctx);
    assert.deepEqual(actual, c.expected);
  });
}

test('golden: drawdown kill-switch follows the peak equity seen by one agent', () => {
  const agent = legacyAgent();
  const gateAt = (equity: number) => agent.gate(signal({}), context({ equity }));
  assert.equal(gateAt(100_000).approved, true);
  assert.deepEqual(gateAt(94_000), rejected('drawdown kill-switch: current drawdown exceeds 5%'));
  assert.equal(gateAt(96_000).approved, true);
  assert.equal(gateAt(100_000).approved, true);
});
