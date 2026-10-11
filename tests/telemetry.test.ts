import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle, Position, TradeRecord } from '../src/types.js';
import { buildTelemetry, fleetRuntimes, singleFlight, venueInfo, type TelemetryInput } from '../src/runtime/telemetry.js';
import type { VenueStatus } from '../src/binance/remoteBroker.js';

const closes = (values: number[]): Candle[] => values.map((c, i) => ({ openTime: i, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
const position = (over: Partial<Position>): Position => ({
  id: 'p', symbol: 'ETHUSDT', side: 'SHORT', strategy: 'FUNDING-ARB-α', entry: 100, qty: 10, mark: 100, upnl: 5, upnlPct: 0.5,
  leverage: 5, marginType: 'ISOLATED', liqDistancePct: 18.5, serverSl: '—', serverTp: 'fund', ...over,
});
const trade = (pnl: number, strategy: TradeRecord['strategy']): TradeRecord =>
  ({ symbol: 'ETHUSDT', strategy, side: 'LONG', entry: 1, exit: 1, qty: 1, pnl, reason: 'CLOSE', closedAt: 1 });

function input(over: Partial<TelemetryInput> = {}): TelemetryInput {
  return {
    account: { equity: 100_100, marginUsed: 200, initialEquity: 100_000 },
    positions: [position({}), position({ symbol: 'BTCUSDT', strategy: 'ADAPTIVE-ST-ζ', side: 'LONG', liqDistancePct: 9.5, qty: 1, mark: 1000, upnl: 0 })],
    trades: [trade(100, 'ADAPTIVE-ST-ζ'), trade(-40, 'ADAPTIVE-ST-ζ')],
    candles: { BTCUSDT: closes(Array.from({ length: 60 }, (_, i) => 100 + i)), ETHUSDT: closes(Array.from({ length: 60 }, (_, i) => 50 + i / 2)) },
    funding: { BTCUSDT: 0.0001, ETHUSDT: 0.0002 },
    nextFundingTime: 3 * 3_600_000 + 25 * 60_000, now: 0,
    adaptive: {},
    agents: [
      { id: 'FUNDING-ARB-α', status: 'RUNNING', strategy: 'funding_rate_harvest' }, { id: 'ADAPTIVE-ST-ζ', status: 'RUNNING', strategy: 'ml_adaptive_supertrend' },
      { id: 'EXECUTOR-ε', status: 'RUNNING', strategy: 'binance_order_routing' },
    ],
    counters: { decisions: 7, executed: 3, monitored: 4 }, apiWeight: 12, wsStatus: 'connected', attributable: true, ...over,
  };
}

test('should derive account, risk and counter fields from real inputs', () => {
  const t = buildTelemetry(input());
  assert.equal(t.totalPnl, 100);
  assert.equal(t.initialEquity, 100_000);
  assert.equal(t.successRate, 50);
  assert.equal(t.minLiqDistancePct, 9.5);
  assert.equal(t.exposurePct, ((10 * 100 + 1 * 1000) / 100_100) * 100);
  assert.deepEqual([t.sessionDecisions, t.sessionExecuted, t.sessionMonitored, t.apiWeight, t.wsStatus], [7, 3, 4, 12, 'connected']);
  assert.ok(Math.abs(t.corrBtcEth! - 1) < 1e-9); // both series are linear
});

test('should build per-agent state from positions and the journal', () => {
  const [funding, adaptive] = buildTelemetry(input()).agents;
  assert.deepEqual({ p: funding.positions, w: funding.winRate, pnl: funding.pnl }, { p: 1, w: null, pnl: 5 });
  assert.deepEqual({ p: adaptive.positions, w: adaptive.winRate, pnl: adaptive.pnl }, { p: 1, w: 50, pnl: 60 });
});

test('should compute funding APR, countdown and the funding estimate', () => {
  const m = buildTelemetry(input()).strategyMetrics!;
  assert.ok(Math.abs(m.fundingBySymbol.BTCUSDT.apr - 0.0001 * 3 * 365 * 100) < 1e-9);
  assert.equal(m.nextFundingCountdown, '3h25m');
  assert.ok(Math.abs(m.estNextFundingUsd! - 10 * 100 * 0.0002) < 1e-9); // short earns positive funding
  assert.deepEqual(m.momentumAboveEma50, { up: 2, total: 2 });
});

test('should return nulls instead of demo values when data is missing', () => {
  const t = buildTelemetry(input({ candles: {}, funding: {}, nextFundingTime: 0, positions: [], trades: [] }));
  assert.equal(t.corrBtcEth, null);
  assert.equal(t.minLiqDistancePct, null);
  assert.equal(t.successRate, null);
  assert.equal(t.strategyMetrics!.nextFundingCountdown, null);
  assert.equal(t.strategyMetrics!.zscoreBtcEth, null);
  assert.deepEqual(t.strategyMetrics!.fundingBySymbol, {});
});

test('should report unattributable live figures as null and give every position to the executor', () => {
  const live = [position({ strategy: 'EXECUTOR-ε', upnl: 5 }), position({ symbol: 'BTCUSDT', strategy: 'EXECUTOR-ε', upnl: -2 })];
  const t = buildTelemetry(input({ attributable: false, positions: live }));
  const [funding, adaptive, executor] = t.agents;
  assert.deepEqual([funding.positions, funding.pnl, adaptive.positions, adaptive.pnl], [null, null, null, null]);
  assert.deepEqual([executor.positions, executor.pnl], [2, 3]);
  assert.equal(t.strategyMetrics!.estNextFundingUsd, null);
  assert.equal(t.liqEvents, null);
});

test('should keep per-strategy attribution and a liquidation count in paper mode', () => {
  const t = buildTelemetry(input());
  assert.equal(t.liqEvents, 0);
  assert.equal(t.agents[2].positions, 0);
  assert.equal(t.agents[2].pnl, 0);
});

test('should carry the risk agent note into its fleet entry and leave the other agents without one', () => {
  const running = [
    { id: 'RISK-MGR-δ' as const, status: 'WATCHING' as const, strategy: 'liquidation_guard_isolated', note: 'HALTED' },
    { id: 'EXECUTOR-ε' as const, status: 'RUNNING' as const, strategy: 'binance_order_routing', note: undefined },
  ];
  const agents = buildTelemetry(input({ agents: fleetRuntimes(running, true) })).agents;
  assert.equal(agents.find((a) => a.id === 'RISK-MGR-δ')?.note, 'HALTED');
  assert.equal(agents.find((a) => a.id === 'EXECUTOR-ε')?.note, undefined);
});

const remote = (state: VenueStatus['state']): VenueStatus => ({ name: 'paper_exchange', accountId: 'crypto-agent', state, lastError: null, lastSyncAt: 0 });

test('should label the venue from the broker status, and fall back to the local engine or live Binance', () => {
  assert.deepEqual(venueInfo(remote('degraded'), 'paper'), { name: 'paper_exchange (crypto-agent)', state: 'degraded' });
  assert.deepEqual(venueInfo(remote('down'), 'paper'), { name: 'paper_exchange (crypto-agent)', state: 'down' });
  assert.deepEqual(venueInfo(null, 'paper'), { name: 'local paper engine', state: 'local' });
  assert.deepEqual(venueInfo(null, 'live'), { name: 'BINANCE FUTURES', state: 'local' });
});

test('should skip a call while the previous one is still running and run again once it settled', async () => {
  let release = () => {};
  let started = 0;
  const guarded = singleFlight(() => { started += 1; return new Promise<void>((resolve) => { release = resolve; }); });
  const first = guarded();
  await guarded();
  assert.equal(started, 1);
  release();
  await first;
  const second = guarded();
  assert.equal(started, 2);
  release();
  await second;
});

test('should release the guard when the task throws', async () => {
  let started = 0;
  const guarded = singleFlight(async () => { started += 1; throw new Error('boom'); });
  await assert.rejects(guarded());
  await assert.rejects(guarded());
  assert.equal(started, 2);
});

test('should build marketIntel summary when marketStates are provided', () => {
  const fakeMs: any = {
    symbol: 'BTCUSDT',
    fundingRate: 0.0001,
    regime: { regime: 'TREND_UP', trendDirection: 'BULLISH', volatility: 'LOW', volatilityPercentile: 20 },
    htfStructure: { trend: 'BULLISH' },
    ltfStructure: { trend: 'BULLISH' },
    pricing: { premium: false, discount: true, positionPct: 25 },
    liquidity: { ltf: { latestSweeps: [{ direction: 'SELL_SIDE', level: 49500 }] } },
    crowding: { fundingPercentile: 65, positioningExtreme: 'BALANCED', openInterestExpansion: true },
    derivatives: { spreadBps: 1.5 },
  };
  const t = buildTelemetry(input({ marketStates: { BTCUSDT: fakeMs } }));
  assert.ok(t.marketIntel?.BTCUSDT);
  const intel = t.marketIntel.BTCUSDT;
  assert.equal(intel.regime, 'TREND_UP');
  assert.equal(intel.htfTrend, 'BULLISH');
  assert.equal(intel.discount, true);
  assert.equal(intel.spreadBps, 1.5);
  assert.equal(intel.strategyStatus.Structure, 'READY');
  assert.equal(intel.strategyStatus.MeanRev, 'BLOCKED');
});

test('should pass edgeMultiplier through to agent state', () => {
  const running = [{ id: 'MOMENTUM-γ' as const, status: 'RUNNING' as const, strategy: 'test', edgeMultiplier: 1.15 }];
  const t = buildTelemetry(input({ agents: running }));
  assert.equal(t.agents[0].edgeMultiplier, 1.15);
});
