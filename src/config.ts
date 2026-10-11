import { createHash } from 'node:crypto';
import type { OptionSegment } from './domain/types.js';
import { TRADING_MODES, type TradingMode } from './domain/mode.js';

/** The production REST host the SDK uses when DHAN_BASE_URL is not set. The sandbox must never point here. */
const PRODUCTION_DHAN_HOST = 'api.dhan.co';
import { parseRedisUrl, validatePostgresUrl } from './persistence/urls.js';
import { parseMinuteOfDay } from './time/ist.js';

/** Index symbols this agent knows how to trade, with the segment their options list on. */
export const KNOWN_UNDERLYINGS: Readonly<Record<string, OptionSegment>> = {
  NIFTY: 'NSE_FNO',
  BANKNIFTY: 'NSE_FNO',
  FINNIFTY: 'NSE_FNO',
  MIDCPNIFTY: 'NSE_FNO',
  SENSEX: 'BSE_FNO',
};

export const LIVE_ACK_PHRASE = 'I_ACCEPT_LIVE_ORDER_RISK';

/**
 * How the Dhan access token is obtained. `otp` logs in with PIN + TOTP at startup and renews
 * the token itself. `static` uses a token pasted in by hand, which expires and must be replaced.
 */
export type DhanAuthConfig =
  | { readonly kind: 'static'; readonly accessToken: string }
  | { readonly kind: 'otp'; readonly pin: string; readonly totpSecret: string };

/**
 * Sandbox order credentials. Used only in sandbox mode. Market data never uses these; it always uses `dhan`.
 * The sandbox base URL has no default, because the sandbox host is not part of the SDK and must be set explicitly.
 */
export interface SandboxConfig {
  readonly clientId: string;
  readonly accessToken: string;
  readonly baseUrl: string;
}

export interface AgentConfig {
  readonly mode: TradingMode;
  readonly dhan: {
    readonly clientId: string;
    readonly auth: DhanAuthConfig;
    readonly baseUrl: string | undefined;
  };
  /** Present only in sandbox mode. */
  readonly sandbox: SandboxConfig | undefined;
  readonly underlyings: readonly { readonly symbol: string; readonly optionSegment: OptionSegment }[];
  readonly capital: {
    readonly inr: number;
    readonly maxRiskPerTradePct: number;
    readonly maxDailyLossPct: number;
    readonly maxOpenPositions: number;
    readonly maxTradesPerDay: number;
    readonly maxLotsPerOrder: number;
  };
  readonly contract: {
    readonly minDaysToExpiry: number;
    readonly expiryDayEntryCutoffMinute: number;
    /** 0 = ATM, positive = further OTM, negative = further ITM. */
    readonly strikeOffsetSteps: number;
    readonly maxSpreadPct: number;
    readonly minOpenInterest: number;
    readonly minVolume: number;
  };
  readonly exits: {
    readonly stopLossPct: number;
    readonly targetRr: number;
    readonly maxHoldMinutes: number;
    readonly flattenByMinute: number;
    readonly cooldownSeconds: number;
  };
  readonly session: {
    readonly entryStartMinute: number;
    readonly entryEndMinute: number;
  };
  readonly strategy: {
    readonly barMinutes: number;
    readonly supertrendPeriod: number;
    readonly supertrendMultiplier: number;
    readonly emaFast: number;
    readonly emaSlow: number;
    readonly orbMinutes: number;
    readonly warmupDays: number;
  };
  readonly feed: {
    readonly staleMs: number;
    readonly istShiftedTimestamps: boolean;
  };
  readonly paper: {
    /** Where paper orders are simulated. Only the PostgreSQL venue exists today. */
    readonly backend: 'postgres';
    readonly slippageBps: number;
  };
  readonly llm: {
    readonly enabled: boolean;
    readonly host: string;
    readonly model: string | undefined;
    readonly apiKey: string | undefined;
    readonly timeoutMs: number;
  };
  readonly ops: {
    /** Directory holding one `events-YYYY-MM-DD.jsonl` file per IST trading day. */
    readonly eventLogDir: string;
    readonly brokerKillSwitchOnBreach: boolean;
    readonly reconcileIntervalMs: number;
    readonly orderTimeoutMs: number;
  };
  readonly persistence: {
    /** PostgreSQL. Required in every mode: the ledger and lease for live and sandbox, the paper venue for paper. Credentials inside the URL are never logged. */
    readonly databaseUrl: string | undefined;
    /** Redis for the account rate gate and the contract cache. Required for live and sandbox, optional for paper. The trading lease lives in PostgreSQL. */
    readonly redisUrl: string | undefined;
    /** Stable name for this host, recorded on every run. Defaults to the hostname at runtime. */
    readonly instanceId: string | undefined;
    /** Trading lease TTL. A crashed holder's lease expires after this, plus the order timeout. */
    readonly leaseTtlMs: number;
    readonly postgresMaxConnections: number;
  };
}

