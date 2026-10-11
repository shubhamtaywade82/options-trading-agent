import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { config } from '../src/config.js';
import stringWidth from 'string-width';
import { useStore } from '../src/store.js';
import { formatLocalTime } from '../src/ui/format.js';
import { clampSelection, MIN_COLS, MIN_ROWS, renderCockpit, type CockpitProps } from '../src/ui/panels.js';
import type { AgentId, AgentState, Position, StrategyMetrics } from '../src/types.js';

export const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

export function baseProps(overrides: Partial<CockpitProps> = {}): CockpitProps {
  return {
    mode: 'paper', time: '12:00:00', equity: 100_000, upnl: 0, marginUsed: 0, positions: [], selPos: 0,
    agents: [], logs: [], spotPrices: {}, isSyncing: false, totalWidth: 160, totalHeight: 58,
    initialEquity: 100_000, totalPnl: 0, totalPnlPct: 0, successRate: null, sharpe: null, maxDd: 0, var95: null,
    liqEvents: 0, sessionDecisions: 0, sessionExecuted: 0, sessionMonitored: 0, apiWeight: 0, wsStatus: 'down',
    exposurePct: 0, minLiqDistancePct: null, corrBtcEth: null, funding: {}, strategyMetrics: null, venue: { name: 'local paper engine', state: 'local' }, ...overrides,
  } as CockpitProps;
}

// Bare numbers are contextual so a real price or count can never collide with them
const FORBIDDEN = ['27,766', '142 decisions', '96.4', 'Sharpe 2.84', '1,842', '18.7x', '0.91 high', '247/1200', 'ETH/USDT', 'SOL/USDT', 'BTC/ETH pairs', '127.40', '2750', '7h58m', '1.8x', '2.1x'];
const render = (props: CockpitProps) => renderCockpit(props).map(strip).join('\n');

function realisticProps(): CockpitProps {
  const symbol = config.symbols[0];
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001, minQty: 0, minNotional: 0 });
  const position: Position = {
    id: 'p', symbol, side: 'LONG', strategy: 'ADAPTIVE-ST-ζ', entry: 81_000.5, qty: 0.012, mark: 81_100.25, upnl: 1.2, upnlPct: 0.12,
    leverage: 5, marginType: 'ISOLATED', liqDistancePct: 19.5, serverSl: '80100.5', serverTp: '83000', initialRisk: 900,
  };
  const agents: AgentState[] = [{ id: 'ADAPTIVE-ST-ζ', status: 'RUNNING', strategy: 'ml_adaptive_supertrend', positions: 1, winRate: 62.5, pnl: 12.34 }];
  return baseProps({
    equity: 100_012.34, upnl: 1.2, marginUsed: 194.6, positions: [position], agents, initialEquity: 100_000, totalPnl: 12.34, totalPnlPct: 0.01234,
    successRate: 62.5, sharpe: null, maxDd: -0.5, var95: null, liqEvents: 0, sessionDecisions: 9, sessionExecuted: 3, sessionMonitored: 6,
    apiWeight: 31, wsStatus: 'connected', exposurePct: 0.97, minLiqDistancePct: 19.5, corrBtcEth: 0.84, funding: {}, strategyMetrics: null,
    spotPrices: { [symbol.replace('USDT', '')]: { price: 81_100.25, changePct: 1.5, low24h: 80_000, high24h: 82_000, volumeQuote: 2e9 } },
  } as Partial<CockpitProps>);
}

test('should render a full-width cockpit without throwing for an empty state', () => {
  const lines = renderCockpit(baseProps());
  assert.ok(lines.length >= 28);
  for (const line of lines) assert.ok(strip(line).length > 0);
});

test('should show no known mock literal with an empty state', () => {
  const text = render(baseProps());
  for (const literal of FORBIDDEN) assert.ok(!text.includes(literal), `mock literal "${literal}" is still rendered`);
});

test('should show no known mock literal with a realistic state', () => {
  const text = render(realisticProps());
  for (const literal of FORBIDDEN) assert.ok(!text.includes(literal), `mock literal "${literal}" is still rendered`);
});

