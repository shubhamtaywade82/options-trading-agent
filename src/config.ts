import 'dotenv/config';
import { z } from 'zod';
import type { Mode } from './types.js';

const pathWithDefault = (fallback: string) => z.string().default(fallback).transform((raw) => raw.trim() || fallback);

const timeframeTtl = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const EnvSchema = z.object({
  MODE: z.enum(['paper', 'live']).default('paper'),
  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  OLLAMA_HOST: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('gemma4:31b'),
  OLLAMA_TECHNICAL_MODEL: z.string().optional(),
  OLLAMA_LIQUIDITY_MODEL: z.string().optional(),
  OLLAMA_DERIVATIVES_MODEL: z.string().optional(),
  OLLAMA_REGIME_MODEL: z.string().optional(),
  OLLAMA_SKEPTIC_MODEL: z.string().optional(),
  OLLAMA_CHAIR_MODEL: z.string().optional(),
  LLM_COUNCIL: z.enum(['off', 'on']).default('on'),
  LLM_COUNCIL_AUTOTRADE: z.enum(['off', 'on']).default('on'),
  LLM_COUNCIL_MIN_PROBABILITY: z.coerce.number().min(0.5).max(0.95).default(0.65),
  OLLAMA_API_KEY_1: z.string().optional(),
  OLLAMA_API_KEY_2: z.string().optional(),
  OLLAMA_API_KEY_3: z.string().optional(),
  OLLAMA_API_KEY_4: z.string().optional(),
  OLLAMA_API_KEY_5: z.string().optional(),
  MIN_LEVERAGE: z.coerce.number().default(5),
  MAX_LEVERAGE: z.coerce.number().default(10),
  MAX_EXPOSURE_PCT: z.coerce.number().default(80),
  RISK_PER_TRADE_PCT: z.coerce.number().default(1),
  MAX_DRAWDOWN_PCT: z.coerce.number().default(5),
  MIN_LIQ_BUFFER_ATR: z.coerce.number().default(1.2),
  SYMBOLS: z.string().default('BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT'),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(3),
  MAX_LOSS_STREAK: z.coerce.number().int().positive().default(4),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().optional(),
  MAX_SYMBOL_EXPOSURE_PCT: z.coerce.number().positive().optional(),
  MAX_CORRELATED_EXPOSURE_PCT: z.coerce.number().positive().optional(),
  /** Geometry sanity floor applied to every candidate before risk: below this the target is effectively at the entry. Not an edge claim. */
  CANDIDATE_MIN_RR: z.coerce.number().nonnegative().default(0.25),
  /** Optional: drop candidates whose cost-adjusted break-even win rate exceeds this (0 = off). Set it from scripts/replay-decisions.ts evidence, not a guess. */
  CANDIDATE_MAX_BREAKEVEN_WINRATE: z.coerce.number().min(0).max(1).default(0),
  /** Alert when a position with no protective stop is at least this % of equity (0 disables). */
  UNPROTECTED_ALERT_PCT: z.coerce.number().nonnegative().default(25),
  MIN_RR: z.coerce.number().nonnegative().default(0),
  TAKER_FEE_RATE: z.coerce.number().nonnegative().default(0.0004),
  SLIPPAGE_BUFFER_RATE: z.coerce.number().nonnegative().default(0.0002),
  RISK_ENGINE: z.enum(['off', 'on']).default('on'),
  MAX_PORTFOLIO_RISK_PCT: z.coerce.number().positive().default(3),
  SIZE_VOL_SCALING: z.enum(['off', 'on']).default('on'),
  SIZE_SCORE_SCALING: z.enum(['off', 'on']).default('on'),

  /** Off by default: on 90-day real-kline replays of BTC/ETH/SOL in two windows no manager variant beat the fixed stop/target (see README). */
  POSITION_MANAGER: z.enum(['off', 'on']).default('off'),
  /**
   * Position manager on live Binance. off = exchange-side stops only (default). shadow = compute and log what it would
   * do against an in-memory overlay, send nothing. on = send real reduce-only and stop-replacement orders. Needs POSITION_MANAGER=on.
   */
  LIVE_POSITION_MANAGER: z.enum(['off', 'shadow', 'on']).default('off'),
  PM_TP1_R: z.coerce.number().positive().default(1),
  PM_TP1_FRACTION: z.coerce.number().gt(0).lt(1).default(0.35),
  PM_TP2_R: z.coerce.number().positive().default(2),
  PM_TP2_FRACTION: z.coerce.number().gt(0).lt(1).default(0.3),
  PM_TRAIL_ATR_LOW: z.coerce.number().positive().default(2),
  PM_TRAIL_ATR_MEDIUM: z.coerce.number().positive().default(2.5),
  PM_TRAIL_ATR_HIGH: z.coerce.number().positive().default(3.2),

  SAFETY: z.enum(['off', 'on']).default('on'),
  SAFETY_TICK_STALE_MS: z.coerce.number().int().positive().default(15_000),
  SAFETY_MARK_STALE_MS: z.coerce.number().int().positive().default(30_000),
  SHOCK_RETURN_Z: z.coerce.number().positive().default(4),
  SHOCK_VOLUME_Z: z.coerce.number().positive().default(4),
  SHOCK_SPREAD_MULT: z.coerce.number().positive().default(2),
  SHOCK_RECOVERY_BARS: z.coerce.number().int().positive().default(5),

  MARKET_DATA_1M_TTL_MS: timeframeTtl(15_000),
  MARKET_DATA_5M_TTL_MS: timeframeTtl(60_000),
  MARKET_DATA_15M_TTL_MS: timeframeTtl(60_000),
  MARKET_DATA_1H_TTL_MS: timeframeTtl(300_000),
  MARKET_DATA_4H_TTL_MS: timeframeTtl(900_000),
  MARKET_DATA_DERIVATIVES_TTL_MS: timeframeTtl(60_000),
  MARKET_DATA_KLINE_LIMIT: z.coerce.number().int().min(50).max(1000).default(300),
  MARKET_DATA_HISTORY_LIMIT: z.coerce.number().int().min(2).max(500).default(30),
  MARKET_DATA_ORDERBOOK_DEPTH: z.coerce.number().int().min(5).max(100).default(20),
  MARKET_DATA_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  MARKET_DATA_DERIVATIVES_PERIOD: z.enum(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']).default('1h'),

  AUDIT: z.enum(['off', 'on']).default('on'),
  ALERTS: z.enum(['off', 'on']).default('on'),
  ADAPTIVE_ST_REQUIRE_ANCHOR: z.enum(['off', 'on']).default('off'),
  STRUCT_LIQ: z.enum(['off', 'on']).default('on'),
  STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES: z.coerce.number().int().min(1).default(6),
  STRUCT_LIQ_MIN_REWARD_RISK: z.coerce.number().min(0).default(1.5),
  /** CROWDING-ι only trades when an untaken liquidity pool pays at least this multiple of its stop distance. */
  CROWDING_MIN_REWARD_RISK: z.coerce.number().min(0).default(1.5),
  EVENTS_PATH: pathWithDefault('data/events.jsonl'),
  NOTIFICATIONS_PATH: pathWithDefault('data/notifications.json'),
  DECISIONS_PATH: pathWithDefault('data/decisions.jsonl'),
  /** Optional per-strategy RR floors written by scripts/calibrate-rr.ts; empty keeps the global MIN_RR. */
  /** classic = the original first-match classifier; scored = trend score + hysteresis + dwell time (see src/market/RegimeScoring.ts). */
  REGIME_MODEL: z.enum(['classic', 'scored']).default('classic'),
  REGIME_CONFIRM_BARS: z.coerce.number().int().min(1).default(2),
  REGIME_TREND_ENTER: z.coerce.number().min(0).max(1).default(0.55),
  REGIME_TREND_EXIT: z.coerce.number().min(0).max(1).default(0.4),
  SETUP_OUTCOMES_PATH: pathWithDefault('data/setup-outcomes.jsonl'),
  /** Gross reward:risk a setup scenario must offer to be built at all (the quality gate then re-checks it after costs). */
  SETUP_MIN_REWARD_RISK: z.coerce.number().min(0).default(1.5),
  /** Hide scenarios the quality gate already rejected (NO_TRADE) from Telegram setup cards; they still reach the outcome ledger. */
  SETUP_ALERT_HIDE_NO_TRADE: z.enum(['off', 'on']).default('on'),
  /** Strategies allowed to trade live; written by scripts/live-readiness.ts --write-approvals. Missing file = none approved. */
  APPROVALS_PATH: pathWithDefault('data/strategy-approvals.json'),
  RR_PROFILE_PATH: z.string().trim().default(''),
  PAPER_EXCHANGE_URL: z.string().optional(),
  PAPER_EXCHANGE_ACCOUNT_ID: z.string().trim().optional(),
  PAPER_EXCHANGE_API_KEY: z.string().trim().optional(),
  COINDCX_API_KEY: z.string().default(''),
  COINDCX_API_SECRET: z.string().default(''),
  COINDCX_PAPER_MODE: z.enum(['off', 'on']).default('on'),
  COINDCX_QUOTE_PREFERENCE: z.enum(['auto', 'USDT', 'INR']).default('auto'),
  COINDCX_MAX_ORDER_NOTIONAL: z.coerce.number().positive().optional(),
  COINDCX_MAX_ORDER_QUANTITY: z.coerce.number().positive().optional(),
  COINDCX_INITIAL_BALANCE: z.coerce.number().positive().default(1_150),
}).superRefine((env, ctx) => {
  if (env.PM_TP2_R <= env.PM_TP1_R) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PM_TP2_R'], message: 'PM_TP2_R must be greater than PM_TP1_R' });
  }
  if (env.REGIME_TREND_EXIT >= env.REGIME_TREND_ENTER) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['REGIME_TREND_EXIT'], message: 'REGIME_TREND_EXIT must be below REGIME_TREND_ENTER (that gap is the hysteresis)' });
  }
  if (env.PM_TP1_FRACTION + env.PM_TP2_FRACTION >= 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PM_TP2_FRACTION'], message: 'PM_TP1_FRACTION + PM_TP2_FRACTION must be below 1 so a runner remains' });
  }
  if (env.MODE !== 'paper' || !env.PAPER_EXCHANGE_URL || env.PAPER_EXCHANGE_ACCOUNT_ID) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['PAPER_EXCHANGE_ACCOUNT_ID'],
    message: 'PAPER_EXCHANGE_ACCOUNT_ID must be set explicitly when PAPER_EXCHANGE_URL is set (there is no default account)',
  });
});

