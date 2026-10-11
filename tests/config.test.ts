import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LIVE_ACK_PHRASE, loadConfig } from '../src/config.js';

const BASE = { DHAN_CLIENT_ID: '1100000001', DHAN_ACCESS_TOKEN: 'token' };

describe('loadConfig', () => {
  it('loads paper-mode defaults that trade NIFTY with one lot and a 1% risk budget', () => {
    const config = loadConfig(BASE);
    assert.equal(config.mode, 'paper');
    assert.deepEqual(config.underlyings, [{ symbol: 'NIFTY', optionSegment: 'NSE_FNO' }]);
    assert.equal(config.capital.maxRiskPerTradePct, 1);
    assert.equal(config.llm.enabled, false);
    assert.equal(config.feed.istShiftedTimestamps, false);
  });

  it('requires Dhan credentials even in paper mode, because market data is live', () => {
    assert.throws(() => loadConfig({}), /DHAN_CLIENT_ID is required/);
  });

  it('refuses live mode without the explicit acknowledgement phrase', () => {
    assert.throws(() => loadConfig({ ...BASE, MODE: 'live' }), /LIVE_TRADING_ACK/);
    assert.throws(() => loadConfig({ ...BASE, MODE: 'live', LIVE_TRADING_ACK: 'yes' }), /LIVE_TRADING_ACK/);
    assert.equal(loadConfig({ ...BASE, MODE: 'live', LIVE_TRADING_ACK: LIVE_ACK_PHRASE }).mode, 'live');
  });

  it('rejects unknown modes and unsupported underlyings', () => {
    assert.throws(() => loadConfig({ ...BASE, MODE: 'sim' }), /MODE must be/);
    assert.throws(() => loadConfig({ ...BASE, UNDERLYINGS: 'BTC' }), /not a supported index/);
  });

  it('maps SENSEX to the BSE derivatives segment and de-duplicates the list', () => {
    const config = loadConfig({ ...BASE, UNDERLYINGS: 'nifty, sensex, NIFTY' });
    assert.deepEqual(config.underlyings, [
      { symbol: 'NIFTY', optionSegment: 'NSE_FNO' },
      { symbol: 'SENSEX', optionSegment: 'BSE_FNO' },
    ]);
  });

  it('rejects numbers outside their bounds and non-integers where integers are required', () => {
    assert.throws(() => loadConfig({ ...BASE, MAX_RISK_PER_TRADE_PCT: '50' }), /within/);
    assert.throws(() => loadConfig({ ...BASE, MAX_TRADES_PER_DAY: '2.5' }), /integer/);
    assert.throws(() => loadConfig({ ...BASE, CAPITAL_INR: 'lots' }), /must be a number/);
  });

  it('rejects flags that are not explicit booleans', () => {
    assert.throws(() => loadConfig({ ...BASE, LLM_ADVISOR: 'maybe' }), /boolean flag/);
    assert.equal(loadConfig({ ...BASE, LLM_ADVISOR: 'on' }).llm.enabled, true);
  });

  it('rejects bar sizes that Dhan intraday charts do not offer', () => {
    assert.throws(() => loadConfig({ ...BASE, BAR_MINUTES: '3' }), /BAR_MINUTES/);
    assert.equal(loadConfig({ ...BASE, BAR_MINUTES: '15' }).strategy.barMinutes, 15);
  });

  it('enforces the session ordering: entry window, then flatten, before the close', () => {
    assert.throws(() => loadConfig({ ...BASE, ENTRY_START: '10:00', ENTRY_END: '09:30' }), /ENTRY_START/);
    assert.throws(() => loadConfig({ ...BASE, ENTRY_END: '15:10', FLATTEN_BY: '15:05' }), /FLATTEN_BY/);
    assert.throws(() => loadConfig({ ...BASE, FLATTEN_BY: '15:45' }), /15:30/);
  });

  it('never lets a single trade risk more than the daily loss budget allows', () => {
    assert.throws(
      () => loadConfig({ ...BASE, MAX_RISK_PER_TRADE_PCT: '5', MAX_DAILY_LOSS_PCT: '3' }),
      /must not exceed/,
    );
  });
});

describe('loadConfig journal location', () => {
  it('defaults to a directory of daily journal files', () => {
    assert.equal(loadConfig(BASE).ops.eventLogDir, 'data/journal');
  });

  it('refuses the removed single-file EVENT_LOG_PATH instead of ignoring it', () => {
    assert.throws(() => loadConfig({ ...BASE, EVENT_LOG_PATH: 'data/events.jsonl' }), /replaced by EVENT_LOG_DIR/);
  });
});