test('should render real values with per-symbol precision', () => {
  const text = render(realisticProps());
  assert.ok(text.includes('+$12.34'));
  assert.ok(text.includes('POSITIONS (1 open)'));
  assert.ok(text.includes('AGENT FLEET (1 active)'));
  assert.ok(text.includes('81,000.50'));
  assert.ok(text.includes('0.012'));
  assert.ok(text.includes('Session 9 decisions'));
  assert.ok(text.includes('Close ' + config.symbols[0]));
  assert.ok(text.includes('api weight 31/2400'));
});

test('should list every configured symbol as an asset row and nothing else', () => {
  const text = render(realisticProps());
  for (const symbol of config.symbols) assert.ok(text.includes(symbol.replace('USDT', '')));
});

test('should show placeholders, not demo values, before data arrives', () => {
  const text = render(baseProps());
  assert.ok(text.includes('no open positions'));
  assert.ok(text.includes('no open position selected'));
  assert.ok(text.includes('POSITIONS (0 open)'));
  assert.ok(text.includes('AGENT FLEET (0 active)'));
});

function metricsFor(symbols: string[]): StrategyMetrics {
  const [first, second] = symbols;
  return {
    fundingBySymbol: { [first]: { rate: 0.0001, apr: 10.95 }, [second]: { rate: 0.0003, apr: 32.85 } },
    nextFundingCountdown: '3h12m', estNextFundingUsd: -0.37, zscoreBtcEth: -1.234,
    atrBySymbol: { [first]: 210.4, [second]: 0 },
    adaptive: { [first]: { direction: 'BULLISH', regime: 'HIGH', superTrend: 80_412.3, distanceAtr: 3.27 } },
    momentumAboveEma50: { up: 1, total: 2 },
  };
}

test('should derive funding, momentum, carry and strategy rows from telemetry', () => {
  const [first, second] = config.symbols;
  const text = render(baseProps({ strategyMetrics: metricsFor(config.symbols) }));
  assert.ok(text.includes('USDM Funding 8h: +0.0200% │ settle in 3h12m'));
  assert.ok(text.includes('MIXED (1 of 2 above EMA50)'));
  assert.ok(text.includes('POSITIVE (+21.90% APR avg)'));
  assert.ok(text.includes(`${first.replace('USDT', '')} +0.0100% (10.95% APR)`));
  assert.ok(text.includes(`${first.replace('USDT', '')} ATR 210.40  ${second.replace('USDT', '')} ATR —`));
  assert.ok(text.includes('next 3h12m est -$0.37'));
  assert.ok(text.includes('BTC/ETH z -1.23 (info only)'));
  assert.ok(text.includes('HIGH 80,412.30 (3.27 ATR)'));
});

test('should show warming-up placeholders when telemetry has no adaptive bars', () => {
  const text = render(baseProps());
  assert.ok(text.includes('warming up (needs 109 closed candles)'));
  assert.ok(text.includes('FUNDING-ARB │ — │ next — est —'));
});

test('should format stop and take-profit as prices when numeric and as labels otherwise', () => {
  const props = realisticProps();
  const [position] = props.positions;
  const numeric = render({ ...props, positions: [position] });
  assert.ok(numeric.includes('SL $80,100.50 │ TP $83,000.00'));
  const labelled = render({ ...props, positions: [{ ...position, serverSl: 'STOP_MARKET', serverTp: '' }] });
  assert.ok(labelled.includes('SL STOP_MARKET │ TP —'));
});

test('should render real log rows and leave the rest blank', () => {
  const logs = [{ ts: Date.UTC(2026, 8, 19, 9, 41, 3), agent: 'SYSTEM' as const, msg: 'ws reconnected', level: 'warn' as const }];
  const text = render(baseProps({ logs }));
  assert.ok(text.includes('09:41:03 SYSTEM'));
  assert.ok(text.includes('ws reconnected'));
  assert.ok(!text.includes('MANUAL'));
});

const REMOTE_NAME = 'paper_exchange (crypto-agent)';
const at = (venue: CockpitProps['venue'], mode: CockpitProps['mode'] = 'paper') => render(baseProps({ venue, mode }));