export const LOOP_INTERVAL_MS = 8000;

type Env = z.infer<typeof EnvSchema>;

const parseSymbols = (raw: string): string[] => raw.split(',').map(s => s.trim());

export function riskFromEnv(env: Env) {
  return {
    minLeverage: env.MIN_LEVERAGE,
    maxLeverage: env.MAX_LEVERAGE,
    maxExposurePct: env.MAX_EXPOSURE_PCT,
    riskPerTradePct: env.RISK_PER_TRADE_PCT,
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
    minLiqBufferAtr: env.MIN_LIQ_BUFFER_ATR,
    maxDailyLossPct: env.MAX_DAILY_LOSS_PCT,
    maxLossStreak: env.MAX_LOSS_STREAK,
    maxConcurrentPositions: env.MAX_CONCURRENT_POSITIONS ?? parseSymbols(env.SYMBOLS).length,
    maxSymbolExposurePct: env.MAX_SYMBOL_EXPOSURE_PCT ?? env.MAX_EXPOSURE_PCT,
    maxCorrelatedExposurePct: env.MAX_CORRELATED_EXPOSURE_PCT ?? env.MAX_EXPOSURE_PCT,
    minRr: env.MIN_RR,
    takerFeeRate: env.TAKER_FEE_RATE,
    slippageBufferRate: env.SLIPPAGE_BUFFER_RATE,
  };
}

