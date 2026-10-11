import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceSmcTradeLifecycle,
  createSmcTradeLifecycle,
  type SmcTradeLifecycle,
} from '../src/strategies/smc-ml/SmcTradeLifecycle.js';

const base = () =>
  createSmcTradeLifecycle({
    setupId: 'BTCUSDT:LONG:BOS:1000',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    initialQty: 1,
    entryPrice: 100,
    initialRisk: 10,
    tp1: 110,
    tp2: 120,
    stopPrice: 90,
  });

test('TP1 partial is emitted exactly once', () => {
  let state = base();
  const first = advanceSmcTradeLifecycle(state, { markPrice: 110, positionQty: 1 });
  assert.equal(first.actions[0]?.type, 'PARTIAL_CLOSE');
  assert.equal(first.actions[0]?.fraction, 0.5);
  assert.equal(first.state.tp1Executed, true);

  const second = advanceSmcTradeLifecycle(first.state, { markPrice: 111, positionQty: 0.5 });
  assert.equal(second.actions.some((a) => a.type === 'PARTIAL_CLOSE'), false);
});

test('breakeven is armed only after TP1 and never loosens protection', () => {
  let state = base();
  const tp1 = advanceSmcTradeLifecycle(state, { markPrice: 110, positionQty: 1 });
  state = tp1.state;

  const be = advanceSmcTradeLifecycle(state, { markPrice: 111, positionQty: 0.5 });
  assert.ok(be.actions.some((a) => a.type === 'MOVE_STOP' && a.stopPrice === 100));
  assert.equal(be.state.breakevenActivated, true);

  const later = advanceSmcTradeLifecycle(be.state, { markPrice: 112, positionQty: 0.5 });
  assert.equal(later.actions.some((a) => a.type === 'MOVE_STOP' && a.stopPrice < 100), false);
});

test('long trailing stop only moves upward after trailing threshold', () => {
  let state = base();
  state = advanceSmcTradeLifecycle(state, { markPrice: 110, positionQty: 1 }).state;
  state = advanceSmcTradeLifecycle(state, { markPrice: 112, positionQty: 0.5 }).state;

  const trail = advanceSmcTradeLifecycle(state, { markPrice: 118, positionQty: 0.5 });
  assert.ok(trail.actions.some((a) => a.type === 'MOVE_STOP'));
  const stop = trail.state.stopPrice;

  const pullback = advanceSmcTradeLifecycle(trail.state, { markPrice: 113, positionQty: 0.5 });
  assert.equal(pullback.state.stopPrice, stop);
  assert.equal(
    pullback.actions.filter((a) => a.type === 'MOVE_STOP').every((a) => a.stopPrice >= stop),
    true,
  );
});

test('short trailing stop only moves downward after trailing threshold', () => {
  let state = createSmcTradeLifecycle({
    setupId: 'BTCUSDT:SHORT:BOS:1000',
    symbol: 'BTCUSDT',
    direction: 'SHORT',
    initialQty: 1,
    entryPrice: 100,
    initialRisk: 10,
    tp1: 90,
    tp2: 80,
    stopPrice: 110,
  });

  state = advanceSmcTradeLifecycle(state, { markPrice: 90, positionQty: 1 }).state;
  state = advanceSmcTradeLifecycle(state, { markPrice: 88, positionQty: 0.5 }).state;

  const trail = advanceSmcTradeLifecycle(state, { markPrice: 82, positionQty: 0.5 });
  assert.ok(trail.actions.some((a) => a.type === 'MOVE_STOP'));
  const stop = trail.state.stopPrice;

  const bounce = advanceSmcTradeLifecycle(trail.state, { markPrice: 87, positionQty: 0.5 });
  assert.equal(bounce.state.stopPrice, stop);
  assert.equal(
    bounce.actions.filter((a) => a.type === 'MOVE_STOP').every((a) => a.stopPrice <= stop),
    true,
  );
});

test('TP2 closes the remaining position and lifecycle becomes terminal', () => {
  let state = base();
  state = advanceSmcTradeLifecycle(state, { markPrice: 110, positionQty: 1 }).state;
  state = advanceSmcTradeLifecycle(state, { markPrice: 111, positionQty: 0.5 }).state;

  const result = advanceSmcTradeLifecycle(state, { markPrice: 120, positionQty: 0.5 });
  assert.deepEqual(result.actions.map((a) => a.type), ['CLOSE_REMAINING']);
  assert.equal(result.state.phase, 'CLOSED');
  assert.equal(result.state.closedReason, 'TP2');
});

test('external close prevents further lifecycle orders', () => {
  let state = base();
  const result = advanceSmcTradeLifecycle(state, { markPrice: 105, positionQty: 0 });
  assert.deepEqual(result.actions, []);
  assert.equal(result.state.phase, 'CLOSED');
  assert.equal(result.state.closedReason, 'EXTERNAL_CLOSE');
});

test('custom lifecycle thresholds are deterministic', () => {
  const state = createSmcTradeLifecycle({
    setupId: 'BTCUSDT:LONG:BOS:2000',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    initialQty: 2,
    entryPrice: 100,
    initialRisk: 10,
    tp1: 110,
    tp2: 130,
    stopPrice: 90,
    config: {
      tp1Fraction: 0.25,
      breakevenBufferR: 0.1,
      trailingStartR: 2,
      trailingDistanceR: 0.5,
    },
  });

  const result = advanceSmcTradeLifecycle(state, { markPrice: 120, positionQty: 2 });
  assert.equal(result.actions[0]?.type, 'PARTIAL_CLOSE');
  assert.equal(result.actions[0]?.fraction, 0.25);
  assert.equal(result.state.trailingActivated, false);
});
