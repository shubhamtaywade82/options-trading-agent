import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import type { LiquidityPool, LiquiditySweep, MarketState, PriceZone } from '../src/market/types.js';
import type { Candle, Signal } from '../src/types.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import { StructureLiquidityAgent } from '../src/agents/StructureLiquidityAgent.js';
import { DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS } from '../src/decision/StructureLiquidityStrategy.js';
import { isRouted } from '../src/decision/StrategyRouter.js';
import { runCandidateFlow } from '../src/decision/CandidateFlow.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';

const BAR_MS = 15 * 60_000;
const BREAK_TIME = 10 * BAR_MS;
const dummyService = {} as BinanceService;

function candle(index: number, close = 100): Candle {
  return {
    openTime: index * BAR_MS,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  };
}

/** The qualifying long setup from the strategy tests, built through the real builder. */
function qualifyingState(overrides: { sweepTime?: number; targetPrice?: number } = {}): MarketState {
  const candles = Array.from({ length: 300 }, (_, i) => candle(i, 90 + i * 0.05));
  const base = new MarketStateBuilder().build({
    symbol: 'BTCUSDT',
    candles,
    mark: 100,
    fundingRate: 0,
  });

  const sweep: LiquiditySweep = {
    poolType: 'SWING_LOW',
    direction: 'SELL_SIDE',
    level: 98,
    sweepPrice: 97,
    close: 99,
    index: 9,
    time: overrides.sweepTime ?? 9 * BAR_MS,
    confirmed: true,
  };

  const target: LiquidityPool = {
    type: 'SWING_HIGH',
    price: overrides.targetPrice ?? 106,
    tolerance: 0.2,
    strength: 0.8,
    timeframe: '1h',
    sourceTimes: [6 * BAR_MS],
  };

  const demand: PriceZone = {
    type: 'DEMAND',
    timeframe: '15m',
    high: 99,
    low: 97.5,
    originTime: 8 * BAR_MS,
    causedBreak: 'BOS',
    displacementAtr: 2,
    touches: 0,
    fresh: true,
    strength: 0.9,
  };

  return {
    ...base,
    generatedAt: BREAK_TIME,
    mark: 100,
    regime: { ...base.regime, regime: 'TREND_UP', trendDirection: 'BULLISH', adx14: 30 },
    htfStructure: { ...base.htfStructure, trend: 'BULLISH' },
    ltfStructure: {
      ...base.ltfStructure,
      trend: 'BULLISH',
      lastBreak: {
        type: 'BOS',
        direction: 'BULLISH',
        level: 99,
        index: 10,
        time: BREAK_TIME,
        distanceAtr: 1,
      },
    },
    timeframes: { ...base.timeframes, '15m': { ...base.timeframes['15m'], atr14: 1 } },
    liquidity: {
      htf: { ...base.liquidity.htf, pools: [] },
      ltf: { ...base.liquidity.ltf, pools: [target], latestSweeps: [sweep], recentSweeps: [sweep] },
    },
    zones: [demand],
    pricing: { ...base.pricing, positionPct: 25, premium: false, discount: true },
  };
}

function context(state: MarketState): MarketContext {
  return {
    candles: {},
    funding: { [state.symbol]: state.fundingRate },
    marks: { [state.symbol]: state.mark },
    spot: {},
    equity: 100_000,
    marketState: { [state.symbol]: state },
  };
}

function structLiqSignal(state: MarketState): Signal {
  return {
    id: `struct-liq-${state.symbol}-${BREAK_TIME}`,
    ts: state.generatedAt,
    agent: 'STRUCT-LIQ-η',
    symbol: state.symbol,
    type: 'OPEN_LONG',
    confidence: 0.9,
    entry: state.mark,
    stopLoss: 96.85,
    takeProfit: 106,
    reason: 'agent test fixture',
  };
}

test('the agent forwards the strategy signal unchanged, once per closed candle', async () => {
  const agent = new StructureLiquidityAgent(dummyService);
  const state = qualifyingState();
  const signals = await agent.run(context(state));

  assert.equal(signals.length, 1);
  const signal = signals[0];
  assert.equal(signal.agent, 'STRUCT-LIQ-η');
  assert.equal(signal.id, `struct-liq-BTCUSDT-${BREAK_TIME}`);
  assert.equal(signal.type, 'OPEN_LONG');
  assert.equal(signal.entry, 100);
  assert.ok(signal.stopLoss! < signal.entry!);
  assert.ok(signal.confidence >= 0.75);
});

test('the agent does not re-emit for the same generatedAt', async () => {
  const agent = new StructureLiquidityAgent(dummyService);
  const state = qualifyingState();
  const ctx = context(state);

  assert.equal((await agent.run(ctx)).length, 1);
  assert.equal((await agent.run(ctx)).length, 0);
  assert.equal((await agent.run(ctx)).length, 0);
});

