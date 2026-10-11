import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvSchema, riskFromEnv } from '../src/config.js';
import { ceilToStep, dec, floorToStep } from '../src/risk/primitives.js';
import {
  circuitRiskMultiplier, clusterOf, deriveCircuitState, riskLimitsFromConfig, type CircuitState, type RiskLimits,
} from '../src/risk/riskConfig.js';

const limits: RiskLimits = {
  maxRiskPerTradePercent: 1, maxLeverage: 10, minLeverage: 5, maxDailyLossPercent: 3, maxDrawdownPercent: 5,
  maxLossStreak: 4, maxConcurrentPositions: 4, maxSymbolExposurePercent: 80, maxPortfolioGrossExposurePercent: 80,
  maxCorrelatedExposurePercent: 80, maxNotionalPerTrade: 1e9, minRiskRewardRatio: 0, feeRateTaker: 0.0004,
  slippageBufferRate: 0.0002,
};

const limitsFromEnv = (env: Record<string, string>): RiskLimits => riskLimitsFromConfig(riskFromEnv(EnvSchema.parse(env)));

test('should floor and ceil to a step without float traps', () => {
  assert.equal(floorToStep(dec(0.3), dec(0.1)).toString(), '0.3');
  assert.equal(ceilToStep(dec(0.3), dec(0.1)).toString(), '0.3');
  assert.equal(floorToStep(dec(0.1).plus(0.2), dec(0.1)).toString(), '0.3');
  assert.equal(floorToStep(dec('0.0129999'), dec('0.001')).toString(), '0.012');
  assert.equal(ceilToStep(dec('0.0121'), dec('0.001')).toString(), '0.013');
  assert.equal(floorToStep(dec(117.9), dec(1)).toString(), '117');
});

test('should leave the value untouched when the step is not positive', () => {
  assert.equal(floorToStep(dec(1.234), dec(0)).toString(), '1.234');
  assert.equal(ceilToStep(dec(1.234), dec(-1)).toString(), '1.234');
});

// daily 3 % (CAUTION 1.5, REDUCED 2.25, HALTED 3), drawdown 5 %, streak 4 (CAUTION 2, REDUCED 3, HALTED 4)
const CIRCUIT_TABLE: Array<[string, number, number, number, CircuitState]> = [
  ['clean', 0, 0, 0, 'NORMAL'],
  ['daily loss just under 50%', 1.4, 0, 0, 'NORMAL'],
  ['daily loss at 50%', 1.5, 0, 0, 'CAUTION'],
  ['daily loss just under 75%', 2.2, 0, 0, 'CAUTION'],
  ['daily loss at 75%', 2.25, 0, 0, 'REDUCED'],
  ['daily loss just under 100%', 2.9, 0, 0, 'REDUCED'],
  ['daily loss at 100%', 3, 0, 0, 'HALTED'],
  ['drawdown just under limit', 0, 4.9, 0, 'NORMAL'],
  ['drawdown at limit', 0, 5, 0, 'EMERGENCY'],
  ['drawdown beats daily halt', 3, 5, 0, 'EMERGENCY'],
  ['streak 1', 0, 0, 1, 'NORMAL'],
  ['streak 2', 0, 0, 2, 'CAUTION'],
  ['streak 3', 0, 0, 3, 'REDUCED'],
  ['streak 4', 0, 0, 4, 'HALTED'],
  ['worst of daily loss and streak', 1.5, 0, 3, 'REDUCED'],
];

for (const [name, daily, drawdown, streak, expected] of CIRCUIT_TABLE) {
  test(`should derive ${expected} when ${name}`, () => {
    assert.equal(deriveCircuitState(daily, drawdown, streak, limits), expected);
  });
}

test('should map each circuit state to its risk multiplier', () => {
  const expected: Record<CircuitState, number> = { NORMAL: 1, CAUTION: 0.75, REDUCED: 0.5, HALTED: 0, EMERGENCY: 0 };
  for (const [state, multiplier] of Object.entries(expected)) {
    assert.equal(circuitRiskMultiplier(state as CircuitState), multiplier);
  }
});