test('should show websocket, evaluation interval and venue in the footer, and mark the equity stale whenever the venue is degraded or down', () => {
  const text = render(realisticProps());
  assert.ok(text.includes('ws ●connected') && text.includes('eval 8s'));
  for (const state of ['connected', 'degraded', 'down'] as const) {
    const remote = at({ name: REMOTE_NAME, state });
    assert.ok(remote.includes(`mode PAPER │ venue ${REMOTE_NAME} ●${state}`) && remote.includes('(paper) stale') === (state !== 'connected'), state);
  }
  const [local, live] = [at({ name: 'local paper engine', state: 'local' }), at({ name: 'BINANCE FUTURES', state: 'local' }, 'live')];
  assert.ok(local.includes('mode PAPER │ venue local paper engine') && live.includes('mode LIVE │ venue BINANCE FUTURES'));
  assert.ok(!local.includes('stale') && !live.includes('stale') && !local.includes('●local') && !live.includes('●local'));
});

const FLEET: AgentId[] = ['FUNDING-ARB-α', 'MOMENTUM-γ', 'ADAPTIVE-ST-ζ', 'RISK-MGR-δ', 'EXECUTOR-ε'];
const WORST_UPNL = ['-$1,234.56', '+$987.65', '+$12.34'];

// Real symbols differ by orders of magnitude, so each configured symbol gets its own price scale and precision
const MARKETS = [{ price: 123_456.78, digits: 2 }, { price: 3_456.78, digits: 2 }, { price: 123.4567, digits: 4 }, { price: 0.6123, digits: 4 }];
const marketAt = (index: number) => MARKETS[index % MARKETS.length];
const perSymbol = <T>(make: (price: number) => T, key = (symbol: string) => symbol) =>
  Object.fromEntries(config.symbols.map((symbol, i) => [key(symbol), make(marketAt(i).price)]));

function worstCasePositions(): Position[] {
  config.symbols.forEach((symbol, i) => setSymbolRules(symbol, { pricePrecision: marketAt(i).digits, quantityPrecision: 1, tickSize: 0.0001, stepSize: 0.1, minQty: 0, minNotional: 0 }));
  return [0, 1, 2].map((i) => {
    const { price } = marketAt(i);
    return {
      id: `p${i}`, symbol: config.symbols[i % config.symbols.length], side: i === 0 ? 'SHORT' : 'LONG', strategy: 'FUNDING-ARB-α', posType: 'LONG/SHORT', entry: price, qty: 12345.6, mark: price * 1.005,
      upnl: [-1234.56, 987.65, 12.34][i], upnlPct: -3.21, leverage: 10, marginType: 'ISOLATED', liqDistancePct: 12.34, serverSl: String(price * 0.98), serverTp: String(price * 1.05), initialRisk: price / 100,
    } as Position;
  });
}

function worstCaseMetrics(): StrategyMetrics {
  return {
    fundingBySymbol: perSymbol(() => ({ rate: -0.00123, apr: -134.69 })), nextFundingCountdown: '12h59m', estNextFundingUsd: -123.45, zscoreBtcEth: -1.234,
    atrBySymbol: perSymbol((price) => price / 100),
    adaptive: perSymbol((price) => ({ direction: 'BULLISH' as const, regime: 'MEDIUM' as const, superTrend: price * 0.98, distanceAtr: 12.34 })),
    momentumAboveEma50: { up: 3, total: 4 },
  };
}

export function worstCaseProps(): CockpitProps {
  const agents: AgentState[] = FLEET.map((id) => ({ id, status: 'RUNNING', strategy: 'funding_rate_harvest', positions: 3, winRate: 100, pnl: -1234.56 }));
  const spotPrices = perSymbol((price) => ({ price, changePct: -12.34, low24h: price * 0.99, high24h: price * 1.01, volumeQuote: 12.34e9, sparkline: '▁▂▃▄▅▆▇█▇▆▅▄' }), (symbol) => symbol.replace('USDT', ''));
  return baseProps({
    equity: 101_994.6, initialEquity: 100_000, upnl: -234.56, marginUsed: 1_994.6, positions: worstCasePositions(), agents, spotPrices, strategyMetrics: worstCaseMetrics(), funding: {},
    successRate: 100, sharpe: -12.34, venue: { name: REMOTE_NAME, state: 'connected' }, maxDd: -3.21, var95: -1234.56, exposurePct: 24.9, minLiqDistancePct: 12.34, corrBtcEth: -0.84,
    sessionDecisions: 1234, sessionExecuted: 123, sessionMonitored: 1111, apiWeight: 2399, wsStatus: 'reconnecting', liqEvents: 12,
  });
}

