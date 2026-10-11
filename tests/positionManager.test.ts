import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Position } from '../src/types.js';
import {
  advance, DEFAULT_PM_CONFIG, initState, isStale, revertReduce,
  type PmConfig, type PmInput, type PmState,
} from '../src/position/PositionManager.js';

const cfg: PmConfig = { ...DEFAULT_PM_CONFIG, costBufferRate: 0.001 };
const lot = { step: 0.001, minQty: 0.001, minNotional: 5 };

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 'BTCUSDT_STRUCTURE-TREND-η', symbol: 'BTCUSDT', side: 'LONG', strategy: 'STRUCTURE-TREND-η',
    entry: 100, qty: 1, mark: 100, upnl: 0, upnlPct: 0, leverage: 5, marginType: 'ISOLATED', liqDistancePct: null,
    serverSl: '95', serverTp: '120', initialRisk: 5, ...overrides,
  };
}

const input = (overrides: Partial<PmInput> = {}): PmInput => ({ mark: 100, qty: 1, atr: 2, vol: 'MEDIUM', lot, ...overrides });
function stateOf(overrides: Partial<Position> = {}): PmState {
  const state = initState(position(overrides), 0, cfg);
  assert.ok(state);
  return state;
}

test('should refuse to manage a position without a numeric protective stop', () => {
  for (const serverSl of ['—', 'server', '']) assert.equal(initState(position({ serverSl }), 0, cfg), null);
  assert.equal(initState(position({ serverSl: '105', side: 'SHORT', entry: 100 }), 0, cfg)?.stop, 105);
  // a stop at or past entry needs a recorded 1R to rebuild from
  assert.equal(initState(position({ serverSl: '100.1', initialRisk: undefined }), 0, cfg), null);
});

test('should rebuild a breakeven-armed position as PROTECTED with TP1 already taken', () => {
  const state = initState(position({ serverSl: '100.1' }), 0, cfg);
  assert.ok(state);
  assert.deepEqual([state.phase, state.tp1Done, state.oneR], ['PROTECTED', true, 5]);
  const next = advance(state, input({ mark: 106 }), cfg, 1);
  assert.ok(!next.actions.some((a) => a.type === 'REDUCE'));
});

test('should pick RUNNER when the signal target is beyond TP2 and TARGET when it is not', () => {
  assert.equal(stateOf({ serverTp: '120' }).mode, 'RUNNER'); // 4R
  assert.equal(stateOf({ serverTp: 'trail' }).mode, 'RUNNER');
  assert.equal(stateOf({ serverTp: '110' }).mode, 'TARGET'); // exactly 2R is not beyond TP2
  assert.equal(stateOf({ serverTp: '108' }).mode, 'TARGET');
});

test('should always use TARGET mode for mean reversion, whatever the target distance', () => {
  assert.equal(stateOf({ strategy: 'MEAN-REVERT-θ', serverTp: '130' }).mode, 'TARGET');
});

test('should do nothing below 1R except track the extreme', () => {
  const result = advance(stateOf(), input({ mark: 104 }), cfg, 1);
  assert.deepEqual(result.actions, []);
  assert.equal(result.state.extreme, 104);
  assert.equal(result.state.phase, 'INITIAL');
});

test('should take TP1 at 1R, then arm breakeven above entry by the cost buffer', () => {
  const result = advance(stateOf(), input({ mark: 105 }), cfg, 1);
  assert.deepEqual(result.actions[0], { type: 'REDUCE', qty: 0.35, reason: 'TP1' });
  const move = result.actions[1];
  assert.equal(move?.type, 'MOVE_STOP');
  assert.ok(move?.type === 'MOVE_STOP' && Math.abs(move.stop - 100.1) < 1e-9 && move.reason === 'BREAKEVEN');
  assert.equal(result.state.phase, 'PROTECTED');
  assert.ok(result.state.tp1Done);
});

test('should not repeat TP1 on the next tick', () => {
  const first = advance(stateOf(), input({ mark: 105 }), cfg, 1);
  const second = advance(first.state, input({ mark: 105.2, qty: 0.65 }), cfg, 2);
  assert.ok(!second.actions.some((a) => a.type === 'REDUCE'));
});

