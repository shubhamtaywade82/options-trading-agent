import type { OptionSegment } from './domain/types.js';
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

export interface AgentConfig {
  readonly mode: 'paper' | 'live';
  readonly dhan: {
    readonly clientId: string;
    readonly auth: DhanAuthConfig;
    readonly baseUrl: string | undefined;
  };
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
  const mode = text(env, 'MODE', 'paper').toLowerCase();
  if (mode !== 'paper' && mode !== 'live') {
    throw new Error(`MODE must be "paper" or "live", got "${mode}"`);
  }
  if (mode === 'live' && text(env, 'LIVE_TRADING_ACK', '') !== LIVE_ACK_PHRASE) {
    throw new Error(`live mode requires LIVE_TRADING_ACK=${LIVE_ACK_PHRASE}`);
  }

  const config: AgentConfig = {
    mode,
    dhan: {
      clientId: text(env, 'DHAN_CLIENT_ID'),
      auth: parseDhanAuth(env),
      baseUrl: optionalText(env, 'DHAN_BASE_URL'),
    },
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
  };

  validateCrossFields(config);
  return config;
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