const SIZES: [number, number][] = [[MIN_COLS, MIN_ROWS], [200, 58]];

test('should truncate nothing and show every signed uPnL at the minimum and a wide size, connected or down', () => {
  for (const [totalWidth, totalHeight] of SIZES) {
    for (const state of ['connected', 'down'] as const) {
      const text = render({ ...worstCaseProps(), venue: { name: REMOTE_NAME, state }, totalWidth, totalHeight });
      assert.ok(!text.includes('…') && text.includes(`●${state}`), `ellipsis or venue missing at ${totalWidth}x${totalHeight} ${state}`);
      for (const upnl of WORST_UPNL) assert.ok(text.includes(upnl), `${upnl} missing at ${totalWidth}x${totalHeight}`);
    }
  }
});

test('should keep every line within the width and the height for any size at or above the minimum', () => {
  for (let width = MIN_COLS; width <= 260; width += 7) {
    for (const height of [MIN_ROWS, MIN_ROWS + 9, 90]) {
      const lines = renderCockpit({ ...worstCaseProps(), totalWidth: width, totalHeight: height });
      assert.ok(lines.length < height, `${lines.length} lines at ${width}x${height}`);
      for (const line of lines) assert.ok(stringWidth(line) <= width, `line wider than ${width}`);
      assert.ok(!lines.map(strip).join('\n').includes('…'), `ellipsis at ${width}x${height}`);
    }
  }
});

test('should close the footer box: top border, two content rows, bottom border', () => {
  for (const [totalWidth, totalHeight] of SIZES) {
    const lines = renderCockpit({ ...worstCaseProps(), totalWidth, totalHeight }).map(strip);
    const footer = lines.slice(-4);
    assert.deepEqual(footer.map((line) => line[0]), ['╭', '│', '│', '╰']);
    assert.ok(footer[1].includes('orchestrator'));
    for (const line of footer) assert.equal(stringWidth(line), totalWidth);
  }
});

// Ink clears the whole terminal on every frame once the output is as tall as the screen, so it must stay strictly shorter
test('should render strictly fewer lines than the terminal has rows for every height at or above the minimum', () => {
  for (const width of [MIN_COLS, 200]) {
    for (let height = MIN_ROWS; height <= 100; height++) {
      const lines = renderCockpit({ ...worstCaseProps(), totalWidth: width, totalHeight: height });
      assert.ok(lines.length < height, `${lines.length} lines at ${width}x${height}`);
    }
  }
  for (const [totalWidth, totalHeight] of SIZES) assert.ok(renderCockpit({ ...worstCaseProps(), totalWidth, totalHeight }).length < totalHeight);
});

test('should fit the widest realistic agent row without an ellipsis at the minimum size', () => {
  const agents: AgentState[] = FLEET.map((id) => ({ id, status: 'RUNNING', strategy: 'funding_rate_harvest', positions: 12, winRate: 100, pnl: -12_345.67 }));
  const text = render(baseProps({ agents, totalWidth: MIN_COLS, totalHeight: MIN_ROWS }));
  assert.ok(text.includes('pos 12 win 100.00% pnl -$12,345.67'));
  assert.ok(!text.includes('…'));
});

test('should show the whole fleet, Sharpe and position actions at the minimum size', () => {
  for (const props of [worstCaseProps(), baseProps({ agents: worstCaseProps().agents })]) {
    const text = render({ ...props, totalWidth: MIN_COLS, totalHeight: MIN_ROWS });
    assert.ok(text.includes('Sharpe') && text.includes('POSITION ACTIONS'));
    for (const id of FLEET) assert.ok(text.includes(id), `${id} missing`);
  }
});

test('should never throw for any width or height', () => {
  for (const width of [0, 1, 10, 79, 100, MIN_COLS - 1]) {
    for (const height of [0, 5, 39, MIN_ROWS - 1]) assert.doesNotThrow(() => renderCockpit({ ...worstCaseProps(), totalWidth: width, totalHeight: height }));
  }
});

test('should render the store seed as an empty account, not a fabricated balance', () => {
  const seed = useStore.getState();
  const text = render({ ...seed, time: '12:00:00', selPos: 0, isSyncing: false, totalWidth: MIN_COLS, totalHeight: MIN_ROWS } as CockpitProps);
  assert.ok(!text.includes('100,000'));
  assert.ok(text.includes('Equity  —'));
  assert.ok(text.includes('liq events —'));
  assert.ok(text.includes('venue — ●down') && text.includes('Equity  — (paper) stale'));
});

