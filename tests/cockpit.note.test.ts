import assert from 'node:assert/strict';
import { test } from 'node:test';
import stringWidth from 'string-width';
import { renderCockpit, computeColWidths, MIN_COLS, MIN_ROWS, type CockpitProps } from '../src/ui/panels.js';
import type { AgentId, AgentState } from '../src/types.js';

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

const FLEET: Array<[AgentId, AgentState['status'], string]> = [
  ['FUNDING-ARB-α', 'RUNNING', 'funding_rate_harvest'], ['MOMENTUM-γ', 'RUNNING', 'ema_momentum'],
  ['ADAPTIVE-ST-ζ', 'RUNNING', 'ml_adaptive_supertrend'], ['RISK-MGR-δ', 'WATCHING', 'liquidation_guard_isolated'], ['EXECUTOR-ε', 'RUNNING', 'binance_order_routing'],
];

function propsWith(riskNote: string | undefined, totalWidth: number, totalHeight: number): CockpitProps {
  const agents: AgentState[] = FLEET.map(([id, status, strategy]) =>
    ({ id, status, strategy, positions: 0, winRate: null, pnl: 0, ...(id === 'RISK-MGR-δ' ? { note: riskNote } : {}) }));
  return {
    mode: 'paper', time: '12:00:00', equity: 100_000, upnl: 0, marginUsed: 0, positions: [], selPos: 0, agents, logs: [], spotPrices: {}, isSyncing: false,
    totalWidth, totalHeight, initialEquity: 100_000, totalPnl: 0, totalPnlPct: 0, successRate: null, sharpe: null, maxDd: 0, var95: null, liqEvents: 0,
    sessionDecisions: 0, sessionExecuted: 0, sessionMonitored: 0, apiWeight: 0, wsStatus: 'down', exposurePct: 0, minLiqDistancePct: null, corrBtcEth: null,
    funding: {}, strategyMetrics: null, venue: { name: 'local paper engine', state: 'local' },
  };
}

const riskRow = (props: CockpitProps): string => {
  const row = renderCockpit(props).map(strip).find((line) => line.includes('WATCHING'));
  assert.ok(row, 'risk agent row not rendered');
  return row;
};

const SIZES: Array<[number, number]> = [[MIN_COLS, MIN_ROWS], [MIN_COLS, 58], [160, 58]];

for (const note of ['CAUTION', 'REDUCED', 'HALTED', 'EMERGENCY']) {
  test(`should render ${note} after the status word without an ellipsis at every size`, () => {
    for (const [width, height] of SIZES) {
      const lines = renderCockpit(propsWith(note, width, height)).map(strip);
      assert.ok(riskRow(propsWith(note, width, height)).includes(`RISK-MGR-δ WATCHING ${note}`), `${note} missing at ${width}x${height}`);
      assert.ok(lines.every((line) => !line.includes('…')), `ellipsis at ${width}x${height}`);
    }
  });
}

test('should not change the cockpit height or any row other than the risk agent row', () => {
  for (const [width, height] of SIZES) {
    const plain = renderCockpit(propsWith(undefined, width, height)).map(strip);
    const noted = renderCockpit(propsWith('EMERGENCY', width, height)).map(strip);
    assert.equal(noted.length, plain.length);
    const changed = noted.filter((line, i) => line !== plain[i]);
    assert.equal(changed.length, 1, `${changed.length} rows changed at ${width}x${height}`);
    assert.ok(noted.every((line) => stringWidth(line) === stringWidth(noted[0])), `ragged row at ${width}x${height}`);
  }
});

test('should truncate an over-long note to the column and never the status', () => {
  const { c1 } = computeColWidths(MIN_COLS);
  const row = riskRow(propsWith('X'.repeat(60), MIN_COLS, MIN_ROWS));
  const fleetCell = row.slice(1, 1 + c1);
  assert.ok(fleetCell.includes('RISK-MGR-δ WATCHING X'));
  assert.ok(!fleetCell.includes('…'));
  assert.equal(fleetCell.match(/X/g)?.length, c1 - stringWidth('  ● RISK-MGR-δ WATCHING '), 'note fills the room left and no more');
  assert.equal(row[1 + c1], '│', 'the next column starts where it always did');
});

test('should render the row exactly as before when there is no note', () => {
  assert.equal(riskRow(propsWith(undefined, MIN_COLS, MIN_ROWS)), riskRow(propsWith('', MIN_COLS, MIN_ROWS)));
  assert.ok(riskRow(propsWith(undefined, MIN_COLS, MIN_ROWS)).includes('RISK-MGR-δ WATCHING '));
});

test('should render the KILL-SWITCH note in full after the status word without an ellipsis at every size', () => {
  for (const [width, height] of SIZES) {
    const lines = renderCockpit(propsWith('KILL-SWITCH', width, height)).map(strip);
    assert.ok(riskRow(propsWith('KILL-SWITCH', width, height)).includes('RISK-MGR-δ WATCHING KILL-SWITCH'), `note missing at ${width}x${height}`);
    assert.ok(lines.every((line) => !line.includes('…')), `ellipsis at ${width}x${height}`);
  }
});
