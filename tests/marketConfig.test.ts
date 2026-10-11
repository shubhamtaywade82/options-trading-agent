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

test('should keep ops flags on by default and expose tuning defaults', () => {
  const env = EnvSchema.parse({});
  assert.equal(env.MARKET_DATA_DERIVATIVES_PERIOD, '1h');
  assert.equal(env.MARKET_DATA_MAX_CONCURRENCY, 4);
  assert.equal(env.MARKET_DATA_KLINE_LIMIT, 300);
  assert.equal(env.AUDIT, 'on');
  assert.equal(env.ALERTS, 'on');
});

test('should accept market-data tuning values and reject invalid values', () => {
  const env = EnvSchema.parse({
    MARKET_DATA_1M_TTL_MS: '20000',
    MARKET_DATA_HISTORY_LIMIT: '50',
    MARKET_DATA_ORDERBOOK_DEPTH: '25',
    MARKET_DATA_MAX_CONCURRENCY: '6',
    MARKET_DATA_DERIVATIVES_PERIOD: '5m',
  });
  assert.equal(env.MARKET_DATA_1M_TTL_MS, 20000);
  assert.equal(env.MARKET_DATA_HISTORY_LIMIT, 50);
  assert.equal(env.MARKET_DATA_ORDERBOOK_DEPTH, 25);
  assert.equal(env.MARKET_DATA_MAX_CONCURRENCY, 6);
  assert.equal(env.MARKET_DATA_DERIVATIVES_PERIOD, '5m');
  assert.ok(!EnvSchema.safeParse({ MARKET_DATA_MAX_CONCURRENCY: '0' }).success);
  assert.ok(!EnvSchema.safeParse({ MARKET_DATA_ORDERBOOK_DEPTH: '101' }).success);
});
