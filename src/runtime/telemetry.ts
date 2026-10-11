import type { AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';
import { atr, ema, pairZScore } from '../binance/indicators.js';
import { correlation, simpleReturns, summarizePerformance, type StrategyPerformance } from '../binance/performance.js';
import type { VenueStatus } from '../binance/remoteBroker.js';
import type { AdaptiveInfo, AgentId, AgentState, AppState, Candle, FundingInfo, MarketIntelSummary, Mode, Position, StrategyMetrics, TradeRecord, WsStatus } from '../types.js';
import type { MarketState } from '../market/types.js';

export interface AgentRuntime { id: AgentId; status: 'RUNNING' | 'PAUSED' | 'WATCHING'; strategy: string; note?: string; edgeMultiplier?: number }
export interface SessionCounters { decisions: number; executed: number; monitored: number }
export interface TelemetryInput {
  account: { equity: number; marginUsed: number; initialEquity: number };
  positions: Position[]; trades: TradeRecord[];
  candles: Record<string, Candle[]>; funding: Record<string, number>; nextFundingTime: number;
  adaptive: Record<string, AdaptiveSuperTrendBar | undefined>;
  agents: AgentRuntime[]; counters: SessionCounters;
  apiWeight: number; wsStatus: WsStatus; now: number;
  attributable: boolean; // live positions are all tagged EXECUTOR-ε, so per-strategy figures cannot be measured
  marketStates?: Record<string, MarketState>;
}
export function accountFields(account: TelemetryInput['account'], positions: Position[]) {
  return { equity: account.equity, marginUsed: account.marginUsed, positions, upnl: positions.reduce((sum, p) => sum + p.upnl, 0) };
}

export type Telemetry = Pick<AppState, 'initialEquity' | 'totalPnl' | 'totalPnlPct' | 'successRate' | 'sharpe' | 'maxDd' | 'var95' | 'liqEvents' | 'sessionDecisions' | 'sessionExecuted' | 'sessionMonitored' | 'apiWeight' | 'wsStatus' | 'exposurePct' | 'minLiqDistancePct' | 'corrBtcEth' | 'agents' | 'strategyMetrics' | 'marketIntel'>;

const BTC = 'BTCUSDT';
const ETH = 'ETHUSDT';
const FUNDING_AGENT: AgentId = 'FUNDING-ARB-α';
const EXECUTOR_AGENT: AgentId = 'EXECUTOR-ε';
const FUNDINGS_PER_DAY = 3;
const DAYS_PER_YEAR = 365;
const MIN_PAIR_CANDLES = 30;
const EMA_PERIOD = 50;
const ATR_PERIOD = 14;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

function exposurePct(positions: Position[], equity: number): number {
  if (equity <= 0) return 0;
  const notional = positions.reduce((sum, p) => sum + p.qty * p.mark, 0);
  return (notional / equity) * 100;
}

function minLiqDistancePct(positions: Position[]): number | null {
  const distances = positions.map((p) => p.liqDistancePct).filter((d): d is number => d !== null);
  return distances.length === 0 ? null : Math.min(...distances);
}

function closesOf(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

function corrBtcEth(candles: Record<string, Candle[]>): number | null {
  if (!candles[BTC] || !candles[ETH]) return null;
  return correlation(simpleReturns(closesOf(candles[BTC])), simpleReturns(closesOf(candles[ETH])));
}

function agentPositionFigures(id: AgentId, positions: Position[], attributable: boolean, closedPnl: number): { positions: number | null; pnl: number | null } {
  if (!attributable && id !== EXECUTOR_AGENT) return { positions: null, pnl: null };
  const open = attributable ? positions.filter((p) => p.strategy === id) : positions;
  return { positions: open.length, pnl: closedPnl + open.reduce((sum, p) => sum + p.upnl, 0) };
}

function buildAgents(runtimes: AgentRuntime[], input: TelemetryInput, byStrategy: Record<string, StrategyPerformance>): AgentState[] {
  return runtimes.map((runtime) => {
    const stats = byStrategy[runtime.id];
    const winRate = stats && stats.closed > 0 ? (stats.wins / stats.closed) * 100 : null;
    return { ...runtime, ...agentPositionFigures(runtime.id, input.positions, input.attributable, stats?.pnl ?? 0), winRate };
  });
}

function fundingBySymbol(funding: Record<string, number>): Record<string, FundingInfo> {
  const bySymbol: Record<string, FundingInfo> = {};
  for (const [symbol, rate] of Object.entries(funding)) {
    bySymbol[symbol] = { rate, apr: rate * FUNDINGS_PER_DAY * DAYS_PER_YEAR * 100 };
  }
  return bySymbol;
}

function fundingCountdown(nextFundingTime: number, now: number): string | null {
  if (nextFundingTime <= 0) return null;
  const totalMinutes = Math.floor(Math.max(0, nextFundingTime - now) / MS_PER_MINUTE);
  return `${Math.floor(totalMinutes / MINUTES_PER_HOUR)}h${totalMinutes % MINUTES_PER_HOUR}m`;
}

function estNextFundingUsd(positions: Position[], funding: Record<string, number>): number {
  let total = 0;
  for (const p of positions.filter((pos) => pos.strategy === FUNDING_AGENT)) {
    const payerSign = p.side === 'SHORT' ? 1 : -1; // shorts receive positive funding, longs pay it
    total += payerSign * p.qty * p.mark * (funding[p.symbol] ?? 0);
  }
  return total;
}

function zscoreBtcEth(candles: Record<string, Candle[]>): number | null {
  const [btc, eth] = [candles[BTC], candles[ETH]];
  if (!btc || !eth || btc.length < MIN_PAIR_CANDLES || eth.length < MIN_PAIR_CANDLES) return null;
  return pairZScore(btc, eth);
}

function atrBySymbol(candles: Record<string, Candle[]>): Record<string, number> {
  const bySymbol: Record<string, number> = {};
  for (const [symbol, series] of Object.entries(candles)) bySymbol[symbol] = atr(series, ATR_PERIOD);
  return bySymbol;
}

function adaptiveBySymbol(bars: Record<string, AdaptiveSuperTrendBar | undefined>): Record<string, AdaptiveInfo> {
  const bySymbol: Record<string, AdaptiveInfo> = {};
  for (const [symbol, bar] of Object.entries(bars)) {
    if (!bar) continue;
    const distanceAtr = bar.assignedAtr > 0 ? Math.abs(bar.candle.close - bar.superTrend) / bar.assignedAtr : 0; // zero ATR would yield Infinity in the UI
    bySymbol[symbol] = { direction: bar.direction, regime: bar.regime, superTrend: bar.superTrend, distanceAtr };
  }
  return bySymbol;
}

function momentumAboveEma50(candles: Record<string, Candle[]>): { up: number; total: number } {
  let up = 0;
  let total = 0;
  for (const series of Object.values(candles)) {
    if (series.length < EMA_PERIOD) continue;
    const closes = closesOf(series);
    total += 1;
    if (closes[closes.length - 1] > ema(closes, EMA_PERIOD)[closes.length - 1]) up += 1;
  }
  return { up, total };
}

function buildStrategyMetrics(input: TelemetryInput): StrategyMetrics {
  return {
    fundingBySymbol: fundingBySymbol(input.funding),
    nextFundingCountdown: fundingCountdown(input.nextFundingTime, input.now),
    estNextFundingUsd: input.attributable ? estNextFundingUsd(input.positions, input.funding) : null,
    zscoreBtcEth: zscoreBtcEth(input.candles),
    atrBySymbol: atrBySymbol(input.candles),
    adaptive: adaptiveBySymbol(input.adaptive),
    momentumAboveEma50: momentumAboveEma50(input.candles),
  };
}

const FUNDINGS_PER_YEAR = 3 * 365 * 100; // rate → APR %

function intelForSymbol(ms: MarketState): MarketIntelSummary {
  const sweep = ms.liquidity.ltf.latestSweeps[0];
  return {
    regime: ms.regime.regime,
    htfTrend: ms.htfStructure.trend,
    ltfTrend: ms.ltfStructure.trend,
    volatility: ms.regime.volatility,
    volatilityPct: ms.regime.volatilityPercentile,
    premium: ms.pricing.premium,
    discount: ms.pricing.discount,
    positionPct: Math.round(ms.pricing.positionPct),
    fundingApr: ms.fundingRate !== 0 ? Number((ms.fundingRate * FUNDINGS_PER_YEAR).toFixed(2)) : null,
    fundingPct: ms.crowding?.fundingPercentile ?? null,
    openInterestExpansion: ms.crowding?.openInterestExpansion ?? null,
    crowding: ms.crowding?.positioningExtreme ?? null,
    spreadBps: ms.derivatives?.spreadBps ?? null,
    lastSweep: sweep ? `${sweep.direction} @ ${sweep.level.toFixed(0)}` : null,
    strategyStatus: {
      'Structure': ms.regime.regime === 'TREND_UP' || ms.regime.regime === 'TREND_DOWN' ? 'READY' : 'BLOCKED',
      'MeanRev': ms.regime.regime === 'RANGE' || ms.regime.regime === 'LOW_VOL' ? 'READY' : 'BLOCKED',
      'Contrarian': ms.crowding?.positioningExtreme !== 'BALANCED' ? 'READY' : 'BLOCKED',
    },
  };
}

function buildMarketIntel(states?: Record<string, MarketState>): Record<string, MarketIntelSummary> | undefined {
  if (!states || Object.keys(states).length === 0) return undefined;
  return Object.fromEntries(Object.entries(states).map(([sym, ms]) => [sym, intelForSymbol(ms)]));
}

/** Derives every cockpit figure from real account, journal, candle and funding data; pure, no I/O. */
export function buildTelemetry(input: TelemetryInput): Telemetry {
  const { equity, initialEquity } = input.account;
  const perf = summarizePerformance(input.trades, initialEquity, equity, input.now);
  return {
    initialEquity,
    totalPnl: perf.totalPnl,
    totalPnlPct: perf.totalPnlPct,
    successRate: perf.winRate,
    sharpe: perf.sharpe,
    maxDd: perf.maxDrawdownPct,
    var95: perf.var95,
    liqEvents: input.attributable ? perf.liquidations : null,
    sessionDecisions: input.counters.decisions,
    sessionExecuted: input.counters.executed,
    sessionMonitored: input.counters.monitored,
    apiWeight: input.apiWeight,
    wsStatus: input.wsStatus,
    exposurePct: exposurePct(input.positions, equity),
    minLiqDistancePct: minLiqDistancePct(input.positions),
    corrBtcEth: corrBtcEth(input.candles),
    agents: buildAgents(input.agents, input, perf.byStrategy),
    strategyMetrics: buildStrategyMetrics(input),
    marketIntel: buildMarketIntel(input.marketStates),
  };
}

const FLEET_ORDER: AgentId[] = [
  'FUNDING-ARB-α', 'MOMENTUM-γ', 'ADAPTIVE-ST-ζ',
  'STRUCTURE-TREND-η', 'STRUCT-LIQ-η', 'MEAN-REVERT-θ', 'CROWDING-ι',
  'RISK-MGR-δ', 'EXECUTOR-ε',
];
const ADAPTIVE_DISABLED_RUNTIME: AgentRuntime = { id: 'ADAPTIVE-ST-ζ', status: 'PAUSED', strategy: 'ml_adaptive_supertrend' };
const STRUCT_LIQ_DISABLED_RUNTIME: AgentRuntime = { id: 'STRUCT-LIQ-η', status: 'PAUSED', strategy: 'smc_structure_liquidity' };

/** Which fleet members are switched on; `true` keeps the pre-flags call shape (all but adaptive). */
export type FleetFlags = boolean | { adaptive?: boolean; structLiq?: boolean };

/**
 * The running agents plus the disabled ones shown as paused, in cockpit order.
 *
 * The boolean form is backwards compatible: it only gates the adaptive agent
 * (the historical call), and every other fleet member is assumed enabled.
 */
export function fleetRuntimes(running: AgentRuntime[], flags: FleetFlags): AgentRuntime[] {
  const adaptiveEnabled = typeof flags === 'boolean' ? flags : flags.adaptive !== false;
  const structLiqEnabled = typeof flags === 'boolean' ? true : flags.structLiq !== false;
  const disabled = [
    ...(adaptiveEnabled ? [] : [ADAPTIVE_DISABLED_RUNTIME]),
    ...(structLiqEnabled ? [] : [STRUCT_LIQ_DISABLED_RUNTIME]),
  ];
  return [...running, ...disabled].sort((a, b) => FLEET_ORDER.indexOf(a.id) - FLEET_ORDER.indexOf(b.id));
}

/** The venue the cockpit names: the remote broker with its live state, else the local paper engine or live Binance. */
export function venueInfo(status: VenueStatus | null, mode: Mode): AppState['venue'] {
  if (status) return { name: `${status.name} (${status.accountId})`, state: status.state };
  return { name: mode === 'live' ? 'BINANCE FUTURES' : 'local paper engine', state: 'local' };
}

/** Skips a call while the previous one is still running: a slow venue must not let two loops act on the same signals. */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let isRunning = false;
  return async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await task();
    } finally {
      isRunning = false;
    }
  };
}