const env = EnvSchema.parse(process.env);

export const config = {
  mode: env.MODE as Mode,
  binance: { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET },
  ollama: {
    host: env.OLLAMA_HOST,
    model: env.OLLAMA_MODEL,
    models: {
      technical: env.OLLAMA_TECHNICAL_MODEL?.trim() || env.OLLAMA_MODEL,
      liquidity: env.OLLAMA_LIQUIDITY_MODEL?.trim() || env.OLLAMA_MODEL,
      derivatives: env.OLLAMA_DERIVATIVES_MODEL?.trim() || env.OLLAMA_MODEL,
      regime: env.OLLAMA_REGIME_MODEL?.trim() || env.OLLAMA_MODEL,
      skeptic: env.OLLAMA_SKEPTIC_MODEL?.trim() || env.OLLAMA_MODEL,
      chair: env.OLLAMA_CHAIR_MODEL?.trim() || env.OLLAMA_MODEL,
    },
    apiKeys: [
      env.OLLAMA_API_KEY_1,
      env.OLLAMA_API_KEY_2,
      env.OLLAMA_API_KEY_3,
      env.OLLAMA_API_KEY_4,
      env.OLLAMA_API_KEY_5,
    ].map((k) => k?.trim()).filter((k): k is string => Boolean(k)),
  },
  risk: riskFromEnv(env),
  riskEngine: env.RISK_ENGINE,
  /** Cap on summed loss-at-stop of open positions plus the new trade, % of equity. */
  portfolioRiskPct: env.MAX_PORTFOLIO_RISK_PCT,
  sizing: {
    volatilityScaling: env.SIZE_VOL_SCALING === 'on',
    scoreScaling: env.SIZE_SCORE_SCALING === 'on',
  },
  positionManager: {
    enabled: env.POSITION_MANAGER === 'on',
    live: env.LIVE_POSITION_MANAGER,
    tp1R: env.PM_TP1_R,
    tp1Fraction: env.PM_TP1_FRACTION,
    tp2R: env.PM_TP2_R,
    tp2Fraction: env.PM_TP2_FRACTION,
    trailAtr: { LOW: env.PM_TRAIL_ATR_LOW, MEDIUM: env.PM_TRAIL_ATR_MEDIUM, HIGH: env.PM_TRAIL_ATR_HIGH },
  },
  safety: {
    enabled: env.SAFETY === 'on',
    tickStaleMs: env.SAFETY_TICK_STALE_MS,
    markStaleMs: env.SAFETY_MARK_STALE_MS,
    shock: {
      returnZ: env.SHOCK_RETURN_Z,
      volumeZ: env.SHOCK_VOLUME_Z,
      spreadMult: env.SHOCK_SPREAD_MULT,
      recoveryBars: env.SHOCK_RECOVERY_BARS,
    },
  },
  llmCouncil: {
    enabled: env.LLM_COUNCIL === 'on',
    /** When on, a chair TRADE verdict on a TRIGGERED setup becomes a real Signal through the normal risk gate. Off by default: the council stays advisory-only. */
    autoTrade: env.LLM_COUNCIL_AUTOTRADE === 'on',
    minProbability: env.LLM_COUNCIL_MIN_PROBABILITY,
  },
  marketDataV2: {
    enabled: true,
    candleTtlMs: {
      '1m': env.MARKET_DATA_1M_TTL_MS,
      '5m': env.MARKET_DATA_5M_TTL_MS,
      '15m': env.MARKET_DATA_15M_TTL_MS,
      '1h': env.MARKET_DATA_1H_TTL_MS,
      '4h': env.MARKET_DATA_4H_TTL_MS,
    },
    derivativesTtlMs: env.MARKET_DATA_DERIVATIVES_TTL_MS,
    klineLimit: env.MARKET_DATA_KLINE_LIMIT,
    historyLimit: env.MARKET_DATA_HISTORY_LIMIT,
    orderBookDepth: env.MARKET_DATA_ORDERBOOK_DEPTH,
    maxConcurrency: env.MARKET_DATA_MAX_CONCURRENCY,
    derivativesPeriod: env.MARKET_DATA_DERIVATIVES_PERIOD,
    basisEnabled: true,
  },
  audit: env.AUDIT,
  alerts: env.ALERTS,
  adaptiveSuperTrend: {
    requireAnchor: env.ADAPTIVE_ST_REQUIRE_ANCHOR === 'on',
  },
  crowding: {
    minimumRewardRisk: env.CROWDING_MIN_REWARD_RISK,
  },
  structLiq: {
    enabled: env.STRUCT_LIQ === 'on',
    maxSweepAgeCandles: env.STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES,
    minimumRewardRisk: env.STRUCT_LIQ_MIN_REWARD_RISK,
  },
  eventsPath: env.EVENTS_PATH,
  notificationsPath: env.NOTIFICATIONS_PATH,
  candidateMinRr: env.CANDIDATE_MIN_RR,
  unprotectedAlertPct: env.UNPROTECTED_ALERT_PCT,
  candidateMaxBreakevenWinRate: env.CANDIDATE_MAX_BREAKEVEN_WINRATE,
  decisionsPath: env.DECISIONS_PATH,
  rrProfilePath: env.RR_PROFILE_PATH,
  approvalsPath: env.APPROVALS_PATH,
  setupOutcomesPath: env.SETUP_OUTCOMES_PATH,
  regime: {
    scored: env.REGIME_MODEL === 'scored',
    options: { confirmBars: env.REGIME_CONFIRM_BARS, trendEnter: env.REGIME_TREND_ENTER, trendExit: env.REGIME_TREND_EXIT },
  },
  setup: {
    minRewardRisk: env.SETUP_MIN_REWARD_RISK,
    alertHideNoTrade: env.SETUP_ALERT_HIDE_NO_TRADE === 'on',
  },
  symbols: parseSymbols(env.SYMBOLS),
  paperExchange: env.PAPER_EXCHANGE_URL && env.PAPER_EXCHANGE_ACCOUNT_ID
    ? {
        url: env.PAPER_EXCHANGE_URL.replace(/\/+$/, ''),
        accountId: env.PAPER_EXCHANGE_ACCOUNT_ID,
        apiKey: env.PAPER_EXCHANGE_API_KEY,
      }
    : null,
  // CoinDCX live-execution migration is in progress but not wired into BinanceService yet (issue #31):
  // built whenever MODE=live so the adapter can pick it up once wired, but never required to start.
  coindcx: env.MODE === 'live' ? {
    apiKey: env.COINDCX_API_KEY,
    apiSecret: env.COINDCX_API_SECRET,
    paperMode: env.COINDCX_PAPER_MODE === 'on',
    quotePreference: env.COINDCX_QUOTE_PREFERENCE,
    maxOrderNotional: env.COINDCX_MAX_ORDER_NOTIONAL,
    maxOrderQuantity: env.COINDCX_MAX_ORDER_QUANTITY,
    initialBalance: env.COINDCX_INITIAL_BALANCE,
  } : null,
} as const;

if (config.mode === 'live' && (!config.binance.apiKey || !config.binance.apiSecret)) {
  throw new Error('LIVE mode requires BINANCE_API_KEY and BINANCE_API_SECRET');
}