test('should derive total PnL from equity so the two lines never disagree', () => {
  const stale = { equity: 100_050, initialEquity: 100_000, totalPnl: 12.34, totalPnlPct: 0.01234 };
  const text = render(baseProps(stale));
  assert.ok(text.includes('+$50.00 (+0.05% total)'));
  assert.ok(!text.includes('+$12.34'));
});

test('should label session and all-time figures apart, and call live figures session', () => {
  const paper = render(baseProps({ successRate: 60, sessionDecisions: 4 }));
  assert.ok(paper.includes('Session 4 decisions'));
  assert.ok(paper.includes('║ All-time 60.00% win'));
  const live = render(baseProps({ mode: 'live', equity: 1_001.2, initialEquity: 1_000, successRate: 60 }));
  assert.ok(live.includes('+$1.20 (+0.12% session)'));
  assert.ok(live.includes('║ Session 60.00% win'));
  assert.ok(!live.includes('All-time'));
});

test('should render unattributable live figures as dashes', () => {
  const agent: AgentState = { id: 'FUNDING-ARB-α', status: 'RUNNING', strategy: 'funding_rate_harvest', positions: null, winRate: null, pnl: null };
  const strategyMetrics = { ...metricsFor(config.symbols), estNextFundingUsd: null };
  const text = render(baseProps({ mode: 'live', agents: [agent], liqEvents: null, strategyMetrics }));
  assert.ok(text.includes('pos — win — pnl —'));
  assert.ok(text.includes('est —'));
  assert.ok(text.includes('liq events —'));
  assert.ok(text.includes('disabled in live mode'));
  assert.ok(!render(baseProps({ mode: 'paper' })).includes('disabled in live mode'));
});

test('should clamp the selection into the list and to nothing when it is empty', () => {
  assert.equal(clampSelection(5, 3), 2);
  assert.equal(clampSelection(-1, 3), 0);
  assert.equal(clampSelection(0, 0), 0);
  assert.equal(clampSelection(4, 0), 0);
});

test('should display both UTC and local timezone time in header when available', () => {
  const text = render(baseProps({ time: '08:36:06', localTime: '14:06:06 IST' }));
  assert.ok(text.includes('08:36:06 UTC │ 14:06:06 IST'));
  const fallback = render(baseProps({ time: '08:36:06', localTime: '08:36:06 UTC' }));
  assert.ok(fallback.includes('08:36:06 UTC') && !fallback.includes('08:36:06 UTC │'));
  assert.match(formatLocalTime(new Date(2026, 8, 20, 14, 6, 6)), /^14:06:06(\s+[A-Za-z0-9+-:]+)?$/);
});

test('should render 15m trend instead of sparkline in asset rows', () => {
  const [first, second] = config.symbols;
  const props = baseProps({
    strategyMetrics: {
      fundingBySymbol: {}, nextFundingCountdown: null, estNextFundingUsd: null, zscoreBtcEth: null,
      atrBySymbol: {}, adaptive: { [first]: { direction: 'BULLISH', regime: 'HIGH', superTrend: 80_000, distanceAtr: 1 } },
      momentumAboveEma50: { up: 1, total: 1 },
    },
    marketIntel: {
      [second]: {
        regime: 'TREND_DOWN', htfTrend: 'BEARISH', ltfTrend: 'BEARISH', volatility: 'LOW', volatilityPct: null,
        premium: false, discount: true, positionPct: 20, fundingApr: null, fundingPct: null,
        openInterestExpansion: null, crowding: null, spreadBps: null, lastSweep: null, strategyStatus: {},
      },
    },
    spotPrices: {
      [first.replace('USDT', '')]: { price: 80_000, changePct: 1.5, low24h: 79_000, high24h: 81_000, volumeQuote: 1e9 },
      [second.replace('USDT', '')]: { price: 2_500, changePct: -2.0, low24h: 2_400, high24h: 2_600, volumeQuote: 5e8 },
    },
  });
  const text = render(props);
  assert.ok(text.includes('▲ BULLISH'), 'expected bullish trend in output');
  assert.ok(text.includes('▼ BEARISH'), 'expected bearish trend in output');
});