test('should take TP2 at 2R in RUNNER mode, drop the fixed target and start trailing', () => {
  const afterTp1 = advance(stateOf(), input({ mark: 105 }), cfg, 1).state;
  const result = advance(afterTp1, input({ mark: 110, qty: 0.65 }), cfg, 2);
  assert.deepEqual(result.actions.find((a) => a.type === 'REDUCE'), { type: 'REDUCE', qty: 0.3, reason: 'TP2' });
  assert.equal(result.state.phase, 'TRAILING');
  assert.equal(result.state.target, null);
});

test('should keep the signal target and skip TP2 in TARGET mode', () => {
  const afterTp1 = advance(stateOf({ serverTp: '109' }), input({ mark: 105 }), cfg, 1).state;
  const result = advance(afterTp1, input({ mark: 108, qty: 0.65 }), cfg, 2);
  assert.ok(!result.actions.some((a) => a.type === 'REDUCE'));
  assert.equal(result.state.target, 109);
});

test('should emit both partials in order when one tick gaps through TP1 and TP2', () => {
  const result = advance(stateOf(), input({ mark: 112 }), cfg, 1);
  assert.deepEqual(result.actions.filter((a) => a.type === 'REDUCE').map((a) => a.type === 'REDUCE' && a.reason), ['TP1', 'TP2']);
  assert.equal(result.state.reducedQty, 0.65);
});

test('should trail a chandelier from the extreme with the volatility multiplier', () => {
  let state = advance(stateOf(), input({ mark: 105 }), cfg, 1).state;
  const high = advance(state, input({ mark: 112, qty: 0.65, vol: 'HIGH' }), cfg, 2); // extreme 112, k=3.2, atr 2 -> 105.6
  const move = high.actions.find((a) => a.type === 'MOVE_STOP');
  assert.ok(move?.type === 'MOVE_STOP');
  assert.ok(Math.abs(move.stop - (112 - 3.2 * 2)) < 1e-9);
  assert.equal(move.reason, 'TRAIL');
  state = high.state;
  const low = advance(stateOf(), input({ mark: 112, vol: 'LOW' }), cfg, 2); // k=2.0 -> 108
  const lowMove = low.actions.find((a) => a.type === 'MOVE_STOP');
  assert.ok(lowMove?.type === 'MOVE_STOP' && Math.abs(lowMove.stop - 108) < 1e-9);
  assert.ok(state.stop > 100);
});

test('should only ratchet: a pullback never loosens the stop', () => {
  const up = advance(stateOf(), input({ mark: 112 }), cfg, 1);
  const back = advance(up.state, input({ mark: 108, qty: 0.35 }), cfg, 2);
  assert.ok(!back.actions.some((a) => a.type === 'MOVE_STOP'));
  assert.equal(back.state.stop, up.state.stop);
});

test('should prefer a tighter structure stop over the chandelier', () => {
  const afterTp1 = advance(stateOf(), input({ mark: 105 }), cfg, 1).state;
  const result = advance(afterTp1, input({ mark: 108, qty: 0.65, swingStop: 106.5 }), cfg, 2); // chandelier 108-5=103 < 106.5
  const move = result.actions.find((a) => a.type === 'MOVE_STOP');
  assert.ok(move?.type === 'MOVE_STOP' && move.stop === 106.5 && move.reason === 'STRUCTURE');
});

test('should ignore a structure level on the wrong side of the mark', () => {
  const afterTp1 = advance(stateOf(), input({ mark: 105 }), cfg, 1).state;
  const result = advance(afterTp1, input({ mark: 108, qty: 0.65, swingStop: 109 }), cfg, 2);
  const move = result.actions.find((a) => a.type === 'MOVE_STOP');
  assert.ok(!(move?.type === 'MOVE_STOP' && move.stop === 109));
});

test('should never place a trail closer than the minimum gap to the mark', () => {
  const afterTp1 = advance(stateOf(), input({ mark: 105 }), cfg, 1).state;
  // swing level just below the mark: clamped to mark - 0.25 ATR = 107.5
  const result = advance(afterTp1, input({ mark: 108, qty: 0.65, swingStop: 107.9 }), cfg, 2);
  const move = result.actions.find((a) => a.type === 'MOVE_STOP');
  assert.ok(move?.type === 'MOVE_STOP' && move.stop <= 108 - 0.25 * 2 + 1e-9);
});

