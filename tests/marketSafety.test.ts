import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessSafety, type SafetyInput } from '../src/market/MarketSafety.js';

const NOW = 10_000_000;
const healthy: SafetyInput = {
  now: NOW, mark: 100, lastTickAt: NOW - 1_000, markAt: NOW - 2_000, exchangeStatus: 'TRADING',
  latestClosed15mOpen: NOW - 20 * 60_000, derivativesAsOf: NOW - 30_000,
  shock: { level: 'NORMAL', retZ: 0.2, volZ: 0.1, spreadMult: 1, reason: '' },
  tickStaleMs: 15_000, markStaleMs: 30_000,
};
const verdict = (overrides: Partial<SafetyInput>) => assessSafety({ ...healthy, ...overrides });

test('should be NORMAL with fresh, valid inputs', () => {
  assert.deepEqual(assessSafety(healthy), { level: 'NORMAL', reasons: [] });
});

test('should HALT on a missing, zero, negative or non-finite mark', () => {
  for (const mark of [undefined, 0, -5, NaN, Infinity]) assert.equal(verdict({ mark }).level, 'HALT');
});

test('should HALT when the exchange reports the symbol is not trading, but not when the status is unknown', () => {
  assert.equal(verdict({ exchangeStatus: 'BREAK' }).level, 'HALT');
  assert.equal(verdict({ exchangeStatus: undefined }).level, 'NORMAL');
});

test('should only block entries when the websocket is stale but the REST mark is fresh', () => {
  const v = verdict({ lastTickAt: NOW - 60_000 });
  assert.equal(v.level, 'NO_ENTRY');
  assert.match(v.reasons[0]!, /websocket tick stale/);
});

test('should HALT when both the tick and the REST mark are stale or never seen', () => {
  assert.equal(verdict({ lastTickAt: NOW - 60_000, markAt: NOW - 120_000 }).level, 'HALT');
  assert.equal(verdict({ lastTickAt: undefined, markAt: undefined }).level, 'HALT');
});

test('should block entries on a stale 15m candle, stale derivatives, or a shock', () => {
  assert.equal(verdict({ latestClosed15mOpen: NOW - 60 * 60_000 }).level, 'NO_ENTRY');
  assert.equal(verdict({ derivativesAsOf: NOW - 10 * 60_000 }).level, 'NO_ENTRY');
  const shock = verdict({ shock: { level: 'SHOCK', retZ: 5, volZ: 6, spreadMult: 3, reason: 'retZ=5.0' } });
  assert.equal(shock.level, 'NO_ENTRY');
  assert.match(shock.reasons[0]!, /shock/);
});

test('should skip optional checks when their inputs are not supplied', () => {
  assert.equal(verdict({ latestClosed15mOpen: undefined, derivativesAsOf: undefined, shock: undefined }).level, 'NORMAL');
});

test('should return the worst level and every reason when several rules fire', () => {
  const v = verdict({ mark: undefined, shock: { level: 'SHOCK', retZ: 5, volZ: 6, spreadMult: 3, reason: 'x' }, lastTickAt: NOW - 60_000 });
  assert.equal(v.level, 'HALT');
  assert.equal(v.reasons.length, 3);
});
