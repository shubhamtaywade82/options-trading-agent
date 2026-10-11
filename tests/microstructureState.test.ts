import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFlow, classifyPriceOi, microstructureState } from '../src/marketdata/MicrostructureState.js';
import type { MinuteRecord } from '../src/marketdata/MinuteAggregator.js';
import { classifyVolatilityPhase, decisionContextOf } from '../src/market/VolatilityPhase.js';
import { mulberry32 } from '../src/research/Bootstrap.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1);
const OPTS = { windowMinutes: 15, baselineMinutes: 240 };

/** Noisy baseline (random-walk mark and OI, balanced flow) followed by a 15-minute window shaped by `last`. */
function series(last: { priceStepBps: number; oiStepPct: number; buyShare: number; liqLong?: number }, seed = 1): MinuteRecord[] {
  const r = mulberry32(seed);
  const out: MinuteRecord[] = [];
  let mark = 100;
  let oi = 1_000_000;
  const n = OPTS.windowMinutes + OPTS.baselineMinutes;
  for (let i = 0; i < n; i += 1) {
    const inWindow = i >= n - OPTS.windowMinutes;
    // the window's first minute is its reference point, so its shape starts on the following minute
    const shaped = inWindow && i > n - OPTS.windowMinutes;
    mark *= 1 + (shaped ? last.priceStepBps / 10_000 : (r() - 0.5) * 0.0004);
    oi *= 1 + (shaped ? last.oiStepPct / 100 : (r() - 0.5) * 0.0004);
    const share = inWindow ? last.buyShare : 0.4 + r() * 0.2;
    out.push({
      t: T0 + i * MIN, symbol: 'SOLUSDT', trades: 100, buyQty: share * 10, sellQty: (1 - share) * 10, buyQuote: share * 1000, sellQuote: (1 - share) * 1000,
      liqLongQty: inWindow ? (last.liqLong ?? 0) : (i % 50 === 0 ? 1 : 0), liqShortQty: 0, liqCount: 0,
      spreadBps: 0.5, bookImbalance: 0.1, bookSamples: 10, mark, index: mark, funding: 0.0001, openInterest: oi, takerRatio: 1,
    });
  }
  return out;
}

const state = (records: MinuteRecord[]) => {
  const res = microstructureState(records, OPTS);
  assert.equal(res.status, 'OK', res.status === 'INSUFFICIENT_DATA' ? res.reason : '');
  return (res as Extract<typeof res, { status: 'OK' }>).state;
};

test('price up with rising OI and buy aggression is a long build with buy-dominant flow', () => {
  const s = state(series({ priceStepBps: 3, oiStepPct: 0.05, buyShare: 0.8 }));
  assert.equal(s.priceOiRegime, 'LONG_BUILD');
  assert.equal(s.flowRegime, 'BUY_DOMINANT');
  assert.ok(s.priceChangeBps > 30 && s.oiChangePct > 0.5);
  assert.equal(s.windowMinutes, 15);
  assert.equal(s.symbol, 'SOLUSDT');
});

test('the four price x OI quadrants', () => {
  assert.equal(state(series({ priceStepBps: 3, oiStepPct: -0.05, buyShare: 0.5 })).priceOiRegime, 'SHORT_COVER');
  assert.equal(state(series({ priceStepBps: -3, oiStepPct: 0.05, buyShare: 0.5 })).priceOiRegime, 'SHORT_BUILD');
  assert.equal(state(series({ priceStepBps: -3, oiStepPct: -0.05, buyShare: 0.5 })).priceOiRegime, 'LONG_LIQUIDATION');
});

test('buying into a falling price is labelled absorbed, and liquidations are scaled against the baseline', () => {
  const s = state(series({ priceStepBps: -3, oiStepPct: 0.05, buyShare: 0.85, liqLong: 5 }));
  assert.equal(s.flowRegime, 'BUY_ABSORBED');
  assert.ok(s.liqLongNotional > 0);
  assert.ok(s.liquidationZ !== null && s.liquidationZ > 3);
});

test('moves inside the deadband stay neutral', () => {
  assert.equal(classifyPriceOi(0.2, 3, 0.5), 'NEUTRAL');
  assert.equal(classifyPriceOi(3, -0.1, 0.5), 'NEUTRAL');
  assert.equal(classifyFlow(0.5, 3, 1, 0.5), 'NEUTRAL');
  assert.equal(classifyFlow(-2, 1, 1, 0.5), 'SELL_ABSORBED');
  assert.equal(classifyFlow(-2, 0, 1, 0.5), 'SELL_DOMINANT');
});

test('insufficient, gapped, mixed or OI-less data is refused with a reason, never classified', () => {
  const full = series({ priceStepBps: 1, oiStepPct: 0.01, buyShare: 0.5 });
  const short = microstructureState(full.slice(10), OPTS);
  assert.equal(short.status, 'INSUFFICIENT_DATA');
  const gapped = full.map((r, i) => (i > 100 ? { ...r, t: r.t + MIN } : r));
  const g = microstructureState(gapped, OPTS);
  assert.ok(g.status === 'INSUFFICIENT_DATA' && g.reason.startsWith('gap'));
  const mixed = full.map((r, i) => (i === 50 ? { ...r, symbol: 'BTCUSDT' } : r));
  assert.equal(microstructureState(mixed, OPTS).status, 'INSUFFICIENT_DATA');
  const noOi = full.map((r, i) => (i === full.length - 1 ? { ...r, openInterest: null } : r));
  const n = microstructureState(noOi, OPTS);
  assert.ok(n.status === 'INSUFFICIENT_DATA' && n.reason.includes('open interest'));
  assert.throws(() => microstructureState(full, { windowMinutes: 15, baselineMinutes: 30 }));
});

test('volatility phase bins the ATR percentile and treats missing data as UNKNOWN', () => {
  assert.equal(classifyVolatilityPhase(5), 'COMPRESSED');
  assert.equal(classifyVolatilityPhase(20), 'COMPRESSED');
  assert.equal(classifyVolatilityPhase(50), 'NORMAL');
  assert.equal(classifyVolatilityPhase(75), 'EXPANDING');
  assert.equal(classifyVolatilityPhase(97), 'EXTREME');
  assert.equal(classifyVolatilityPhase(null), 'UNKNOWN');
  assert.equal(classifyVolatilityPhase(Number.NaN), 'UNKNOWN');
});

test('decision context carries regime and phase together', () => {
  const ctx = decisionContextOf(
    { regime: 'TREND_UP', trendDirection: 'BULLISH', trendStrength: 1, volatility: 'LOW', volatilityPercentile: 10, adx14: 30, emaSlopePct: 0.1 },
    { timeframe: '15m', candleCount: 300, lastClose: 1, ema20: null, ema50: null, ema200: null, emaSlopePct: null, adx14: 31, atr14: 1, atrPercentile: 12,
      rsi14: null, vwap: null, bollingerMiddle: null, bollingerUpper: null, bollingerLower: null },
  );
  assert.deepEqual(ctx, { regime: 'TREND_UP', volatilityPhase: 'COMPRESSED', atrPercentile: 12, adx14: 31 });
});