test('should mirror every rule for shorts', () => {
  const short = { side: 'SHORT' as const, serverSl: '105', serverTp: '80' };
  const result = advance(stateOf(short), input({ mark: 95 }), cfg, 1);
  assert.deepEqual(result.actions[0], { type: 'REDUCE', qty: 0.35, reason: 'TP1' });
  const move = result.actions[1];
  assert.ok(move?.type === 'MOVE_STOP' && Math.abs(move.stop - 99.9) < 1e-9);
  const low = advance(result.state, input({ mark: 88, qty: 0.65 }), cfg, 2);
  assert.ok(low.actions.some((a) => a.type === 'REDUCE' && a.reason === 'TP2'));
  const trail = low.actions.find((a) => a.type === 'MOVE_STOP');
  assert.ok(trail?.type === 'MOVE_STOP' && Math.abs(trail.stop - (88 + 2.5 * 2)) < 1e-9);
});

test('should skip a partial that would leave a remainder below the exchange minimum, but still arm breakeven', () => {
  const tiny = { ...lot, minQty: 0.4 };
  const result = advance(stateOf(), input({ mark: 105, lot: tiny }), cfg, 1);
  assert.ok(!result.actions.some((a) => a.type === 'REDUCE'));
  assert.match(result.notes.join(), /TP1 partial skipped/);
  assert.ok(result.actions.some((a) => a.type === 'MOVE_STOP' && a.reason === 'BREAKEVEN'));
});

test('should skip a partial below the minimum notional', () => {
  const result = advance(stateOf(), input({ mark: 105, lot: { ...lot, minNotional: 100 } }), cfg, 1);
  assert.ok(!result.actions.some((a) => a.type === 'REDUCE'));
});

test('should still run partials and breakeven when ATR is unavailable, and skip only the trail', () => {
  const result = advance(stateOf(), input({ mark: 112, atr: null }), cfg, 1);
  assert.equal(result.actions.filter((a) => a.type === 'REDUCE').length, 2);
  assert.ok(result.actions.every((a) => a.type !== 'MOVE_STOP' || a.reason === 'BREAKEVEN'));
});

test('should reject non-finite or non-positive inputs without changing state', () => {
  const state = stateOf();
  for (const bad of [NaN, 0, -1, Infinity]) {
    const result = advance(state, input({ mark: bad }), cfg, 1);
    assert.deepEqual(result.actions, []);
    assert.equal(result.state, state);
  }
  assert.deepEqual(advance(state, input({ qty: 0 }), cfg, 1).actions, []);
});

test('should be pure: the previous state is never mutated', () => {
  const state = stateOf();
  const snapshot = JSON.stringify(state);
  advance(state, input({ mark: 112 }), cfg, 1);
  assert.equal(JSON.stringify(state), snapshot);
});

test('should detect a scale-in or an outside quantity change as stale', () => {
  const state = stateOf();
  assert.ok(!isStale(state, position()));
  assert.ok(isStale(state, position({ qty: 1.5 })));
  assert.ok(isStale(state, position({ entry: 101 })));
  assert.ok(isStale(state, position({ side: 'SHORT' })));
  const reduced = advance(state, input({ mark: 105 }), cfg, 1).state;
  assert.ok(!isStale(reduced, position({ qty: 0.65 })));
  assert.ok(isStale(reduced, position({ qty: 1 })));
});

test('should let a failed partial be retried: reverting the flag re-emits the reduce', () => {
  const first = advance(stateOf(), input({ mark: 105 }), cfg, 1);
  const reverted = revertReduce(first.state, 'TP1', 0.35);
  assert.equal(reverted.tp1Done, false);
  assert.equal(reverted.reducedQty, 0);
  const retry = advance(reverted, input({ mark: 105.5 }), cfg, 2);
  assert.deepEqual(retry.actions.find((a) => a.type === 'REDUCE'), { type: 'REDUCE', qty: 0.35, reason: 'TP1' });
});

test('should restore the signal target when a TP2 order fails', () => {
  const afterTp1 = advance(stateOf(), input({ mark: 105 }), cfg, 1).state;
  const tp2 = advance(afterTp1, input({ mark: 110, qty: 0.65 }), cfg, 2);
  const reverted = revertReduce(tp2.state, 'TP2', 0.3);
  assert.equal(reverted.target, 120);
  assert.equal(reverted.tp2Done, false);
  assert.equal(reverted.phase, 'PROTECTED');
});
