import { SEVERITY_RANK, type AlertEvent } from './alerts.js';

export type TelegramChannel = 'alert' | 'trading';

export interface TelegramOptions {
  readonly channel?: TelegramChannel;
  readonly silent?: boolean;
}

export interface TelegramDeps {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dryRun?: boolean;
  readonly log?: (line: string) => void;
}

const SEND_TIMEOUT_MS = 10_000;
const DRY_RUN_PREFIX = '[telegram dry-run]';
const TRADING_CHANNEL_CLASSES: ReadonlySet<string> = new Set(['TRADE', 'SIGNAL', 'SETUP']);

// Truthiness rather than `??`: a blank variable in .env must fall through to the shared bot, not disable sending
const firstValue = (env: Readonly<Record<string, string | undefined>>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
};

const TOKEN_KEYS: Readonly<Record<TelegramChannel, readonly string[]>> = {
  trading: ['TELEGRAM_TRADING_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'],
  alert: ['TELEGRAM_ALERTBOT_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'],
};

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** True when a chat id and at least one bot token are present. */
export const telegramConfigured = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  Boolean(firstValue(env, ['TELEGRAM_CHAT_ID']) && (firstValue(env, TOKEN_KEYS.alert) || firstValue(env, TOKEN_KEYS.trading)));

const isDryRun = (env: Readonly<Record<string, string | undefined>>): boolean =>
  ['1', 'true'].includes(env.TELEGRAM_DRY_RUN?.trim().toLowerCase() ?? '');

const safeLog = (log: (line: string) => void, line: string): void => {
  try {
    log(line);
  } catch {
    // a broken logger must not turn a card into a crash
  }
};

/** Sends an HTML card; resolves false (never throws) when unconfigured, rejected, timed out or unreachable. */
export async function sendTelegram(text: string, opts: TelegramOptions = {}, deps: TelegramDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (deps.dryRun ?? isDryRun(env)) {
    safeLog(deps.log ?? console.log, `${DRY_RUN_PREFIX} ${text}`);
    return true;
  }
  const token = firstValue(env, TOKEN_KEYS[opts.channel ?? 'alert']);
  const chatId = firstValue(env, ['TELEGRAM_CHAT_ID']);
  if (!token || !chatId) return false;
  try {
    const response = await (deps.fetchImpl ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: opts.silent ?? false,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    // Not logged: fetch errors can echo the request URL, which contains the bot token
    return false;
  }
}

/** Sends an alert card: TRADE/SIGNAL use the trading bot, the rest the alert bot; below IMPORTANT is silent. */
export const sendAlert = (event: AlertEvent, html: string, deps: TelegramDeps = {}): Promise<boolean> =>
  sendTelegram(html, {
    channel: TRADING_CHANNEL_CLASSES.has(event.class) ? 'trading' : 'alert',
    silent: SEVERITY_RANK[event.severity] < SEVERITY_RANK.IMPORTANT,
  }, deps);
