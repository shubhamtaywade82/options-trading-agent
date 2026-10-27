import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LIVE_ACK_PHRASE, loadConfig } from '../src/config.js';

const SANDBOX = {
  DHAN_SANDBOX_CLIENT_ID: 'SANDBOX-CLIENT',
  DHAN_SANDBOX_ACCESS_TOKEN: 'sandbox-token',
  DHAN_SANDBOX_BASE_URL: 'https://sandbox.example.test/v2',
};

const BASE = {
  DHAN_CLIENT_ID: '1100000001',
  DHAN_ACCESS_TOKEN: 'token',
  DATABASE_URL: 'postgres://paper.test.invalid/agent',
  REDIS_URL: 'redis://cache.test.invalid:6379/0',
};

describe('loadConfig', () => {
  it('loads paper-mode defaults that trade NIFTY with one lot and a 1% risk budget', () => {
    const config = loadConfig(BASE);
    assert.equal(config.mode, 'paper');
    assert.deepEqual(config.underlyings, [{ symbol: 'NIFTY', optionSegment: 'NSE_FNO' }]);
    assert.equal(config.capital.maxRiskPerTradePct, 1);
    assert.equal(config.llm.enabled, false);
    assert.equal(config.feed.istShiftedTimestamps, false);
    assert.equal(config.feed.feedIstShifted, true, 'Dhan stamps WebSocket LTT in IST wall-clock');
  });

  it('requires Dhan credentials even in paper mode, because market data is live', () => {
    assert.throws(() => loadConfig({}), /DHAN_CLIENT_ID is required/);
  });

  it('refuses live mode without the explicit acknowledgement phrase', () => {
    assert.throws(() => loadConfig({ ...BASE, MODE: 'live' }), /LIVE_TRADING_ACK/);
    assert.throws(() => loadConfig({ ...BASE, MODE: 'live', LIVE_TRADING_ACK: 'yes' }), /LIVE_TRADING_ACK/);
    const live = { ...BASE, MODE: 'live', DATABASE_URL: 'postgres://ledger.internal/agent', REDIS_URL: 'redis://cache.internal:6379/0' };
    assert.equal(loadConfig({ ...live, LIVE_TRADING_ACK: LIVE_ACK_PHRASE }).mode, 'live');
  });

  it('refuses live risk above the real-money ceilings, whatever .env says', () => {
    const live = { ...BASE, MODE: 'live', LIVE_TRADING_ACK: LIVE_ACK_PHRASE, DATABASE_URL: 'postgres://ledger.internal/agent', REDIS_URL: 'redis://cache.internal:6379/0' };
    assert.throws(() => loadConfig({ ...live, MAX_RISK_PER_TRADE_PCT: '30', MAX_DAILY_LOSS_PCT: '50' }), /caps MAX_RISK_PER_TRADE_PCT at 2/);
    assert.throws(() => loadConfig({ ...live, MAX_DAILY_LOSS_PCT: '10' }), /caps MAX_DAILY_LOSS_PCT at 6/);
    assert.equal(loadConfig({ ...live, MAX_RISK_PER_TRADE_PCT: '2', MAX_DAILY_LOSS_PCT: '6' }).capital.maxRiskPerTradePct, 2);
    assert.equal(loadConfig({ ...BASE, MAX_RISK_PER_TRADE_PCT: '30', MAX_DAILY_LOSS_PCT: '50' }).capital.maxRiskPerTradePct, 30, 'paper is not capped');
  });

  it('accepts exactly three modes: live, sandbox and paper', () => {
    const sandbox = { ...BASE, MODE: 'sandbox', ...SANDBOX };
    assert.equal(loadConfig({ ...BASE, MODE: 'paper' }).mode, 'paper');
    assert.equal(loadConfig({ ...BASE, MODE: 'PAPER' }).mode, 'paper');
    assert.equal(loadConfig(sandbox).mode, 'sandbox');
    assert.throws(() => loadConfig({ ...BASE, MODE: 'backtest' }), /MODE must be one of live, sandbox, paper/);
  });

  it('gives sandbox its own order credentials and keeps market-data credentials separate', () => {
    const config = loadConfig({ ...BASE, MODE: 'sandbox', ...SANDBOX });
    assert.deepEqual(config.sandbox, { clientId: 'SANDBOX-CLIENT', accessToken: 'sandbox-token', baseUrl: 'https://sandbox.example.test/v2' });
    assert.equal(config.dhan.clientId, '1100000001', 'market data keeps the live client id');
    assert.equal(config.sandbox === undefined, false);
    assert.equal(loadConfig(BASE).sandbox, undefined, 'only sandbox mode carries sandbox credentials');
  });

  it('refuses sandbox mode without all three sandbox settings, and never names a token in the error', () => {
    assert.throws(() => loadConfig({ ...BASE, MODE: 'sandbox', ...SANDBOX, DHAN_SANDBOX_ACCESS_TOKEN: undefined }), /DHAN_SANDBOX_ACCESS_TOKEN/);
    assert.equal(loadConfig({ ...BASE, MODE: 'sandbox', ...SANDBOX, DHAN_SANDBOX_BASE_URL: undefined }).sandbox?.baseUrl, undefined, 'the SDK default host is used');
    assert.throws(
      () => loadConfig({ ...BASE, MODE: 'sandbox', ...SANDBOX, DHAN_SANDBOX_BASE_URL: 'http://sandbox.example.test/v2' }),
      /must be an https URL/,
    );
  });

  it('refuses a sandbox base URL that is the production host, so sandbox orders cannot reach production', () => {
    assert.throws(
      () => loadConfig({ ...BASE, MODE: 'sandbox', ...SANDBOX, DHAN_SANDBOX_BASE_URL: 'https://api.dhan.co/v2' }),
      /production host/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, MODE: 'sandbox', ...SANDBOX, DHAN_BASE_URL: 'https://gateway.example.test', DHAN_SANDBOX_BASE_URL: 'https://gateway.example.test/sandbox' }),
      /production host/,
    );
  });

  it('needs the ledger and Redis for sandbox, as for live, and does not need the live acknowledgement', () => {
    const noStores = { ...BASE, DATABASE_URL: undefined, MODE: 'sandbox', ...SANDBOX };
    assert.throws(() => loadConfig(noStores), /sandbox mode requires DATABASE_URL.*REDIS_URL/);
    assert.equal(loadConfig({ ...BASE, MODE: 'sandbox', ...SANDBOX }).mode, 'sandbox');
  });

  it('selects the paper venue: the PostgreSQL venue by default, or a paper_exchange server', () => {
    assert.equal(loadConfig({ ...BASE, MODE: 'paper' }).paper.backend, 'postgres');
    assert.equal(loadConfig({ ...BASE, MODE: 'paper' }).paper.exchange, undefined);
    assert.throws(() => loadConfig({ ...BASE, MODE: 'paper', PAPER_BACKEND: 'memory' }), /must be "postgres" or "exchange"/);
  });

  it('requires the paper_exchange URL and API key when that backend is chosen, and never echoes the key', () => {
    assert.throws(() => loadConfig({ ...BASE, MODE: 'paper', PAPER_BACKEND: 'exchange' }), /PAPER_EXCHANGE_URL and PAPER_EXCHANGE_API_KEY/);
    assert.throws(
      () => {
        try {
          loadConfig({ ...BASE, MODE: 'paper', PAPER_BACKEND: 'exchange', PAPER_EXCHANGE_URL: 'not a url', PAPER_EXCHANGE_API_KEY: 'k-secret' });
        } catch (error) {
          assert.ok(!(error as Error).message.includes('k-secret'));
          throw error;
        }
      },
      /must be a URL/,
    );
  });

  it('accepts paper_exchange over https, or over http on loopback only, and defaults the account to the Dhan client id', () => {
    const exchange = { ...BASE, MODE: 'paper', PAPER_BACKEND: 'exchange', PAPER_EXCHANGE_API_KEY: 'k' };
    const local = loadConfig({ ...exchange, PAPER_EXCHANGE_URL: 'http://127.0.0.1:3100/' });
    assert.deepEqual(local.paper.exchange, { url: 'http://127.0.0.1:3100', apiKey: 'k', accountId: BASE.DHAN_CLIENT_ID });
    assert.equal(loadConfig({ ...exchange, PAPER_EXCHANGE_URL: 'https://paper.example.test' }).paper.backend, 'exchange');
    assert.throws(() => loadConfig({ ...exchange, PAPER_EXCHANGE_URL: 'http://paper.example.test' }), /https, or http on loopback/);
    assert.equal(loadConfig({ ...exchange, PAPER_EXCHANGE_URL: 'http://127.0.0.1:3100', PAPER_EXCHANGE_ACCOUNT_ID: 'paper-1' }).paper.exchange?.accountId, 'paper-1');
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
    assert.equal(loadConfig(BASE).feed.marketFeedMode, 'ticker');
    assert.throws(() => loadConfig({ ...BASE, DHAN_MARKET_FEED_MODE: 'depth' }), /DHAN_MARKET_FEED_MODE/);
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
    assert.equal(loadConfig(BASE).paper.slippageBps, 25, 'paper exits pay about half the spread by default');
    assert.throws(() => loadConfig({ ...BASE, FLATTEN_BY: '15:45' }), /15:15/);
    assert.throws(() => loadConfig({ ...BASE, FLATTEN_BY: '15:16' }), /before Dhan auto-squares/);
    assert.equal(loadConfig({ ...BASE, FLATTEN_BY: '15:15' }).exits.flattenByMinute, 15 * 60 + 15);
  });

  it('never lets a single trade risk more than the daily loss budget allows', () => {
    assert.throws(
      () => loadConfig({ ...BASE, MAX_RISK_PER_TRADE_PCT: '5', MAX_DAILY_LOSS_PCT: '3' }),
      /must not exceed/,
    );
  });
});

