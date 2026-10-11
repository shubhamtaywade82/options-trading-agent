import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvSchema } from '../src/config.js';

const URL = 'http://127.0.0.1:3100';

test('should refuse a remote paper exchange without an explicit account id, naming the variable', () => {
  for (const env of [{ PAPER_EXCHANGE_URL: URL }, { PAPER_EXCHANGE_URL: URL, PAPER_EXCHANGE_ACCOUNT_ID: '  ' }]) {
    const result = EnvSchema.safeParse(env);
    assert.ok(!result.success);
    assert.deepEqual(result.error.issues.map((issue) => issue.path.join('.')), ['PAPER_EXCHANGE_ACCOUNT_ID']);
    assert.match(result.error.issues[0].message, /PAPER_EXCHANGE_ACCOUNT_ID.*PAPER_EXCHANGE_URL/);
  }
});

test('should accept a remote paper exchange with an account id and keep the id as given', () => {
  assert.equal(EnvSchema.parse({ PAPER_EXCHANGE_URL: URL, PAPER_EXCHANGE_ACCOUNT_ID: 'crypto-agent' }).PAPER_EXCHANGE_ACCOUNT_ID, 'crypto-agent');
});

test('should not need an account id for local paper or live mode', () => {
  assert.ok(EnvSchema.safeParse({}).success);
  assert.ok(EnvSchema.safeParse({ MODE: 'live', PAPER_EXCHANGE_URL: URL }).success);
});

test('should default the ops flags on and the ops files under data/', () => {
  const env = EnvSchema.parse({});
  assert.deepEqual([env.AUDIT, env.ALERTS, env.EVENTS_PATH, env.NOTIFICATIONS_PATH], ['on', 'on', 'data/events.jsonl', 'data/notifications.json']);
});

test('should accept on/off ops flags, reject anything else, and treat a blank path as unset', () => {
  assert.deepEqual([EnvSchema.parse({ AUDIT: 'on', ALERTS: 'on', EVENTS_PATH: ' /tmp/e.jsonl ' }).AUDIT, EnvSchema.parse({ EVENTS_PATH: ' /tmp/e.jsonl ' }).EVENTS_PATH], ['on', '/tmp/e.jsonl']);
  assert.ok(!EnvSchema.safeParse({ ALERTS: 'yes' }).success);
  assert.equal(EnvSchema.parse({ NOTIFICATIONS_PATH: '  ' }).NOTIFICATIONS_PATH, 'data/notifications.json');
});

test('struct-liq tuning knobs default to the strategy defaults and accept overrides', () => {
  const defaults = EnvSchema.parse({});
  assert.deepEqual(
    [defaults.STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES, defaults.STRUCT_LIQ_MIN_REWARD_RISK],
    [6, 1.5],
  );

  const tuned = EnvSchema.parse({ STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES: '24', STRUCT_LIQ_MIN_REWARD_RISK: '0.8' });
  assert.deepEqual([tuned.STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES, tuned.STRUCT_LIQ_MIN_REWARD_RISK], [24, 0.8]);
});

test('struct-liq sweep age must be a positive integer; reward-risk floor must be non-negative', () => {
  assert.ok(!EnvSchema.safeParse({ STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES: '0' }).success);
  assert.ok(!EnvSchema.safeParse({ STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES: '2.5' }).success);
  assert.ok(!EnvSchema.safeParse({ STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES: 'abc' }).success);
  assert.ok(!EnvSchema.safeParse({ STRUCT_LIQ_MIN_REWARD_RISK: '-1' }).success);
  // RR 0 is allowed: it disables the reward-risk floor entirely (diagnostic setting)
  assert.ok(EnvSchema.safeParse({ STRUCT_LIQ_MIN_REWARD_RISK: '0' }).success);
});