type Env = Readonly<Record<string, string | undefined>>;

function text(env: Env, key: string, fallback?: string): string {
  const raw = env[key]?.trim();
  if (raw !== undefined && raw !== '') {
    return raw;
  }
  if (fallback === undefined) {
    throw new Error(`${key} is required`);
  }
  return fallback;
}

function optionalText(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

function number(env: Env, key: string, fallback: number, bounds: { min: number; max: number; integer?: boolean }): number {
  const raw = optionalText(env, key);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a number, got "${raw}"`);
  }
  if (bounds.integer && !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer, got ${value}`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new Error(`${key} must be within [${bounds.min}, ${bounds.max}], got ${value}`);
  }
  return value;
}

function flag(env: Env, key: string, fallback: boolean): boolean {
  const raw = optionalText(env, key);
  if (raw === undefined) {
    return fallback;
  }
  if (['true', '1', 'on', 'yes'].includes(raw.toLowerCase())) {
    return true;
  }
  if (['false', '0', 'off', 'no'].includes(raw.toLowerCase())) {
    return false;
  }
  throw new Error(`${key} must be a boolean flag (true/false), got "${raw}"`);
}

function minuteOfDay(env: Env, key: string, fallback: string): number {
  try {
    return parseMinuteOfDay(text(env, key, fallback));
  } catch (error) {
    throw new Error(`${key}: ${(error as Error).message}`);
  }
}

/**
 * OTP login (DHAN_PIN + DHAN_TOTP_SECRET) is preferred and selected whenever either is set.
 * A static DHAN_ACCESS_TOKEN is accepted only when no OTP variable is present, so the token
 * source is never ambiguous. Error messages name variables but never echo their values.
 */
function parseDhanAuth(env: Env): DhanAuthConfig {
  const pin = optionalText(env, 'DHAN_PIN');
  const totpSecret = optionalText(env, 'DHAN_TOTP_SECRET');
  const accessToken = optionalText(env, 'DHAN_ACCESS_TOKEN');

  if (pin === undefined && totpSecret === undefined) {
    if (accessToken === undefined) {
      throw new Error('DHAN_ACCESS_TOKEN is required unless DHAN_PIN and DHAN_TOTP_SECRET are set');
    }
    return { kind: 'static', accessToken };
  }
  if (pin === undefined || totpSecret === undefined) {
    throw new Error('DHAN_PIN and DHAN_TOTP_SECRET must be set together');
  }
  if (accessToken !== undefined) {
    throw new Error('DHAN_ACCESS_TOKEN conflicts with DHAN_PIN/DHAN_TOTP_SECRET; remove DHAN_ACCESS_TOKEN so the token source is unambiguous');
  }
  // Authenticator apps show the secret in groups of four, sometimes with padding. Normalise before validating.
  const normalizedSecret = totpSecret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(normalizedSecret)) {
    throw new Error('DHAN_TOTP_SECRET must be a base32 secret (letters A-Z and digits 2-7)');
  }
  return { kind: 'otp', pin, totpSecret: normalizedSecret };
}

