import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combinedSizeMultiplier, scoreMultiplier, volatilityMultiplier } from '../src/risk/sizeMultipliers.js';

test('should shrink size as the ATR percentile rises, with the boundaries inclusive on the hotter side', () => {
  assert.deepEqual([0, 59.9, 60, 79.9, 80, 94.9, 95, 100].map(volatilityMultiplier), [1, 1, 0.75, 0.75, 0.5, 0.5, 0.25, 0.25]);
});

test('should shrink size for a marginal score and never exceed 1 for a high one', () => {
  assert.deepEqual([0, 64, 65, 74, 75, 95, 100, 250].map(scoreMultiplier), [0.5, 0.5, 0.75, 0.75, 1, 1, 1, 1]);
});

test('should treat unknown inputs as neutral rather than punishing or boosting size', () => {
  for (const bad of [undefined, NaN, Infinity]) {
    assert.equal(volatilityMultiplier(bad), 1);
    assert.equal(scoreMultiplier(bad), 1);
  }
});

test('should multiply the enabled scalers and ignore the disabled ones', () => {
  const inputs = { atrPercentile: 85, evidenceScore: 70 };
  assert.equal(combinedSizeMultiplier({ volatility: true, score: true }, inputs), 0.5 * 0.75);
  assert.equal(combinedSizeMultiplier({ volatility: true, score: false }, inputs), 0.5);
  assert.equal(combinedSizeMultiplier({ volatility: false, score: true }, inputs), 0.75);
  assert.equal(combinedSizeMultiplier({ volatility: false, score: false }, inputs), 1);
});