test('should cluster majors separately from other alts', () => {
  assert.equal(clusterOf('BTCUSDT'), 'BTC');
  assert.equal(clusterOf('ethusdt'), 'ETH');
  assert.equal(clusterOf('SOLUSDT'), 'SOL');
  assert.equal(clusterOf('xrpusdt'), 'XRP');
  assert.equal(clusterOf('AVAXUSDT'), 'ALT');
});

test('should default new limits from the existing ones and the symbol count', () => {
  const derived = limitsFromEnv({ SYMBOLS: 'BTCUSDT,ETHUSDT,SOLUSDT' });
  assert.equal(derived.maxRiskPerTradePercent, 1);
  assert.equal(derived.minLeverage, 5);
  assert.equal(derived.maxLeverage, 10);
  assert.equal(derived.maxDrawdownPercent, 5);
  assert.equal(derived.maxDailyLossPercent, 3);
  assert.equal(derived.maxLossStreak, 4);
  assert.equal(derived.maxConcurrentPositions, 3);
  assert.equal(derived.maxPortfolioGrossExposurePercent, 80);
  assert.equal(derived.maxSymbolExposurePercent, 80);
  assert.equal(derived.maxCorrelatedExposurePercent, 80);
  assert.equal(derived.minRiskRewardRatio, 0);
  assert.equal(derived.feeRateTaker, 0.0004);
  assert.equal(derived.slippageBufferRate, 0.0002);
});

test('should follow MAX_EXPOSURE_PCT for the symbol and correlated caps unless overridden', () => {
  const followed = limitsFromEnv({ MAX_EXPOSURE_PCT: '60' });
  assert.deepEqual([followed.maxSymbolExposurePercent, followed.maxCorrelatedExposurePercent], [60, 60]);
  const overridden = limitsFromEnv({ MAX_EXPOSURE_PCT: '60', MAX_SYMBOL_EXPOSURE_PCT: '30', MAX_CORRELATED_EXPOSURE_PCT: '45' });
  assert.deepEqual([overridden.maxSymbolExposurePercent, overridden.maxCorrelatedExposurePercent], [30, 45]);
});

test('should apply explicit overrides for every new variable', () => {
  const derived = limitsFromEnv({
    MAX_DAILY_LOSS_PCT: '2', MAX_LOSS_STREAK: '6', MAX_CONCURRENT_POSITIONS: '2', MIN_RR: '1.5',
    TAKER_FEE_RATE: '0.0005', SLIPPAGE_BUFFER_RATE: '0.001',
  });
  assert.equal(derived.maxDailyLossPercent, 2);
  assert.equal(derived.maxLossStreak, 6);
  assert.equal(derived.maxConcurrentPositions, 2);
  assert.equal(derived.minRiskRewardRatio, 1.5);
  assert.equal(derived.feeRateTaker, 0.0005);
  assert.equal(derived.slippageBufferRate, 0.001);
});

test('should run the risk engine unless RISK_ENGINE=off', () => {
  assert.equal(EnvSchema.parse({}).RISK_ENGINE, 'on');
  assert.equal(EnvSchema.parse({ RISK_ENGINE: 'off' }).RISK_ENGINE, 'off');
  assert.ok(!EnvSchema.safeParse({ RISK_ENGINE: 'yes' }).success);
});

test('should reject limits that would halt trading permanently', () => {
  for (const env of [{ MAX_DAILY_LOSS_PCT: '0' }, { MAX_LOSS_STREAK: '0' }, { MAX_CONCURRENT_POSITIONS: '0' }, { MAX_LOSS_STREAK: '2.5' }]) {
    assert.ok(!EnvSchema.safeParse(env).success, JSON.stringify(env));
  }
});