function parseUnderlyings(env: Env): AgentConfig['underlyings'] {
  const symbols = text(env, 'UNDERLYINGS', 'NIFTY')
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
  if (symbols.length === 0) {
    throw new Error('UNDERLYINGS must list at least one index symbol');
  }
  const unique = [...new Set(symbols)];
  return unique.map((symbol) => {
    const optionSegment = KNOWN_UNDERLYINGS[symbol];
    if (optionSegment === undefined) {
      throw new Error(
        `UNDERLYINGS: "${symbol}" is not a supported index (supported: ${Object.keys(KNOWN_UNDERLYINGS).join(', ')})`,
      );
    }
    return { symbol, optionSegment };
  });
}

/**
 * Parses and validates the full agent configuration. Every invalid or unsafe
 * value throws before any network call; live mode additionally requires an
 * explicit acknowledgement phrase.
 */
export function loadConfig(env: Env = process.env): AgentConfig {
  if (optionalText(env, 'EVENT_LOG_PATH') !== undefined) {
    // A single file grew without bound and was read in full at every start. Refuse rather than ignore it.
    throw new Error('EVENT_LOG_PATH was replaced by EVENT_LOG_DIR (daily journal files); unset EVENT_LOG_PATH');
  }
  const modeText = text(env, 'MODE', 'paper').toLowerCase();
  if (!(TRADING_MODES as readonly string[]).includes(modeText)) {
    throw new Error(`MODE must be one of ${TRADING_MODES.join(', ')}, got "${modeText}"`);
  }
  const mode = modeText as TradingMode;
  if (mode === 'live' && text(env, 'LIVE_TRADING_ACK', '') !== LIVE_ACK_PHRASE) {
    throw new Error(`live mode requires LIVE_TRADING_ACK=${LIVE_ACK_PHRASE}`);
  }

  const dhanBaseUrl = optionalText(env, 'DHAN_BASE_URL');
  const config: AgentConfig = {
    mode,
    dhan: {
      clientId: text(env, 'DHAN_CLIENT_ID'),
      auth: parseDhanAuth(env),
      baseUrl: dhanBaseUrl,
    },
    sandbox: mode === 'sandbox' ? parseSandbox(env, dhanBaseUrl) : undefined,
    underlyings: parseUnderlyings(env),
    capital: {
      inr: number(env, 'CAPITAL_INR', 100_000, { min: 1_000, max: 1e12 }),
      maxRiskPerTradePct: number(env, 'MAX_RISK_PER_TRADE_PCT', 1, { min: 0.01, max: 10 }),
      maxDailyLossPct: number(env, 'MAX_DAILY_LOSS_PCT', 3, { min: 0.01, max: 50 }),
      maxOpenPositions: number(env, 'MAX_OPEN_POSITIONS', 1, { min: 1, max: 10, integer: true }),
      maxTradesPerDay: number(env, 'MAX_TRADES_PER_DAY', 3, { min: 1, max: 50, integer: true }),
      maxLotsPerOrder: number(env, 'MAX_LOTS_PER_ORDER', 1, { min: 1, max: 1000, integer: true }),
    },
    contract: {
      minDaysToExpiry: number(env, 'MIN_DAYS_TO_EXPIRY', 0, { min: 0, max: 60, integer: true }),
      expiryDayEntryCutoffMinute: minuteOfDay(env, 'EXPIRY_DAY_ENTRY_CUTOFF', '13:30'),
      strikeOffsetSteps: number(env, 'STRIKE_OFFSET_STEPS', 0, { min: -10, max: 10, integer: true }),
      maxSpreadPct: number(env, 'MAX_SPREAD_PCT', 2, { min: 0.01, max: 20 }),
      minOpenInterest: number(env, 'MIN_OPEN_INTEREST', 10_000, { min: 0, max: 1e12, integer: true }),
      minVolume: number(env, 'MIN_VOLUME', 1_000, { min: 0, max: 1e12, integer: true }),
    },
    exits: {
      stopLossPct: number(env, 'STOP_LOSS_PCT', 30, { min: 1, max: 90 }),
      targetRr: number(env, 'TARGET_RR', 2, { min: 0.5, max: 10 }),
      maxHoldMinutes: number(env, 'MAX_HOLD_MINUTES', 20, { min: 1, max: 390, integer: true }),
      flattenByMinute: minuteOfDay(env, 'FLATTEN_BY', '15:05'),
      cooldownSeconds: number(env, 'COOLDOWN_SECONDS', 300, { min: 0, max: 86_400, integer: true }),
    },
    session: {
      entryStartMinute: minuteOfDay(env, 'ENTRY_START', '09:30'),
      entryEndMinute: minuteOfDay(env, 'ENTRY_END', '14:30'),
    },
    strategy: {
      barMinutes: number(env, 'BAR_MINUTES', 5, { min: 1, max: 60, integer: true }),
      supertrendPeriod: number(env, 'SUPERTREND_PERIOD', 10, { min: 2, max: 100, integer: true }),
      supertrendMultiplier: number(env, 'SUPERTREND_MULTIPLIER', 3, { min: 0.5, max: 10 }),
      emaFast: number(env, 'EMA_FAST', 9, { min: 2, max: 200, integer: true }),
      emaSlow: number(env, 'EMA_SLOW', 21, { min: 3, max: 400, integer: true }),
      orbMinutes: number(env, 'ORB_MINUTES', 15, { min: 5, max: 60, integer: true }),
      warmupDays: number(env, 'WARMUP_DAYS', 5, { min: 1, max: 30, integer: true }),
    },
    feed: {
      staleMs: number(env, 'FEED_STALE_MS', 5_000, { min: 500, max: 60_000, integer: true }),
      istShiftedTimestamps: flag(env, 'DHAN_EPOCH_IST_SHIFTED', false),
    },
    paper: {
      backend: parsePaperBackend(env),
      slippageBps: number(env, 'PAPER_SLIPPAGE_BPS', 0, { min: 0, max: 500 }),
    },
    llm: {
      enabled: flag(env, 'LLM_ADVISOR', false),
      host: text(env, 'OLLAMA_HOST', 'http://127.0.0.1:11434'),
      model: optionalText(env, 'OLLAMA_MODEL'),
      apiKey: optionalText(env, 'OLLAMA_API_KEY'),
      timeoutMs: number(env, 'LLM_TIMEOUT_MS', 8_000, { min: 500, max: 60_000, integer: true }),
    },
    ops: {
      eventLogDir: text(env, 'EVENT_LOG_DIR', 'data/journal'),
      brokerKillSwitchOnBreach: flag(env, 'BROKER_KILL_SWITCH_ON_BREACH', true),
      reconcileIntervalMs: number(env, 'RECONCILE_INTERVAL_MS', 5_000, { min: 1_000, max: 60_000, integer: true }),
      orderTimeoutMs: number(env, 'ORDER_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000, integer: true }),
    },
    persistence: parsePersistence(env, mode),
  };

  validateCrossFields(config);
  return config;
}

/**
 * Sandbox order credentials. Every value is required together, and the base URL must not be the production host:
 * a sandbox run that quietly sent orders to production would be the worst failure this mode can have.
 */
function parseSandbox(env: Env, dhanBaseUrl: string | undefined): SandboxConfig {
  const clientId = optionalText(env, 'SANDBOX_DHAN_CLIENT_ID');
  const accessToken = optionalText(env, 'SANDBOX_DHAN_ACCESS_TOKEN');
  const baseUrl = optionalText(env, 'SANDBOX_DHAN_BASE_URL');
  if (clientId === undefined || accessToken === undefined || baseUrl === undefined) {
    throw new Error('sandbox mode requires SANDBOX_DHAN_CLIENT_ID, SANDBOX_DHAN_ACCESS_TOKEN and SANDBOX_DHAN_BASE_URL');
  }
  let host: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') {
      throw new Error('not https');
    }
    host = url.hostname.toLowerCase();
  } catch {
    throw new Error('SANDBOX_DHAN_BASE_URL must be an https URL');
  }
  // DHAN_BASE_URL is validated by the SDK when the client is built. Here it only needs to be compared against.
  const marketDataHost = dhanBaseUrl === undefined ? undefined : hostOfUrl(dhanBaseUrl);
  if (host === PRODUCTION_DHAN_HOST || host === marketDataHost) {
    throw new Error(`SANDBOX_DHAN_BASE_URL points at a production host (${host}); sandbox orders must go to the sandbox host`);
  }
  return { clientId, accessToken, baseUrl };
}

