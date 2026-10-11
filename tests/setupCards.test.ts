import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { setupMapCard } from '../src/ops/setupCards.js';
import type { SetupMap } from '../src/decision/SetupEngine.js';

setSymbolRules('BTCUSDT', { tickSize: 0, stepSize: 0, minQty: 0, minNotional: 0, pricePrecision: 2, quantityPrecision: 3 });
const AT = Date.UTC(2026, 8, 25, 18, 0, 0);

const map: SetupMap = {
  symbol: 'BTCUSDT',
  generatedAt: AT,
  mark: 100,
  state: 'TRIGGERED',
  bias: 'BULLISH',
  regime: 'TREND_UP',
  volatility: 'MEDIUM',
  positionPct: 72,
  location: 'PREMIUM',
  htfTrend: 'BULLISH',
  ltfTrend: 'BULLISH',
  lastBreak: { type: 'BOS', direction: 'BULLISH', level: 99, time: AT - 900_000, distanceAtr: 1.2 },
  nearestUpperLiquidity: 105,
  nearestLowerLiquidity: 98,
  crowding: 'SHORT_CROWDED',
  openInterestExpansion: true,
  takerAggressionRatio: 1.25,
  scenarios: [{
    id: 's1',
    kind: 'BREAKOUT_RETEST',
    direction: 'LONG',
    state: 'FORMING',
    timeframe: '15m',
    entryLow: 104.8,
    entryHigh: 105.2,
    stopLoss: 104,
    target1: 107,
    target2: 110,
    trigger: '15m close above 105 + retest hold',
    invalidation: 'acceptance back below 105',
    flowHypothesis: 'initiative buy-flow hypothesis with OI expansion',
    expectedMove: { minMinutes: 20, maxMinutes: 80, thesisExpiryMinutes: 120, distanceAtr: 2 },
    sourceTime: AT,
    rewardRisk: 2.75,
  }],
  noTradeReasons: ['long setup is in premium; require stronger confirmation'],
};

test('setup telegram card contains structure, flow, levels and move clock', () => {
  const html = setupMapCard(map);
  assert.match(html, /\[ SETUP \]<\/b> BTCUSDT/);
  assert.match(html, /DERIVATIVES FLOW CONTEXT/);
  assert.match(html, /HTF BULLISH · LTF BULLISH/);
  assert.match(html, /SHORT_CROWDED/);
  assert.match(html, /Entry:/);
  assert.match(html, /SL:/);
  assert.match(html, /TP1:/);
  assert.match(html, /RR:<\/b> 2\.75/);
  assert.match(html, /Trigger:/);
  assert.match(html, /Invalidation:/);
  assert.match(html, /Flow hypothesis:/);
  assert.match(html, /Move window.*20m–1\.3h/);
  assert.match(html, /Thesis expiry:<\/b> 2h/);
});

test('setup telegram card escapes untrusted fields', () => {
  const html = setupMapCard({ ...map, regime: 'TREND <UP>' });
  assert.match(html, /TREND &lt;UP&gt;/);
});