test('the agent emits again once the next candle closes', async () => {
  const agent = new StructureLiquidityAgent(dummyService);
  const state = qualifyingState();
  const ctx = context(state);

  assert.equal((await agent.run(ctx)).length, 1);
  const nextBar = { ...state, generatedAt: BREAK_TIME + BAR_MS };
  const signals = await agent.run(context(nextBar));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ts, BREAK_TIME + BAR_MS);
});

test('the agent returns nothing without a market state', async () => {
  const agent = new StructureLiquidityAgent(dummyService);
  const signals = await agent.run({ candles: {}, funding: {}, marks: {}, spot: {}, equity: 100_000 });
  assert.equal(signals.length, 0);
});

test('the agent returns nothing for a state the strategy rejects', async () => {
  const agent = new StructureLiquidityAgent(dummyService);
  const state = qualifyingState();
  state.regime = { ...state.regime, regime: 'RANGE', trendDirection: 'NEUTRAL' };
  assert.equal((await agent.run(context(state))).length, 0);
});

test('the router allows STRUCT-LIQ only in directional regimes', () => {
  const signal = structLiqSignal(qualifyingState());
  const trendUp = { ...qualifyingState(), regime: { ...qualifyingState().regime, regime: 'TREND_UP' as const } };
  const trendDown = { ...trendUp, regime: { ...trendUp.regime, regime: 'TREND_DOWN' as const } };
  const range = { ...trendUp, regime: { ...trendUp.regime, regime: 'RANGE' as const } };

  assert.equal(isRouted(signal, trendUp), true);
  assert.equal(isRouted(signal, trendDown), true);
  assert.equal(isRouted(signal, range), false);
});

test('a lone STRUCT-LIQ signal resolves through fusion with its intent evidence', () => {
  const state = qualifyingState();
  const flow = runCandidateFlow([structLiqSignal(state)], { BTCUSDT: state });

  assert.equal(flow.signals.length, 1);
  assert.equal(flow.signals[0].agent, 'STRUCT-LIQ-η');
  assert.equal(flow.fusionFiltered, 0);
  const intent = flow.intents.get('BTCUSDT:STRUCT-LIQ-η');
  assert.ok(intent);
  assert.equal(intent.side, 'LONG');
  assert.ok(intent.evidenceScore >= 50);
});

test('fusion drops the weaker opposing candidate and keeps the STRUCT-LIQ setup', () => {
  const state = qualifyingState();
  // Crowding is router-eligible in TREND_UP (mean-revert is not), so both candidates reach fusion.
  const contrarian: Signal = {
    id: 'crowd-opposing',
    ts: state.generatedAt,
    agent: 'CROWDING-ι',
    symbol: 'BTCUSDT',
    type: 'OPEN_SHORT',
    confidence: 0.7,
    entry: 100,
    stopLoss: 102,
    takeProfit: 95,
    reason: 'opposing fixture',
  };

  const flow = runCandidateFlow([structLiqSignal(state), contrarian], { BTCUSDT: state });

  assert.equal(flow.signals.length, 1);
  assert.equal(flow.signals[0].agent, 'STRUCT-LIQ-η');
  assert.equal(flow.fusionFiltered, 1);
});

test('relaxed sweep-age options let the agent fire on a setup the defaults reject', async () => {
  // Sweep 7 candles before the break: outside the default 6-candle window, inside 12.
  const agedSweep = qualifyingState({ sweepTime: 3 * BAR_MS });

  const defaults = new StructureLiquidityAgent(dummyService);
  assert.equal((await defaults.run(context(agedSweep))).length, 0, 'default window must reject a 7-candle-old sweep');

  const relaxed = new StructureLiquidityAgent(dummyService, {
    ...DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS,
    maxSweepAgeCandles: 12,
  });
  const signals = await relaxed.run(context(agedSweep));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].agent, 'STRUCT-LIQ-η');
});

test('relaxed reward-risk options let the agent fire on a thinner target the defaults reject', async () => {
  // Target 103 against a 3.15 risk unit: RR = 0.95 — below the default 1.5 floor, above 0.8.
  const thinTarget = qualifyingState({ targetPrice: 103 });

  const defaults = new StructureLiquidityAgent(dummyService);
  assert.equal((await defaults.run(context(thinTarget))).length, 0, 'default floor must reject a sub-1.5R target');

  const relaxed = new StructureLiquidityAgent(dummyService, {
    ...DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS,
    minimumRewardRisk: 0.8,
  });
  const signals = await relaxed.run(context(thinTarget));
  assert.equal(signals.length, 1);
  assert.ok(signals[0].takeProfit !== undefined && signals[0].takeProfit! > signals[0].entry!);
});