function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Paper orders are simulated by the PostgreSQL venue. The local paper_exchange server is not implemented, so it is refused, not ignored. */
function parsePaperBackend(env: Env): 'postgres' {
  const raw = (optionalText(env, 'PAPER_BACKEND') ?? 'postgres').toLowerCase();
  if (raw !== 'postgres') {
    throw new Error(`PAPER_BACKEND must be "postgres"; the "${raw}" paper backend is not implemented`);
  }
  return 'postgres';
}

/**
 * Brings persistence settings into the config. Live and sandbox need the ledger (which holds the trading lease)
 * and Redis. Paper needs the ledger too, because its wallet, orders and positions are stored there. Redis is
 * optional for paper.
 */
function parsePersistence(env: Env, mode: TradingMode): AgentConfig['persistence'] {
  const databaseUrl = optionalText(env, 'DATABASE_URL');
  const redisUrl = optionalText(env, 'REDIS_URL');
  if (databaseUrl !== undefined) {
    validatePostgresUrl(databaseUrl);
  }
  if (redisUrl !== undefined) {
    parseRedisUrl(redisUrl);
  }
  if (mode !== 'paper' && (databaseUrl === undefined || redisUrl === undefined)) {
    throw new Error(`${mode} mode requires DATABASE_URL (trading ledger and lease) and REDIS_URL (rate gate and cache)`);
  }
  if (mode === 'paper' && databaseUrl === undefined) {
    throw new Error('paper mode requires DATABASE_URL (the paper wallet, orders and positions are stored there)');
  }
  return {
    databaseUrl,
    redisUrl,
    instanceId: optionalText(env, 'INSTANCE_ID'),
    leaseTtlMs: number(env, 'LEASE_TTL_MS', 30_000, { min: 5_000, max: 120_000, integer: true }),
    postgresMaxConnections: number(env, 'POSTGRES_MAX_CONNECTIONS', 5, { min: 1, max: 50, integer: true }),
  };
}