describe('loadConfig Dhan authentication', () => {
  const OTP = { DHAN_CLIENT_ID: '1100000001', DHAN_PIN: '4321', DHAN_TOTP_SECRET: 'JBSWY3DPEHPK3PXP', DATABASE_URL: 'postgres://paper.test.invalid/agent' };

  it('uses a static access token when no OTP variable is set', () => {
    assert.deepEqual(loadConfig(BASE).dhan.auth, { kind: 'static', accessToken: 'token' });
  });

  it('selects PIN + TOTP login without requiring a static access token', () => {
    assert.deepEqual(loadConfig(OTP).dhan.auth, { kind: 'otp', pin: '4321', totpSecret: 'JBSWY3DPEHPK3PXP' });
  });

  it('normalises a TOTP secret copied from an authenticator app (spaces, dashes, lowercase, padding)', () => {
    const config = loadConfig({ ...OTP, DHAN_TOTP_SECRET: 'jbsw y3dp-ehpk3pxp==' });
    assert.deepEqual(config.dhan.auth, { kind: 'otp', pin: '4321', totpSecret: 'JBSWY3DPEHPK3PXP' });
  });

  it('requires DHAN_PIN and DHAN_TOTP_SECRET together', () => {
    assert.throws(() => loadConfig({ DHAN_CLIENT_ID: '1', DHAN_PIN: '4321' }), /must be set together/);
    assert.throws(() => loadConfig({ DHAN_CLIENT_ID: '1', DHAN_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' }), /must be set together/);
  });

  it('refuses a static token alongside OTP variables, so the token source is never ambiguous', () => {
    assert.throws(() => loadConfig({ ...OTP, DHAN_ACCESS_TOKEN: 'stale' }), /conflicts with DHAN_PIN/);
  });

  it('rejects a TOTP secret that is not base32, without echoing it', () => {
    const bad = 'NOT-BASE32!0189';
    assert.throws(() => loadConfig({ ...OTP, DHAN_TOTP_SECRET: bad }), (error: Error) => {
      assert.match(error.message, /base32/);
      assert.equal(error.message.includes(bad), false);
      return true;
    });
  });

  it('names the accepted credential sources when neither a token nor OTP variables are set', () => {
    assert.throws(() => loadConfig({ DHAN_CLIENT_ID: '1' }), /DHAN_ACCESS_TOKEN is required unless DHAN_PIN/);
  });

  it('still requires DHAN_CLIENT_ID for OTP login', () => {
    assert.throws(() => loadConfig({ DHAN_PIN: '4321', DHAN_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' }), /DHAN_CLIENT_ID is required/);
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

describe('loadConfig posture and YAML loading', () => {
  it('defaults initial posture to aligned', () => {
    assert.equal(loadConfig(BASE).session.initialPosture, 'aligned');
  });

  it('accepts configured initial posture from env', () => {
    assert.equal(loadConfig({ ...BASE, STRATEGY_POSTURE: 'scout' }).session.initialPosture, 'scout');
    assert.equal(loadConfig({ ...BASE, POSTURE: 'confirmed' }).session.initialPosture, 'confirmed');
  });

  it('rejects unknown posture values', () => {
    assert.throws(() => loadConfig({ ...BASE, STRATEGY_POSTURE: 'yolo' }), /STRATEGY_POSTURE must be one of/);
  });

  it('loads paper YAML configuration and applies scout posture, 10L capital, and daily risk brakes', () => {
    const config = loadConfig(BASE, 'config.paper.yml');
    assert.deepEqual(config.underlyings.map((u) => u.symbol), ['NIFTY', 'BANKNIFTY', 'SENSEX']);
    assert.equal(config.session.initialPosture, 'scout');
    assert.equal(config.capital.inr, 1_000_000);
    assert.equal(config.capital.maxRiskPerTradePct, 2.0);
    assert.equal(config.capital.maxDailyLossPct, 4.0);
    assert.equal(config.capital.maxLotsPerOrder, 15);
    assert.equal(config.capital.maxTradesPerDay, 0);
    assert.equal(config.exits.cooldownSeconds, 900);
    assert.equal(config.capital.maxOpenPositions, 6);
    assert.equal(config.capital.maxPositionsPerSide, 2);
    assert.equal(config.session.entryStartMinute, 9 * 60 + 15);
    assert.equal(config.session.entryEndMinute, 14 * 60);
    assert.equal(config.exits.flattenByMinute, 15 * 60 + 15);
    assert.equal(config.ops.brokerKillSwitchOnBreach, false);
    assert.equal(config.strategy.maxBarsSinceFlip, 4);
    assert.equal(config.strategy.minDistanceAtr, 0.2);
    assert.equal(config.contract.minDaysToExpiry, 0);
    assert.equal(config.contract.maxDaysToExpiry, 6);
    assert.equal(config.chainAnalysis.enabled, true);
    assert.equal(config.chainAnalysis.minHeadroomPts, 15);
  });
});