/**
 * A fingerprint of the trading-relevant configuration, recorded on every run so a ledger row can be
 * tied to the settings that produced it. Secrets and connection strings are excluded by construction:
 * this function only reads the trading sections.
 */
export function configFingerprint(config: AgentConfig): string {
  const { mode, underlyings, capital, contract, exits, session, strategy, feed, paper } = config;
  return createHash('sha256')
    .update(JSON.stringify({ mode, underlyings, capital, contract, exits, session, strategy, feed, paper }))
    .digest('hex');
}

function validateCrossFields(config: AgentConfig): void {
  const { session, exits, strategy, contract } = config;
  if (!(session.entryStartMinute < session.entryEndMinute)) {
    throw new Error('ENTRY_START must be earlier than ENTRY_END');
  }
  if (!(session.entryEndMinute <= exits.flattenByMinute)) {
    throw new Error('FLATTEN_BY must not be earlier than ENTRY_END');
  }
  if (!(exits.flattenByMinute < 15 * 60 + 30)) {
    throw new Error('FLATTEN_BY must be before the 15:30 IST close');
  }
  if (![1, 5, 15, 25, 60].includes(strategy.barMinutes)) {
    throw new Error('BAR_MINUTES must be one of 1, 5, 15, 25, 60 (Dhan intraday chart intervals)');
  }
  if (!(strategy.emaFast < strategy.emaSlow)) {
    throw new Error('EMA_FAST must be shorter than EMA_SLOW');
  }
  if (!(contract.expiryDayEntryCutoffMinute >= session.entryStartMinute)) {
    throw new Error('EXPIRY_DAY_ENTRY_CUTOFF must not precede ENTRY_START');
  }
  if (config.capital.maxRiskPerTradePct > config.capital.maxDailyLossPct) {
    throw new Error('MAX_RISK_PER_TRADE_PCT must not exceed MAX_DAILY_LOSS_PCT');
  }
}
